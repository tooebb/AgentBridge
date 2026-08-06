package com.rokid.cxrswithcxrl.agent

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.gson.Gson
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

class AgentBridgeClient(
    context: Context,
    private val serverUrl: String = DEFAULT_SERVER_URL,
    private val sessionId: String = DEFAULT_SESSION_ID,
    private val listener: Listener,
    bindIp: String? = null
) {
    interface Listener {
        fun onConnectionChanged(label: String)
        fun onMessage(message: DeviceMessage, duplicate: Boolean)
        fun onError(label: String, throwable: Throwable?)
    }

    private val gson = Gson()
    private val prefs: SharedPreferences =
        context.getSharedPreferences("agent_bridge", Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .apply {
            if (bindIp != null) {
                val addr = InetSocketAddress(bindIp, 0)
                socketFactory(BindSocketFactory(addr))
            }
        }
        .build()

    private var webSocket: WebSocket? = null
    private var closedByUser = false
    private var reconnectDelayMs = 2_000L
    private val seenSeqs = linkedSetOf<Long>()
    private val seenMessageIds = linkedSetOf<String>()

    // Start from 0 each app launch to avoid seq mismatch when Core restarts.
    var lastAckedSeq: Long = 0L
        private set

    fun connect() {
        closedByUser = false
        // Reset seq tracking on each new connection to handle Core restarts.
        // Core's event store is in-memory and seq counters reset on restart.
        seenSeqs.clear()
        seenMessageIds.clear()
        lastAckedSeq = 0L
        listener.onConnectionChanged("WS: connecting")
        val request = Request.Builder()
            .url(wsUrl())
            .build()
        webSocket = httpClient.newWebSocket(request, socketListener)
    }

    fun disconnect() {
        closedByUser = true
        mainHandler.removeCallbacksAndMessages(null)
        webSocket?.close(1000, "activity stopped")
        webSocket = null
        listener.onConnectionChanged("WS: disconnected")
    }

    fun sendAction(taskId: String, actionType: String, text: String = ""): Boolean {
        if (taskId.isBlank()) {
            listener.onError("No active task for action=$actionType", null)
            return false
        }
        val message = ClientMessage(
            sessionId = sessionId,
            taskId = taskId,
            lastAckedSeq = lastAckedSeq,
            action = ClientAction(type = actionType, text = text)
        )
        val sent = webSocket?.send(gson.toJson(message)) == true
        if (!sent) {
            listener.onError("Action send failed: $actionType", null)
        }
        return sent
    }

    private fun wsUrl(): String {
        val base = serverUrl.trimEnd('/').replaceFirst("^http".toRegex(), "ws")
        val params = mutableListOf("device_type=$DEVICE_TYPE_AR_GLASSES")
        if (lastAckedSeq > 0) {
            params += "last_acked_seq=$lastAckedSeq"
        }
        return "$base/ws/$sessionId?${params.joinToString("&")}"
    }

    private val socketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectDelayMs = 2_000L
            listener.onConnectionChanged("WS: connected")
            Log.d(TAG, "connected ${wsUrl()}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching {
                gson.fromJson(text, DeviceMessage::class.java)
            }.onSuccess { message ->
                val duplicate = markAck(message)
                listener.onMessage(message, duplicate)
            }.onFailure {
                listener.onError("Invalid WS message", it)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            listener.onError("WS failure: ${t.message ?: "unknown"}", t)
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            listener.onConnectionChanged("WS: closed $code")
            scheduleReconnect()
        }
    }

    private fun markAck(message: DeviceMessage): Boolean {
        val seq = message.seq
        if (seq > 0) {
            if (seq <= lastAckedSeq || seenSeqs.contains(seq)) {
                return true
            }
            seenSeqs += seq
            if (seenSeqs.size > MAX_SEEN) {
                seenSeqs.remove(seenSeqs.first())
            }
            lastAckedSeq = seq
            return false
        }

        val messageId = message.messageId
        if (messageId.isBlank()) {
            return false
        }
        if (seenMessageIds.contains(messageId)) {
            return true
        }
        seenMessageIds += messageId
        if (seenMessageIds.size > MAX_SEEN) {
            seenMessageIds.remove(seenMessageIds.first())
        }
        return false
    }

    private fun scheduleReconnect() {
        if (closedByUser) {
            return
        }
        val delay = reconnectDelayMs
        listener.onConnectionChanged("WS: retry in ${delay / 1000}s")
        mainHandler.postDelayed({ connect() }, delay)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
    }

    companion object {
        private const val TAG = "AgentBridgeClient"
        const val DEFAULT_SERVER_URL = "ws://127.0.0.1:19090"
        const val DEFAULT_SESSION_ID = "default"
        private const val KEY_LAST_ACKED_SEQ = "last_acked_seq"
        private const val MAX_SEEN = 200
    }
}

private class BindSocketFactory(
    private val bindAddr: InetSocketAddress
) : SocketFactory() {
    override fun createSocket(): Socket = Socket().apply { bind(bindAddr) }
    override fun createSocket(host: String, port: Int): Socket =
        Socket().apply { bind(bindAddr); connect(InetSocketAddress(host, port)) }
    override fun createSocket(host: String, port: Int, localHost: java.net.InetAddress, localPort: Int): Socket =
        Socket().apply { bind(InetSocketAddress(localHost, localPort)); connect(InetSocketAddress(host, port)) }
    override fun createSocket(host: java.net.InetAddress, port: Int): Socket =
        Socket().apply { bind(bindAddr); connect(InetSocketAddress(host, port)) }
    override fun createSocket(
        address: java.net.InetAddress, port: Int,
        localAddress: java.net.InetAddress, localPort: Int
    ): Socket =
        Socket().apply { bind(InetSocketAddress(localAddress, localPort)); connect(InetSocketAddress(address, port)) }
}
