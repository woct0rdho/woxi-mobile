package com.woctordho.woximobile

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

// Single-activity WebView shell.
//
// The whole experience (engine + notebook UI + keyboard + plots) lives in
// `assets/www`. Assets are served over a local HTTPS origin via [WebViewAssetLoader] so that
// web workers, `fetch`, WebGL and storage behave exactly like a normal secure web origin
// (a `file://` origin would break worker creation and storage APIs).
class MainActivity : ComponentActivity() {
    companion object {
        private const val TAG = "Woxi"
        const val ORIGIN = "https://woxi.local"
        const val APP_URL = "$ORIGIN/assets/www/index.html"
        const val NOTEBOOK_MIME = "application/x-ipynb+json"
        private const val LOAD_RETRY_MS = 5000L
        private const val MAX_LOAD_ATTEMPTS = 4
    }

    private lateinit var webView: WebView
    private lateinit var container: FrameLayout
    private val bridge = NativeBridge(this)

    private var backHandlerActive = false
    private var pageLoaded = false
    private var loadAttempts = 0

    // Current system-bar insets in pixels. The web layer reads these via the bridge.
    var insetTopPx = 0
        private set
    var insetBottomPx = 0
        private set

    private val createDocumentLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument(NOTEBOOK_MIME)) { uri ->
            bridge.onSaveResult(uri)
        }

    private val openDocumentLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            bridge.onOpenResult(uri)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        createWebView()
        bridge.attach(webView)
        // The notebook is persisted in the web layer (localStorage), so a fresh load is
        // enough to restore the session reliably, even after process death.
        loadApp()
        setupBackHandling()
        handleTestIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleTestIntent(intent)
    }

    // Automation hook used during development: `adb shell am start -n
    // com.woctordho.woximobile/.MainActivity --es woxi_action save` runs the matching
    // action in the web layer. Harmless in normal use (no extra -> no-op).
    private fun handleTestIntent(intent: Intent?) {
        val action = intent?.getStringExtra("woxi_action") ?: return
        val argument = intent.getStringExtra("woxi_arg") ?: ""
        val script =
            "window.WoxiApp && WoxiApp.testAction(" + JSONObject.quote(action) +
                "," + JSONObject.quote(argument) + ")"
        Log.w(TAG, "test action: $action $argument")
        webView.postDelayed({ webView.evaluateJavascript(script, null) }, 1200)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        // A WebView ignores View padding when it renders its content, so the
        // system-bar insets are applied to a plain container view instead.
        val root = FrameLayout(this)
        val wv = WebView(this)
        root.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        wv.setBackgroundColor(0xFF14161A.toInt())
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // All gestures (pan/zoom/rotate on plots) are handled by the web layer.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        val assetLoader =
            WebViewAssetLoader
                .Builder()
                .setDomain("woxi.local")
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
                .build()

        wv.webViewClient =
            object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageStarted(
                    view: WebView,
                    url: String,
                    favicon: android.graphics.Bitmap?,
                ) {
                    Log.w(TAG, "page started: " + url)
                }

                override fun onPageFinished(
                    view: WebView,
                    url: String,
                ) {
                    Log.w(TAG, "page finished: " + url)
                    pageLoaded = true
                    // The page can now receive the insets it needs for the keyboard padding.
                    pushInsetsToWeb()
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: android.webkit.WebResourceError,
                ) {
                    Log.w(
                        TAG,
                        "resource error: " + request.url + " main=" + request.isForMainFrame +
                            " " + error.errorCode + " " + error.description,
                    )
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    response: WebResourceResponse,
                ) {
                    Log.w(TAG, "http error: " + request.url + " " + response.statusCode)
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: android.webkit.RenderProcessGoneDetail,
                ): Boolean {
                    Log.w(TAG, "WebView renderer gone (crashed=" + detail.didCrash() + ")")
                    recreateWebView()
                    loadApp()
                    return true
                }
            }

        wv.webChromeClient =
            object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    Log.w(TAG, "console: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                    return true
                }
            }

        // Edge-to-edge: keep content clear of the status bar and cutouts. The bottom
        // inset is not applied here - the keyboard extends behind the navigation bar
        // and insets its own content via the --woxi-inset-bottom CSS variable, so no blank
        // strip appears between the keyboard and the system buttons.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars =
                insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
                )
            v.setPadding(bars.left, bars.top, bars.right, 0)
            insetTopPx = bars.top
            insetBottomPx = bars.bottom
            pushInsetsToWeb()
            insets
        }

        container = root
        webView = wv
        setContentView(root)
    }

    private fun loadApp() {
        // A cache-busting query keeps Chromium from reusing a stale cached entry for
        // the notebook page.
        loadAttempts = 0
        pageLoaded = false
        loadWithRetries()
    }

    // On some ROMs the WebView's renderer process never starts, so no load ever reports
    // back (the platform refuses to spawn it again for this app uid, which only a reboot
    // or a reinstall clears). Reload a few times in case the renderer is merely slow,
    // and otherwise say what is wrong instead of showing an empty window.
    private fun loadWithRetries() {
        if (loadAttempts >= MAX_LOAD_ATTEMPTS) {
            Log.w(TAG, "giving up after $MAX_LOAD_ATTEMPTS load attempts")
            showStartupProblem()
            return
        }
        Log.w(TAG, "load attempt ${loadAttempts + 1}/$MAX_LOAD_ATTEMPTS")
        webView.loadUrl(APP_URL + "?t=" + System.currentTimeMillis() + "&r=" + loadAttempts)
        loadAttempts++
        webView.postDelayed({ if (!pageLoaded) loadWithRetries() }, LOAD_RETRY_MS)
    }

    // Replaces a dead WebView (see [WebViewClient.onRenderProcessGone]).
    private fun recreateWebView() {
        runCatching {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        createWebView()
        bridge.attach(webView)
    }

    private fun showStartupProblem() {
        val message =
            android.widget.TextView(this).apply {
                setPadding(48, 120, 48, 48)
                textSize = 16f
                setTextColor(0xFFE6E9EE.toInt())
                setBackgroundColor(0xFF14161A.toInt())
                text = getString(R.string.startup_failed)
            }
        setContentView(message)
    }

    private fun setupBackHandling() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (backHandlerActive) {
                        // Web layer owns back (open panel / fullscreen plot / menu).
                        webView.evaluateJavascript("window.WoxiApp && window.WoxiApp.onNativeBack()", null)
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
    }

    // services used by NativeBridge

    // Hands the current insets to the web layer (window.WoxiNativeCallbacks.onInsets).
    fun pushInsetsToWeb() {
        if (!::webView.isInitialized) return
        val script =
            "window.WoxiNativeCallbacks && WoxiNativeCallbacks.onInsets && " +
                "WoxiNativeCallbacks.onInsets($insetTopPx,$insetBottomPx)"
        webView.post { webView.evaluateJavascript(script, null) }
    }

    fun setBackHandlerActive(active: Boolean) {
        backHandlerActive = active
    }

    // Applies the resolved theme ('light' | 'dark') to everything outside the web layer:
    // window background (visible before the page paints), system-bar icon contrast, and
    // the interpreter's typesetting colours.
    fun applyTheme(theme: String) {
        val dark = theme != "light"
        val background = if (dark) 0xFF1E1E1E.toInt() else 0xFFECECEC.toInt()
        runCatching { container.setBackgroundColor(background) }
        runCatching { window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(background)) }
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        runCatching {
            controller.isAppearanceLightStatusBars = !dark
            controller.isAppearanceLightNavigationBars = !dark
        }
        NativeEngine.setDark(dark)
    }

    fun launchCreateDocument(name: String) {
        createDocumentLauncher.launch(name)
    }

    fun launchOpenDocument(mime: String) {
        openDocumentLauncher.launch(arrayOf(NOTEBOOK_MIME, mime, "application/json", "text/plain", "*/*"))
    }
}
