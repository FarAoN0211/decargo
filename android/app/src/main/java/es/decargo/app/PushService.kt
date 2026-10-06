package es.decargo.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Recibe los avisos de DECARGO (mensajes de datos de prioridad alta: llegan con la pantalla apagada y la app cerrada). */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { Fcm.newToken(applicationContext, token) }

    override fun onMessageReceived(m: RemoteMessage) {
        val d = m.data
        val type = d["type"] ?: return
        val test = if (type == "TEST") d["n"] else null
        Alerts.ack(this, test, "received")
        val title = d["title"]?.take(80) ?: if (type == "TEST") "Aviso de prueba" else "Aviso de transporte"
        val body = d["body"]?.take(300) ?: "Tienes un nuevo transporte asignado."
        Alerts.show(this, type, title, body, Alerts.safePath(d["url"]), test)
        Alerts.ack(this, test, "shown", withInfo = true)
    }
}
