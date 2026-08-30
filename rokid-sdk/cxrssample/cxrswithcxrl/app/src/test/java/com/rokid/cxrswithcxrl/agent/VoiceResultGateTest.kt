package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceResultGateTest {
    @Test
    fun resultNotDisplayedWhenNeverStarted() {
        val gate = VoiceResultGate()
        assertFalse(gate.shouldDisplayResult())
    }

    @Test
    fun resultDisplayedOnceAfterStart() {
        val gate = VoiceResultGate()
        gate.markPending()
        assertTrue(gate.shouldDisplayResult())
        assertFalse(gate.shouldDisplayResult())
    }

    @Test
    fun cancelSuppressesPendingResult() {
        val gate = VoiceResultGate()
        gate.markPending()
        gate.cancel()
        assertFalse(gate.shouldDisplayResult())
    }

    @Test
    fun restartAfterCancelDisplaysNewResult() {
        val gate = VoiceResultGate()
        gate.markPending()
        gate.cancel()
        gate.markPending()
        assertTrue(gate.shouldDisplayResult())
    }
}
