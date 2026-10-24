import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

// Version comes from the Python package, so every platform ships the same number.
val openwaveVersion: String = Regex("__version__ = \"([^\"]+)\"")
    .find(rootProject.file("../openwave/__init__.py").readText())!!.groupValues[1]
val (vMajor, vMinor, vPatch) = openwaveVersion.split(".").map { it.toInt() }

// Release signing: CI passes these as env vars; locally they come from ~/.openwave/android/keystore.properties.
val signing = Properties().apply {
    val f = file("${System.getProperty("user.home")}/.openwave/android/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(env: String, key: String): String? = System.getenv(env) ?: signing.getProperty(key)

android {
    namespace = "io.github.saisiddharthbs.openwave"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.saisiddharthbs.openwave"
        minSdk = 24
        targetSdk = 35
        versionCode = vMajor * 10000 + vMinor * 100 + vPatch
        versionName = openwaveVersion
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }  // 64-bit phones (Python 3.12 has no 32-bit ARM build)
    }

    signingConfigs {
        create("release") {
            val store = signingValue("OPENWAVE_KEYSTORE_FILE", "storeFile")
            if (store != null) {
                storeFile = file(store)
                storePassword = signingValue("OPENWAVE_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = signingValue("OPENWAVE_KEY_ALIAS", "keyAlias")
                keyPassword = signingValue("OPENWAVE_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            val release = signingConfigs.getByName("release")
            signingConfig = if (release.storeFile != null) release else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

// The engine is the same Python package the desktop apps use: copy it in at build time.
val syncEngine by tasks.registering(Sync::class) {
    from(rootProject.file("../openwave")) {
        exclude("**/__pycache__/**", "**/*.pyc")
    }
    into(layout.buildDirectory.dir("engine/openwave"))
}
tasks.named("preBuild") { dependsOn(syncEngine) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("PythonSources") }.configureEach { dependsOn(syncEngine) }

chaquopy {
    defaultConfig {
        version = "3.12"
        // Packages read data files from disk (web UI, locales, CA bundle), so unpack them.
        extractPackages("openwave", "ytmusicapi", "certifi")
        pip {
            // FastAPI 0.99 + pydantic 1.x are pure Python (pydantic 2's Rust core isn't available on Android).
            install("fastapi==0.99.1")
            install("pydantic==1.10.26")
            install("uvicorn==0.30.6")
            install("httpx==0.27.2")
            install("ytmusicapi==1.12.3")
            install("yt-dlp")
            install("certifi")
        }
    }
    sourceSets {
        getByName("main") {
            srcDir("src/main/python")
            srcDir(layout.buildDirectory.dir("engine"))
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.media:media:1.7.1")
}
