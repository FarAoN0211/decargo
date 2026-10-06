package es.decargo.app

import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings

/**
 * Xiaomi / Redmi / POCO (MIUI y HyperOS) añaden permisos propios que Android no deja pedir con el diálogo normal:
 * «Mostrar en la pantalla de bloqueo» y «Abrir nuevas ventanas mientras se ejecuta en segundo plano». Sin ellos el aviso
 * no aparece con la pantalla apagada. Aquí se consulta su estado (operaciones internas de MIUI) y se abre su pantalla de permisos.
 */
object Xiaomi {
    private const val OP_SHOW_WHEN_LOCKED = 10020
    private const val OP_BACKGROUND_START_ACTIVITY = 10021

    val isXiaomi: Boolean = Build.MANUFACTURER.lowercase().let { it == "xiaomi" || it == "redmi" || it == "poco" } ||
        Build.BRAND.lowercase().let { it == "xiaomi" || it == "redmi" || it == "poco" }

    /** true/false si MIUI lo dice; null si no se puede saber (otras versiones). */
    private fun op(c: Context, op: Int): Boolean? = runCatching {
        val ops = c.getSystemService(AppOpsManager::class.java)
        val m = AppOpsManager::class.java.getMethod("checkOpNoThrow", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java)
        (m.invoke(ops, op, Process.myUid(), c.packageName) as Int) == AppOpsManager.MODE_ALLOWED
    }.getOrNull()

    fun lockScreen(c: Context): Boolean? = if (isXiaomi) op(c, OP_SHOW_WHEN_LOCKED) else true
    fun backgroundStart(c: Context): Boolean? = if (isXiaomi) op(c, OP_BACKGROUND_START_ACTIVITY) else true

    /** Pantalla «Otros permisos» de la app en MIUI/HyperOS (con alternativas por versión) y, si no existe, la ficha de la app. */
    fun openPermissions(c: Context) {
        val pkg = c.packageName
        val tries = listOf(
            Intent("miui.intent.action.APP_PERM_EDITOR").setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity").putExtra("extra_pkgname", pkg),
            Intent("miui.intent.action.APP_PERM_EDITOR").setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.AppPermissionsEditorActivity").putExtra("extra_pkgname", pkg),
            Intent("miui.intent.action.APP_PERM_EDITOR").setPackage("com.miui.securitycenter").putExtra("extra_pkgname", pkg),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        )
        for (i in tries) if (runCatching { c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
    }

    /** «Inicio automático» de MIUI: deja que el sistema despierte la app al llegar un aviso. */
    fun openAutostart(c: Context) {
        val i = Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
        if (runCatching { c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isFailure) openPermissions(c)
    }
}
