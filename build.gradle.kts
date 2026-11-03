plugins {
    id("com.android.application") version "9.5.0" apply false
}

// AGP 9's built-in Kotlin runs on the Kotlin Gradle plugin it declares (2.2.10).
// 2.4.21 is what fixes GHSA-r937-wjx7-w2jp.
buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}
