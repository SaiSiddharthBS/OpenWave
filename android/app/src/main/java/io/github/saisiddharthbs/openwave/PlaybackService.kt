package io.github.saisiddharthbs.openwave

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.support.v4.media.MediaBrowserCompat.MediaItem
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.Executors

/**
 * Keeps OpenWave alive while music plays and connects it to Android: the media notification,
 * lock screen, Bluetooth/headset buttons, "headphones unplugged", and Android Auto.
 *
 * In the car, Android Auto draws the screens and this service fills them: four tabs (Home, Mixes,
 * Library, Recent) with folders inside, search, voice ("Hey Google, play … on OpenWave"), the queue
 * and like/shuffle/repeat buttons. The page answers what's in each (js/car.js), so the car shows
 * the same library and mixes as the app. If the car connects while OpenWave isn't open, the page
 * starts without a screen (PageHost).
 *
 * Audio focus (calls, other apps) is left to the WebView: it requests focus itself when the page
 * plays and pauses or ducks on loss. Requesting it here as well would steal focus from the
 * WebView and pause every song the moment it starts.
 */
class PlaybackService : MediaBrowserServiceCompat() {
    private lateinit var session: MediaSessionCompat
    private var noisyRegistered = false
    private var foreground = false
    private val artworkLoader = Executors.newSingleThreadExecutor()
    private var artwork: Pair<String, Bitmap>? = null
    private val onTrack: (NowPlaying?) -> Unit = { update(it) }
    private val onQueue: () -> Unit = { updateQueue() }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        session = MediaSessionCompat(this, "OpenWave").apply {
            setCallback(Controls())
            setSessionActivity(openAppIntent())
            isActive = true
        }
        sessionToken = session.sessionToken
        Bridge.observe(onTrack)
        Bridge.observeQueue(onQueue)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started by the app or a media button (startForegroundService): Android wants the notification now.
        goForeground()
        MediaButtonReceiver.handleIntent(session, intent)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping OpenWave away from recents while nothing plays closes it completely.
        if (Bridge.track?.playing != true) stopSelf()
    }

    override fun onDestroy() {
        Bridge.unobserve(onTrack)
        Bridge.unobserveQueue(onQueue)
        setNoisyReceiver(false)
        session.release()
        PageHost.destroyIfHeadless()
        super.onDestroy()
    }

    private fun goForeground() {
        if (foreground) return
        foreground = runCatching {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(Bridge.track), foregroundType())
            // A car may have started the music with only a connection to this service: make it a started
            // service too, so the music carries on if the car lets go (otherwise Android would end it).
            startService(Intent(this, PlaybackService::class.java))
            true
        }.getOrElse { Log.w(Engine.TAG, "couldn't show the playback notification yet: $it"); false }
    }

    // ------------------------------------------------------------------ controls (notification, headsets, the car)

    /** Runs `then` once the page is up, starting it without a screen if OpenWave isn't open. */
    private fun withPage(then: () -> Unit) {
        PageHost.ensure(this)
        then()
    }

    private inner class Controls : MediaSessionCompat.Callback() {
        override fun onPlay() = withPage { Bridge.command("play") }
        override fun onPause() = Bridge.command("pause")
        override fun onSkipToNext() = withPage { Bridge.command("next") }
        override fun onSkipToPrevious() = withPage { Bridge.command("prev") }
        override fun onStop() = Bridge.command("pause")
        override fun onSeekTo(pos: Long) = Bridge.command("seek", (pos / 1000.0).toString())
        override fun onSetRating(rating: android.support.v4.media.RatingCompat?) = Bridge.command("like")
        override fun onSkipToQueueItem(id: Long) = Bridge.command("jump", id.toString())

        override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
            val id = mediaId ?: return
            loading()
            withPage { Bridge.ask("play", id) { answer -> if (answer == null) failed("OpenWave didn’t start in time. Try again.") } }
        }

        override fun onPlayFromSearch(query: String?, extras: Bundle?) {
            loading()
            withPage { Bridge.ask("play", "voice|" + (query ?: "")) { answer -> if (answer == null) failed("OpenWave didn’t start in time. Try again.") } }
        }

        override fun onCustomAction(action: String?, extras: Bundle?) {
            when (action) {
                ACTION_LIKE -> Bridge.command("like")
                ACTION_SHUFFLE -> Bridge.command("shuffle")
                ACTION_REPEAT -> Bridge.command("repeat")
            }
        }
    }

    /** The car shows a spinner until the song starts. */
    private fun loading() {
        session.setPlaybackState(state(PlaybackStateCompat.STATE_CONNECTING, Bridge.track))
    }

    private fun failed(message: String) {
        if (Bridge.track?.playing == true) return
        session.setPlaybackState(
            PlaybackStateCompat.Builder(state(PlaybackStateCompat.STATE_ERROR, Bridge.track))
                .setErrorMessage(PlaybackStateCompat.ERROR_CODE_APP_ERROR, message).build(),
        )
    }

    // ------------------------------------------------------------------ browsing (Android Auto)

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot {
        if (!trustedCar(clientPackageName, clientUid)) {
            // Anything else may still show what's playing and press play/pause, but not read the library.
            return BrowserRoot(EMPTY_ROOT, null)
        }
        if (rootHints?.getBoolean(BrowserRoot.EXTRA_RECENT) == true) {
            // "Resume" after a restart: Android's media controls and the car offer the last song.
            return BrowserRoot(RECENT_ROOT, null)
        }
        val extras = Bundle().apply {
            putBoolean(CONTENT_STYLE_SUPPORTED, true)
            putBoolean(SEARCH_SUPPORTED, true)
            putInt(BROWSABLE_HINT, GRID)
            putInt(PLAYABLE_HINT, LIST)
        }
        // The car lists the tabs straight away; their insides need the page, so start it now.
        ContextCompat.getMainExecutor(this).execute { PageHost.ensure(this) }
        return BrowserRoot(ROOT, extras)
    }

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaItem>>) {
        when (parentId) {
            EMPTY_ROOT -> return result.sendResult(mutableListOf())
            ROOT -> return result.sendResult(tabs())
            RECENT_ROOT -> return result.sendResult(lastSong())
        }
        result.detach()
        withPage {
            Bridge.ask("browse", parentId) { answer -> result.sendResult(items(answer)) }
        }
    }

    override fun onSearch(query: String, extras: Bundle?, result: Result<MutableList<MediaItem>>) {
        result.detach()
        withPage { Bridge.ask("search", q = query) { answer -> result.sendResult(items(answer)) } }
    }

    /** Android Auto, cars that run Android, Google Assistant, Android's own media controls, this app. */
    private fun trustedCar(pkg: String, uid: Int): Boolean {
        if (uid == Process.myUid() || uid % 100_000 < Process.FIRST_APPLICATION_UID) return true   // this app, or Android itself
        // Apps OpenWave can't see (Android 11+ package visibility) come back as null: only KNOWN_CARS are listed in the manifest's <queries>.
        val owns = packageManager.getPackagesForUid(uid)?.contains(pkg) == true
        if (!owns) return false
        if (pkg in KNOWN_CARS) return true
        val info = runCatching { packageManager.getApplicationInfo(pkg, 0) }.getOrNull() ?: return false
        return info.flags and ApplicationInfo.FLAG_SYSTEM != 0
    }

    private fun tabs(): MutableList<MediaItem> = mutableListOf(
        tab("home", "Home", R.drawable.ic_car_home, GRID, LIST),
        tab("mixes", "Mixes", R.drawable.ic_car_mixes, GRID, GRID),
        tab("library", "Library", R.drawable.ic_car_library, GRID, LIST),
        tab("recent", "Recent", R.drawable.ic_car_recent, LIST, LIST),
    )

    private fun tab(id: String, title: String, icon: Int, browsable: Int, playable: Int): MediaItem {
        val extras = Bundle().apply {
            putInt(BROWSABLE_HINT, browsable)
            putInt(PLAYABLE_HINT, playable)
        }
        val desc = MediaDescriptionCompat.Builder().setMediaId(id).setTitle(title)
            .setIconUri(resourceUri(icon)).setExtras(extras).build()
        return MediaItem(desc, MediaItem.FLAG_BROWSABLE)
    }

    /** android.resource://package/drawable/name: cars read icons by name (a numeric id crashes some). */
    private fun resourceUri(id: Int): Uri = Uri.Builder().scheme("android.resource").authority(resources.getResourcePackageName(id))
        .appendPath(resources.getResourceTypeName(id)).appendPath(resources.getResourceEntryName(id)).build()

    private fun lastSong(): MutableList<MediaItem> {
        val t = Bridge.track ?: return mutableListOf()
        val desc = MediaDescriptionCompat.Builder().setMediaId("resume").setTitle(t.title).setSubtitle(t.artist)
            .setIconUri(CarArt.uri(this, t.artwork)).build()
        return mutableListOf(MediaItem(desc, MediaItem.FLAG_PLAYABLE))
    }

    /** The page's answer (js/car.js) as the car's items. */
    private fun items(answer: JSONObject?): MutableList<MediaItem> {
        if (answer == null) return mutableListOf(message("OpenWave is starting", "Give it a moment, then open this again", "mixes"))
        when (answer.optString("error")) {
            "" -> Unit
            "profile" -> return mutableListOf(message("Choose who’s listening", "Open OpenWave on your phone and pick your profile", "liked"))
            "offline" -> return mutableListOf(message("You’re offline", "Your downloads still play: find them in Library", "downloads"))
            else -> return mutableListOf(message("Couldn’t load this", answer.optString("error"), "mixes"))
        }
        val list = answer.optJSONArray("items") ?: return mutableListOf()
        val items = (0 until list.length()).mapNotNull { list.optJSONObject(it)?.let(::item) }.toMutableList()
        // The first screenful of pictures, drawn now rather than when the car scrolls to them.
        CarArt.prepare(this, items.take(18).mapNotNull { it.description.iconUri }.filter { it.scheme == "content" })
        return items
    }

    private fun item(o: JSONObject): MediaItem {
        val extras = Bundle()
        o.optString("group").takeIf { it.isNotEmpty() }?.let { extras.putString(GROUP_TITLE, it) }
        when (o.optString("style")) {
            "grid" -> extras.putInt(SINGLE_ITEM_HINT, GRID)
            "list" -> extras.putInt(SINGLE_ITEM_HINT, LIST)
        }
        when (o.optString("children")) {
            "list" -> { extras.putInt(BROWSABLE_HINT, GRID); extras.putInt(PLAYABLE_HINT, LIST) }
            "grid" -> { extras.putInt(BROWSABLE_HINT, GRID); extras.putInt(PLAYABLE_HINT, GRID) }
        }
        if (o.optBoolean("downloaded")) extras.putLong(MediaDescriptionCompat.EXTRA_DOWNLOAD_STATUS, MediaDescriptionCompat.STATUS_DOWNLOADED)
        if (o.optBoolean("explicit")) extras.putLong(IS_EXPLICIT, 1L)
        val art = CarArt.uri(this, o.optString("art").ifBlank { null }, o.optString("tile").ifBlank { null },
            o.optString("label").ifBlank { null }, o.optString("tint").ifBlank { null }, o.optBoolean("round"))
        val desc = MediaDescriptionCompat.Builder()
            .setMediaId(o.optString("id"))
            .setTitle(o.optString("title"))
            .setSubtitle(o.optString("subtitle").ifBlank { null })
            .setIconUri(art)
            .setExtras(extras)
            .build()
        return MediaItem(desc, if (o.optBoolean("play")) MediaItem.FLAG_PLAYABLE else MediaItem.FLAG_BROWSABLE)
    }

    private fun message(title: String, subtitle: String, tile: String): MediaItem {
        val desc = MediaDescriptionCompat.Builder().setMediaId("message-hint").setTitle(title).setSubtitle(subtitle)
            .setIconUri(CarArt.uri(this, null, tile)).build()
        return MediaItem(desc, MediaItem.FLAG_BROWSABLE)
    }

    // ------------------------------------------------------------------ state

    private fun state(code: Int, t: NowPlaying?): PlaybackStateCompat {
        val b = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                    PlaybackStateCompat.ACTION_SEEK_TO or PlaybackStateCompat.ACTION_STOP or
                    PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH or
                    PlaybackStateCompat.ACTION_SKIP_TO_QUEUE_ITEM,
            )
            .setState(code, ((t?.position ?: 0.0) * 1000).toLong(), if (code == PlaybackStateCompat.STATE_PLAYING) 1f else 0f)
        if (t != null) {
            b.setActiveQueueItemId(Bridge.queueIndex.toLong())
            b.addCustomAction(ACTION_LIKE, if (t.liked) "Remove from Liked songs" else "Like", if (t.liked) R.drawable.ic_car_heart_fill else R.drawable.ic_car_heart)
            b.addCustomAction(ACTION_SHUFFLE, if (t.shuffle) "Shuffle off" else "Shuffle", if (t.shuffle) R.drawable.ic_car_shuffle_on else R.drawable.ic_car_shuffle)
            b.addCustomAction(ACTION_REPEAT, when (t.repeat) { "all" -> "Repeat one"; "one" -> "Repeat off"; else -> "Repeat" },
                when (t.repeat) { "all" -> R.drawable.ic_car_repeat_on; "one" -> R.drawable.ic_car_repeat_one; else -> R.drawable.ic_car_repeat })
        }
        return b.build()
    }

    private fun update(t: NowPlaying?) {
        if (t == null) {
            session.setPlaybackState(PlaybackStateCompat.Builder().setState(PlaybackStateCompat.STATE_NONE, 0, 0f).build())
        } else {
            val art = CarArt.uri(this, t.artwork)
            val meta = MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, t.videoId)
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, t.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, t.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, t.album)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, t.title)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, t.artist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (t.duration * 1000).toLong())
            art?.let {
                meta.putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, it.toString())
                meta.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, it.toString())
            }
            artwork?.takeIf { it.first == t.artwork }?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it.second) }
            session.setMetadata(meta.build())
            session.setPlaybackState(state(if (t.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, t))
            if (t.artwork != null && artwork?.first != t.artwork) loadArtwork(t.artwork)
            setNoisyReceiver(t.playing)
            if (t.playing) goForeground()
        }
        if (foreground) getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(t))
        PlayerWidget.update(this, t, artwork?.takeIf { it.first == t?.artwork }?.second)
    }

    /** Up next, for the car's queue screen. */
    private fun updateQueue() {
        session.setQueueTitle(Bridge.queueTitle)
        session.setQueue(Bridge.queue.map { q ->
            val desc = MediaDescriptionCompat.Builder().setMediaId("queue/${q.index}").setTitle(q.title).setSubtitle(q.subtitle)
                .setIconUri(CarArt.uri(this, q.artwork)).build()
            MediaSessionCompat.QueueItem(desc, q.index.toLong())
        })
        Bridge.track?.let { update(it) }
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

        private const val ROOT = "root"
        private const val RECENT_ROOT = "recent-root"
        private const val EMPTY_ROOT = "empty"

        private const val ACTION_LIKE = "openwave.like"
        private const val ACTION_SHUFFLE = "openwave.shuffle"
        private const val ACTION_REPEAT = "openwave.repeat"

        // How Android Auto lays things out (developer.android.com/training/cars/media).
        private const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
        private const val SEARCH_SUPPORTED = "android.media.browse.SEARCH_SUPPORTED"
        private const val BROWSABLE_HINT = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
        private const val PLAYABLE_HINT = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
        private const val SINGLE_ITEM_HINT = "android.media.browse.CONTENT_STYLE_SINGLE_ITEM_HINT"
        private const val GROUP_TITLE = "android.media.browse.CONTENT_STYLE_GROUP_TITLE_HINT"
        private const val IS_EXPLICIT = "android.media.IS_EXPLICIT"
        private const val LIST = 1
        private const val GRID = 2

        private val KNOWN_CARS = setOf(
            "com.google.android.projection.gearhead",   // Android Auto
            "com.android.car.media",                     // cars that run Android
            "com.google.android.carassistant",
            "com.google.android.googlequicksearchbox",   // Google Assistant
            "com.android.systemui",                      // Android's media controls
        )

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
        }
    }
}
