package es.decargo.app

import android.content.Context
import android.net.Uri

/** Ajustes guardados en el teléfono: servidor DECARGO, configuración pública de Firebase y token de avisos. */
object Prefs {
    private fun sp(c: Context) = c.getSharedPreferences("decargo", Context.MODE_PRIVATE)

    fun server(c: Context): String = sp(c).getString("server", null) ?: BuildConfig.SERVER_URL

    /** Solo https y solo dominio (sin ruta): «https://decargo.empresa.com». Devuelve null si no es válido. */
    fun normalizeServer(raw: String): String? {
        val s = raw.trim().let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }
        val u = runCatching { Uri.parse(s) }.getOrNull() ?: return null
        if (u.scheme != "https" || u.host.isNullOrBlank() || !(u.host!!.contains('.'))) return null
        return "https://${u.host}${if (u.port > 0 && u.port != 443) ":${u.port}" else ""}"
    }

    fun setServer(c: Context, url: String) {
        sp(c).edit().putString("server", url).remove("fcm_config").remove("fcm_token").remove("entry").apply()
    }

    fun serverHost(c: Context): String = Uri.parse(server(c)).host ?: ""

    /** Ruta de la aplicación en el servidor («/<ruta>/»; la raíz es la web pública). La da GET /api/v1/app/entry. */
    fun entry(c: Context): String = sp(c).getString("entry", null)?.takeIf { Regex("^/([A-Za-z0-9_-]{16,64}/)?$").matches(it) } ?: "/"
    fun setEntry(c: Context, v: String) { sp(c).edit().putString("entry", v).apply() }

    fun getFcmConfig(c: Context): String? = sp(c).getString("fcm_config", null)
    fun setFcmConfig(c: Context, v: String?) { sp(c).edit().putString("fcm_config", v).apply() }
    fun getToken(c: Context): String? = sp(c).getString("fcm_token", null)
    fun setToken(c: Context, v: String?) { sp(c).edit().putString("fcm_token", v).apply() }
    fun askedNotifications(c: Context): Boolean = sp(c).getBoolean("asked_notif", false)
    fun setAskedNotifications(c: Context) { sp(c).edit().putBoolean("asked_notif", true).apply() }
}
