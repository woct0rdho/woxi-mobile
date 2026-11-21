package com.woctordho.woximobile

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

// JavaScript bridge exposed to the web layer as `window.WoxiNative`.
//
// Notebook text crosses the JS/Java boundary as a UTF-8 string. Files live in app-private
// storage. The Storage Access Framework is only the import/export boundary. The notebook
// files themselves are owned by NotebookFiles, which runs every mutation and read on one
// thread.
class NativeBridge(
    private val activity: MainActivity,
) {
    companion object {
        private const val TAG = "Woxi"
        private const val PREFS_FILES = "woxi-files"
        private const val NOTEBOOK_DIR = "notebooks"
    }

    private class PendingExport(
        val bytes: ByteArray,
        val name: String,
        val pageToken: String,
    )

    @Volatile
    private var webView: WebView? = null

    @Volatile
    private var pendingExport: PendingExport? = null

    // The file picker can outlive the page that opened it. Keep its token so the result
    // can be ignored by a replacement page.
    @Volatile
    private var pendingOpenToken: String? = null

    // This token gates engine work and picker callbacks. Notebook file ordering has its
    // own token inside NotebookFiles.
    @Volatile
    private var activePageToken: String? = null

    private val files by lazy {
        NotebookFiles(
            File(activity.filesDir, NOTEBOOK_DIR),
            activity.getSharedPreferences(PREFS_FILES, Context.MODE_PRIVATE),
        ) { function, args ->
            callJs(function, *args.toTypedArray())
        }
    }

    fun attach(view: WebView) {
        webView = view
        val token = "attached-" + System.nanoTime()
        NativeEngine.beginPage(token)
        activePageToken = token
        view.addJavascriptInterface(this, "WoxiNative")
    }

    private fun pageIsActive(pageToken: String) = activePageToken == pageToken

    // logging / ui

    @JavascriptInterface
    fun log(message: String) {
        // Log.d is filtered out for third-party apps on some OEM ROMs.
        Log.w(TAG, "web: $message")
    }

    @JavascriptInterface
    fun focusWebView() {
        activity.runOnUiThread {
            webView?.requestFocus()
        }
    }

    @JavascriptInterface
    fun testReady() {
        activity.onTestPageReady()
    }

    // A renderer restart creates a new page. It becomes the only page allowed to submit
    // mutations. Late calls from the previous page are rejected.
    @JavascriptInterface
    fun beginPage(pageToken: String) {
        NativeEngine.beginPage(pageToken)
        activePageToken = pageToken
        pendingOpenToken = null
        pendingExport = null
        files.beginPage(pageToken)
    }

    // Records the file the UI is showing, even when opening it did not write anything.
    @JavascriptInterface
    fun setCurrentNotebook(
        name: String,
        pageToken: String,
    ) {
        files.setCurrent(name, pageToken)
    }

    // clipboard

    @JavascriptInterface
    fun setClipboard(text: String) {
        val clipboard =
            activity.getSystemService(Context.CLIPBOARD_SERVICE)
                as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Woxi", text))
    }

    @JavascriptInterface
    fun getClipboard(): String {
        val clipboard =
            activity.getSystemService(Context.CLIPBOARD_SERVICE)
                as android.content.ClipboardManager
        val clip = clipboard.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(activity).toString()
    }

    // app-private notebook files

    @JavascriptInterface
    fun autosave(
        name: String,
        text: String,
        revision: String,
        pageToken: String,
    ) {
        files.autosave(name, text, revision, pageToken)
    }

    @JavascriptInterface
    fun flushAutosave() {
        files.flush()
    }

    @JavascriptInterface
    fun nextNotebookName(base: String): String = files.nextName(base)

    @JavascriptInterface
    fun loadLastNotebook(): String = files.loadLast()

    @JavascriptInterface
    fun readNotebook(name: String): String = files.read(name)

    @JavascriptInterface
    fun listNotebooks(): String = files.list()

    // Rename and delete are single commands on the notebook actor. The file work and the
    // callbacks happen there. This bridge method does not touch notebook state.
    @JavascriptInterface
    fun renameNotebook(
        oldName: String,
        newName: String,
        text: String,
        pageToken: String,
    ) {
        files.rename(oldName, newName, text, pageToken)
    }

    @JavascriptInterface
    fun deleteNotebook(
        name: String,
        pageToken: String,
    ) {
        files.delete(name, pageToken)
    }

    // Storage Access Framework import/export

    @JavascriptInterface
    fun exportFile(
        name: String,
        text: String,
        pageToken: String,
    ) {
        if (!pageIsActive(pageToken)) return
        val bytes = text.toByteArray(Charsets.UTF_8)
        activity.runOnUiThread {
            if (!pageIsActive(pageToken)) return@runOnUiThread
            pendingExport = PendingExport(bytes, name, pageToken)
            activity.launchCreateNotebook(name)
        }
    }

    @JavascriptInterface
    fun openFile(pageToken: String) {
        if (!pageIsActive(pageToken)) return
        activity.runOnUiThread {
            if (!pageIsActive(pageToken)) return@runOnUiThread
            pendingOpenToken = pageToken
            activity.launchOpenNotebook()
        }
    }

    fun onSaveResult(uri: Uri?) {
        val pending = pendingExport
        pendingExport = null
        if (uri == null || pending == null) {
            callJs(
                "onSaveComplete",
                "false",
                pending?.name ?: NotebookFiles.FALLBACK_NAME,
                pending?.pageToken ?: "",
            )
            return
        }
        thread(name = "woxi-export") {
            val ok =
                try {
                    activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(pending.bytes) }
                        ?: error("cannot open output stream")
                    true
                } catch (error: Exception) {
                    Log.w(TAG, "export failed", error)
                    false
                }
            val display = displayName(uri) ?: pending.name
            activity.runOnUiThread {
                callJs("onSaveComplete", if (ok) "true" else "false", display, pending.pageToken)
            }
        }
    }

    fun onOpenResult(uri: Uri?) {
        val pageToken = pendingOpenToken ?: ""
        pendingOpenToken = null
        if (uri == null) {
            callJs("onFileOpened", "", "", pageToken)
            return
        }
        thread(name = "woxi-open") {
            try {
                val input = activity.contentResolver.openInputStream(uri) ?: error("cannot open input stream")
                val bytes = input.use { stream -> stream.readBytes() }
                val name = displayName(uri) ?: NotebookFiles.FALLBACK_NAME
                callJs("onFileOpened", name, String(bytes, Charsets.UTF_8), pageToken)
            } catch (error: Exception) {
                Log.w(TAG, "open failed", error)
                callJs(
                    "onFileOpened",
                    "",
                    "",
                    pageToken,
                    "Could not read file: ${error.message}",
                )
            }
        }
    }

    private fun displayName(uri: Uri): String? =
        runCatching {
            activity.contentResolver
                .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }
        }.getOrNull()

    // window / system

    @JavascriptInterface
    fun setTheme(theme: String) {
        activity.runOnUiThread { activity.applyTheme(theme) }
    }

    @JavascriptInterface
    fun engineRequest(
        id: Int,
        kind: String,
        input: String,
        body: String,
        bindings: String,
        pageToken: String,
    ) {
        if (!pageIsActive(pageToken)) return
        NativeEngine.request(kind, input, body, bindings, pageToken) { json ->
            callJs("onEngineResult", id.toString(), json, pageToken)
        }
    }

    @JavascriptInterface
    fun plotRequest(
        id: Int,
        request: String,
        pageToken: String,
    ) {
        if (!pageIsActive(pageToken)) return
        NativeEngine.plotRequest(request, pageToken) { json ->
            callJs("onEngineResult", id.toString(), json, pageToken)
        }
    }

    @JavascriptInterface
    fun queryRequest(
        id: Int,
        request: String,
        pageToken: String,
    ) {
        if (!pageIsActive(pageToken)) return
        NativeEngine.query(request, pageToken) { json ->
            callJs("onEngineResult", id.toString(), json, pageToken)
        }
    }

    // helpers

    private fun callJs(
        function: String,
        vararg args: String,
    ) {
        val view = webView ?: return
        val argList = args.joinToString(",") { JSONObject.quote(it) }
        val script = "window.WoxiNativeCallbacks && window.WoxiNativeCallbacks.$function($argList);"
        runCatching {
            view.post {
                runCatching { view.evaluateJavascript(script, null) }
            }
        }
    }
}
