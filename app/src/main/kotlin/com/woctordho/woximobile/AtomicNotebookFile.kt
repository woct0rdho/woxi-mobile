package com.woctordho.woximobile

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

// Checked replacement for one notebook file.
//
// Invariants:
// - the caller holds NativeBridge's file lock for the whole read/write/delete call.
// - a successful write leaves one complete base file and no temporary file.
// - a failed write leaves the previous base file in place on the normal Android path and
//   removes its temporary file.
// - a read never exposes a partial `.new` file as notebook content.
//
// The platform AtomicFile cannot report a failed sync or rename. This class uses a
// temp-file replacement and makes the commit result observable. The replacement function
// is injectable only so JVM tests can replace the Windows behavior. Production always uses
// the atomic rename.
internal object AtomicNotebookFile {
    const val TEMP_SUFFIX = ".new"

    fun write(
        file: File,
        bytes: ByteArray,
    ): Boolean = write(file, bytes) { temp, base -> temp.renameTo(base) }

    // The replacement is injectable so JVM tests can use a Windows-safe move. Production
    // always takes the atomic rename path above. There is no delete-then-retry fallback.
    internal fun write(
        file: File,
        bytes: ByteArray,
        replace: (File, File) -> Boolean,
    ): Boolean {
        val parent = file.parentFile
        if (parent == null || (!parent.isDirectory && !parent.mkdirs())) return false

        val temp = File(parent, file.name + TEMP_SUFFIX)
        return try {
            FileOutputStream(temp, false).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            // Do not replace the last good file with a partial temp file.
            if (!temp.isFile || temp.length() != bytes.size.toLong()) {
                temp.delete()
                return false
            }
            if (!replace(temp, file)) {
                temp.delete()
                return false
            }
            // A rename that succeeds must expose the complete destination. This is the
            // postcondition the caller needs before it reports a completed autosave.
            file.isFile && file.length() == bytes.size.toLong()
        } catch (error: IOException) {
            temp.delete()
            false
        } catch (error: SecurityException) {
            temp.delete()
            false
        }
    }

    fun read(file: File): ByteArray? =
        runCatching {
            // A temp file is an uncommitted write. All callers hold the writer lock, so
            // this temp cannot belong to an in-flight write.
            val temp = File(file.parentFile, file.name + TEMP_SUFFIX)
            temp.delete()
            file.takeIf { it.isFile }?.readBytes()
        }.getOrNull()

    fun delete(file: File): Boolean =
        runCatching {
            val parent = file.parentFile ?: return@runCatching !file.exists()
            if (file.exists() && (!file.isFile || !file.delete())) return@runCatching false
            deleteTemp(parent, file.name)
            !file.exists()
        }.getOrDefault(false)

    fun cleanupTemps(file: File) {
        val parent = file.parentFile ?: return
        deleteTemp(parent, file.name)
    }

    private fun deleteTemp(
        parent: File,
        name: String,
    ) {
        File(parent, name + TEMP_SUFFIX).delete()
    }
}
