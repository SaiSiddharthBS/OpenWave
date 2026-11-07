package io.github.saisiddharthbs.openwave

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Owns the page that plays the music, so it can outlive the screen. Normally MainActivity shows it;
 * when a car starts OpenWave with the phone in a pocket there is no screen, so the page runs on its
 * own ("headless") until the app is opened, and MainActivity then adopts the same page: the music
 * never stops and there is only ever one player.
 */
object PageHost {
    private var view: WebView? = null

    /** The address the page is on, to decide whether it may use window.OpenWaveAndroid. */
    @Volatile var currentUrl: String? = null

    val alive: Boolean get() = view != null

    fun prefs(context: Context) = context.getSharedPreferences("openwave", Context.MODE_PRIVATE)

    /** Is `url` one of OpenWave's own pages (the engine on this phone, or the computer it uses)? */
    fun isAppPage(context: Context, url: Uri): Boolean {
        val p = prefs(context)
        val server = p.getString("server", "") ?: ""
        val connect = p.getBoolean("connect", false)
        val base = Uri.parse(server.ifEmpty { Engine.localUrl })
        if (url.scheme == "file" || url.scheme == "blob" || url.scheme == "data") return true
        if (url.host != base.host || url.port != base.port) return false
        // The phone app sits on a shared website: trust only its own folder of it.
        return !connect || server.isEmpty() || (url.scheme == base.scheme && (url.path ?: "/").startsWith(base.path ?: "/"))
    }

    fun trusted(context: Context): Boolean = currentUrl?.let { isAppPage(context, Uri.parse(it)) } == true

    /** A new page for `context` (the screen, or the app when there's no screen). */
    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context): WebView {
        val web = WebView(MutableContextWrapper(context)).apply {
            setBackgroundColor(Color.parseColor("#0A0B14"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportZoom(false)
            settings.userAgentString = settings.userAgentString + " OpenWaveAndroid/" + BuildConfig.VERSION_NAME
            addJavascriptInterface(PageInterface(context.applicationContext), "OpenWaveAndroid")
        }
        view = web
        Bridge.attach(web)
        return web
    }

    /** The page that's already running, moved onto `screen`; null if there is none. */
    fun adopt(screen: Context): WebView? {
        val web = view ?: return null
        (web.parent as? ViewGroup)?.removeView(web)
        (web.context as MutableContextWrapper).baseContext = screen
        return web
    }

    /** The screen is going away: keep the page (and the music) running without it. */
    fun release(screen: Context) {
        val web = view ?: return
        val wrapper = web.context as MutableContextWrapper
        if (wrapper.baseContext !== screen) return
        (web.parent as? ViewGroup)?.removeView(web)
        wrapper.baseContext = screen.applicationContext
        web.webViewClient = Headless(screen.applicationContext)
        web.webChromeClient = Console
    }

    /** Makes sure a page is running, starting one without a screen if need be (a car asked). */
    fun ensure(context: Context) {
        if (view != null) return
        val app = context.applicationContext
        Log.i(Engine.TAG, "starting OpenWave without a screen")
        val web = create(app)
        web.webViewClient = Headless(app)
        web.webChromeClient = Console
        val p = prefs(app)
        val server = p.getString("server", "") ?: ""
        Bridge.pageWillLoad()
        if (server.isNotEmpty()) {
            web.loadUrl(server)
            return
        }
        Engine.start(app) { ok -> if (ok && view === web) web.loadUrl(Engine.localUrl) }
    }

    /** Frees a page nobody is showing (OpenWave was closed and nothing is playing or connected). */
    fun destroyIfHeadless() {
        val web = view ?: return
        if ((web.context as MutableContextWrapper).baseContext !is android.app.Activity) {
            Log.i(Engine.TAG, "closing the page")
            view = null
            Bridge.detach(web)
            web.destroy()
        }
    }

    private class Headless(private val app: Context) : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) { currentUrl = url }
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !isAppPage(app, request.url)
        override fun onPageFinished(view: WebView, url: String?) { Log.i(Engine.TAG, "page loaded without a screen: ${url?.take(80)}") }
    }

    private object Console : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                Log.w(Engine.TAG, "page: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
            }
            return true
        }
    }
}

/**
 * window.OpenWaveAndroid. It stays with the page for its whole life, so it hands anything that
 * needs the screen (share sheets, pairing, haptics) to MainActivity while it's open.
 */
class PageInterface(private val app: Context) {
    private fun screen() = MainActivity.live()?.bridge
    private fun trusted() = PageHost.trusted(app)

    @JavascriptInterface
    fun postMessage(json: String) { if (trusted()) Bridge.handle(json) }

    @JavascriptInterface
    fun getServer(): String = screen()?.getServer() ?: run {
        val p = PageHost.prefs(app)
        if (trusted() && !p.getBoolean("connect", false)) p.getString("server", "") ?: "" else ""
    }

    @JavascriptInterface
    fun pairedComputer(): Boolean = screen()?.pairedComputer() ?: false

    @JavascriptInterface
    fun useComputer(): String = screen()?.useComputer() ?: "Open OpenWave on your phone first."

    @JavascriptInterface
    fun setServer(url: String): String = screen()?.setServer(url) ?: "Open OpenWave on your phone first."

    @JavascriptInterface
    fun shareFile(name: String, mime: String, base64: String) { screen()?.shareFile(name, mime, base64) }

    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun addWidget(): Boolean = screen()?.addWidget() ?: false

    @JavascriptInterface
    fun shareText(title: String, text: String) { screen()?.shareText(title, text) }

    @JavascriptInterface
    fun deviceName(): String = if (trusted()) Engine.deviceName(app) else ""

    @JavascriptInterface
    fun haptic(kind: String) { screen()?.haptic(kind) }
}
