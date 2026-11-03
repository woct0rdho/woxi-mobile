import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional release signing. Create keystore.properties with:
//   storeFile=keystore/woxi.jks
//   storePassword=...
//   keyAlias=...
//   keyPassword=...
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

// Which ABIs to package. The phone is arm64, so that is the default. Emulator builds
// pass -Pabi=arm64-v8a,x86_64 (or -Pabi=all). An ABI can only be selected if
// app/src/main/jniLibs has a libwoxi_jni.so for it, which tools/build-engine.ps1
// builds: .\tools\build-engine.ps1 -Abi x86_64
val abis: List<String> = run {
    val requested = (project.findProperty("abi") as String?)?.trim().orEmpty()
    when {
        requested.isEmpty() -> listOf("arm64-v8a")
        requested == "all" -> listOf("arm64-v8a", "x86_64")
        else -> requested.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }
}

android {
    namespace = "com.woctordho.woximobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.woctordho.woximobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
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
        // `ndk.abiFilters` covers native code Gradle builds. The interpreter is a
        // prebuilt in jniLibs, so leave out the ABI folders that were not selected.
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

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Pinned to the newest AndroidX versions that support compileSdk 36:
    // core 1.19.0 requires compileSdk 37 + AGP 9.1, which is not needed here.
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
}
