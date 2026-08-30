plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.cloudcli.runtimecontroller"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.cloudcli.runtimecontroller"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Deliberately minimal: AppCompat/Material for the four-state screen, and
    // coroutines for the RUN_COMMAND round trip + the cosmetic health poll.
    // No networking or JSON library — org.json ships with the platform, and the
    // one HTTP call (a bounded local /health poll) uses HttpURLConnection.
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    // The platform's own org.json.JSONObject is API-only for local unit tests (every
    // method throws "not mocked" at runtime) — this is a real, functional implementation
    // so TermuxResultOutcomeTest can parse actual JSON instead of hand-rolling a fake.
    testImplementation("org.json:json:20260814")
}
