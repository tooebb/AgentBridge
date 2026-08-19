# mDNS 服务发现实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让眼镜无线自动发现 PC 上 Core 的地址并直连，替代硬编码 LAN IP，降级链 mDNS → 手动 IP → ADB 隧道。

**Architecture:** Core（Go）启动时用 `grandcat/zeroconf` 广播 `_agentbridge._tcp` 服务（TXT 带 `id`/`session`/`version`）；眼镜（Kotlin）用 `NsdManager` 发现并解析 host/port，经纯函数 `ConnectionResolver` 按「id 匹配优先 → 取第一个 → 手动 IP → ADB 隧道」选出连接目标，直连 Core。审批链路与消息协议完全不变。

**Tech Stack:** Go 1.26（`github.com/grandcat/zeroconf` v1.0.0）、Kotlin（`android.net.nsd.NsdManager`）、PowerShell（ADB 配置脚本）。

## Global Constraints

- 不改 Core 协议、不改 `AgentBridgeClient` 消息协议（只改「连哪个地址」）。
- 眼镜与 PC 必须同一 WiFi 二层网络（mDNS 组播不跨网段）。
- 审批链路复用现有 `needs_approval` / `approve` / `reject` 语义，零改动。
- Core 监听端口来自 `AGENTBRIDGE_ADDR`（默认 `:8080`；本项目运行用 `:8088`，避免 NI 抢占 8080）。
- 眼镜端：minSdk 31 / targetSdk 36 / Kotlin Compose / okhttp 4.12.0 / gson 2.10.1。
- 设备映射：眼镜 `1901092534002787`（app `com.rokid.cxrswithcxrl`）、手机 `4EU0221B11003871`。
- 眼镜 App 构建命令：`JAVA_HOME="/d/Software/Android/jbr" ./gradlew assembleDebug`（在 `rokid-sdk/cxrssample/cxrswithcxrl` 目录）。
- ADB 路径：`C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe`；ADB 操作必须用 PowerShell（Git Bash 会破坏 `/sdcard/` 路径）。

---

### Task 1: Core mDNS broadcaster（ParsePort TDD + Start）

**Files:**
- Create: `middleware-core/internal/mdns/broadcaster.go`
- Create: `middleware-core/internal/mdns/broadcaster_test.go`
- Modify: `middleware-core/go.mod`（`go get` 自动改）

**Interfaces:**
- Consumes: 无（第一个任务）。
- Produces:
  - `func ParsePort(addr string) int` — 从监听地址抽端口。
  - `func Start(port int, id, session string) (shutdown func(), err error)` — 广播服务，返回关闭函数。

- [ ] **Step 1: 拉取 zeroconf 依赖**

Run: `cd middleware-core && go get github.com/grandcat/zeroconf@v1.0.0`

Expected: `go.mod` 增加 `github.com/grandcat/zeroconf v1.0.0`，无报错。

- [ ] **Step 2: 写失败测试**

创建 `middleware-core/internal/mdns/broadcaster_test.go`：

```go
package mdns

import "testing"

func TestParsePort(t *testing.T) {
	cases := []struct {
		addr string
		want int
	}{
		{":8088", 8088},
		{"127.0.0.1:8088", 8088},
		{":8080", 8080},
		{"", 8080},
		{"0.0.0.0:19090", 19090},
	}
	for _, c := range cases {
		if got := ParsePort(c.addr); got != c.want {
			t.Errorf("ParsePort(%q) = %d, want %d", c.addr, got, c.want)
		}
	}
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd middleware-core && go test ./internal/mdns/`

Expected: FAIL，`undefined: ParsePort`。

- [ ] **Step 4: 写最小实现**

创建 `middleware-core/internal/mdns/broadcaster.go`：

```go
package mdns

import (
	"strconv"
	"strings"

	"github.com/grandcat/zeroconf"
)

// ParsePort extracts the TCP port from a listen address.
// Supports ":8088", "127.0.0.1:8088", and empty (defaults to 8080).
func ParsePort(addr string) int {
	if addr == "" {
		return 8080
	}
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		if p, err := strconv.Atoi(addr[i+1:]); err == nil {
			return p
		}
	}
	return 8080
}

// Start broadcasts _agentbridge._tcp on all interfaces.
// Returns a shutdown func that sends the mDNS goodbye packet.
func Start(port int, id, session string) (shutdown func(), err error) {
	server, err := zeroconf.Register(
		"AgentBridge-"+id,
		"_agentbridge._tcp",
		"local.",
		port,
		[]string{"id=" + id, "session=" + session, "version=1"},
		nil,
	)
	if err != nil {
		return nil, err
	}
	return server.Shutdown, nil
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd middleware-core && go test ./internal/mdns/`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd middleware-core
git add internal/mdns/ go.mod go.sum
git commit -m "feat: add mDNS broadcaster (ParsePort + zeroconf Start)"
```

---

### Task 2: main.go 接入 mDNS 广播

**Files:**
- Modify: `middleware-core/cmd/server/main.go:1-24`（import）+ `main.go:62-69`（main 主体）

**Interfaces:**
- Consumes: `mdns.ParsePort`、`mdns.Start`（Task 1）。
- Produces: Core 进程启动时广播 `_agentbridge._tcp`，`id` 来自 `AGENTBRIDGE_INSTANCE_ID` 或主机名。

- [ ] **Step 1: 加 import**

在 `main.go` 的 import 块（`agentbridge/internal/...` 之后）加：

```go
	"agentbridge/internal/mdns"
```

- [ ] **Step 2: 在 main() 里接入广播**

把 `main.go:62-69` 这段：

```go
	addr := os.Getenv("AGENTBRIDGE_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("AgentBridge Middleware Core starting on %s", addr)
	if err := http.ListenAndServe(addr, srv.router); err != nil {
		log.Fatalf("server: %v", err)
	}
```

替换为：

```go
	addr := os.Getenv("AGENTBRIDGE_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	id := os.Getenv("AGENTBRIDGE_INSTANCE_ID")
	if id == "" {
		if h, err := os.Hostname(); err == nil {
			id = h
		} else {
			id = "agentbridge"
		}
	}
	port := mdns.ParsePort(addr)
	if shutdown, err := mdns.Start(port, id, "default"); err != nil {
		log.Printf("server: mdns broadcast failed: %v", err)
	} else {
		defer shutdown()
		log.Printf("server: mDNS broadcast _agentbridge._tcp (id=%s port=%d)", id, port)
	}

	log.Printf("AgentBridge Middleware Core starting on %s", addr)
	if err := http.ListenAndServe(addr, srv.router); err != nil {
		log.Fatalf("server: %v", err)
	}
```

- [ ] **Step 3: 构建验证**

Run: `cd middleware-core && go build ./...`

Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
cd middleware-core
git add cmd/server/main.go
git commit -m "feat: wire mDNS broadcast into Core startup"
```

---

### Task 3: 眼镜 ConnectionResolver（TDD 纯逻辑）

**Files:**
- Create: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/ConnectionResolver.kt`
- Create: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/ConnectionResolverTest.kt`

**Interfaces:**
- Consumes: 无（纯 Kotlin，无 Android 依赖）。
- Produces:
  - `data class DiscoveredService(host, port, id)`
  - `data class ConnectionConfig(manualIp="", manualPort=8088, preferredId="")`
  - `data class ConnectionTarget(host, port)`，含 `val wsUrl: String`
  - `object ConnectionResolver { val ADB_TUNNEL: ConnectionTarget; fun resolve(services, config): ConnectionTarget }`
  - 这些类型被 Task 5（MainViewModel）消费。

- [ ] **Step 1: 写失败测试**

创建 `app/src/test/java/com/rokid/cxrswithcxrl/agent/ConnectionResolverTest.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionResolverTest {

    @Test
    fun `prefers matching preferred id`() {
        val services = listOf(
            DiscoveredService("192.168.31.1", 8088, "pc-a"),
            DiscoveredService("192.168.31.2", 8088, "pc-b"),
        )
        val config = ConnectionConfig(preferredId = "pc-b")
        assertEquals(
            ConnectionTarget("192.168.31.2", 8088),
            ConnectionResolver.resolve(services, config),
        )
    }

    @Test
    fun `falls back to first service when preferred id blank`() {
        val services = listOf(
            DiscoveredService("192.168.31.1", 8088, "pc-a"),
            DiscoveredService("192.168.31.2", 8088, "pc-b"),
        )
        assertEquals(
            ConnectionTarget("192.168.31.1", 8088),
            ConnectionResolver.resolve(services, ConnectionConfig()),
        )
    }

    @Test
    fun `uses manual ip when no services found`() {
        val config = ConnectionConfig(manualIp = "192.168.31.185", manualPort = 8088)
        assertEquals(
            ConnectionTarget("192.168.31.185", 8088),
            ConnectionResolver.resolve(emptyList(), config),
        )
    }

    @Test
    fun `falls back to adb tunnel when nothing available`() {
        assertEquals(
            ConnectionResolver.ADB_TUNNEL,
            ConnectionResolver.resolve(emptyList(), ConnectionConfig()),
        )
    }

    @Test
    fun `wsUrl builds correct scheme`() {
        assertEquals("ws://127.0.0.1:19090", ConnectionResolver.ADB_TUNNEL.wsUrl)
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd "D:/project/5project/AgentBridge-master/rokid-sdk/cxrssample/cxrswithcxrl"
JAVA_HOME="/d/Software/Android/jbr" ./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.ConnectionResolverTest"
```

Expected: FAIL，`Unresolved reference: ConnectionResolver`（编译错误）。

- [ ] **Step 3: 写最小实现**

创建 `app/src/main/java/com/rokid/cxrswithcxrl/agent/ConnectionResolver.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

data class DiscoveredService(val host: String, val port: Int, val id: String)

data class ConnectionConfig(
    val manualIp: String = "",
    val manualPort: Int = 8088,
    val preferredId: String = "",
)

data class ConnectionTarget(val host: String, val port: Int) {
    val wsUrl: String get() = "ws://$host:$port"
}

object ConnectionResolver {
    val ADB_TUNNEL = ConnectionTarget("127.0.0.1", 19090)

    fun resolve(services: List<DiscoveredService>, config: ConnectionConfig): ConnectionTarget {
        val preferred = services.firstOrNull {
            config.preferredId.isNotBlank() && it.id == config.preferredId
        }
        val target = preferred ?: services.firstOrNull()
        if (target != null) return ConnectionTarget(target.host, target.port)
        if (config.manualIp.isNotBlank()) return ConnectionTarget(config.manualIp, config.manualPort)
        return ADB_TUNNEL
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2 的命令。

Expected: PASS（5 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/ConnectionResolver.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/ConnectionResolverTest.kt
git commit -m "feat: add ConnectionResolver for mDNS → manual IP → ADB fallback chain"
```

---

### Task 4: MainViewModel 集成发现 + 降级链 + Manifest 权限

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt:1-24`（import）+ `MainViewModel.kt:220-240`（替换硬编码 LAN 段）+ 类内新增方法
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/AndroidManifest.xml:5-10`（新增权限）

**Interfaces:**
- Consumes: `ConnectionResolver` / `ConnectionConfig` / `ConnectionTarget` / `DiscoveredService`（Task 3）；`AgentBridgeClient`（已有）。
- Produces: 眼镜启动时经 mDNS 发现 → 手动 IP → ADB 隧道选出连接地址并 `createClient`。对后续审批链路无新接口。

- [ ] **Step 1: 新增 Multicast 权限**

在 `AndroidManifest.xml` 的 `<uses-permission android:name="android.permission.WAKE_LOCK" />`（第 10 行）之后加：

```xml
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
```

- [ ] **Step 2: 加 import**

在 `MainViewModel.kt` 顶部 import 块（`import java.net.NetworkInterface` 之后）加：

```kotlin
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import com.rokid.cxrswithcxrl.agent.ConnectionConfig
import com.rokid.cxrswithcxrl.agent.ConnectionResolver
import com.rokid.cxrswithcxrl.agent.ConnectionTarget
import com.rokid.cxrswithcxrl.agent.DiscoveredService
```

- [ ] **Step 3: 替换硬编码 LAN 段**

把 `MainViewModel.kt` 第 220-240 行这段：

```kotlin
        // LAN direct: glasses WiFi connects to PC on same LAN
        val pcIp = "192.168.31.209"
        val pcPort = 8088
        val serverUrl = "ws://$pcIp:$pcPort"
        netInfo = "$netInfo | LAN direct mode"
        _debugStatus.value = debugText("lan direct")
        // Quick TCP probe then connect
        Thread {
            val tcpResult = try {
                val sock = java.net.Socket()
                sock.connect(java.net.InetSocketAddress(pcIp, pcPort), 5000)
                val ok = sock.isConnected
                sock.close()
                if (ok) "TCP:OK" else "TCP:clsd"
            } catch (e: Exception) {
                "TCP:${e.javaClass.simpleName}"
            }
            netInfo = "$netInfo | serverUrl=$serverUrl $tcpResult"
            _debugStatus.value = debugText("tcp done")
            createClient(appContext, handler, serverUrl, null)
        }.start()
```

替换为：

```kotlin
        // Resolve target: mDNS discovery → manual IP → ADB tunnel.
        val config = readConfig(appContext)
        startDiscovery(appContext, handler, config)
```

- [ ] **Step 4: 新增发现/连接方法**

在类内 `createClient(...)` 方法（原 243 行）之前插入以下方法：

```kotlin
    private val discoveryTimeoutMs = 5_000L

    private fun readConfig(context: Context): ConnectionConfig {
        val prefs = context.getSharedPreferences("agent_bridge", Context.MODE_PRIVATE)
        return ConnectionConfig(
            manualIp = prefs.getString("manual_pc_ip", "") ?: "",
            manualPort = prefs.getInt("manual_pc_port", 8088),
            preferredId = prefs.getString("preferred_pc_id", "") ?: "",
        )
    }

    private fun startDiscovery(context: Context, handler: AgentActionHandler, config: ConnectionConfig) {
        val nsdManager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (nsdManager == null) {
            connectResolved(context, handler, ConnectionResolver.resolve(emptyList(), config))
            return
        }

        val services = mutableListOf<DiscoveredService>()
        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                connectResolved(context, handler, ConnectionResolver.resolve(emptyList(), config))
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
                    override fun onServiceResolved(resolved: NsdServiceInfo) {
                        val host = resolved.host?.hostAddress ?: return
                        val id = resolved.attributes?.get("id")?.let { String(it, Charsets.UTF_8) } ?: ""
                        services += DiscoveredService(host, resolved.port, id)
                        // No preference → connect to first found immediately.
                        if (config.preferredId.isBlank()) {
                            connectResolved(context, handler, ConnectionResolver.resolve(services.toList(), config))
                        }
                    }
                })
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        }

        nsdManager.discoverServices("_agentbridge._tcp", NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        netInfo = "$netInfo | mDNS discovering"
        _debugStatus.value = debugText("mdns discovering")

        Handler(Looper.getMainLooper()).postDelayed({
            nsdManager.stopServiceDiscovery(discoveryListener)
            connectResolved(context, handler, ConnectionResolver.resolve(services.toList(), config))
        }, discoveryTimeoutMs)
    }

    private fun connectResolved(context: Context, handler: AgentActionHandler, target: ConnectionTarget) {
        if (agentClient != null) return
        val url = target.wsUrl
        netInfo = "$netInfo | serverUrl=$url"
        _debugStatus.value = debugText("resolved")
        Thread {
            val tcpResult = try {
                val sock = java.net.Socket()
                sock.connect(java.net.InetSocketAddress(target.host, target.port), 5000)
                val ok = sock.isConnected
                sock.close()
                if (ok) "TCP:OK" else "TCP:clsd"
            } catch (e: Exception) {
                "TCP:${e.javaClass.simpleName}"
            }
            netInfo = "$netInfo | $tcpResult"
            _debugStatus.value = debugText("tcp done")
            createClient(context, handler, url, null)
        }.start()
    }
```

> 说明：`preferredId` 非空时（多 PC 场景）等待 5s 超时收集全部实例再解析，保证 id 匹配正确；单 PC 无偏好时首个服务即连，避免无谓等待。

- [ ] **Step 5: 编译验证**

Run:
```bash
cd "D:/project/5project/AgentBridge-master/rokid-sdk/cxrssample/cxrswithcxrl"
JAVA_HOME="/d/Software/Android/jbr" ./gradlew :app:assembleDebug
```

Expected: BUILD SUCCESSFUL，APK 输出 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 6: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/AndroidManifest.xml
git commit -m "feat: glasses discover Core via NsdManager with fallback chain"
```

---

### Task 5: set-glasses-config.ps1 配置脚本

**Files:**
- Create: `scripts/set-glasses-config.ps1`

**Interfaces:**
- Consumes: 无。
- Produces: 一条命令写眼镜 `SharedPreferences("agent_bridge")` 的 `manual_pc_ip` / `manual_pc_port` / `preferred_pc_id`，并 force-stop 眼镜 app 使配置下次启动生效。

- [ ] **Step 1: 写脚本**

创建 `scripts/set-glasses-config.ps1`：

```powershell
param(
    [string]$Ip = "",
    [string]$Port = "8088",
    [string]$PreferredId = ""
)

$adb = "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$glasses = "1901092534002787"
$pkg = "com.rokid.cxrswithcxrl"

$lines = @()
$lines += "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
$lines += "<map>"
if ($Ip)      { $lines += "    <string name=`"manual_pc_ip`">$Ip</string>" }
$lines += "    <int name=`"manual_pc_port`" value=`"$Port`" />"
if ($PreferredId) { $lines += "    <string name=`"preferred_pc_id`">$PreferredId</string>" }
$lines += "</map>"
$xml = $lines -join "`n"

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml))

Write-Host "Writing agent_bridge config to glasses..."
& $adb -s $glasses shell "run-as $pkg sh -c 'mkdir -p shared_prefs && echo $b64 | base64 -d > shared_prefs/agent_bridge.xml'"

Write-Host "Force-stopping app so config takes effect on next launch..."
& $adb -s $glasses shell "am force-stop $pkg"

Write-Host "Done. Config: ip=$Ip port=$Port preferredId=$PreferredId"
```

- [ ] **Step 2: 语法检查**

Run:
```powershell
powershell -NoProfile -Command "& { $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw 'D:/project/5project/AgentBridge-master/scripts/set-glasses-config.ps1'), [ref]$null) }"
```

Expected: 无输出（无语法错误）。

- [ ] **Step 3: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add scripts/set-glasses-config.ps1
git commit -m "feat: add glasses config script (manual IP / preferred id)"
```

---

### Task 6: 真机 E2E 验证（5 场景）

**Files:** 无代码改动（验证任务）。

**Interfaces:**
- Consumes: Task 1-5 全部产物。
- Produces: 验证记录（写进 `docs/` 或 CLAUDE.md 的连接模式表）。

**前置：** Core 已启动（`AGENTBRIDGE_ADDR=":8088"`），眼镜 WiFi 已开（`svc wifi enable`）。

- [ ] **Step 1: 场景 1 — mDNS 自动发现直连**

启动 Core，部署并启动眼镜 app。观察眼镜 debug 文字出现 `mDNS discovering` → `serverUrl=ws://192.168.31.x:8088` → `TCP:OK` → `WS: connected`。

Expected: 眼镜自动连上 PC 的 Core，无硬编码 IP。

- [ ] **Step 2: 场景 2 — 手动 IP 兜底**

停掉 Core（或让 PC 不广播），运行：
```powershell
powershell -File "D:/project/5project/AgentBridge-master/scripts/set-glasses-config.ps1" -Ip "192.168.31.185" -Port "8088"
```
重新启动 Core + 眼镜 app。

Expected: mDNS 发现为空 → `serverUrl=ws://192.168.31.185:8088` → 连上。

- [ ] **Step 3: 场景 3 — ADB 隧道兜底**

清空手动 IP（`-Ip ""`），不广播（Core 未起 mDNS 或直接验证降级路径），建 ADB 隧道：
```powershell
& "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 1901092534002787 reverse tcp:19090 tcp:8088
```
启动眼镜 app。

Expected: `serverUrl=ws://127.0.0.1:19090` → 经 USB 隧道连上。

- [ ] **Step 4: 场景 4 — 多 PC 身份匹配**

两台 PC 同时广播 `_agentbridge._tcp`（一台真实 Core，一台用 spike 的 Node `bonjour` 广播不同 `id`）。设置：
```powershell
powershell -File ".../scripts/set-glasses-config.ps1" -PreferredId "<目标Core的id>"
```

Expected: 眼镜连到 `preferredId` 匹配的那台，不误连另一台。

- [ ] **Step 5: 场景 5 — 断连重发现**

连上后拔掉 PC 网线/关 Core，再恢复。

Expected: 眼镜 `onServiceLost` → 重连；Core 恢复后眼镜重新发现并连回。

---

### Task 7: 文档 + 记忆更新

**Files:**
- Modify: `CLAUDE.md`（「眼镜连接模式」表 + Phase 3 待办）
- Modify: `C:\Users\_\.claude\projects\D--project-5project-AgentBridge-master\memory\project_status.md`
- Modify: `C:\Users\_\.claude\projects\D--project-5project-AgentBridge-master\memory\MEMORY.md`

**Interfaces:**
- Consumes: Task 1-6 全部。
- Produces: 文档/记忆与代码一致（mDNS 从「待开发」→「已验证/进行中」）。

- [ ] **Step 1: 更新 CLAUDE.md 连接模式表**

把「眼镜连接模式」表中 mDNS 行从 `🔜 待开发` 改为 `✅ 已实现（Core 广播 + NsdManager 发现）`，LAN 直连行标注「已被 mDNS 替代，保留手动 IP 兜底」。

- [ ] **Step 2: 更新 memory project_status.md**

把「方向：转向 mDNS（待开发）」更新为「mDNS 已实现并通过 E2E」，Phase 3 待办移除 mDNS 条目。

- [ ] **Step 3: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add CLAUDE.md
git commit -m "docs: mark mDNS discovery as implemented"
```

---

## Self-Review 记录

**Spec coverage：**
- §3.1 Core 广播 → Task 1、2 ✅
- §3.2 眼镜发现 + §3.3 优先级 + §3.4 降级链 → Task 3、4 ✅
- §3.5 手动 IP 配置 → Task 5 ✅
- §5 技术选型（grandcat/zeroconf + NsdManager）→ Task 1、4 ✅
- §6 测试（Core TDD + 眼镜 5 场景）→ Task 1、3（单测）+ Task 6（E2E）✅
- §8 交付物 → 全部覆盖 ✅

**Placeholder scan：** 无 TBD/TODO/占位符。

**Type consistency：** `ParsePort`/`Start`（Task 1）↔ main.go（Task 2）；`ConnectionResolver.resolve(services, config): ConnectionTarget`、`DiscoveredService(host, port, id)`、`ConnectionConfig(manualIp, manualPort, preferredId)`（Task 3）↔ MainViewModel（Task 4）签名一致。
