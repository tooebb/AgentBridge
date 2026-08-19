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
