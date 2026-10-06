package es.decargo.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Muestra un aviso: enciende la pantalla, notificación de máxima prioridad y aviso modal a pantalla completa (AlertActivity). */
object Alerts {
    const val CHANNEL = "avisos"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_PATH = "path"
    const val EXTRA_TEST = "test"
    const val EXTRA_NOTIF = "notif"
    const val EXTRA_KIND = "kind"
    private val io = Executors.newSingleThreadExecutor()

    /** Solo rutas internas de la app («/conductor?t=…»): nunca otra web. */
    fun safePath(p: String?): String = if (p != null && p.startsWith("/") && !p.startsWith("//") && p.length < 300) p else "/conductor"

    /** «Ver transporte» si el aviso lleva a un transporte concreto (asignado o modificado); si no (prueba, anulado, retirado), «Abrir DECARGO». */
    fun buttonLabel(kind: String, path: String): String = if (kind != "TEST" && path.contains("?t=")) "Ver transporte" else "Abrir DECARGO"

    fun show(c: Context, kind: String, title: String, body: String, path: String, testId: String?) {
        val id = (kind + path).hashCode()
        val alert = Intent(c, AlertActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            putExtra(EXTRA_TITLE, title); putExtra(EXTRA_BODY, body); putExtra(EXTRA_PATH, path)
            putExtra(EXTRA_TEST, testId); putExtra(EXTRA_NOTIF, id); putExtra(EXTRA_KIND, kind)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val fullScreen = PendingIntent.getActivity(c, id, alert, flags)
        val open = PendingIntent.getActivity(c, id + 1, MainActivity.openIntent(c, path, testId), flags)
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_aviso)
            .setColor(0xFF123D4E.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setFullScreenIntent(fullScreen, true)
            .addAction(Notification.Action.Builder(null, buttonLabel(kind, path), open).build())
            .build()
        wakeScreen(c)
        c.getSystemService(NotificationManager::class.java).notify(id, n)
        // Con la pantalla encendida Android no abre la pantalla completa (solo la notificación emergente): si la app puede mostrarse
        // encima de otras apps, se abre el aviso modal igualmente.
        // En Xiaomi basta con «Abrir nuevas ventanas mientras se ejecuta en segundo plano».
        if (Settings.canDrawOverlays(c) || (Xiaomi.isXiaomi && Xiaomi.backgroundStart(c) == true)) runCatching { c.startActivity(alert) }
    }

    /** Enciende la pantalla unos segundos aunque el teléfono esté en reposo. */
    @Suppress("DEPRECATION")
    private fun wakeScreen(c: Context) {
        val pm = c.getSystemService(PowerManager::class.java)
        if (pm.isInteractive) return
        val wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE, "decargo:aviso")
        wl.acquire(15_000)
    }

    fun canFullScreen(c: Context): Boolean =
        Build.VERSION.SDK_INT < 34 || c.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /** Acuse de una PRUEBA de aviso de la oficina (recibido → mostrado → pulsado), igual que hace la web. */
    fun ack(c: Context, testId: String?, event: String, withInfo: Boolean = false) {
        if (testId.isNullOrBlank()) return
        val server = Prefs.server(c)
        val info = if (!withInfo) null else JSONObject().apply {
            put("ua", "DECARGO Android ${BuildConfig.VERSION_NAME}")
            put("model", "${Build.MANUFACTURER} ${Build.MODEL}".take(60))
            put("os", "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            put("perm", if (c.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) "granted" else "denied")
            put("browser", "fullscreen=${canFullScreen(c)} overlay=${Settings.canDrawOverlays(c)}" + if (Xiaomi.isXiaomi) " lockscreen=${Xiaomi.lockScreen(c)} bgstart=${Xiaomi.backgroundStart(c)}" else "")
        }
        io.execute {
            runCatching {
                val conn = URL("$server/api/v1/push/ack").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"; conn.doOutput = true; conn.connectTimeout = 8000; conn.readTimeout = 8000
                conn.setRequestProperty("content-type", "application/json")
                val body = JSONObject().put("n", testId).put("event", event)
                if (info != null) body.put("info", info)
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                conn.responseCode
            }
        }
    }
}
