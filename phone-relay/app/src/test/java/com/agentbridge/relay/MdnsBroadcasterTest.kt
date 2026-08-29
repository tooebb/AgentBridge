package com.agentbridge.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class MdnsBroadcasterTest {
    @Test fun broadcastParamsMatchCoreProtocol() {
        assertEquals("_agentbridge._tcp", RelayConfig.SERVICE_TYPE)
        assertEquals("AgentBridge-phone-relay", RelayConfig.SERVICE_NAME)
        assertEquals(8088, RelayConfig.LISTEN_PORT)
        assertEquals("phone-relay", RelayConfig.TXT_RECORDS["id"])
        assertEquals("default", RelayConfig.TXT_RECORDS["session"])
        assertEquals("1", RelayConfig.TXT_RECORDS["version"])
    }
}
