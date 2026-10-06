package es.decargo.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** La aplicación es la misma web de DECARGO dentro de un WebView; lo nativo solo añade avisos que encienden la pantalla. */
class MainActivity : Activity() {
    companion object {
        private const val EXTRA_OPEN = "open_path"
        private const val REQ_NOTIF = 10
        private const val REQ_LOCATION = 11
        private const val REQ_FILE = 12

        fun openIntent(c: Context, path: String, testId: String?): Intent =
            Intent(c, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                putExtra(EXTRA_OPEN, Alerts.safePath(path))
                if (testId != null) putExtra(Alerts.EXTRA_TEST, testId)
            }
    }

    private lateinit var web: WebView
    private lateinit var errorView: View
    @Volatile private var currentHost: String = ""
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var geoCallback: Pair<String, GeolocationPermissions.Callback>? = null

    fun currentHostIsServer(): Boolean = currentHost.isNotEmpty() && currentHost == Prefs.serverHost(this)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        errorView = buildErrorView()
        val root = FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(errorView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        errorView.visibility = View.GONE
        setContentView(root)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // sesión del conductor y credencial del dispositivo (localStorage)
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString DecargoAndroid/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(this), "DecargoAndroid")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        Fcm.onChange = { notifyWeb() }

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else load(intent.getStringExtra(EXTRA_OPEN) ?: "/")
        intent.getStringExtra(Alerts.EXTRA_TEST)?.let { Alerts.ack(this, it, "clicked") }
    }

    private fun load(path: String) {
        errorView.visibility = View.GONE
        // La aplicación vive en /<ruta>/ (la raíz es la web pública): «/conductor?t=…» → «/<ruta>/conductor?t=…».
        val p = if (path == "/") "" else Alerts.safePath(path).removePrefix("/")
        web.loadUrl(Prefs.server(this) + Prefs.entry(this) + p)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(Alerts.EXTRA_TEST)?.let { Alerts.ack(this, it, "clicked") }
        intent.getStringExtra(EXTRA_OPEN)?.let { load(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }
    override fun onResume() { super.onResume(); web.onResume(); Fcm.refresh(this); notifyWeb() }
    override fun onPause() { web.onPause(); super.onPause() }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (errorView.visibility == View.GONE && web.canGoBack()) web.goBack() else moveTaskToBack(true)
    }

    /** Avisa a la web de que algo cambió (permisos, token…): la web vuelve a leer `DecargoAndroid.state()`. */
    fun notifyWeb() { runOnUiThread { web.evaluateJavascript("window.dispatchEvent(new Event('decargo-native'))", null) } }

    fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            Prefs.setAskedNotifications(this)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        } else {
            startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_NOTIF -> { Fcm.refresh(this); notifyWeb() }
            REQ_LOCATION -> geoCallback?.let { (origin, cb) ->
                cb.invoke(origin, grantResults.any { it == PackageManager.PERMISSION_GRANTED }, false); geoCallback = null
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileCallback = null
        }
    }

    fun saveToDownloads(bytes: ByteArray, name: String, mime: String) {
        if (Build.VERSION.SDK_INT < 29) return
        val v = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, mime)
        }
        runCatching {
            contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)?.let { uri -> contentResolver.openOutputStream(uri)?.use { it.write(bytes) } }
        }
    }

    /** QR de activación de la oficina: abre la pantalla «Activar mi cuenta» con el usuario y el código ya puestos. */
    fun scanActivationQr() {
        val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, opts).startScan()
            .addOnSuccessListener { openActivation(it.rawValue ?: "") }
            .addOnFailureListener { toast("No se pudo abrir el escáner de QR (necesita los servicios de Google Play actualizados).") }
    }

    /** Solo enlaces https de activación: https://servidor[/<ruta>]/activar#u=…&c=…. Si el QR es de otro servidor, se pregunta antes de cambiarlo
     *  (sirve para configurar la app de una empresa con su propio servidor; un QR ajeno nunca cambia el servidor sin confirmación). */
    private fun openActivation(raw: String) {
        val u = runCatching { Uri.parse(raw.trim()) }.getOrNull()
        val seg = u?.pathSegments ?: emptyList()
        val entry = when {
            seg.size == 2 && Regex("^[A-Za-z0-9_-]{16,64}$").matches(seg[0]) && seg[1] == "activar" -> "/${seg[0]}/"
            seg.size == 1 && seg[0] == "activar" -> "/"
            else -> null
        }
        val server = if (u?.scheme == "https") Prefs.normalizeServer("https://${u.encodedAuthority}") else null
        if (u == null || entry == null || server == null || u.fragment?.contains("c=") != true) { toast("Este QR no es un código de activación de DECARGO."); return }
        val go = { Prefs.setEntry(this, entry); errorView.visibility = View.GONE; web.loadUrl(raw.trim()) }
        if (server == Prefs.server(this)) { go(); return }
        AlertDialog.Builder(this)
            .setTitle("Servidor DECARGO de tu empresa")
            .setMessage("Este código de activación es del servidor:\n\n${u.host}\n\n¿Usar este servidor en la app a partir de ahora?")
            .setPositiveButton("Usar este servidor") { _, _ -> Prefs.setServer(this, server); Fcm.refresh(this); go() }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun toast(msg: String) { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    // Los enlaces «blob:» (PDF generados en la página) no se pueden abrir en un WebView: se pasan a la app en base64.
    // `navigator.share` tampoco existe: se usa el menú de compartir de Android.
    private val pageScript = """
        (function(){
          if (window.__decargoApp) return; window.__decargoApp = true;
          document.addEventListener('click', function(ev){
            var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="blob:"]') : null;
            if (!a) return;
            ev.preventDefault(); ev.stopPropagation();
            var name = a.getAttribute('download') || 'documento.pdf', dl = a.hasAttribute('download');
            fetch(a.href).then(function(r){ return r.blob(); }).then(function(b){
              var fr = new FileReader(); fr.onload = function(){ DecargoAndroid.saveBlob(fr.result, name, dl); }; fr.readAsDataURL(b);
            });
          }, true);
          if (!navigator.share) navigator.share = function(d){ DecargoAndroid.share((d && (d.text || d.url)) || ''); return Promise.resolve(); };
        })();
    """.trimIndent()

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { currentHost = Uri.parse(url).host ?: "" }
        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) { currentHost = Uri.parse(url).host ?: "" }
        override fun onPageFinished(view: WebView, url: String) { if (currentHostIsServer()) view.evaluateJavascript(pageScript, null); notifyWeb() }

        /** Lo que no es DECARGO (mapas, teléfono, correo…) se abre con su app; nunca dentro de la app. */
        override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
            val u = req.url
            if (u.scheme == "https" && u.host == Prefs.serverHost(this@MainActivity)) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            return true
        }

        override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
            if (req.isForMainFrame) showError("No se puede conectar con ${Prefs.server(this@MainActivity)}.\n(${err.description})")
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            if (Uri.parse(origin).host != Prefs.serverHost(this@MainActivity)) { callback.invoke(origin, false, false); return }
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) { callback.invoke(origin, true, false); return }
            geoCallback = origin to callback
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOCATION)
        }

        override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = cb
            return runCatching { startActivityForResult(params.createIntent(), REQ_FILE); true }.getOrElse { fileCallback = null; false }
        }
    }

    // Pantalla de «sin conexión», con la opción de cambiar el servidor (traslado de servidor o dominio nuevo).
    private lateinit var errorText: TextView
    private fun buildErrorView(): View {
        val pad = (20 * resources.displayMetrics.density).toInt()
        errorText = TextView(this).apply { textSize = 17f; setTextColor(0xFF222222.toInt()); gravity = Gravity.CENTER }
        val server = EditText(this).apply { setText(Prefs.server(this@MainActivity)); textSize = 15f; isSingleLine = true }
        val note = TextView(this).apply { textSize = 13f; setTextColor(0xFF7A1A14.toInt()) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(pad, pad, pad, pad); setBackgroundColor(0xFFF2F6F7.toInt())
            addView(TextView(this@MainActivity).apply { text = "DECARGO"; textSize = 26f; setTextColor(0xFF123D4E.toInt()); gravity = Gravity.CENTER })
            addView(errorText)
            addView(Button(this@MainActivity).apply { text = "Reintentar"; setOnClickListener { load("/") } })
            addView(Button(this@MainActivity).apply { text = "Escanear QR de activación"; setOnClickListener { scanActivationQr() } })
            addView(TextView(this@MainActivity).apply { text = "\nDirección del servidor DECARGO de tu empresa:"; textSize = 14f })
            addView(server)
            addView(note)
            addView(Button(this@MainActivity).apply {
                text = "Guardar dirección"
                setOnClickListener {
                    val n = Prefs.normalizeServer(server.text.toString())
                    if (n == null) { note.text = "Escribe una dirección https, por ejemplo https://decargo.tuempresa.com"; return@setOnClickListener }
                    Prefs.setServer(this@MainActivity, n); server.setText(n); note.text = ""
                    Fcm.refresh(this@MainActivity); load("/")
                }
            })
        }
    }

    private fun showError(msg: String) { errorText.text = msg; errorView.visibility = View.VISIBLE }
}
