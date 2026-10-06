# Métodos del puente con la web (se llaman por su nombre desde JavaScript).
-keepclassmembers class es.decargo.app.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
