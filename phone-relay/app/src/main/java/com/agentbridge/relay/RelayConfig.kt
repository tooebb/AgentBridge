package com.agentbridge.relay

data class RelayConfig(val host: String, val port: Int) {
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
            val host = trimmed.substring(0, idx)
            if (host.isBlank()) return null
            return RelayConfig(host, port)
        }
    }
}
