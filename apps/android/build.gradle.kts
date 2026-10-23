buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("com.google.dagger.hilt.android") version "2.60.1" apply false
    id("com.google.devtools.ksp") version "2.3.12" apply false
}

tasks.wrapper {
    gradleVersion = "9.6.0"
    distributionType = Wrapper.DistributionType.BIN
    distributionUrl = "https://downloads.gradle.org/distributions/gradle-9.6.0-bin.zip"
    distributionSha256Sum = "bbaeb2fef8710818cf0e261201dab964c572f92b942812df0c3620d62a529a01"
}
