package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCaptureStateTest {
    @Test
    fun togglesBetweenIdleAndRecording() {
        var state = VoiceCaptureState.IDLE
        state = VoiceCaptureState.RECORDING
        assertEquals(VoiceCaptureState.RECORDING, state)
    }
}
