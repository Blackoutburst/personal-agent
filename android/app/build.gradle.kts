import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing lives outside the repo (~/.config/personal-agent/android-signing.properties:
// storeFile, storePassword, keyAlias, keyPassword). Without it, release builds stay unsigned.
val signingFile = System.getenv("COMPANION_SIGNING")?.let(::File)
    ?: File(System.getProperty("user.home"), ".config/personal-agent/android-signing.properties")
val signing = Properties().apply { if (signingFile.isFile) signingFile.inputStream().use(::load) }

// Firebase (push, docs/PUSH.md) is configured from the project's google-services.json, kept outside the repo
// (~/.config/personal-agent/google-services.json). The values are public client identifiers, not secrets. Without the
// file the app builds with push turned off.
val firebaseFile = System.getenv("COMPANION_FIREBASE")?.let(::File)
    ?: File(System.getProperty("user.home"), ".config/personal-agent/google-services.json")
@Suppress("UNCHECKED_CAST")
val firebase: Map<String, String> = if (!firebaseFile.isFile) emptyMap() else {
    val json = groovy.json.JsonSlurper().parse(firebaseFile) as Map<String, Any?>
    val project = json["project_info"] as Map<String, Any?>
    val client = (json["client"] as List<Map<String, Any?>>).first {
        ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == "dev.blackoutburst.companion"
    }
    mapOf("APP_ID" to (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"].toString(),
        "API_KEY" to ((client["api_key"] as List<Map<String, Any?>>).first()["current_key"]).toString(),
        "PROJECT_ID" to project["project_id"].toString(),
        "SENDER_ID" to project["project_number"].toString())
}

android {
    namespace = "dev.blackoutburst.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.blackoutburst.companion"
        minSdk = 35
        targetSdk = 36
        versionCode = 22
        versionName = "0.12.0"
        buildConfigField("String", "SITE", "\"https://blackoutburst.com\"")
        buildConfigField("String", "COMPANION_PATH", "\"/personal-agent-preview/\"")
        for (name in listOf("APP_ID", "API_KEY", "PROJECT_ID", "SENDER_ID"))
            buildConfigField("String", "FIREBASE_$name", "\"${firebase[name] ?: ""}\"")
    }

    signingConfigs {
        if (signing.containsKey("storeFile")) create("release") {
            storeFile = File(signing.getProperty("storeFile"))
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("keyPassword")
        }
    }

    buildTypes {
        // Source-only QA can compile an APK without opening or creating any signing key.
        if (providers.gradleProperty("companionUnsignedDebug").orNull == "true") {
            getByName("debug") { signingConfig = null }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Until the release key exists, test builds use the debug key (so they install over debug builds).
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.kotlinx.serialization.json)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    debugImplementation(libs.androidx.ui.tooling)
    testImplementation(libs.junit)
}
