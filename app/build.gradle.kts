import java.util.Properties

plugins {
    id("com.android.application")
}

val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

val abis: List<String> = run {
    val requested = (project.findProperty("abi") as String?)?.trim().orEmpty()
    when {
        requested.isEmpty() -> listOf("arm64-v8a")
        requested == "all" -> listOf("arm64-v8a", "x86_64")
        else -> requested.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }
}

val automation =
    (project.findProperty("woxiAutomation") as String?)?.toBoolean() ?: false

android {
    namespace = "com.woctordho.woximobile"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.woctordho.woximobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("boolean", "AUTOMATION", automation.toString())
        ndk {
            abiFilters += abis
        }
    }

    if (keystorePropsFile.exists()) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        val allAbis = listOf("arm64-v8a", "x86_64", "armeabi-v7a", "x86")
        jniLibs {
            excludes += allAbis.filter { it !in abis }.map { "lib/$it/**" }
        }
        resources {
            excludes += setOf(
                "META-INF/*.version",
                "META-INF/LICENSE*",
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "kotlin-tooling-metadata.json",
                "DebugProbesKt.bin",
            )
        }
    }

    lint {
        // The app is a WebView shell. Most platform lint checks are noise here.
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
}
