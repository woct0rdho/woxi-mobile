package com.woctordho.woximobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

// JavaScript bridge exposed to the web layer as `window.WoxiNative`.
//
// Notebook text crosses the JS/Java boundary as base64 so that the file bytes arrive in the
// WebView unchanged, whatever they contain.
class NativeBridge(
    private val activity: MainActivity,
) {
    companion object {
        private const val TAG = "Woxi"
        private const val PREFS_NOTEBOOK_URI = "notebook_uri"
    }

    private class PendingSave(
        val bytes: ByteArray,
        val name: String,
    )

    @Volatile
    private var webView: WebView? = null

    private var pendingSave: PendingSave? = null

    @Volatile
    private var notebookUri: Uri? = null
    private val prefs by lazy { activity.getSharedPreferences("woxi-files", Context.MODE_PRIVATE) }

    fun attach(view: WebView) {
        webView = view
        view.addJavascriptInterface(this, "WoxiNative")
    }

    // logging / ui

    @JavascriptInterface
    fun log(message: String) {
        // Log.d is filtered out for third-party apps on some OEM ROMs.
        Log.w(TAG, "web: $message")
    }

    // The window focus, not a DOM element's: a WebView takes it only when a finger lands
    // in it, and a text caret is drawn only for a focused window. A notebook that has just
    // opened, or one whose sheet, menu or file picker was closed, has a focused textarea
    // (the DOM's `activeElement`) but no caret until this asks for the window again.
    @JavascriptInterface
    fun focusWebView() {
        activity.runOnUiThread {
            webView?.requestFocus()
        }
    }

    // The page has finished booting: the automation actions that arrived while it was loading
    // can run (see MainActivity.handleTestIntent).
    @JavascriptInterface
    fun testReady() {
        activity.onTestPageReady()
    }

    private fun showToast(message: String) {
        activity.runOnUiThread {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }

    // clipboard

    // Used by the action bar's Copy/Cut keys.
    @JavascriptInterface
    fun setClipboard(text: String) {
        val clipboard =
            activity.getSystemService(Context.CLIPBOARD_SERVICE)
                as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Woxi", text))
    }

    // Returns the clipboard's text ("" when it holds something else). Used by Paste.
    @JavascriptInterface
    fun getClipboard(): String {
        val clipboard =
            activity.getSystemService(Context.CLIPBOARD_SERVICE)
                as android.content.ClipboardManager
        val clip = clipboard.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(activity).toString()
    }

    // notebook files (Storage Access Framework)

    // @param name suggested file name, e.g. `Untitled.ipynb`
    // @param base64 notebook bytes (UTF-8 JSON, the .ipynb text)
    @JavascriptInterface
    fun saveFile(
        name: String,
        base64: String,
    ) {
        val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return
        val uri = currentNotebookUri()
        if (uri == null) {
            saveViaPicker(name, bytes)
            return
        }
        writeNotebook(uri, bytes, name)
    }

    // Save as always asks for a new document, even when a notebook is already open.
    @JavascriptInterface
    fun saveFileAs(
        name: String,
        base64: String,
    ) {
        val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return
        saveViaPicker(name, bytes)
    }

    private fun saveViaPicker(
        name: String,
        bytes: ByteArray,
    ) {
        activity.runOnUiThread {
            pendingSave = PendingSave(bytes, name)
            activity.launchCreateNotebook(name)
        }
    }

    @JavascriptInterface
    fun clearNotebookFile() {
        notebookUri = null
        prefs.edit().remove(PREFS_NOTEBOOK_URI).apply()
    }

    @JavascriptInterface
    fun openFile() {
        activity.runOnUiThread { activity.launchOpenNotebook() }
    }

    fun onSaveResult(uri: Uri?) {
        val pending = pendingSave
        pendingSave = null
        if (uri == null || pending == null) {
            callJs("onSaveComplete", "false", pending?.name ?: "Untitled.ipynb")
            return
        }
        writeNotebook(uri, pending.bytes, pending.name)
    }

    // Writes on a worker thread: the notebook is small, but a provider can block for
    // longer than the UI should. The callback and the remembered URI go back to the UI
    // thread.
    private fun writeNotebook(
        uri: Uri,
        bytes: ByteArray,
        name: String,
    ) {
        thread(name = "woxi-save") {
            val ok =
                runCatching {
                    activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                        ?: error("cannot open output stream")
                }.isSuccess
            val display = displayName(uri) ?: name
            activity.runOnUiThread {
                if (ok) rememberNotebookUri(uri)
                callJs("onSaveComplete", if (ok) "true" else "false", display)
            }
        }
    }

    private fun currentNotebookUri(): Uri? {
        notebookUri?.let { return it }
        val stored = prefs.getString(PREFS_NOTEBOOK_URI, null) ?: return null
        return runCatching { Uri.parse(stored) }.getOrNull()?.also { notebookUri = it }
    }

    private fun rememberNotebookUri(uri: Uri) {
        notebookUri = uri
        prefs.edit().putString(PREFS_NOTEBOOK_URI, uri.toString()).apply()
        persistUriPermission(uri)
    }

    // A document picked through SAF is usable again after a restart only if its grant is
    // persisted. Try the combined grant first. Some providers grant only one direction.
    private fun persistUriPermission(uri: Uri) {
        val flags =
            listOf(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        for (flag in flags) {
            if (runCatching { activity.contentResolver.takePersistableUriPermission(uri, flag) }.isSuccess) {
                return
            }
        }
    }

    fun onOpenResult(uri: Uri?) {
        if (uri == null) {
            callJs("onFileOpened", "", "")
            return
        }
        val result =
            runCatching {
                val input = activity.contentResolver.openInputStream(uri) ?: error("cannot open input stream")
                val buffer = ByteArrayOutputStream()
                input.use { stream -> stream.copyTo(buffer) }
                buffer.toByteArray()
            }
        result
            .onSuccess { bytes ->
                rememberNotebookUri(uri)
                val name = displayName(uri) ?: "Untitled.ipynb"
                callJs("onFileOpened", name, Base64.encodeToString(bytes, Base64.NO_WRAP))
            }.onFailure { error ->
                Log.w(TAG, "open failed", error)
                callJs("onFileOpened", "", "")
                showToast("Could not read file: ${error.message}")
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

    // Applies the resolved theme ('light' | 'dark') to the shell and the interpreter.
    @JavascriptInterface
    fun setTheme(theme: String) {
        activity.runOnUiThread { activity.applyTheme(theme) }
    }

    // Evaluates a notebook entry (or re-renders a Manipulate) and answers with the
    // interpreter's JSON output items via `WoxiNativeCallbacks.onEngineResult(id, json)`.
    // Work happens on the engine thread, so the UI is not blocked.
    @JavascriptInterface
    fun engineRequest(
        id: Int,
        kind: String,
        input: String,
        body: String,
        bindings: String,
    ) {
        NativeEngine.request(kind, input, body, bindings) { json ->
            callJs("onEngineResult", id.toString(), json)
        }
    }

    // One plot-interaction message (pan/zoom frame, re-sample, release).
    // Replies through the same callback channel as `engineRequest`.
    @JavascriptInterface
    fun plotRequest(
        id: Int,
        request: String,
    ) {
        NativeEngine.plotRequest(request) { json ->
            callJs("onEngineResult", id.toString(), json)
        }
    }

    // Typing help: completion, inspection, completeness, diagnostics, prototypes, definitions,
    // formatting and the catalog. Same reply envelope as the plot messages.
    @JavascriptInterface
    fun queryRequest(
        id: Int,
        request: String,
    ) {
        NativeEngine.query(request) { json ->
            callJs("onEngineResult", id.toString(), json)
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
        view.post { view.evaluateJavascript(script, null) }
    }
}
