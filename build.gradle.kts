plugins {
    id("com.android.application") version "9.5.1" apply false
}

// AGP 9's built-in Kotlin runs on the Kotlin Gradle plugin it declares (2.2.10).
// 2.4.21 is what fixes GHSA-r937-wjx7-w2jp.
buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

// ktlint managed in this manifest so Dependabot can update it.
// The app build never resolves this configuration, and build scripts
// (*.gradle.kts) are deliberately not linted.
val ktlint by configurations.creating {
    attributes {
        attribute(
            org.gradle.api.attributes.Bundling.BUNDLING_ATTRIBUTE,
            objects.named(org.gradle.api.attributes.Bundling::class.java, org.gradle.api.attributes.Bundling.SHADOWED),
        )
    }
}

dependencies {
    ktlint("com.pinterest.ktlint:ktlint-cli:1.8.0")
}

val ktlintSources = listOf("app/src/main/kotlin/**/*.kt")

tasks.register<JavaExec>("ktlintCheck") {
    group = "verification"
    description = "Check the Kotlin style of the app sources with ktlint."
    classpath = configurations.named("ktlint").get()
    mainClass.set("com.pinterest.ktlint.Main")
    args = listOf("--relative") + ktlintSources
}

tasks.register<JavaExec>("ktlintFormat") {
    group = "formatting"
    description = "Rewrite the app sources in place with ktlint."
    classpath = configurations.named("ktlint").get()
    mainClass.set("com.pinterest.ktlint.Main")
    args = listOf("--relative", "--format", "--ignore-autocorrect-failures") + ktlintSources
}
