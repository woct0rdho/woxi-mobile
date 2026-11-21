package com.woctordho.woximobile

import android.content.SharedPreferences
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask

// One-thread owner of the notebook files.
//
// All mutable notebook state lives on [executor]. Public methods either enqueue a mutation or
// run a synchronous query on that thread. There is therefore no state lock and no file lock:
// writes, reads, renames and deletes are naturally serialized in submission order.
internal class NotebookFiles(
    private val dir: File,
    private val prefs: SharedPreferences,
    private val notify: (String, List<String>) -> Unit,
) {
    companion object {
        private const val TAG = "Woxi"
        private const val PREFS_LAST = "last_notebook"
        private const val EXTENSION = ".ipynb"
        const val FALLBACK_NAME = "Untitled.ipynb"

        private const val MAX_FILENAME_BYTES = 255
        private val EXTENSION_BYTES = EXTENSION.toByteArray(Charsets.UTF_8).size
        private val TEMP_SUFFIX_BYTES = AtomicNotebookFile.TEMP_SUFFIX.toByteArray(Charsets.UTF_8).size
        private val MAX_STEM_BYTES = MAX_FILENAME_BYTES - EXTENSION_BYTES - TEMP_SUFFIX_BYTES
        private const val FIRST_NUMBERED_SUFFIX = 2
    }

    private data class PendingAutosave(
        val bytes: ByteArray,
        val name: String,
        val revision: Long,
        val pageToken: String,
        val order: Long,
    )

    private data class FileResult(
        val ok: Boolean,
        val message: String = "",
    )

    private val executor =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "woxi-notebooks").apply { isDaemon = true }
        }

    private val pending = linkedMapOf<String, PendingAutosave>()
    private val failed = linkedMapOf<String, PendingAutosave>()
    private var nextWriteOrder = 0L
    private var activePageToken: String? = null
    private var activeName: String? = null
    private var mutationName: String? = null
    private val allocatedNames = mutableSetOf<String>()

    init {
        dir.mkdirs()
    }

    // page lifecycle

    fun beginPage(pageToken: String) {
        enqueue {
            activePageToken = pageToken
            activeName = null
            mutationName = null
            pruneReservations()
        }
    }

    fun setCurrent(
        name: String,
        pageToken: String,
    ) {
        enqueue {
            if (pageToken != activePageToken) return@enqueue
            val safe = safeName(name)
            activeName = safe
            prefs.edit().putString(PREFS_LAST, safe).apply()
        }
    }

    // autosave

    fun autosave(
        name: String,
        text: String,
        revision: String,
        pageToken: String,
    ) {
        enqueue {
            val revisionNumber = revision.toLongOrNull()
            if (revisionNumber == null || pageToken != activePageToken) {
                notify(
                    "onAutosaveComplete",
                    listOf("false", name, revision, pageToken),
                )
                return@enqueue
            }
            val safe = safeName(name)
            if (safe != activeName || mutationName == safe) {
                notify(
                    "onAutosaveComplete",
                    listOf("false", safe, revision, pageToken),
                )
                return@enqueue
            }
            failed.remove(safe)
            pending[safe] =
                PendingAutosave(
                    text.toByteArray(Charsets.UTF_8),
                    safe,
                    revisionNumber,
                    pageToken,
                    nextOrder(),
                )
            drainWrites()
        }
    }

    fun flush() {
        enqueue {
            val blocked = mutationName
            val moved = mutableListOf<String>()
            for ((name, snapshot) in failed) {
                if (name == blocked) continue
                pending.putIfAbsent(name, snapshot)
                moved.add(name)
            }
            for (name in moved) failed.remove(name)
            drainWrites()
        }
    }

    // rename / delete

    fun rename(
        oldName: String,
        newName: String,
        text: String,
        pageToken: String,
    ) {
        enqueue {
            renameOnActor(oldName, newName, text, pageToken)
        }
    }

    fun delete(
        name: String,
        pageToken: String,
    ) {
        enqueue {
            deleteOnActor(name, pageToken)
        }
    }

    private fun renameOnActor(
        oldName: String,
        newName: String,
        text: String,
        pageToken: String,
    ) {
        val old = safeName(oldName)
        val target = safeName(newName)
        if (pageToken != activePageToken) {
            notify("onNotebookRenamed", listOf("false", old, target, "stale page", pageToken))
            return
        }
        if (mutationName != null) {
            notify("onNotebookRenamed", listOf("false", old, target, "another notebook operation is in progress", pageToken))
            return
        }

        val current = old == activeName
        val saved = pending.remove(old) ?: failed.remove(old)
        mutationName = old
        try {
            val bytes = if (text.isNotEmpty()) text.toByteArray(Charsets.UTF_8) else saved?.bytes
            val result = renameFile(old, target, bytes)
            if (result.ok) {
                pending.remove(old)
                failed.remove(old)
                allocatedNames.remove(old)
                allocatedNames.remove(target)
                if (current) {
                    activeName = target
                    if (prefs.getString(PREFS_LAST, null) == old) {
                        prefs.edit().putString(PREFS_LAST, target).apply()
                    }
                }
            } else if (saved != null) {
                pending.putIfAbsent(old, saved)
                allocatedNames.add(old)
            }
            notify(
                "onNotebookRenamed",
                listOf(if (result.ok) "true" else "false", old, target, result.message, pageToken),
            )
        } finally {
            mutationName = null
        }
    }

    private fun deleteOnActor(
        name: String,
        pageToken: String,
    ) {
        val safe = safeName(name)
        if (pageToken != activePageToken) {
            notify("onNotebookDeleted", listOf("false", safe, "stale page", pageToken))
            return
        }
        if (mutationName != null) {
            notify(
                "onNotebookDeleted",
                listOf("false", safe, "another notebook operation is in progress", pageToken),
            )
            return
        }

        val current = safe == activeName
        val saved = pending.remove(safe) ?: failed.remove(safe)
        mutationName = safe
        try {
            val result = deleteFile(safe)
            if (result.ok) {
                pending.remove(safe)
                failed.remove(safe)
                allocatedNames.remove(safe)
                if (current) {
                    activeName = null
                    if (prefs.getString(PREFS_LAST, null) == safe) {
                        prefs.edit().remove(PREFS_LAST).apply()
                    }
                }
            } else if (saved != null) {
                pending.putIfAbsent(safe, saved)
                allocatedNames.add(safe)
            }
            notify(
                "onNotebookDeleted",
                listOf(if (result.ok) "true" else "false", safe, result.message, pageToken),
            )
        } finally {
            mutationName = null
        }
    }

    private fun renameFile(
        old: String,
        target: String,
        bytes: ByteArray?,
    ): FileResult {
        val oldFile = File(dir, old)
        val targetFile = File(dir, target)
        if (old == target) {
            return if (bytes == null || AtomicNotebookFile.write(oldFile, bytes)) {
                FileResult(true)
            } else {
                FileResult(false, "could not save the notebook")
            }
        }
        if (targetFile.exists() || nameReserved(target)) {
            return FileResult(false, "a notebook with that name already exists")
        }
        if (!oldFile.isFile && bytes == null) {
            return FileResult(false, "notebook not found")
        }
        if (bytes != null && !AtomicNotebookFile.write(oldFile, bytes)) {
            return FileResult(false, "could not save the notebook")
        }
        if (!oldFile.renameTo(targetFile)) {
            return FileResult(false, "could not rename the notebook")
        }
        AtomicNotebookFile.cleanupTemps(oldFile)
        AtomicNotebookFile.cleanupTemps(targetFile)
        return FileResult(true)
    }

    private fun deleteFile(name: String): FileResult =
        if (AtomicNotebookFile.delete(File(dir, name))) {
            FileResult(true)
        } else {
            FileResult(false, "could not delete the notebook")
        }

    // synchronous queries used by the JavaScript interface

    fun nextName(base: String): String =
        query {
            val first = safeName(base)
            if (available(first)) return@query reserve(first)
            val stem = first.dropLast(EXTENSION.length)
            val candidate =
                generateSequence(FIRST_NUMBERED_SUFFIX) { it + 1 }
                    .map { index ->
                        val suffix = " $index"
                        val stemForNumber =
                            truncateUtf8(
                                stem,
                                MAX_STEM_BYTES - suffix.toByteArray(Charsets.UTF_8).size,
                            ).trimEnd()
                        stemForNumber + suffix + EXTENSION
                    }.first { available(it) }
            reserve(candidate)
        }

    fun loadLast(): String =
        query {
            val stored = prefs.getString(PREFS_LAST, null)
            val name =
                stored?.let(::safeName)?.takeIf { hasFileOrSnapshot(it) }
                    ?: newestNotebook()
            if (name == null) return@query ""
            notebookJson(name)
        }

    fun read(name: String): String =
        query {
            val safe = safeName(name)
            if (!hasFileOrSnapshot(safe)) return@query ""
            notebookJson(safe)
        }

    fun list(): String =
        query {
            val files =
                dir.listFiles { file ->
                    file.isFile && file.name.endsWith(EXTENSION, ignoreCase = true)
                } ?: return@query "[]"
            val list = JSONArray()
            files
                .sortedByDescending { it.lastModified() }
                .forEach { file ->
                    list.put(
                        JSONObject()
                            .put("name", file.name)
                            .put("modified", file.lastModified())
                            .put("size", file.length()),
                    )
                }
            list.toString()
        }

    // actor internals

    private fun enqueue(block: () -> Unit) {
        executor.execute {
            runCatching(block).onFailure { Log.w(TAG, "notebook task failed", it) }
        }
    }

    private fun <T> query(block: () -> T): T {
        val task = FutureTask<T> { block() }
        executor.execute(task)
        return task.get()
    }

    private fun drainWrites() {
        while (true) {
            val first = pending.entries.firstOrNull() ?: return
            pending.remove(first.key)
            val next = first.value
            val ok = AtomicNotebookFile.write(File(dir, next.name), next.bytes)
            if (ok) {
                failed.remove(next.name)
                allocatedNames.remove(next.name)
            } else {
                Log.w(TAG, "autosave failed: " + next.name)
                val newer = pending[next.name]
                if (newer == null || newer.order <= next.order) failed[next.name] = next
            }
            notify(
                "onAutosaveComplete",
                listOf(if (ok) "true" else "false", next.name, next.revision.toString(), next.pageToken),
            )
        }
    }

    private fun notebookJson(name: String): String {
        val latest = latestSnapshot(name)
        val bytes = latest?.bytes ?: AtomicNotebookFile.read(File(dir, name))
        if (bytes == null) return ""
        return runCatching {
            JSONObject()
                .put("name", name)
                .put("text", String(bytes, Charsets.UTF_8))
                .put("pending", latest != null)
                .toString()
        }.getOrElse { error ->
            Log.w(TAG, "read notebook failed", error)
            ""
        }
    }

    private fun latestSnapshot(name: String): PendingAutosave? {
        val candidates = listOfNotNull(pending[name], failed[name])
        return candidates.maxByOrNull { it.order }
    }

    private fun hasFileOrSnapshot(name: String): Boolean = File(dir, name).isFile || latestSnapshot(name) != null

    private fun newestNotebook(): String? =
        dir
            .listFiles { file -> file.isFile && file.name.endsWith(EXTENSION, ignoreCase = true) }
            ?.maxByOrNull { it.lastModified() }
            ?.name

    private fun available(name: String): Boolean =
        !File(dir, name).exists() && name !in allocatedNames &&
            name !in pending && name !in failed

    private fun reserve(name: String): String {
        allocatedNames.add(name)
        return name
    }

    private fun nameReserved(name: String): Boolean = name in allocatedNames || name in pending || name in failed

    private fun pruneReservations() {
        for (name in allocatedNames.toList()) {
            allocatedNames.remove(name)
            if (nameReserved(name)) allocatedNames.add(name)
        }
    }

    private fun nextOrder(): Long {
        nextWriteOrder += 1
        return nextWriteOrder
    }

    private fun safeName(name: String): String {
        val leaf = File(name).name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
        val withExtension =
            when {
                leaf.isEmpty() || leaf == "." || leaf == ".." -> FALLBACK_NAME
                leaf.endsWith(EXTENSION, ignoreCase = true) -> leaf
                else -> leaf + EXTENSION
            }
        val stem = withExtension.dropLast(EXTENSION.length)
        val limited = truncateUtf8(stem, MAX_STEM_BYTES).trimEnd()
        val finalStem = limited.ifEmpty { FALLBACK_NAME.removeSuffix(EXTENSION) }
        return finalStem + EXTENSION
    }

    private fun truncateUtf8(
        value: String,
        maxBytes: Int,
    ): String {
        if (value.toByteArray(Charsets.UTF_8).size <= maxBytes) return value
        val out = StringBuilder()
        var used = 0
        var index = 0
        while (index < value.length) {
            val codePoint = value.codePointAt(index)
            val width = Character.charCount(codePoint)
            val piece = value.substring(index, index + width)
            val bytes = piece.toByteArray(Charsets.UTF_8).size
            if (used + bytes > maxBytes) break
            out.append(piece)
            used += bytes
            index += width
        }
        return out.toString()
    }
}
