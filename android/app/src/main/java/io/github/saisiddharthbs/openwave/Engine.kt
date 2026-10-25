package io.github.saisiddharthbs.openwave

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.chaquo.python.Python
import java.util.concurrent.Executors

/**
 * The OpenWave engine (the same Python server the desktop apps run) living inside this app.
 * The app talks to it on 127.0.0.1. Other devices on the Wi-Fi only reach its small "devices"
 * listener (see openwave/link.py), and only once they've been allowed on this phone.
 */
object Engine {
    const val TAG = "OpenWave"
    const val PORT = 47878
    val localUrl = "http://127.0.0.1:$PORT/"

    enum class State { STOPPED, STARTING, RUNNING, FAILED }

    @Volatile var state = State.STOPPED
        private set
    var error: String? = null
        private set

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val waiting = mutableListOf<(Boolean) -> Unit>()

    /** The phone's name as its owner set it ("Sai's Pixel"), else the model. */
    fun deviceName(context: Context): String =
        (if (Build.VERSION.SDK_INT >= 25) Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) else null)
            ?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /** Starts the engine once; [done] runs on the main thread with true when it's ready. */
    fun start(context: Context, done: (Boolean) -> Unit) {
        when (state) {
            State.RUNNING -> return done(true)
            State.STARTING -> { waiting += done; return }
            else -> Unit
        }
        state = State.STARTING
        waiting += done
        val dataDir = context.filesDir.resolve("openwave").apply { mkdirs() }.absolutePath
        worker.execute {
            Log.i(TAG, "starting engine in $dataDir")
            val started = System.currentTimeMillis()
            val ok = try {
                Python.getInstance().getModule("android_main").callAttr("start", dataDir, PORT, "127.0.0.1", deviceName(context))
                true
            } catch (t: Throwable) {
                error = t.message ?: t.toString()
                Log.e(TAG, "engine failed", t)
                false
            }
            Log.i(TAG, "engine ${if (ok) "ready" else "failed"} after ${System.currentTimeMillis() - started} ms")
            state = if (ok) State.RUNNING else State.FAILED
            main.post {
                val callbacks = waiting.toList()
                waiting.clear()
                callbacks.forEach { it(ok) }
            }
        }
    }
}
