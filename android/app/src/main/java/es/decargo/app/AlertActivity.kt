package es.decargo.app

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Aviso modal a pantalla completa: se muestra sobre la pantalla de bloqueo, la enciende y lleva al apartado del aviso. */
class AlertActivity : Activity() {
    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (android.os.Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        render()
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); render() }

    private fun render() {
        val title = intent.getStringExtra(Alerts.EXTRA_TITLE) ?: "DECARGO"
        val body = intent.getStringExtra(Alerts.EXTRA_BODY) ?: ""
        val path = Alerts.safePath(intent.getStringExtra(Alerts.EXTRA_PATH))
        val test = intent.getStringExtra(Alerts.EXTRA_TEST)
        val kind = intent.getStringExtra(Alerts.EXTRA_KIND) ?: ""
        val notif = intent.getIntExtra(Alerts.EXTRA_NOTIF, 0)

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(20))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(16).toFloat() }
            elevation = dp(8).toFloat()
        }
        card.addView(TextView(this).apply {
            text = "DECARGO"; setTextColor(0xFF123D4E.toInt()); textSize = 13f; typeface = Typeface.DEFAULT_BOLD; letterSpacing = 0.1f
        })
        card.addView(TextView(this).apply {
            text = title; setTextColor(0xFF111111.toInt()); textSize = 24f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, dp(8), 0, dp(8))
        })
        card.addView(TextView(this).apply { text = body; setTextColor(0xFF333333.toInt()); textSize = 18f; setPadding(0, 0, 0, dp(20)) })
        val primary = Button(this).apply {
            text = Alerts.buttonLabel(kind, path).uppercase()
            textSize = 18f; setTextColor(Color.WHITE); typeface = Typeface.DEFAULT_BOLD
            background = GradientDrawable().apply { setColor(0xFF123D4E.toInt()); cornerRadius = dp(10).toFloat() }
            minHeight = dp(56)
            setOnClickListener { go(path, test, notif) }
        }
        card.addView(primary, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        card.addView(Button(this).apply {
            text = "Cerrar"; textSize = 16f; setTextColor(0xFF123D4E.toInt()); setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })

        val root = LinearLayout(this).apply {
            gravity = Gravity.CENTER; setPadding(dp(20), dp(20), dp(20), dp(20))
            addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        setContentView(root)
    }

    /** Desbloquea (si hace falta, Android pide el PIN/huella) y abre la app en el apartado del aviso. */
    private fun go(path: String, test: String?, notif: Int) {
        getSystemService(NotificationManager::class.java).cancel(notif)
        Alerts.ack(this, test, "clicked")
        val open = { startActivity(MainActivity.openIntent(this, path, null)); finish() }
        val km = getSystemService(KeyguardManager::class.java)
        if (km.isKeyguardLocked) {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() { open() }
            })
        } else open()
    }
}
