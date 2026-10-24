package io.github.saisiddharthbs.openwave

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import java.net.URL
import java.util.concurrent.Executors

/**
 * Keeps OpenWave alive while music plays and connects it to Android: the media notification,
 * lock screen, Bluetooth/headset buttons and "headphones unplugged".
 *
 * Audio focus (calls, other apps) is left to the WebView: it requests focus itself when the page
 * plays and pauses or ducks on loss. Requesting it here as well would steal focus from the
 * WebView and pause every song the moment it starts.
 */
class PlaybackService : Service() {
    private lateinit var session: MediaSessionCompat
    private var noisyRegistered = false
    private val artworkLoader = Executors.newSingleThreadExecutor()
    private var artwork: Pair<String, Bitmap>? = null
    private val onTrack: (NowPlaying?) -> Unit = { update(it) }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        session = MediaSessionCompat(this, "OpenWave").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = Bridge.command("play")
                override fun onPause() = Bridge.command("pause")
                override fun onSkipToNext() = Bridge.command("next")
                override fun onSkipToPrevious() = Bridge.command("prev")
                override fun onStop() = Bridge.command("pause")
                override fun onSeekTo(pos: Long) = Bridge.command("seek", (pos / 1000.0).toString())
                override fun onSetRating(rating: android.support.v4.media.RatingCompat?) = Bridge.command("like")
            })
            setSessionActivity(openAppIntent())
            isActive = true
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(Bridge.track), foregroundType())
        Bridge.observe(onTrack)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        MediaButtonReceiver.handleIntent(session, intent)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping OpenWave away from recents while nothing plays closes it completely.
        if (Bridge.track?.playing != true) stopSelf()
    }

    override fun onDestroy() {
        Bridge.unobserve(onTrack)
        setNoisyReceiver(false)
        session.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ------------------------------------------------------------------ state

    private fun update(t: NowPlaying?) {
        if (t == null) {
            session.setPlaybackState(PlaybackStateCompat.Builder().setState(PlaybackStateCompat.STATE_NONE, 0, 0f).build())
        } else {
            val meta = MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, t.videoId)
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, t.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, t.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, t.album)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (t.duration * 1000).toLong())
            artwork?.takeIf { it.first == t.artwork }?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it.second) }
            session.setMetadata(meta.build())
            session.setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setActions(
                        PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
                            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                            PlaybackStateCompat.ACTION_SEEK_TO or PlaybackStateCompat.ACTION_STOP,
                    )
                    .setState(
                        if (t.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                        (t.position * 1000).toLong(), if (t.playing) 1f else 0f,
                    )
                    .build(),
            )
            if (t.artwork != null && artwork?.first != t.artwork) loadArtwork(t.artwork)
            setNoisyReceiver(t.playing)
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(t))
    }

    private fun loadArtwork(url: String) {
        artworkLoader.execute {
            val bitmap = runCatching { URL(url).openStream().use { BitmapFactory.decodeStream(it) } }.getOrNull() ?: return@execute
            ContextCompat.getMainExecutor(this).execute {
                artwork = url to bitmap
                update(Bridge.track)
            }
        }
    }

    // ------------------------------------------------------------------ notification

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.channel_playback), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.channel_playback_description)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun action(icon: Int, title: String, action: Long) = NotificationCompat.Action(
        icon, title, MediaButtonReceiver.buildMediaButtonPendingIntent(this, action),
    )

    private fun buildNotification(t: NowPlaying?): android.app.Notification {
        val playing = t?.playing == true
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(t?.title ?: "OpenWave")
            .setContentText(t?.artist ?: "Ready to play")
            .setLargeIcon(artwork?.takeIf { it.first == t?.artwork }?.second)
            .setContentIntent(openAppIntent())
            .setDeleteIntent(MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_STOP))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .addAction(action(android.R.drawable.ic_media_previous, "Previous", PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
            .addAction(
                if (playing) action(android.R.drawable.ic_media_pause, "Pause", PlaybackStateCompat.ACTION_PAUSE)
                else action(android.R.drawable.ic_media_play, "Play", PlaybackStateCompat.ACTION_PLAY),
            )
            .addAction(action(android.R.drawable.ic_media_next, "Next", PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
            .setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    private fun foregroundType(): Int =
        if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0

    // ------------------------------------------------------------------ unplugging

    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) Bridge.command("pause")
        }
    }

    private fun setNoisyReceiver(on: Boolean) {
        if (on == noisyRegistered) return
        if (on) ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
        else unregisterReceiver(noisy)
        noisyRegistered = on
    }

    companion object {
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
        }
    }
}
