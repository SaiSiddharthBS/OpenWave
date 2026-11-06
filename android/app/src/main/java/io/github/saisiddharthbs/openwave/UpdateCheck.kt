package io.github.saisiddharthbs.openwave

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Looks for a new OpenWave twice a day, even when the app is closed, and puts up one notification
 * for each new version. Tapping it downloads the update, as the Update button in the app does.
 */
class UpdateCheck : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            runCatching { check(this) }.onFailure { Log.i(Engine.TAG, "update check: ${it.message}") }
            jobFinished(params, false)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val JOB_ID = 4701
        private const val NOTIFICATION_ID = 4702
        private const val CHANNEL_ID = "updates"
        private const val PREFS = "updates"
        private const val TOLD = "told"
        private const val APK = "OpenWave-Android.apk"
        private const val UPDATE_APK = "OpenWave-Android-update.apk"   // only for updates, so the Stats page counts only installs
        private const val LATEST = "https://api.github.com/repos/SaiSiddharthBS/OpenWave/releases/latest"

        fun schedule(context: Context) {
            val jobs = context.getSystemService(JobScheduler::class.java)
            if (jobs.getPendingJob(JOB_ID) != null) return
            jobs.schedule(
                JobInfo.Builder(JOB_ID, ComponentName(context, UpdateCheck::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(TimeUnit.HOURS.toMillis(12))
                    .setPersisted(true)
                    .build(),
            )
        }

        fun isNewer(candidate: String, current: String): Boolean {
            val a = candidate.split('.').map { it.toIntOrNull() ?: 0 }
            val b = current.split('.').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(a.size, b.size)) {
                val x = a.getOrElse(i) { 0 }
                val y = b.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }

        private fun check(context: Context) {
            val release = fetchLatest()
            val version = release.getString("tag_name").trimStart('v', 'V')
            val assets = release.getJSONArray("assets")
            val files = (0 until assets.length()).map { assets.getJSONObject(it) }
            // Releases before 0.5.8 have no update copy: those use the normal file.
            val apk = (files.firstOrNull { it.optString("name") == UPDATE_APK } ?: files.firstOrNull { it.optString("name") == APK })
                ?.getString("browser_download_url") ?: return
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!isNewer(version, BuildConfig.VERSION_NAME) || prefs.getString(TOLD, null) == version) return
            notify(context, version, apk)
            prefs.edit().putString(TOLD, version).apply()
        }

        private fun fetchLatest(): JSONObject {
            val c = URL(LATEST).openConnection() as HttpURLConnection
            try {
                c.connectTimeout = 15000
                c.readTimeout = 15000
                c.setRequestProperty("Accept", "application/vnd.github+json")
                c.setRequestProperty("User-Agent", "OpenWave-Android")
                return JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            } finally {
                c.disconnect()
            }
        }

        private fun notify(context: Context, version: String, apk: String) {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Updates", NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
            val tap = PendingIntent.getActivity(
                context, 0, Intent(Intent.ACTION_VIEW, Uri.parse(apk)),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            manager.notify(
                NOTIFICATION_ID,
                NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("OpenWave $version is available")
                    .setContentText("Tap to download the update.")
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }
}
