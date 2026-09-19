// Top-level build file. Plugin versions are pinned for a reproducible, modern toolchain:
//   AGP 8.13.2  -> stable 8.x line, supports compileSdk 36 and JDK 17/21
//   Kotlin 2.2.x -> current stable KGP compatible with Gradle 8.14.x
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
}
