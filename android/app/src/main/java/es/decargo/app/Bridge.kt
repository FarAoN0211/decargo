package es.decargo.app

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * Puente `window.DecargoAndroid` para la web de DECARGO. Solo responde si la página cargada es la del servidor configurado.
 * La web lo usa para mostrar el estado de los permisos de aviso y registrar el token del teléfono en el servidor.
 */
class Bridge(private val a: MainActivity) {
    private fun trusted(): Boolean = a.currentHostIsServer()

    @JavascriptInterface
    fun state(): String {
        if (!trusted()) return "{}"
        val nm = a.getSystemService(NotificationManager::class.java)
        val granted = nm.areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        val notif = when {
            granted -> "granted"
            Build.VERSION.SDK_INT >= 33 && Prefs.askedNotifications(a) && !a.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) -> "denied"
            Build.VERSION.SDK_INT < 33 -> "denied"     // desactivadas a mano en los ajustes
            else -> "default"
        }
        return JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("notifications", notif)
            .put("fullscreen", Alerts.canFullScreen(a))
            .put("overlay", Settings.canDrawOverlays(a))
            .put("battery", a.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(a.packageName))
            .put("xiaomi", Xiaomi.isXiaomi)
            .put("lockscreen", Xiaomi.lockScreen(a) ?: JSONObject.NULL)
            .put("bgstart", Xiaomi.backgroundStart(a) ?: JSONObject.NULL)
            .put("firebase", Fcm.state)
            .put("token", Prefs.getToken(a) ?: JSONObject.NULL)
            .toString()
    }

    @JavascriptInterface fun requestNotifications() { if (trusted()) a.runOnUiThread { a.requestNotifications() } }
    @JavascriptInterface fun refresh() { if (trusted()) Fcm.refresh(a) }

    @JavascriptInterface fun openFullScreenSettings() {
        if (!trusted()) return
        if (Build.VERSION.SDK_INT >= 34) open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg())) else openAppSettings()
    }
    @JavascriptInterface fun openXiaomiPermissions() { if (trusted()) a.runOnUiThread { Xiaomi.openPermissions(a) } }
    @JavascriptInterface fun openXiaomiAutostart() { if (trusted()) a.runOnUiThread { Xiaomi.openAutostart(a) } }
    @JavascriptInterface fun openOverlaySettings() { if (trusted()) open(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg())) }
    @JavascriptInterface fun requestBattery() {
        if (!trusted()) return
        @Suppress("BatteryLife")
        open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg()))
    }
    @JavascriptInterface fun openAppSettings() {
        if (!trusted()) return
        val i = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.packageName)
                else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg())
        open(i)
    }

    /** `navigator.share` no existe en WebView: se comparte con el menú de Android. */
    @JavascriptInterface fun share(text: String) {
        if (!trusted()) return
        val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text.take(4000))
        a.runOnUiThread { a.startActivity(Intent.createChooser(i, "Compartir")) }
    }

    /** Ficheros que la web genera en memoria (PDF del DeCA): se guardan y se abren con el visor del teléfono. */
    @JavascriptInterface fun saveBlob(dataUrl: String, name: String, download: Boolean) {
        if (!trusted()) return
        val comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith("data:") || comma < 0 || dataUrl.length > 40_000_000) return
        val mime = dataUrl.substring(5, comma).substringBefore(';').ifBlank { "application/octet-stream" }
        val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
        val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(80).ifBlank { "documento.pdf" }
        val dir = File(a.cacheDir, "docs").apply { mkdirs() }
        val f = File(dir, safe).apply { writeBytes(bytes) }
        if (download && Build.VERSION.SDK_INT >= 29) a.saveToDownloads(bytes, safe, mime)
        val uri = FileProvider.getUriForFile(a, "es.decargo.app.files", f)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        a.runOnUiThread {
            if (download && Build.VERSION.SDK_INT >= 29) Toast.makeText(a, "Guardado en Descargas: $safe", Toast.LENGTH_LONG).show()
            runCatching { a.startActivity(Intent.createChooser(view, "Abrir con")) }
        }
    }

    private fun pkg(): Uri = Uri.parse("package:${a.packageName}")
    private fun open(i: Intent) { a.runOnUiThread { runCatching { a.startActivity(i) }.onFailure { runCatching { a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg())) } } } }
}
