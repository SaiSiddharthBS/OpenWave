package io.github.saisiddharthbs.openwave

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import java.io.File
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    companion object {
        /** The live screen (Android can recreate the activity, e.g. when the WebView updates). */
        private var current = WeakReference<MainActivity>(null)
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingLink: String? = null
    @Volatile private var currentUrl: String? = null
    private val io = Executors.newSingleThreadExecutor()

    private val prefs by lazy { getSharedPreferences("openwave", MODE_PRIVATE) }

    /** "" = the engine on this phone; otherwise OpenWave on the user's computer/server. */
    private var serverUrl: String
        get() = prefs.getString("server", "") ?: ""
        set(value) = prefs.edit().putString("server", value).apply()

    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0A0B14"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportZoom(false)
            settings.userAgentString = settings.userAgentString + " OpenWaveAndroid/" + BuildConfig.VERSION_NAME
            addJavascriptInterface(AndroidBridge(), "OpenWaveAndroid")
            webViewClient = Client()
            webChromeClient = Chrome()
        }
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0A0B14"))
            addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        // Keep the page clear of the status and navigation bars (Android 15 draws edge to edge).
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        Bridge.attach(web)
        current = WeakReference(this)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The page decides: close a menu, sheet or the player, or go to the previous screen.
                // On Home (or before the page has loaded) OpenWave steps aside and keeps playing.
                web.evaluateJavascript("window.openwaveNative ? window.openwaveNative.back() : false") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        PlaybackService.start(this)
        pendingLink = linkFrom(intent)
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        boot()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        linkFrom(intent)?.let { openLink(it) }
    }

    // ------------------------------------------------------------------ startup

    private fun boot() {
        val remote = serverUrl
        if (remote.isNotEmpty()) {
            splash("Connecting to OpenWave on your computer…")
            io.execute {
                val ok = reachable(remote)
                runOnUiThread {
                    if (ok) load(remote)
                    else splash("Can’t reach OpenWave at $remote. Make sure it’s running and on the same Wi-Fi.", retry = true, offerLocal = true)
                }
            }
            return
        }
        splash(if (Engine.state == Engine.State.RUNNING) "Loading…" else "Starting OpenWave…")
        Engine.start(applicationContext) { ok ->
            // Android may have recreated the screen while the engine started: talk to the live one.
            val screen = current.get() ?: return@start
            if (screen.serverUrl.isNotEmpty()) return@start
            if (ok) screen.load(Engine.localUrl)
            else screen.splash("OpenWave couldn’t start: ${Engine.error ?: "unknown error"}", retry = true)
        }
    }

    private fun load(base: String) {
        Log.i(Engine.TAG, "loading $base")
        Bridge.pageWillLoad()
        val link = pendingLink
        pendingLink = null
        web.loadUrl(base + (link?.let { route(it) } ?: ""))
    }

    private fun reachable(base: String): Boolean = runCatching {
        (URL(base.trimEnd('/') + "/api/health").openConnection() as HttpURLConnection).run {
            connectTimeout = 4000
            readTimeout = 4000
            responseCode == 200
        }
    }.getOrDefault(false)

    private fun splash(message: String, retry: Boolean = false, offerLocal: Boolean = false) {
        val html = """
            <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
            html,body{height:100%;margin:0;background:#0a0b14;color:#f3f3f6;font:16px system-ui,sans-serif}
            body{display:grid;place-items:center;text-align:center}
            .c{display:flex;flex-direction:column;align-items:center;gap:20px;padding:28px;max-width:420px}
            img{width:180px;filter:drop-shadow(0 10px 36px rgba(79,107,255,.55));animation:b 1.6s ease-in-out infinite}
            @keyframes b{50%{transform:scale(1.05)}}
            p{color:#a4a4b2;margin:0;line-height:1.5}
            a{color:#fff;text-decoration:none;font-weight:650;padding:12px 24px;border-radius:999px;background:linear-gradient(135deg,#2fc8ff,#4f6bff 45%,#c45cff)}
            a.alt{background:none;border:1px solid rgba(255,255,255,.3)}
            </style></head><body><div class="c"><img src="logo.png" alt=""><p>${message.replace("<", "&lt;")}</p>
            ${if (retry) "<a href=\"openwave-app://retry\">Try again</a>" else ""}
            ${if (offerLocal) "<a class=\"alt\" href=\"openwave-app://local\">Use this phone instead</a>" else ""}
            </div></body></html>
        """.trimIndent()
        web.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "utf-8", null)
    }

    // ------------------------------------------------------------------ links shared to OpenWave

    private fun linkFrom(intent: Intent?): String? = when (intent?.action) {
        Intent.ACTION_VIEW -> intent.dataString
        Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { Regex("https?://\\S+").find(it)?.value ?: it }
        else -> null
    }

    /** openwave://play/ID → #/play/ID; a YouTube or Spotify link → search / import. */
    private fun route(link: String): String {
        if (link.startsWith("openwave://")) return "#/" + link.removePrefix("openwave://")
        if ("spotify.com" in link) return "#/library"
        return "#/search?q=" + Uri.encode(link)
    }

    private fun openLink(link: String) {
        val hash = route(link)
        Bridge.command("navigate", hash)
    }

    // ------------------------------------------------------------------ WebView plumbing

    private fun isAppPage(url: Uri): Boolean {
        val base = Uri.parse(serverUrl.ifEmpty { Engine.localUrl })
        return url.scheme == "file" || url.scheme == "blob" || url.scheme == "data" ||
            (url.host == base.host && url.port == base.port)
    }

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            currentUrl = url
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            when {
                url.scheme == "openwave-app" && url.host == "retry" -> boot()
                url.scheme == "openwave-app" && url.host == "local" -> { serverUrl = ""; boot() }
                url.scheme == "openwave" -> openLink(url.toString())
                isAppPage(url) -> return false
                else -> try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                } catch (_: ActivityNotFoundException) { }
            }
            return true
        }

        override fun onPageFinished(view: WebView, url: String?) {
            Log.i(Engine.TAG, "page loaded: ${url?.take(80)}")
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            Log.w(Engine.TAG, "load error ${error.errorCode} ${error.description} for ${request.url}")
            if (request.isForMainFrame && request.url.scheme == "http") {
                splash("Lost connection to OpenWave.", retry = true, offerLocal = serverUrl.isNotEmpty())
            }
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                Log.w(Engine.TAG, "page: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
            }
            return true
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            pickFiles.launch("*/*")
            return true
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
            // target=_blank links: open them in the browser.
            val href = view.hitTestResult.extra ?: return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(href))) }
            return false
        }
    }

    /** Exposed to the page as window.OpenWaveAndroid. Only OpenWave's own pages may use it. */
    private inner class AndroidBridge {
        private fun trusted(): Boolean = currentUrl?.let { isAppPage(Uri.parse(it)) } == true

        @JavascriptInterface
        fun postMessage(json: String) {
            if (trusted()) Bridge.handle(json)
        }

        @JavascriptInterface
        fun getServer(): String = if (trusted()) serverUrl else ""

        /** Point the app at OpenWave on a computer ("" = use this phone). Returns an error message or "". */
        @JavascriptInterface
        fun setServer(url: String): String {
            if (!trusted()) return "not allowed"
            val clean = url.trim().let { if (it.isEmpty() || it.startsWith("http")) it else "http://$it" }
                .let { if (it.isEmpty() || it.endsWith("/")) it else "$it/" }
            if (clean.isNotEmpty() && !reachable(clean)) return "Couldn’t reach OpenWave at $clean"
            serverUrl = clean
            runOnUiThread { boot() }
            return ""
        }

        /** Hands a file (library backup, insights card) to Android's share sheet. */
        @JavascriptInterface
        fun shareFile(name: String, mime: String, base64: String) {
            if (!trusted()) return
            val dir = File(cacheDir, "shared").apply { mkdirs() }
            val file = File(dir, name.replace(Regex("[^\\w.-]"), "_"))
            file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
            val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            runOnUiThread { startActivity(Intent.createChooser(send, name)) }
        }

        @JavascriptInterface
        fun appVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun haptic(kind: String) {
            if (!trusted()) return
            val feedback = when (kind) {
                "long" -> HapticFeedbackConstants.LONG_PRESS
                "tick" -> HapticFeedbackConstants.CLOCK_TICK
                else -> HapticFeedbackConstants.VIRTUAL_KEY
            }
            web.post { web.performHapticFeedback(feedback) }
        }
    }
}
