package io.github.saisiddharthbs.openwave

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.widget.RemoteViews
import androidx.media.session.MediaButtonReceiver

/**
 * Home-screen player: artwork, song and artist, with previous / play-pause / next. The buttons send
 * the same media-button intents as the notification, so the playback service handles them.
 */
class PlayerWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        update(context, Bridge.track, null, keepArt = true)
    }

    companion object {
        private var lastArt: Bitmap? = null

        /** Redraw every OpenWave widget (does nothing when none are placed). `artwork` is the current
         * song's, or null while it loads; keepArt is for system refreshes that don't know the art. */
        fun update(context: Context, track: NowPlaying?, artwork: Bitmap?, keepArt: Boolean = false) {
            try {
                val manager = AppWidgetManager.getInstance(context)
                val ids = manager.getAppWidgetIds(ComponentName(context, PlayerWidget::class.java))
                if (ids.isEmpty()) return
                if (!keepArt) lastArt = artwork?.let(::small)
                manager.updateAppWidget(ids, views(context, track))
            } catch (e: Exception) {
                Log.w(Engine.TAG, "widget update failed", e) // a widget must never break playback
            }
        }

        private fun views(context: Context, t: NowPlaying?) = RemoteViews(context.packageName, R.layout.widget_player).apply {
            setTextViewText(R.id.widget_title, t?.title?.ifBlank { null } ?: context.getString(R.string.app_name))
            setTextViewText(R.id.widget_artist, t?.artist?.ifBlank { null } ?: context.getString(R.string.widget_idle))
            val art = lastArt
            if (t != null && art != null) setImageViewBitmap(R.id.widget_art, art) else setImageViewResource(R.id.widget_art, R.mipmap.ic_launcher)
            setImageViewResource(R.id.widget_play, if (t?.playing == true) R.drawable.ic_widget_pause else R.drawable.ic_widget_play)
            setOnClickPendingIntent(R.id.widget_prev, MediaButtonReceiver.buildMediaButtonPendingIntent(context, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
            setOnClickPendingIntent(R.id.widget_play, MediaButtonReceiver.buildMediaButtonPendingIntent(context, PlaybackStateCompat.ACTION_PLAY_PAUSE))
            setOnClickPendingIntent(R.id.widget_next, MediaButtonReceiver.buildMediaButtonPendingIntent(context, PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
            setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(
                context, 1, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ))
        }

        /** Widgets travel between processes in a size-limited parcel, so keep artwork small. */
        private fun small(b: Bitmap): Bitmap {
            val max = 240
            if (b.width <= max && b.height <= max) return b
            val scale = max.toFloat() / maxOf(b.width, b.height)
            return Bitmap.createScaledBitmap(b, (b.width * scale).toInt(), (b.height * scale).toInt(), true)
        }
    }
}
