package com.agentbridge.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayConfigTest {
    @Test fun defaultsMatchSpec() {
        assertEquals("100.117.117.37", RelayConfig.DEFAULT_HOST)
        assertEquals(8088, RelayConfig.DEFAULT_PORT)
        assertEquals(8788, RelayConfig.AUDIO_PORT)
        assertEquals("_agentbridge._tcp", RelayConfig.SERVICE_TYPE)
        assertEquals("AgentBridge-phone-relay", RelayConfig.SERVICE_NAME)
    }

    @Test fun txtRecordsMatchCoreProtocol() {
        assertEquals("phone-relay", RelayConfig.TXT_RECORDS["id"])
        assertEquals("default", RelayConfig.TXT_RECORDS["session"])
        assertEquals("1", RelayConfig.TXT_RECORDS["version"])
    }

    @Test fun parseHostOnlyUsesDefaultPort() {
        assertEquals(RelayConfig("100.117.117.37", 8088), RelayConfig.parse("100.117.117.37"))
    }

    @Test fun parseHostAndPort() {
        assertEquals(RelayConfig("10.0.0.5", 9000), RelayConfig.parse("10.0.0.5:9000"))
    }

    @Test fun parseBlankReturnsNull() {
        assertNull(RelayConfig.parse(""))
        assertNull(RelayConfig.parse("   "))
    }
}
