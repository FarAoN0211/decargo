package es.decargo.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager

/** Arranque del proceso: canal de avisos e inicio de Firebase con la configuración guardada (también cuando lo despierta un aviso). */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        createChannel()
        Fcm.initFromCache(this)
        Fcm.refresh(this)
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(Alerts.CHANNEL, "Avisos de transportes", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Nuevos transportes asignados y avisos de la oficina. Encienden la pantalla."
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400)
            enableLights(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        }
        nm.createNotificationChannel(ch)
    }
}
