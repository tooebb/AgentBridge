package com.agentbridge.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class RetryPolicyTest {
    @Test fun doublesUntilCap() {
        val p = RetryPolicy(baseDelayMs = 1_000L, maxDelayMs = 30_000L)
        assertEquals(1_000L, p.delayMs(0))
        assertEquals(2_000L, p.delayMs(1))
        assertEquals(4_000L, p.delayMs(2))
        assertEquals(8_000L, p.delayMs(3))
        assertEquals(16_000L, p.delayMs(4))
        assertEquals(30_000L, p.delayMs(5))
        assertEquals(30_000L, p.delayMs(6))
    }

    @Test fun negativeAttemptTreatsAsZero() {
        val p = RetryPolicy()
        assertEquals(1_000L, p.delayMs(-1))
    }
}
