package es.decargo.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Firebase se configura con los datos PÚBLICOS que da el servidor DECARGO (GET /api/v1/app/fcm-config), así la misma app vale para
 * cualquier empresa o servidor. Se guardan en el teléfono para poder recibir avisos aunque el proceso arranque sin red.
 */
object Fcm {
    @Volatile var state: String = "loading"      // ok | loading | no_config | error
        private set
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    var onChange: (() -> Unit)? = null

    private fun changed() = main.post { onChange?.invoke() }

    private fun options(j: JSONObject): FirebaseOptions = FirebaseOptions.Builder()
        .setProjectId(j.getString("project_id"))
        .setGcmSenderId(j.getString("sender_id"))
        .setApplicationId(j.getString("app_id"))
        .setApiKey(j.getString("api_key"))
        .build()

    /** Inicia Firebase con la configuración guardada (sin red). */
    fun initFromCache(c: Context) {
        val cfg = Prefs.getFcmConfig(c) ?: return
        runCatching { if (FirebaseApp.getApps(c).isEmpty()) FirebaseApp.initializeApp(c, options(JSONObject(cfg))) }
            .onFailure { Log.w("DECARGO", "Firebase: ${it.message}") }
        if (FirebaseApp.getApps(c).isNotEmpty()) state = "ok"
    }

    /** Pide la configuración al servidor; si cambió, reinicia Firebase. Después obtiene el token del teléfono. */
    fun refresh(c: Context) {
        val app = c.applicationContext
        if (FirebaseApp.getApps(app).isEmpty()) { state = "loading"; changed() }
        io.execute {
            // Ruta de la aplicación en este servidor (puede cambiar si el administrador la cambia).
            runCatching {
                val e = URL("${Prefs.server(app)}/api/v1/app/entry").openConnection() as HttpURLConnection
                e.connectTimeout = 8000; e.readTimeout = 8000
                if (e.responseCode == 200) Prefs.setEntry(app, JSONObject(e.inputStream.bufferedReader().use { it.readText() }).getString("app_path"))
            }
            try {
                val conn = URL("${Prefs.server(app)}/api/v1/app/fcm-config").openConnection() as HttpURLConnection
                conn.connectTimeout = 8000; conn.readTimeout = 8000
                val code = conn.responseCode
                if (code == 404) {
                    Prefs.setFcmConfig(app, null); state = "no_config"; changed(); return@execute
                }
                if (code != 200) throw IllegalStateException("http $code")
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val j = JSONObject(body)
                val old = Prefs.getFcmConfig(app)
                val same = old != null && JSONObject(old).toString() == j.toString()
                if (!same) {
                    FirebaseApp.getApps(app).forEach { runCatching { it.delete() } }
                    Prefs.setFcmConfig(app, j.toString()); Prefs.setToken(app, null)
                }
                if (FirebaseApp.getApps(app).isEmpty()) FirebaseApp.initializeApp(app, options(j))
                fetchToken(app)
            } catch (e: Exception) {
                Log.w("DECARGO", "fcm-config: ${e.message}")
                // Sin red: si ya había configuración, se sigue usando.
                state = if (FirebaseApp.getApps(app).isNotEmpty() && Prefs.getToken(app) != null) "ok" else "error"
                changed()
            }
        }
    }

    private fun fetchToken(c: Context) {
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { t -> Prefs.setToken(c, t); state = "ok"; changed() }
            .addOnFailureListener { e -> Log.w("DECARGO", "token: ${e.message}"); state = "error"; changed() }
    }

    fun newToken(c: Context, t: String) { Prefs.setToken(c, t); state = "ok"; changed() }
}
