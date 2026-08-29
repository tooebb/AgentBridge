package com.agentbridge.relay

import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap

open class RelayServer(
    private val config: RelayConfig,
    private val listenPort: Int = RelayConfig.LISTEN_PORT,
) {
    @Volatile private var running = false
    private var serverSocket: ServerSocket? = null
    private val connections = ConcurrentHashMap.newKeySet<Socket>()

    @Synchronized
    open fun start() {
        if (running) return
        val listener = ServerSocket(listenPort)
        serverSocket = listener
        running = true
        Thread({ acceptLoop(listener) }, "relay-accept").start()
    }

    fun actualPort(): Int = serverSocket?.localPort
        ?: throw IllegalStateException("Relay server is not running")

    private fun acceptLoop(listener: ServerSocket) {
        while (running) {
            val client = try {
                listener.accept()
            } catch (_: Exception) {
                if (!running) break
                continue
            }
            connections += client
            Thread({ handle(client) }, "relay-connection").start()
        }
    }

    private fun handle(client: Socket) {
        try {
            Socket(config.host, config.port).use { upstream ->
                connections += upstream
                try {
                    TcpRelay().relay(client, upstream)
                } finally {
                    connections -= upstream
                }
            }
        } catch (_: Exception) {
            runCatching { client.close() }
        } finally {
            connections -= client
        }
    }

    @Synchronized
    open fun stop() {
        running = false
        runCatching { serverSocket?.close() }
        serverSocket = null
        connections.forEach { runCatching { it.close() } }
        connections.clear()
    }
}
