package io.github.saisiddharthbs.openwave

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.wifi.WifiManager
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

    /** "" = the engine on this phone; otherwise OpenWave on the user's computer/server: its address
     * (same Wi-Fi, Tailscale), or the OpenWave phone app that reaches it from anywhere (connect). */
    private var serverUrl: String
        get() = prefs.getString("server", "") ?: ""
        set(value) = prefs.edit().putString("server", value).apply()

    /** serverUrl is the phone app paired with a computer through Settings → Phones → Add a phone
     * there (openwave/connect.py): its API arrives over an encrypted WebRTC connection, not HTTP. */
    private var connectMode: Boolean
        get() = prefs.getBoolean("connect", false)
        set(value) = prefs.edit().putBoolean("connect", value).apply()

    /** A pairing link to open once, with its code (the part after #connect=). */
    private var pendingPairing: String? = null

    /** The phone app of the last computer this phone paired with, to go back to after "Use this phone". */
    private var lastComputer: String
        get() = prefs.getString("lastConnect", "") ?: ""
        set(value) = prefs.edit().putString("lastConnect", value).apply()

    private var safeTop = 0f
    private var safeBottom = 0f

    private fun tellPageSafeArea() {
        web.evaluateJavascript("(s=>{s.setProperty('--safe-t','${safeTop}px');s.setProperty('--safe-b','${safeBottom}px')})(document.documentElement.style)", null)
    }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Wi-Fi drops broadcast packets to save power; while the app is open, let through the ones
     * other devices send to find OpenWave (Devices → play on this phone, listen together). */
    private val discovery by lazy {
        (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager).createMulticastLock("openwave-devices").apply { setReferenceCounted(false) }
    }

    override fun onStart() {
        super.onStart()
        runCatching { discovery.acquire() }
    }

    override fun onStop() {
        runCatching { discovery.release() }
        super.onStop()
    }

    /** Phones with 90 or 120 Hz screens often hold apps they don't recognise at 60, which looks less fluid than the rest of the phone. */
    private fun useFastestScreenMode() {
        val screen = (if (Build.VERSION.SDK_INT >= 30) display else @Suppress("DEPRECATION") windowManager.defaultDisplay) ?: return
        val now = screen.mode
        val fastest = screen.supportedModes
            .filter { it.physicalWidth == now.physicalWidth && it.physicalHeight == now.physicalHeight }
            .maxByOrNull { it.refreshRate } ?: return
        window.attributes = window.attributes.apply { preferredDisplayModeId = fastest.modeId }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        useFastestScreenMode()

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
        // Edge to edge, as on the iPhone: the page's colour runs behind the status and navigation
        // bars, and the page is told how much room they take (--safe-t, --safe-b in css/app.css).
        // The keyboard still pushes the page up.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            v.updatePadding(left = bars.left, right = bars.right, bottom = keyboard)
            val density = resources.displayMetrics.density
            safeTop = bars.top / density
            safeBottom = if (keyboard > 0) 0f else bars.bottom / density
            tellPageSafeArea()
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
        UpdateCheck.schedule(this)
        pendingLink = linkFrom(intent)
        pendingLink?.let { link -> pairingBase(link)?.let { usePairing(link, it, boot = false); pendingLink = null } }
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        boot()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val link = linkFrom(intent) ?: return
        val base = pairingBase(link)
        if (base != null) usePairing(link, base) else openLink(link)
    }

    // ------------------------------------------------------------------ pairing with a computer

    /** The phone app's address, if `link` is a pairing link from a computer's Add a phone:
     * https://…/OpenWave/app/#connect=… (http only for a computer's own private address, in tests). */
    private fun pairingBase(link: String): String? {
        val uri = runCatching { Uri.parse(link.trim()) }.getOrNull() ?: return null
        if (uri.fragment?.startsWith("connect=") != true || uri.host.isNullOrEmpty()) return null
        val secure = uri.scheme == "https" || (uri.scheme == "http" && privateHost(uri.host!!))
        if (!secure) return null
        val path = (uri.path ?: "/").let { if (it.endsWith("/")) it else it.substringBeforeLast('/') + "/" }
        return uri.buildUpon().path(path).clearQuery().fragment(null).build().toString()
    }

    private fun privateHost(host: String): Boolean =
        Regex("""^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01])|127\.\d+)\.\d+\.\d+$""").matches(host)

    /** Play from the computer that made this pairing link, from anywhere, instead of this phone. */
    private fun usePairing(link: String, base: String, boot: Boolean = true) {
        serverUrl = base
        connectMode = true
        lastComputer = base
        pendingPairing = link.trim()
        if (boot) boot()
    }

    // ------------------------------------------------------------------ startup

    private fun boot() {
        val remote = serverUrl
        if (remote.isNotEmpty() && connectMode) {
            // The phone app works offline too (downloads), and reaches the computer itself.
            Log.i(Engine.TAG, "loading the phone app for a computer")
            Bridge.pageWillLoad()
            val pairing = pendingPairing
            val link = pendingLink
            pendingPairing = null
            pendingLink = null
            web.loadUrl(pairing ?: (remote + (link?.let { route(it) } ?: "")))
            return
        }
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
    }?.takeUnless { "/OpenWave/app" in it && "#connect=" !in it }   // the phone app itself, without a code: just open OpenWave

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
        if (url.scheme == "file" || url.scheme == "blob" || url.scheme == "data") return true
        if (url.host != base.host || url.port != base.port) return false
        // The phone app sits on a shared website: trust only its own folder of it.
        return !connectMode || serverUrl.isEmpty() || (url.scheme == base.scheme && (url.path ?: "/").startsWith(base.path ?: "/"))
    }

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            currentUrl = url
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            when {
                url.scheme == "openwave-app" && url.host == "retry" -> boot()
                url.scheme == "openwave-app" && url.host == "local" -> { serverUrl = ""; connectMode = false; boot() }
                url.scheme == "openwave" -> openLink(url.toString())
                isAppPage(url) -> return false
                else -> try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                } catch (_: ActivityNotFoundException) { }
            }
            return true
        }

        override fun onPageCommitVisible(view: WebView, url: String?) = tellPageSafeArea()

        override fun onPageFinished(view: WebView, url: String?) {
            Log.i(Engine.TAG, "page loaded: ${url?.take(80)}")
            tellPageSafeArea()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            Log.w(Engine.TAG, "load error ${error.errorCode} ${error.description} for ${request.url}")
            if (request.isForMainFrame && (request.url.scheme == "http" || request.url.scheme == "https")) {
                splash(if (connectMode && serverUrl.isNotEmpty()) "Can’t open OpenWave. Check this phone’s internet connection." else "Lost connection to OpenWave.",
                    retry = true, offerLocal = serverUrl.isNotEmpty())
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
        fun getServer(): String = if (trusted() && !connectMode) serverUrl else ""

        /** Is there a computer this phone paired with before (Settings → "Play from your computer")? */
        @JavascriptInterface
        fun pairedComputer(): Boolean = trusted() && lastComputer.isNotEmpty()

        /** Go back to playing from that computer; its phone app reconnects with the key it kept. */
        @JavascriptInterface
        fun useComputer(): String {
            if (!trusted()) return "not allowed"
            val base = lastComputer
            if (base.isEmpty()) return "Pair with a computer first."
            runOnUiThread {
                serverUrl = base
                connectMode = true
                boot()
            }
            return ""
        }

        /** Point the app at OpenWave on a computer ("" = use this phone): its address, or a pairing
         * link from its Settings → Phones → Add a phone. Returns an error message or "". */
        @JavascriptInterface
        fun setServer(url: String): String {
            if (!trusted()) return "not allowed"
            pairingBase(url)?.let { base ->
                runOnUiThread { usePairing(url, base) }
                return ""
            }
            if (url.contains("#connect=")) return "That pairing link isn’t one OpenWave can use. Copy it again from the computer."
            val clean = url.trim().let { if (it.isEmpty() || it.startsWith("http")) it else "http://$it" }
                .let { if (it.isEmpty() || it.endsWith("/")) it else "$it/" }
            if (clean.isNotEmpty() && !reachable(clean)) return "Couldn’t reach OpenWave at $clean"
            connectMode = false
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

        /** Ask the launcher to add the player widget (Android shows its own confirmation). */
        @JavascriptInterface
        fun addWidget(): Boolean {
            if (!trusted() || Build.VERSION.SDK_INT < 26) return false
            val manager = getSystemService(android.appwidget.AppWidgetManager::class.java) ?: return false
            if (!manager.isRequestPinAppWidgetSupported) return false
            return manager.requestPinAppWidget(android.content.ComponentName(this@MainActivity, PlayerWidget::class.java), null, null)
        }

        @JavascriptInterface
        fun shareText(title: String, text: String) {
            if (!trusted()) return
            val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, title)
                .putExtra(Intent.EXTRA_TEXT, text)
            runOnUiThread { startActivity(Intent.createChooser(send, title)) }
        }

        /** The name other devices see for this phone (Devices → play on / listen together). */
        @JavascriptInterface
        fun deviceName(): String = if (trusted()) Engine.deviceName(this@MainActivity) else ""

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
