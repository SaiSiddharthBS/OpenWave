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
    val shuffle: Boolean = false,
    val repeat: String = "off",
    val updatedAt: Long = System.currentTimeMillis(),
)

/** One song in the car's queue screen; `index` is its place in the page's queue. */
data class QueueEntry(val index: Int, val title: String, val subtitle: String, val artwork: String?)

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

    /** What's coming up (for the car), and where the current song is in it. */
    var queue: List<QueueEntry> = emptyList()
        private set
    var queueTitle = ""
        private set
    var queueIndex = -1
        private set
    private val queueListeners = mutableSetOf<() -> Unit>()
    fun observeQueue(listener: () -> Unit) { queueListeners += listener }
    fun unobserveQueue(listener: () -> Unit) { queueListeners -= listener }

    /** Did the last answer say nobody has chosen a profile on this phone yet? */
    var needsProfile = false
        private set

    private val asks = mutableMapOf<Int, (JSONObject?) -> Unit>()
    private var nextAsk = 1

    fun attach(view: WebView) {
        webView = WeakReference(view)
        ready = false
    }

    fun detach(view: WebView) {
        if (webView.get() === view) webView = WeakReference(null)
        ready = false
    }

    /**
     * Asks the page a question for the car (js/car.js): browse a folder, search, or play. `done` runs on
     * the main thread with the answer, or with null if the page doesn't answer in time.
     */
    fun ask(op: String, id: String = "", q: String = "", timeoutMs: Long = 45_000, done: (JSONObject?) -> Unit) {
        main.post {
            val n = nextAsk++
            asks[n] = done
            main.postDelayed({ asks.remove(n)?.invoke(null) }, timeoutMs)
            command("car", JSONObject().put("req", n).put("op", op).put("id", id).put("q", q).toString())
        }
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
                            shuffle = t.optBoolean("shuffle"),
                            repeat = t.optString("repeat", "off"),
                        )
                    }
                    listeners.toList().forEach { it(track) }
                }
                "car" -> {
                    needsProfile = msg.optString("error") == "profile"
                    asks.remove(msg.optInt("req"))?.invoke(msg)
                }
                "queue" -> {
                    val q = msg.optJSONObject("queue") ?: return@post
                    val items = q.optJSONArray("items")
                    queue = (0 until (items?.length() ?: 0)).mapNotNull { i ->
                        items!!.optJSONObject(i)?.let {
                            QueueEntry(it.optInt("i"), it.optString("title"), it.optString("subtitle"), it.optString("art").ifBlank { null })
                        }
                    }
                    queueTitle = q.optString("title")
                    queueIndex = q.optInt("index", -1)
                    queueListeners.toList().forEach { it() }
                }
            }
        }
    }

    /** Runs a player command in the page (queued until the page says it's ready). */
    fun command(name: String, arg: String? = null) {
        // A car's question can hold a search: log only that one was asked.
        android.util.Log.i(Engine.TAG, "command $name${if (name == "car") "" else arg?.let { " $it" } ?: ""}")
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
