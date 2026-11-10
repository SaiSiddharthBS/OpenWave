package io.github.saisiddharthbs.openwave

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.cos
import kotlin.math.sin

/**
 * Pictures for the car. Android Auto only shows artwork it can read from the phone itself
 * (content:// addresses), so each picture gets one here, and is fetched and drawn when the car
 * first asks for it. Besides covers this draws what the app draws: Daily Mix covers with their
 * colour and name, and the gradient tiles for Liked songs, Downloads and Shuffle.
 */
object CarArt {
    private const val SIZE = 600

    /** What one picture is: a cover, a cover with a mix name over it, a tile, or a country's dotted
     * shape ("columns,rows,base64 bits", as in js/world-map.js). */
    private data class Spec(val url: String?, val tile: String?, val label: String?, val tint: Int?, val round: Boolean, val shape: String? = null)

    private val specs = ConcurrentHashMap<String, Spec>()

    private fun authority(context: Context) = context.packageName + ".art"

    /** The car's address for a picture; null when there's nothing to show. */
    fun uri(context: Context, url: String?, tile: String? = null, label: String? = null, tint: String? = null, round: Boolean = false, shape: String? = null): Uri? {
        val spec = Spec(
            url?.takeIf { it.startsWith("http://") || it.startsWith("https://") },
            tile?.takeIf { it in TILES },
            label?.takeIf { it.isNotBlank() },
            tint?.let { runCatching { Color.parseColor(it) }.getOrNull() },
            round,
            shape?.takeIf { SHAPE.matches(it) },
        )
        if (spec.url == null && spec.tile == null && spec.shape == null) return null
        val key = MessageDigest.getInstance("SHA-1").digest(spec.toString().toByteArray()).joinToString("") { "%02x".format(it) }.take(32)
        specs[key] = spec
        return Uri.Builder().scheme("content").authority(authority(context)).appendPath(key).build()
    }

    private val drawing = ConcurrentHashMap<String, Any>()
    private val ahead = java.util.concurrent.Executors.newFixedThreadPool(3)

    /** Draws pictures the car is about to show, so they're there when the screen slides in. */
    fun prepare(context: Context, uris: List<Uri>) {
        val app = context.applicationContext
        uris.forEach { u -> u.lastPathSegment?.let { key -> ahead.execute { file(app, key) } } }
    }

    /** The picture's file, drawing it first if need be. Only pictures this app asked for exist. */
    fun file(context: Context, key: String): File? {
        if (!key.matches(Regex("[0-9a-f]{32}"))) return null
        val dir = File(context.cacheDir, "car-art").apply { mkdirs() }
        val out = File(dir, "$key.img")
        if (out.exists()) return out.also { it.setLastModified(System.currentTimeMillis()) }
        // The car and prepare() may ask for the same picture at once: draw it once.
        synchronized(drawing.getOrPut(key) { Any() }) {
            if (out.exists()) return out
            val spec = specs[key] ?: return null
            val picture = runCatching { draw(context, spec) }.onFailure { Log.w(Engine.TAG, "car picture failed: $it") }.getOrNull() ?: return null
            val tmp = File(dir, "$key.tmp")
            // Round pictures need see-through corners (PNG); the rest are photos (JPEG).
            tmp.outputStream().use { picture.compress(if (spec.round) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 90, it) }
            picture.recycle()
            tmp.renameTo(out)
        }
        drawing.remove(key)
        tidy(dir)
        return out
    }

    private fun tidy(dir: File) {
        val files = dir.listFiles()?.filter { it.name.endsWith(".img") } ?: return
        if (files.size <= 500) return
        files.sortedBy { it.lastModified() }.take(files.size - 400).forEach { it.delete() }
    }

    // ------------------------------------------------------------------ drawing

    private fun draw(context: Context, spec: Spec): Bitmap? {
        val cover = spec.url?.let { fetch(it) }
        // A plain cover keeps its own size (up to 600): small list pictures stay small and sharp.
        val size = if (cover != null && spec.label == null) minOf(SIZE, minOf(cover.width, cover.height)).coerceAtLeast(64) else SIZE
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        if (size != SIZE) canvas.scale(size / SIZE.toFloat(), size / SIZE.toFloat())
        when {
            cover != null -> { drawCover(canvas, cover); cover.recycle() }
            spec.tile != null -> drawTile(context, canvas, spec.tile)
            spec.shape != null -> drawShape(canvas, spec.shape, spec.tint ?: Color.parseColor("#7b7bff"), spec.label != null)
            else -> { out.recycle(); return null }
        }
        if (spec.label != null) drawMixLabel(canvas, spec.label, spec.tint ?: Color.parseColor("#7b7bff"))
        return if (spec.round) round(out) else out
    }

    /** Artists are round, as in the app: a smooth circle with see-through corners. */
    private fun round(square: Bitmap): Bitmap {
        val n = square.width
        val out = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawCircle(n / 2f, n / 2f, n / 2f, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
        canvas.drawBitmap(square, 0f, 0f, paint)
        square.recycle()
        return out
    }

    private fun fetch(url: String): Bitmap? = runCatching {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 10000
        c.inputStream.use { BitmapFactory.decodeStream(it) }
    }.getOrNull()

    /** The cover, cropped to a square. */
    private fun drawCover(canvas: Canvas, cover: Bitmap) {
        val side = minOf(cover.width, cover.height)
        val src = Rect((cover.width - side) / 2, (cover.height - side) / 2, (cover.width + side) / 2, (cover.height + side) / 2)
        canvas.drawBitmap(cover, src, Rect(0, 0, SIZE, SIZE), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    }

    /** As on Home's mix cards (css .card.mix): the mix's colour rising from a corner, and its name. */
    private fun drawMixLabel(canvas: Canvas, label: String, tint: Int) {
        val deep = blend(tint, Color.BLACK, 0.15f)
        // linear-gradient(160deg, transparent 35%, tint 100%)
        val a = Math.toRadians(160.0 - 90.0)
        val half = SIZE / 2f
        val reach = (half * (kotlin.math.abs(cos(a)) + kotlin.math.abs(sin(a)))).toFloat()
        val dx = (cos(a) * reach).toFloat()
        val dy = (sin(a) * reach).toFloat()
        val shade = Paint().apply {
            shader = LinearGradient(half - dx, half - dy, half + dx, half + dy,
                intArrayOf(withAlpha(deep, 0f), withAlpha(deep, 0f), deep),
                floatArrayOf(0f, 0.35f, 1f), Shader.TileMode.CLAMP)
        }
        canvas.drawRect(0f, 0f, SIZE.toFloat(), SIZE.toFloat(), shade)
        val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 66f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            letterSpacing = -0.015f
            setShadowLayer(18f, 0f, 4f, Color.argb(130, 0, 0, 0))
        }
        val margin = 40f
        val width = (SIZE - margin * 2).toInt()
        val layout = StaticLayout.Builder.obtain(label, 0, label.length, text, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setLineSpacing(0f, 1.05f)
            .setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).build()
        canvas.save()
        canvas.translate(margin, SIZE - margin - layout.height)
        layout.draw(canvas)
        canvas.restore()
    }

    private val SHAPE = Regex("\\d{1,3},\\d{1,3},[A-Za-z0-9+/=]{1,400}")

    /** A country in Explore (css .cty-card): its own dotted shape glowing in its colour on the night
     * sky, leaving room at the bottom for its name. */
    private fun drawShape(canvas: Canvas, shape: String, tint: Int, named: Boolean) {
        val (c, r, b64) = shape.split(",", limit = 3)
        val cols = c.toInt().coerceIn(1, 60)
        val rows = r.toInt().coerceIn(1, 60)
        val bits = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        val s = SIZE.toFloat()
        canvas.drawColor(Color.parseColor("#121428"))
        canvas.drawRect(0f, 0f, s, s, Paint().apply {
            shader = android.graphics.RadialGradient(s / 2, s * 0.4f, s * 0.62f, intArrayOf(withAlpha(tint, 0.55f), withAlpha(tint, 0.12f), withAlpha(tint, 0f)),
                floatArrayOf(0f, 0.62f, 1f), Shader.TileMode.CLAMP)
        })
        val hex = Math.sqrt(3.0).toFloat() / 2
        val boxW = s * 0.78f
        val boxH = s * (if (named) 0.56f else 0.72f)
        val step = minOf(boxW / (cols + 0.5f), boxH / (rows * hex + 0.2f))
        val ox = (s - (cols + 0.5f) * step) / 2
        val oy = s * (if (named) 0.1f else 0.14f) + (boxH - rows * hex * step) / 2
        val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(0f, oy, 0f, oy + rows * hex * step, intArrayOf(Color.WHITE, tint, withAlpha(tint, 0.8f)), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
        }
        for (y in 0 until rows) for (x in 0 until cols) {
            val i = y * cols + x
            if (i shr 3 >= bits.size || (bits[i shr 3].toInt() shr (i and 7)) and 1 == 0) continue
            canvas.drawCircle(ox + (x + 0.5f + (y % 2) * 0.5f) * step, oy + (y + 0.5f) * hex * step, step * 0.36f, dot)
        }
    }

    /** The app's tiles: a gradient with a white symbol (css .liked-tile, .download-tile…). */
    private fun drawTile(context: Context, canvas: Canvas, tile: String) {
        val (colours, glyph) = TILES.getValue(tile)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(0f, 0f, SIZE.toFloat(), SIZE.toFloat(), colours.map { Color.parseColor(it.first) }.toIntArray(),
                colours.map { it.second }.toFloatArray(), Shader.TileMode.CLAMP)
        }
        canvas.drawRect(RectF(0f, 0f, SIZE.toFloat(), SIZE.toFloat()), paint)
        // A soft light from the top left, like the glass in the app.
        val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = android.graphics.RadialGradient(SIZE * 0.25f, SIZE * 0.2f, SIZE * 0.8f,
                Color.argb(60, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        }
        canvas.drawRect(0f, 0f, SIZE.toFloat(), SIZE.toFloat(), glow)
        val icon = ContextCompat.getDrawable(context, glyph)?.mutate() ?: return
        icon.setTint(Color.WHITE)
        val side = (SIZE * 0.4f).toInt()
        val left = (SIZE - side) / 2
        icon.setBounds(left, left, left + side, left + side)
        icon.draw(canvas)
    }

    private fun blend(a: Int, b: Int, t: Float) = Color.rgb(
        (Color.red(a) * (1 - t) + Color.red(b) * t).toInt(),
        (Color.green(a) * (1 - t) + Color.green(b) * t).toInt(),
        (Color.blue(a) * (1 - t) + Color.blue(b) * t).toInt(),
    )

    private fun withAlpha(c: Int, a: Float) = Color.argb((a * 255).toInt(), Color.red(c), Color.green(c), Color.blue(c))

    private val BRAND = listOf("#2fc8ff" to 0f, "#4f6bff" to 0.45f, "#c45cff" to 1f)
    private val TILES: Map<String, Pair<List<Pair<String, Float>>, Int>> = mapOf(
        "liked" to (listOf("#5b3df5" to 0f, "#c86bff" to 0.6f, "#ff8bb5" to 1f) to R.drawable.ic_car_heart_fill),
        "downloads" to (listOf("#1b4fd6" to 0f, "#6fb6ff" to 1f) to R.drawable.ic_car_download),
        "recent" to (listOf("#12656b" to 0f, "#3dd6c6" to 1f) to R.drawable.ic_car_recent),
        "shuffle" to (BRAND to R.drawable.ic_car_shuffle),
        "mixes" to (BRAND to R.drawable.ic_car_mixes),
        "playlist" to (listOf("#2b2b3d" to 0f, "#565673" to 1f) to R.drawable.ic_car_library),
    )
}

/** Serves CarArt's pictures to the car (read-only, and only pictures OpenWave made). */
class ArtProvider : ContentProvider() {
    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (mode != "r") throw SecurityException("read-only")
        val key = uri.lastPathSegment ?: return null
        val file = CarArt.file(context ?: return null, key) ?: throw java.io.FileNotFoundException(key)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri) = "image/*"
    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
}
