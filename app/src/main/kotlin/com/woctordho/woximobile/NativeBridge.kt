package com.woctordho.woximobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream

// JavaScript bridge exposed to the web layer as `window.WoxiNative`.
//
// Notebook text crosses the JS/Java boundary as base64 so that the file bytes arrive in the
// WebView unchanged, whatever they contain.
class NativeBridge(
    private val activity: MainActivity,
) {
    companion object {
        private const val TAG = "Woxi"
    }

    private var webView: WebView? = null
    private var pendingSaveBytes: ByteArray? = null
    private var pendingSaveName: String? = null

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

    // The app uses its own math keyboard (`inputmode="none"` keeps the system IME away).
    // This is a safety net for WebView versions that still raise the IME on focus.
    @JavascriptInterface
    fun hideKeyboard() {
        activity.runOnUiThread {
            val view = activity.currentFocus ?: webView
            if (view == null) return@runOnUiThread
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.hideSoftInputFromWindow(view.windowToken, 0)
        }
    }

    @JavascriptInterface
    fun toast(message: String) {
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

    // documents (Storage Access Framework)

    // @param name suggested file name, e.g. `Untitled.ipynb`
    // @param base64 notebook bytes (UTF-8 JSON, the .ipynb text)
    @JavascriptInterface
    fun saveFile(
        name: String,
        base64: String,
        mime: String,
    ) {
        activity.runOnUiThread {
            pendingSaveBytes = Base64.decode(base64, Base64.DEFAULT)
            pendingSaveName = name
            activity.launchCreateDocument(name)
        }
    }

    @JavascriptInterface
    fun openFile() {
        activity.runOnUiThread { activity.launchOpenDocument("application/x-ipynb+json") }
    }

    fun onSaveResult(uri: Uri?) {
        val bytes = pendingSaveBytes
        val name = pendingSaveName ?: "Untitled.ipynb"
        pendingSaveBytes = null
        pendingSaveName = null
        if (uri == null || bytes == null) {
            callJs("onSaveComplete", "false", name)
            return
        }
        val ok =
            runCatching {
                activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                    ?: error("cannot open output stream")
            }.isSuccess
        callJs("onSaveComplete", if (ok) "true" else "false", displayName(uri) ?: name)
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
                val name = displayName(uri) ?: "Untitled.ipynb"
                callJs("onFileOpened", name, Base64.encodeToString(bytes, Base64.NO_WRAP))
            }.onFailure { error ->
                Log.w(TAG, "open failed", error)
                callJs("onFileOpened", "", "")
                toast("Could not read file: ${error.message}")
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

    @JavascriptInterface
    fun setBackHandlerActive(active: Boolean) {
        activity.runOnUiThread { activity.setBackHandlerActive(active) }
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

    // One plot-interaction message (pan/zoom frame, re-sample, retain, release).
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

    // System-bar insets in pixels, so the web layer can pad the keyboard itself.
    @JavascriptInterface
    fun getInsets(): String =
        JSONObject()
            .apply {
                put("top", activity.insetTopPx)
                put("bottom", activity.insetBottomPx)
            }.toString()

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
