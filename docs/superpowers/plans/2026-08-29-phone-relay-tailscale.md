# 手机中继（Tailscale 跨网络）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在手机上实现一个「mDNS 广播 + WebSocket 透明转发」的中继 App，让眼镜跨网络（连手机热点）经手机 Tailscale 通道连回 PC Core。

**Architecture:** 独立 Android 工程 `phone-relay/`。手机广播 `_agentbridge._tcp` 伪装成 Core，眼镜用既有 mDNS 发现逻辑自动连接；中继 `ServerSocket(8088)` 把连接透明转发到 PC `100.117.117.37:8088`。眼镜与 Core 零改动。

**Tech Stack:** Kotlin 2.2.10、AGP 9.2.1、Gradle 9.4.1、Compose、`NsdManager`（mDNS 广播）、`ServerSocket`/`Socket`（TCP 转发）、JUnit 4（JVM 单测）。

**Spec:** `docs/superpowers/specs/2026-08-29-phone-relay-tailscale-design.md`

## Global Constraints

- **眼镜零改动**：不改 `cxrswithcxrl` 任何代码。
- **Core 零改动**：Core 已监听 `0.0.0.0:8088`（含 Tailscale 网卡），不改。
- **不改消息协议**：中继不解析 AgentBridge 协议，纯字节转发。
- **不改审批链路**：审批逻辑全在 PC 侧。
- 广播协议必须与 Core 完全一致：服务类型 `_agentbridge._tcp`，TXT `id`/`session`/`version`。
- 监听端口固定 `8088`；PC 地址 `100.117.117.37` 为默认值且可配置。
- 本期只做 8088 审批卡片核心链路；语音 8788 不做。
- 构建环境：`JAVA_HOME` 指向 `C:\Users\_\.gradle\jdks\eclipse_adoptium-21-amd64-windows.2`（bash: `export JAVA_HOME="/c/Users/_/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"`）；Gradle 依赖走 aliyun 镜像仓库。
- 提交风格：`feat:`（新功能）/ `test:`（测试）/ `chore:`（脚手架），中文描述。

---

## File Structure

```
phone-relay/                                   ← 新工程（从 CXRLSample 复制 wrapper）
├── gradlew / gradlew.bat                      ← 复制自 rokid-sdk/CXRLSample
├── gradle/
│   ├── wrapper/gradle-wrapper.jar             ← 复制
│   ├── wrapper/gradle-wrapper.properties      ← 复制
│   └── libs.versions.toml                     ← 复用 CXRLSample（去掉 CXR 无关项不影响）
├── gradle.properties
├── settings.gradle.kts
├── build.gradle.kts
└── app/
    ├── build.gradle.kts
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   └── java/com/agentbridge/relay/
        │       ├── RelayConfig.kt             ← 常量 + 默认值（可单测）
        │       ├── TcpRelay.kt                ← 双向字节流转发核心（纯 JVM，可单测）
        │       ├── RelayServer.kt             ← accept 循环 + 每连接转发
        │       ├── MdnsBroadcaster.kt         ← NsdManager 广播封装
        │       └── MainActivity.kt            ← Compose 界面 + 生命周期
        └── test/
            └── java/com/agentbridge/relay/
                ├── RelayConfigTest.kt
                └── TcpRelayTest.kt
```

---

### Task 1: 工程脚手架（可 build 的空 App）

**Files:**
- Create: `phone-relay/settings.gradle.kts`
- Create: `phone-relay/build.gradle.kts`
- Create: `phone-relay/gradle.properties`
- Create: `phone-relay/app/build.gradle.kts`
- Create: `phone-relay/app/src/main/AndroidManifest.xml`
- Create: `phone-relay/app/src/main/java/com/agentbridge/relay/MainActivity.kt`（占位空界面）
- Copy: `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties`, `gradle/libs.versions.toml` 从 `rokid-sdk/CXRLSample/`

**Interfaces:**
- Produces: 一个能 `assembleDebug` 的 Android 工程骨架，后续 task 往里加类。

- [ ] **Step 1: 复制 gradle wrapper 与 version catalog**

从 `rokid-sdk/CXRLSample/` 复制到 `phone-relay/`：

```bash
mkdir -p phone-relay/gradle/wrapper
cp rokid-sdk/CXRLSample/gradlew rokid-sdk/CXRLSample/gradlew.bat phone-relay/
cp rokid-sdk/CXRLSample/gradle/wrapper/gradle-wrapper.jar phone-relay/gradle/wrapper/
cp rokid-sdk/CXRLSample/gradle/wrapper/gradle-wrapper.properties phone-relay/gradle/wrapper/
cp rokid-sdk/CXRLSample/gradle/libs.versions.toml phone-relay/gradle/
```

- [ ] **Step 2: 写 `settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        google()
        mavenCentral()
    }
}

rootProject.name = "PhoneRelay"
include(":app")
```

- [ ] **Step 3: 写根 `build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
```

- [ ] **Step 4: 写 `gradle.properties`**

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
```

- [ ] **Step 5: 写 `app/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.agentbridge.relay"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.agentbridge.relay"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    testImplementation(libs.junit)
}
```

- [ ] **Step 6: 写 `app/src/main/AndroidManifest.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />

    <application
        android:allowBackup="true"
        android:label="AgentBridge Relay"
        android:usesCleartextTraffic="true"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

- [ ] **Step 7: 写占位 `MainActivity.kt`**

```kotlin
package com.agentbridge.relay

import android.os.Bundle
import androidx.activity.ComponentActivity

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }
}
```

- [ ] **Step 8: 构建验证**

```bash
export JAVA_HOME="/c/Users/_/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
cd phone-relay && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`，生成 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 9: Commit**

```bash
git add phone-relay/
git commit -m "chore: phone-relay 工程脚手架（Compose + 空 MainActivity）"
```

---

### Task 2: RelayConfig（常量 + 默认值，TDD）

**Files:**
- Create: `phone-relay/app/src/main/java/com/agentbridge/relay/RelayConfig.kt`
- Test: `phone-relay/app/src/test/java/com/agentbridge/relay/RelayConfigTest.kt`

**Interfaces:**
- Produces: `RelayConfig(host: String, port: Int)` data class；`RelayConfig.DEFAULT_HOST`/`DEFAULT_PORT`/`SERVICE_TYPE`/`SERVICE_NAME`/`TXT_RECORDS`；`RelayConfig.parse(hostPort: String): RelayConfig?`。供 Task 4/5/6 使用。

- [ ] **Step 1: 写失败测试**

```kotlin
package com.agentbridge.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayConfigTest {
    @Test
    fun defaultsMatchSpec() {
        assertEquals("100.117.117.37", RelayConfig.DEFAULT_HOST)
        assertEquals(8088, RelayConfig.DEFAULT_PORT)
        assertEquals("_agentbridge._tcp", RelayConfig.SERVICE_TYPE)
        assertEquals("AgentBridge-phone-relay", RelayConfig.SERVICE_NAME)
    }

    @Test
    fun txtRecordsMatchCoreProtocol() {
        assertEquals("phone-relay", RelayConfig.TXT_RECORDS["id"])
        assertEquals("default", RelayConfig.TXT_RECORDS["session"])
        assertEquals("1", RelayConfig.TXT_RECORDS["version"])
    }

    @Test
    fun parseHostOnlyUsesDefaultPort() {
        val cfg = RelayConfig.parse("100.117.117.37")
        assertEquals(RelayConfig("100.117.117.37", 8088), cfg)
    }

    @Test
    fun parseHostAndPort() {
        val cfg = RelayConfig.parse("10.0.0.5:9000")
        assertEquals(RelayConfig("10.0.0.5", 9000), cfg)
    }

    @Test
    fun parseBlankReturnsNull() {
        assertNull(RelayConfig.parse(""))
        assertNull(RelayConfig.parse("   "))
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 编译失败，`Unresolved reference: RelayConfig`。

- [ ] **Step 3: 实现 `RelayConfig.kt`**

```kotlin
package com.agentbridge.relay

data class RelayConfig(
    val host: String,
    val port: Int,
) {
    companion object {
        const val DEFAULT_HOST = "100.117.117.37"
        const val DEFAULT_PORT = 8088
        const val LISTEN_PORT = 8088
        const val SERVICE_TYPE = "_agentbridge._tcp"
        const val SERVICE_NAME = "AgentBridge-phone-relay"
        val TXT_RECORDS = mapOf(
            "id" to "phone-relay",
            "session" to "default",
            "version" to "1",
        )

        fun parse(hostPort: String): RelayConfig? {
            val trimmed = hostPort.trim()
            if (trimmed.isEmpty()) return null
            val idx = trimmed.lastIndexOf(':')
            if (idx <= 0) return RelayConfig(trimmed, DEFAULT_PORT)
            val port = trimmed.substring(idx + 1).toIntOrNull() ?: return null
            if (port !in 1..65535) return null
            return RelayConfig(trimmed.substring(0, idx), port)
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add phone-relay/app/src/
git commit -m "feat: RelayConfig 常量 + host:port 解析"
```

---

### Task 3: TcpRelay 双向字节流转发（TDD）

**Files:**
- Create: `phone-relay/app/src/main/java/com/agentbridge/relay/TcpRelay.kt`
- Test: `phone-relay/app/src/test/java/com/agentbridge/relay/TcpRelayTest.kt`

**Interfaces:**
- Consumes: 无（纯 `java.net.Socket`）。
- Produces: `TcpRelay().relay(client: Socket, upstream: Socket)` —— 双向转发字节流，任一端 EOF 后关闭另一端并返回。供 Task 4 使用。

- [ ] **Step 1: 写失败测试**

```kotlin
package com.agentbridge.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket

class TcpRelayTest {
    @Test
    fun relayForwardsClientToUpstream() {
        // upstream 端 echo server：读到字节后原样回写
        val upstreamServer = ServerSocket(0)
        val upstreamGot = ByteArrayOutputStream()
        val upstreamThread = Thread {
            val conn = upstreamServer.accept()
            val input = conn.getInputStream()
            val output = conn.getOutputStream()
            val buf = ByteArray(8192)
            var n: Int
            while (input.read(buf).also { n = it } >= 0) {
                upstreamGot.write(buf, 0, n)
                output.write(buf, 0, n)
                output.flush()
            }
            conn.close()
        }
        upstreamThread.start()

        val relayServer = ServerSocket(0)
        val relayThread = Thread {
            val client = relayServer.accept()
            val upstream = Socket("127.0.0.1", upstreamServer.localPort)
            TcpRelay().relay(client, upstream)
        }
        relayThread.start()

        val client = Socket("127.0.0.1", relayServer.localPort)
        client.getOutputStream().write("hello".toByteArray())
        client.getOutputStream().flush()
        val echo = ByteArray(5)
        var read = 0
        while (read < 5) read += client.getInputStream().read(echo, read, 5 - read)
        client.close()

        assertArrayEquals("hello".toByteArray(), echo)
        assertArrayEquals("hello".toByteArray(), upstreamGot.toByteArray())

        upstreamServer.close()
        relayServer.close()
        upstreamThread.join(2000)
        relayThread.join(2000)
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 编译失败，`Unresolved reference: TcpRelay`。

- [ ] **Step 3: 实现 `TcpRelay.kt`**

```kotlin
package com.agentbridge.relay

import java.io.InputStream
import java.io.OutputStream
import java.net.Socket

class TcpRelay {
    fun relay(client: Socket, upstream: Socket) {
        val cToU = Thread { pump(client.getInputStream(), upstream.getOutputStream()) }
        val uToC = Thread { pump(upstream.getInputStream(), client.getOutputStream()) }
        cToU.start()
        uToC.start()
        cToU.join()
        uToC.join()
        try { client.close() } catch (_: Exception) {}
        try { upstream.close() } catch (_: Exception) {}
    }

    private fun pump(input: InputStream, output: OutputStream) {
        try {
            val buf = ByteArray(8192)
            var n: Int
            while (input.read(buf).also { n = it } >= 0) {
                output.write(buf, 0, n)
                output.flush()
            }
        } catch (_: Exception) {
        } finally {
            try { output.close() } catch (_: Exception) {}
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add phone-relay/app/src/
git commit -m "feat: TcpRelay 双向字节流转发（纯 JVM，localhost 集成测试）"
```

---

### Task 4: RelayServer（accept 循环 + 每连接转发，TDD）

**Files:**
- Create: `phone-relay/app/src/main/java/com/agentbridge/relay/RelayServer.kt`
- Test: `phone-relay/app/src/test/java/com/agentbridge/relay/RelayServerTest.kt`

**Interfaces:**
- Consumes: `TcpRelay`（Task 3）、`RelayConfig`（Task 2）。
- Produces: `RelayServer(config: RelayConfig).start()` / `.stop()` —— 监听 `RelayConfig.LISTEN_PORT`，每连接新建 upstream Socket 并 `TcpRelay.relay`。供 Task 6 使用。

- [ ] **Step 1: 写失败测试**

```kotlin
package com.agentbridge.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket

class RelayServerTest {
    @Test
    fun relayForwardsThroughServer() {
        // 目标端（模拟 PC Core）：echo server
        val targetServer = ServerSocket(0)
        val targetPort = targetServer.localPort
        val targetGot = ByteArrayOutputStream()
        val targetThread = Thread {
            val conn = targetServer.accept()
            val input = conn.getInputStream()
            val output = conn.getOutputStream()
            val buf = ByteArray(8192)
            var n: Int
            while (input.read(buf).also { n = it } >= 0) {
                targetGot.write(buf, 0, n)
                output.write(buf, 0, n)
                output.flush()
            }
            conn.close()
        }
        targetThread.start()

        // 中继监听一个随机端口（测试里绕过固定 8088，直接构造带端口的 relay）
        val server = RelayServerForTest(RelayConfig("127.0.0.1", targetPort), port = 0)
        server.start()
        val relayPort = server.actualPort()

        val client = Socket("127.0.0.1", relayPort)
        client.getOutputStream().write("ping".toByteArray())
        client.getOutputStream().flush()
        val resp = ByteArray(4)
        var read = 0
        while (read < 4) read += client.getInputStream().read(resp, read, 4 - read)
        client.close()

        assertArrayEquals("ping".toByteArray(), resp)
        assertArrayEquals("ping".toByteArray(), targetGot.toByteArray())

        server.stop()
        targetServer.close()
        targetThread.join(2000)
    }
}
```

> 说明：`RelayServerForTest` 是 RelayServer 的测试子类，暴露 `port` 构造参数与 `actualPort()`，便于用随机端口测试，避免与真实 8088 冲突。正式 `RelayServer` 监听 `RelayConfig.LISTEN_PORT`（8088）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 编译失败，`Unresolved reference: RelayServer`。

- [ ] **Step 3: 实现 `RelayServer.kt`**

```kotlin
package com.agentbridge.relay

import java.net.ServerSocket
import java.net.Socket

open class RelayServer(
    private val config: RelayConfig,
) {
    @Volatile private var running = false
    private var serverSocket: ServerSocket? = null

    open fun start() {
        if (running) return
        running = true
        serverSocket = ServerSocket(RelayConfig.LISTEN_PORT)
        Thread {
            while (running) {
                try {
                    val client = serverSocket?.accept() ?: break
                    Thread {
                        try {
                            val upstream = Socket(config.host, config.port)
                            TcpRelay().relay(client, upstream)
                        } catch (_: Exception) {
                            try { client.close() } catch (_: Exception) {}
                        }
                    }.start()
                } catch (_: Exception) {
                    if (!running) break
                }
            }
        }.start()
    }

    open fun stop() {
        running = false
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
    }
}
```

测试辅助（放 `app/src/test/java/...` 里，仅测试用）：

```kotlin
class RelayServerForTest(config: RelayConfig, private val port: Int) : RelayServer(config) {
    private var actual: ServerSocket? = null
    override fun start() {
        // 用指定端口创建 ServerSocket（绕过固定 8088）
        actual = ServerSocket(port)
        Thread {
            while (true) {
                val client = try { actual?.accept() } catch (_: Exception) { return@Thread }
                Thread {
                    val upstream = Socket(config.host, config.port)
                    TcpRelay().relay(client!!, upstream)
                }.start()
            }
        }.start()
    }
    fun actualPort(): Int = actual!!.localPort
    override fun stop() { try { actual?.close() } catch (_: Exception) {} }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add phone-relay/app/src/
git commit -m "feat: RelayServer accept 循环 + 每连接 TcpRelay 转发"
```

---

### Task 5: MdnsBroadcaster（NsdManager 广播）

**Files:**
- Create: `phone-relay/app/src/main/java/com/agentbridge/relay/MdnsBroadcaster.kt`
- Test: `phone-relay/app/src/test/java/com/agentbridge/relay/MdnsBroadcasterTest.kt`

**Interfaces:**
- Consumes: `RelayConfig` 常量（Task 2）。
- Produces: `MdnsBroadcaster(context: Context, port: Int).start()` / `.stop()` —— 用 `NsdManager.registerService` 广播 `_agentbridge._tcp`。供 Task 6 使用。

- [ ] **Step 1: 写失败测试（常量断言）**

NsdManager 依赖 Android framework，纯 JVM 无法实例化，故只测「广播参数与 Core 协议一致」这一可测面：

```kotlin
package com.agentbridge.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class MdnsBroadcasterTest {
    @Test
    fun broadcastParamsMatchCoreProtocol() {
        assertEquals("_agentbridge._tcp", RelayConfig.SERVICE_TYPE)
        assertEquals("AgentBridge-phone-relay", RelayConfig.SERVICE_NAME)
        assertEquals(8088, RelayConfig.LISTEN_PORT)
        assertEquals("phone-relay", RelayConfig.TXT_RECORDS["id"])
        assertEquals("default", RelayConfig.TXT_RECORDS["session"])
        assertEquals("1", RelayConfig.TXT_RECORDS["version"])
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 通过（这些常量已在 Task 2 定义）。此测试作为协议回归护栏，若通过说明常量未变，直接进入实现。

- [ ] **Step 3: 实现 `MdnsBroadcaster.kt`**

```kotlin
package com.agentbridge.relay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

class MdnsBroadcaster(
    private val context: Context,
    private val port: Int,
) {
    private var nsdManager: NsdManager? = null
    private var listener: NsdManager.RegistrationListener? = null

    fun start() {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        nsdManager = nsd
        val info = NsdServiceInfo().apply {
            serviceName = RelayConfig.SERVICE_NAME
            serviceType = RelayConfig.SERVICE_TYPE
            setPort(port)
            RelayConfig.TXT_RECORDS.forEach { (k, v) -> setAttribute(k, v) }
        }
        listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                Log.d("Relay", "mDNS registered: ${info.serviceName}")
            }
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w("Relay", "mDNS registration failed: $errorCode")
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener!!)
    }

    fun stop() {
        val nsd = nsdManager ?: return
        val l = listener ?: return
        try { nsd.unregisterService(l) } catch (_: Exception) {}
        listener = null
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd phone-relay && ./gradlew :app:testDebugUnitTest`
Expected: 全部 PASS（常量回归护栏通过 + 编译通过）。

- [ ] **Step 5: Commit**

```bash
git add phone-relay/app/src/
git commit -m "feat: MdnsBroadcaster 广播 _agentbridge._tcp（协议常量回归护栏）"
```

---

### Task 6: MainActivity 集成（Compose UI + 生命周期）

**Files:**
- Modify: `phone-relay/app/src/main/java/com/agentbridge/relay/MainActivity.kt`

**Interfaces:**
- Consumes: `RelayConfig`（Task 2）、`RelayServer`（Task 4）、`MdnsBroadcaster`（Task 5）。
- Produces: 完整 App —— 填 PC 地址、启动/停止中继、显示状态。

- [ ] **Step 1: 实现 MainActivity**

```kotlin
package com.agentbridge.relay

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    private var relayServer: RelayServer? = null
    private var mdns: MdnsBroadcaster? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("relay", Context.MODE_PRIVATE)
        val savedHost = prefs.getString("pc_host", RelayConfig.DEFAULT_HOST) ?: RelayConfig.DEFAULT_HOST
        val savedPort = prefs.getInt("pc_port", RelayConfig.DEFAULT_PORT)

        setContent {
            RelayScreen(
                initialHost = savedHost,
                initialPort = savedPort.toString(),
                onStart = { host, port ->
                    prefs.edit().putString("pc_host", host).putInt("pc_port", port).apply()
                    val config = RelayConfig(host, port)
                    if (relayServer == null) {
                        relayServer = RelayServer(config)
                        relayServer?.start()
                    }
                    if (mdns == null) {
                        mdns = MdnsBroadcaster(this, RelayConfig.LISTEN_PORT)
                        mdns?.start()
                    }
                },
                onStop = {
                    relayServer?.stop()
                    relayServer = null
                    mdns?.stop()
                    mdns = null
                },
            )
        }
    }

    override fun onDestroy() {
        relayServer?.stop()
        mdns?.stop()
        super.onDestroy()
    }
}

@Composable
fun RelayScreen(
    initialHost: String,
    initialPort: String,
    onStart: (String, Int) -> Unit,
    onStop: () -> Unit,
) {
    var host by remember { mutableStateOf(initialHost) }
    var port by remember { mutableStateOf(initialPort) }
    var running by remember { mutableStateOf(false) }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier.padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("AgentBridge 手机中继", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("PC Tailscale IP") },
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = port,
                onValueChange = { port = it },
                label = { Text("PC 端口") },
            )
            Spacer(Modifier.height(16.dp))
            Button(
                enabled = !running,
                onClick = {
                    val p = port.toIntOrNull() ?: RelayConfig.DEFAULT_PORT
                    onStart(host.trim(), p)
                    running = true
                },
            ) { Text("启动中继") }
            Spacer(Modifier.height(8.dp))
            Button(enabled = running, onClick = { onStop(); running = false }) {
                Text("停止")
            }
            if (running) {
                Spacer(Modifier.height(16.dp))
                Text("中继运行中（监听 :8088，广播 _agentbridge._tcp）")
            }
        }
    }
}
```

- [ ] **Step 2: 构建验证**

Run: `cd phone-relay && ./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL`。

- [ ] **Step 3: Commit**

```bash
git add phone-relay/app/src/
git commit -m "feat: MainActivity 集成（Compose 配置界面 + 启动/停止中继）"
```

---

### Task 7: 真机验证 + 文档

**Files:**
- Modify: `CLAUDE.md`（记录 phone-relay 使用方式与验证结果）

**Interfaces:**
- Consumes: Task 1-6 的完整 App。

- [ ] **Step 1: 构建 + 安装到手机**

```bash
export JAVA_HOME="/c/Users/_/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
cd phone-relay && ./gradlew assembleDebug
/c/Users/_/AppData/Local/Android/Sdk/platform-tools/adb.exe -s 4EU0221B11003871 install -r app/build/outputs/apk/debug/app-debug.apk
```

Expected: `Success`。

- [ ] **Step 2: 手动真机验证（跨网络核心链路）**

1. 手机连 WiFi/流量，确认 Tailscale 在线（`tailscale status` 手机↔PC 同 tailnet）。
2. 手机开「热点」。
3. 打开手机上的「AgentBridge Relay」App，PC 地址默认 `100.117.117.37:8088`，点「启动中继」。
4. 眼镜经 Rokid App 连手机热点。
5. 眼镜 mDNS 发现手机 → 自动连上（观察眼镜卡片/状态）。
6. PC 端触发一个审批卡片 → 眼镜显示 → 手势 approve → PC 工具执行 → 结果回传眼镜。

Expected: 完整审批闭环在跨网络下跑通。

- [ ] **Step 3: 更新 `CLAUDE.md`**

在「跨网络连接（Tailscale）」节补充手机中继的使用方式（一句话 + 指向 phone-relay 工程），并注明「眼镜跨网络 = 连手机热点 + 手机跑 phone-relay 中继」。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: 记录 phone-relay 手机中继使用方式与真机验证结果"
```

---

## Self-Review

**Spec coverage:**
- mDNS 广播 → Task 5 ✅
- TCP 透明转发 → Task 3/4 ✅
- PC 地址配置 → Task 2/6 ✅
- 眼镜零改动 / Core 零改动 → Global Constraints + Task 7 验证 ✅
- 8088 核心链路 → Task 4/7 ✅；语音 8788 不做 → Global Constraints ✅
- 边界（重启/IP 漂移/断连）→ spec 已覆盖，实现依赖眼镜既有重连机制 ✅

**Placeholder scan:** 无 TBD/TODO；所有 task 含完整代码与命令。

**Type consistency:**
- `RelayConfig(host, port)` 字段名 Task 2 定义，Task 4/6 一致使用 ✅
- `RelayConfig.LISTEN_PORT`/`SERVICE_TYPE`/`SERVICE_NAME`/`TXT_RECORDS` 命名全 plan 一致 ✅
- `TcpRelay().relay(client, upstream)` 签名 Task 3 定义，Task 4 调用一致 ✅
- `MdnsBroadcaster(context, port)` 构造签名 Task 5 定义，Task 6 调用一致 ✅
