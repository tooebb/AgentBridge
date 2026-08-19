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
