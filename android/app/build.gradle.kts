import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firma: android/keystore.properties (fuera del repositorio). Sin él, solo se puede compilar la versión de depuración.
val signing = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "es.decargo.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "es.decargo.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "1.4.0"
        // Servidor por defecto (se puede cambiar desde la propia app si no conecta). Se pasa con -PserverUrl=https://…
        buildConfigField("String", "SERVER_URL", "\"${(project.findProperty("serverUrl") as String?) ?: "https://decargo.duckdns.org"}\"")
    }

    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.core:core:1.13.1")
    // Escáner de QR de Google Play Services: lo muestra el sistema, sin permiso de cámara en la app
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
