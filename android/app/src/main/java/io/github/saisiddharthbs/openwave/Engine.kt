package io.github.saisiddharthbs.openwave

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.chaquo.python.Python
import java.util.concurrent.Executors

/**
 * The OpenWave engine (the same Python server the desktop apps run) living inside this app.
 * It listens on 127.0.0.1 only, so nothing outside the phone can reach it.
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
                Python.getInstance().getModule("android_main").callAttr("start", dataDir, PORT)
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
