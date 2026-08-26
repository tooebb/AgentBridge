package com.rokid.cxrswithcxrl.activities.main

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.lifecycle.ViewModel
import com.rokid.cxr.CXRServiceBridge
import com.rokid.cxr.Caps
import com.rokid.cxrswithcxrl.agent.AgentActionHandler
import com.rokid.cxrswithcxrl.agent.AgentBridgeClient
import com.rokid.cxrswithcxrl.agent.AgentCardState
import com.rokid.cxrswithcxrl.agent.CardStateMachine
import com.rokid.cxrswithcxrl.agent.ConnectionConfig
import com.rokid.cxrswithcxrl.agent.ConnectionResolver
import com.rokid.cxrswithcxrl.agent.ConnectionTarget
import com.rokid.cxrswithcxrl.agent.DeviceMessage
import com.rokid.cxrswithcxrl.agent.DiscoveredService
import com.rokid.cxrswithcxrl.agent.VoiceCapture
import com.rokid.cxrswithcxrl.agent.VoiceCaptureState
import com.rokid.cxrswithcxrl.receiver.KeyEventListener
import com.rokid.cxrswithcxrl.receiver.KeyReceiver
import com.rokid.cxrswithcxrl.receiver.KeyType
import java.net.Inet4Address
import java.net.NetworkInterface
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Diagnostic build: surface subscribe return value + connection state on screen
 * to determine whether CXR-S subscribe is failing or messages are being dropped upstream.
 */
class MainViewModel: ViewModel() {
    private val _capsFromClient = MutableStateFlow("subscribe: pending...")
    val capsFromClient = _capsFromClient.asStateFlow()

    private val _debugStatus = MutableStateFlow("init")
    val debugStatus = _debugStatus.asStateFlow()

    private val _voiceStatus = MutableStateFlow("")
    val voiceStatus = _voiceStatus.asStateFlow()

    private val _agentCard = MutableStateFlow(AgentCardState())
    val agentCard = _agentCard.asStateFlow()

    private val cxrBridge = CXRServiceBridge()
    private var agentClient: AgentBridgeClient? = null
    private var actionHandler: AgentActionHandler? = null
    private var voiceCapture: VoiceCapture? = null
    private var discoveredHost: String? = null
    private val audioPort = 8788
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var connectionStarted = false

    private val cmdKey = "rk_custom_key"
    private val clientKey = "rk_custom_client"
    private var netInfo = "net:?"
    private val discoveryTimeoutMs = 5_000L
    private fun debugText(msg: String) = "$msg | $netInfo"

    private val keyEventListener = object : KeyEventListener {
        override fun onKeyEvent(keyType: KeyType) {
            Log.d("KEY", "KeyReceiver: ${keyType.name}")
            _capsFromClient.value = "KEY: ${keyType.name}"
            sendMessage("Listener: key action = ${keyType.name}")
            actionHandler?.onKey(keyType)?.let {
                _agentCard.value = it
            }
        }
    }

    val keyReceiver = KeyReceiver(keyEventListener)

    private val connectionCallback = object : CXRServiceBridge.StatusListener{
        override fun onConnected(p0: String?, p1: String?, p2: Int) {
            Log.d("CXR", "onConnected: p0=$p0 p1=$p1 p2=$p2")
            val result = cxrBridge.subscribe(clientKey, msgCallback)
            Log.d("CXR", "subscribe in onConnected returned: $result")
            _debugStatus.value = "onConnected, sub=$result"
        }

        override fun onDisconnected() {
            Log.d("CXR", "onDisconnected")
            _debugStatus.value = "disconnected"
        }

        override fun onConnecting(p0: String?, p1: String?, p2: Int) {
            Log.d("CXR", "onConnecting: p0=$p0 p1=$p1 p2=$p2")
            _debugStatus.value = "connecting..."
        }

        override fun onARTCStatus(p0: Float, p1: Boolean) {}
        override fun onRokidAccountChanged(p0: String?) {}
        override fun onAudioNoise(p0: Float) {}
    }

    private val msgCallback = object : CXRServiceBridge.MsgCallback {
        override fun onReceive(name: String?, args: Caps?, bytes: ByteArray?) {
            val received = "RECV: name=$name, args=${args?.let { parseCaps(it) } ?: "null"}"
            Log.d("CXR", "onReceive: $received")
            _capsFromClient.value = received
        }
    }

    init {
        cxrBridge.setStatusListener(connectionCallback)
        val result = cxrBridge.subscribe(clientKey, msgCallback)
        Log.d("CXR", "subscribe in init returned: $result (0=ok, -1=bad arg, -2=dup)")
        _capsFromClient.value = when (result) {
            0 -> "BUILD-20 sub OK(0)"
            -1 -> "BUILD-20 sub BAD(-1)"
            -2 -> "BUILD-20 sub DUP(-2)"
            else -> "BUILD-20 init: $result"
        }
        _debugStatus.value = "BUILD-20 init done"
    }

    private fun networkSummary(ctx: Context): String {
        return try {
            val parts = mutableListOf<String>()

            // ConnectivityManager - most reliable on Android
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val activeNet = cm?.activeNetwork
            val caps = activeNet?.let { cm.getNetworkCapabilities(it) }
            if (caps != null) {
                val transport = when {
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WiFi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Cellular"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_USB) -> "USB"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Eth"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "BT"
                    else -> "?"
                }
                parts += "link=$transport"
            } else {
                parts += "link=none"
            }

            // WifiManager for IP
            val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val wifiInfo = wm?.connectionInfo
            if (wifiInfo != null && wifiInfo.ipAddress != 0) {
                val ip = (wifiInfo.ipAddress and 0xFF).toString() + "." +
                    ((wifiInfo.ipAddress shr 8) and 0xFF).toString() + "." +
                    ((wifiInfo.ipAddress shr 16) and 0xFF).toString() + "." +
                    ((wifiInfo.ipAddress shr 24) and 0xFF).toString()
                parts += "wifi=$ip"
                parts += "ssid=\"${wifiInfo.ssid?.take(12) ?: "?"}\""
            }

            // NetworkInterface as fallback
            val ifaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            val ips = ifaces.flatMap { ni ->
                ni.inetAddresses.toList().filterIsInstance<Inet4Address>().filter { !it.isLoopbackAddress }.map {
                    "${ni.name}=${it.hostAddress}"
                }
            }
            if (ips.isNotEmpty()) {
                parts += "ifaces:${ips.take(2).joinToString(",")}"
            }
            if (parts.isEmpty()) "no-network" else parts.joinToString(" ")
        } catch (e: Exception) {
            "net-err:${e.javaClass.simpleName}:${e.message?.take(20)}"
        }
    }

    fun startAgentBridge(context: Context) {
        if (agentClient != null) {
            return
        }
        val appContext = context.applicationContext
        netInfo = networkSummary(appContext)
        _debugStatus.value = debugText("starting")

        val handler = AgentActionHandler(appContext) { taskId, actionType ->
            agentClient?.sendAction(taskId, actionType) == true
        }
        actionHandler = handler

        // Keep WiFi on: the glasses OS disables WiFi to save power.
        // Try direct shell command first (Rokid ROM may allow it), fall
        // back to WifiManager, then wifi panel as last resort.
        try {
            val wm = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            if (wm != null && !wm.isWifiEnabled) {
                netInfo = "$netInfo | wifi:off"
                // 1) shell command (works on some custom ROMs)
                val shellOk = try {
                    val p = Runtime.getRuntime().exec(arrayOf("svc", "wifi", "enable"))
                    p.waitFor()
                    val exit = p.exitValue()
                    netInfo = "$netInfo | svc:exit=$exit"
                    exit == 0
                } catch (e: Exception) {
                    netInfo = "$netInfo | svc:${e.javaClass.simpleName}"
                    false
                }
                // 2) WifiManager (no-op on AOSP 10+ but may work on custom ROM)
                if (!shellOk) {
                    try { wm.setWifiEnabled(true) } catch (_: Exception) {}
                }
                // Wait briefly for WiFi to come up
                try { Thread.sleep(500) } catch (_: Exception) {}
                // 3) Still off → open system panel
                if (!wm.isWifiEnabled) {
                    try {
                        val intent = Intent(Settings.Panel.ACTION_WIFI)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        appContext.startActivity(intent)
                    } catch (e: Exception) {
                        try {
                            appContext.startActivity(Intent(Settings.ACTION_WIFI_SETTINGS).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            })
                        } catch (_: Exception) {}
                    }
                }
            }
            // Always hold WiFiLock regardless of how WiFi was enabled
            val lock = wm?.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF, "AgentBridge:WiFiLock"
            )
            lock?.acquire()
            wifiLock = lock
            netInfo = "$netInfo | wifiLock:held"
        } catch (e: Exception) {
            netInfo = "$netInfo | wifiLock:${e.javaClass.simpleName}"
        }

        // Resolve target: mDNS discovery -> manual IP -> ADB tunnel.
        val config = readConfig(appContext)
        startDiscovery(appContext, handler, config)
    }

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
            try {
                nsdManager.stopServiceDiscovery(discoveryListener)
            } catch (_: Exception) {
            }
            connectResolved(context, handler, ConnectionResolver.resolve(services.toList(), config))
        }, discoveryTimeoutMs)
    }

    private fun connectResolved(context: Context, handler: AgentActionHandler, target: ConnectionTarget) {
        if (connectionStarted || agentClient != null) return
        connectionStarted = true
        discoveredHost = target.host
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

    private fun createClient(context: Context, handler: AgentActionHandler, serverUrl: String, bindIp: String? = null) {
        if (agentClient != null) {
            Log.d("WIFI", "createClient: already created, skipping")
            return
        }
        Log.d("WIFI", "createClient: serverUrl=$serverUrl bindIp=$bindIp")
        agentClient = AgentBridgeClient(
            context = context,
            serverUrl = serverUrl,
            bindIp = bindIp,
            listener = object : AgentBridgeClient.Listener {
                override fun onConnectionChanged(label: String) {
                    _agentCard.value = handler.onConnectionChanged(label)
                    val current = _debugStatus.value
                    _debugStatus.value = if (current.startsWith("ERR:")) {
                        "$current | $label"
                    } else {
                        debugText(label)
                    }
                }

                override fun onMessage(message: DeviceMessage, duplicate: Boolean) {
                    when (message.event?.eventType) {
                        "user_input" -> _voiceStatus.value = "已识别: ${message.event?.body.orEmpty()}（处理中…）"
                        "task_completed", "task_failed", "needs_approval" -> _voiceStatus.value = ""
                    }
                    _agentCard.value = handler.reduce(message, duplicate)
                    _debugStatus.value = debugText(
                        if (duplicate) "duplicate ignored"
                        else "event=${message.event?.eventType ?: "unknown"} seq=${message.seq}"
                    )
                }

                override fun onError(label: String, throwable: Throwable?) {
                    Log.w("AgentBridge", label, throwable)
                    val exMsg = throwable?.message?.takeIf { it.isNotBlank() } ?: ""
                    _debugStatus.value = debugText("ERR: $label${if (exMsg.isNotBlank()) " | $exMsg" else ""}")
                    _agentCard.value = handler.onConnectionChanged("ERR: $label")
                }

                override fun onStale() {
                    Log.d("WIFI", "onStale: re-discovering")
                    _debugStatus.value = debugText("stale, re-discovering")
                    val old = agentClient
                    agentClient = null
                    connectionStarted = false
                    old?.disconnect()
                    startDiscovery(context, handler, readConfig(context))
                }
            }
        ).also { client ->
            _debugStatus.value = debugText("connecting now...")
            client.connect()
        }
    }

    fun sendMessage(str: String){
        val result = cxrBridge.sendMessage(cmdKey, Caps().apply {
            write("message")
            write(str)
        })
        Log.d("CXR", "sendMessage result=$result")
    }

    fun showInputDebug(msg: String) {
        _capsFromClient.value = "INPUT: $msg"
    }

    fun showMicResult(msg: String) {
        _capsFromClient.value = msg
    }

    fun onGesture(actionType: String) {
        val handler = actionHandler
        if (handler == null) {
            _capsFromClient.value = "INPUT: handler null"
            return
        }
        val card = agentCard.value

        if (actionType == "screen_off") {
            _agentCard.value = CardStateMachine.setScreenOff(card, true)
            return
        }
        if (actionType == "view_details") {
            _agentCard.value = CardStateMachine.onViewDetails(card)
            return
        }
        if (card.screenOff) {
            if (actionType == "approve") {
                _agentCard.value = CardStateMachine.setScreenOff(card, false)
            }
            return
        }
        if (CardStateMachine.shouldRouteToApproval(card)) {
            val client = agentClient
            if (client == null) {
                _capsFromClient.value = "INPUT: agentClient null"
                return
            }
            val sent = client.sendAction(card.taskId, actionType)
            _capsFromClient.value = "INPUT: sendAction=$sent taskId=${card.taskId} action=$actionType"
            _agentCard.value = handler.onGestureResult(actionType, sent)
        } else {
            if (actionType == "approve") {
                toggleVoice()
            } else if (actionType == "reject") {
                _agentCard.value = CardStateMachine.resetToIdle(card)
            }
        }
    }

    fun toggleVoice() {
        val current = voiceCapture
        if (current != null && current.state == VoiceCaptureState.RECORDING) {
            current.stop()
            _capsFromClient.value = "VOICE: stopped"
            return
        }

        val host = discoveredHost
        if (host.isNullOrBlank()) {
            _capsFromClient.value = "VOICE: no discovered PC host"
            return
        }

        val capture = VoiceCapture(
            onState = { state ->
                _capsFromClient.value = "VOICE: ${state.name.lowercase()}"
                _voiceStatus.value = when (state) {
                    VoiceCaptureState.RECORDING -> "聆听中…"
                    VoiceCaptureState.IDLE -> "识别中…"
                }
            },
            onError = { error ->
                _capsFromClient.value = "VOICE: $error"
            },
        )
        voiceCapture = capture
        capture.start("ws://$host:$audioPort")
    }

    private fun parseCaps(caps: Caps): String {
        val strBuilder = StringBuilder("{")
        for (i in 0 until caps.size()) {
            val capsValue = caps.at(i)
            val string = when (capsValue.type()) {
                Caps.Value.TYPE_STRING -> "string:${capsValue.string}"
                Caps.Value.TYPE_INT32, Caps.Value.TYPE_UINT32 -> "int:${capsValue.int}"
                Caps.Value.TYPE_INT64, Caps.Value.TYPE_UINT64 -> "long:${capsValue.long}"
                Caps.Value.TYPE_FLOAT -> "float:${capsValue.float}"
                Caps.Value.TYPE_DOUBLE -> "double:${capsValue.double}"
                Caps.Value.TYPE_OBJECT -> parseCaps(capsValue.`object`)
                Caps.Value.TYPE_BINARY -> capsValue.binary?.let {
                    "binary:${Base64.encode(it.data, it.length)}"
                } ?: "binary:null"
                else -> "unknown:null"
            }
            strBuilder.append("${string},")
        }
        if (strBuilder.length > 4) {
            strBuilder.deleteCharAt(strBuilder.length - 1)
        }
        strBuilder.append("}")
        return strBuilder.toString()
    }

    override fun onCleared() {
        voiceCapture?.stop()
        agentClient?.disconnect()
        actionHandler?.close()
        try { wifiLock?.release() } catch (_: Exception) {}
        super.onCleared()
    }
}
