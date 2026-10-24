package io.github.saisiddharthbs.openwave

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference

/** What's playing, as reported by the page. */
data class NowPlaying(
    val videoId: String,
    val title: String,
    val artist: String,
    val album: String,
    val artwork: String?,
    val duration: Double,
    val position: Double,
    val playing: Boolean,
    val liked: Boolean,
    val updatedAt: Long = System.currentTimeMillis(),
)

/**
 * Two-way link between the page's player and Android: the page posts "nowPlaying" messages,
 * and Android sends commands (play, pause, next…) from the notification, lock screen and headsets.
 */
object Bridge {
    private val main = Handler(Looper.getMainLooper())
    private var webView = WeakReference<WebView>(null)
    private var ready = false
    private val pending = mutableListOf<Pair<String, String?>>()
    private val listeners = mutableSetOf<(NowPlaying?) -> Unit>()

    var track: NowPlaying? = null
        private set

    fun attach(view: WebView) {
        webView = WeakReference(view)
        ready = false
    }

    fun pageWillLoad() { ready = false }

    fun observe(listener: (NowPlaying?) -> Unit) { listeners += listener; listener(track) }
    fun unobserve(listener: (NowPlaying?) -> Unit) { listeners -= listener }

    /** Called (on a binder thread) by the page through window.OpenWaveAndroid.postMessage. */
    fun handle(json: String) {
        val msg = runCatching { JSONObject(json) }.getOrNull() ?: return
        main.post {
            when (msg.optString("type")) {
                "ready" -> {
                    ready = true
                    val queued = pending.toList()
                    pending.clear()
                    queued.forEach { (name, arg) -> command(name, arg) }
                }
                "nowPlaying" -> {
                    track = msg.optJSONObject("track")?.let { t ->
                        NowPlaying(
                            videoId = t.optString("videoId"),
                            title = t.optString("title"),
                            artist = t.optString("artist"),
                            album = t.optString("album"),
                            artwork = t.optString("artwork").ifBlank { null },
                            duration = t.optDouble("duration", 0.0),
                            position = t.optDouble("position", 0.0),
                            playing = t.optBoolean("playing"),
                            liked = t.optBoolean("liked"),
                        )
                    }
                    listeners.toList().forEach { it(track) }
                }
            }
        }
    }

    /** Runs a player command in the page (queued until the page says it's ready). */
    fun command(name: String, arg: String? = null) {
        android.util.Log.i(Engine.TAG, "command $name${arg?.let { " $it" } ?: ""}")
        main.post {
            val view = webView.get()
            if (!ready || view == null) {
                pending += name to arg
                return@post
            }
            val argJs = arg?.let { ", " + JSONObject.quote(it) } ?: ""
            view.evaluateJavascript("window.openwaveNative && window.openwaveNative.command(${JSONObject.quote(name)}$argJs)", null)
        }
    }
}
