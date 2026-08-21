package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MicProbeStatsTest {

    @Test
    fun `tracks sample count peak and rms`() {
        val stats = MicProbeStats()

        stats.add(shortArrayOf(-3, 4, 0), 3)

        val snapshot = stats.snapshot()
        assertEquals(3L, snapshot.samples)
        assertEquals(4.0, snapshot.peak, 0.001)
        assertEquals(2.887, snapshot.rms, 0.001)
    }

    @Test
    fun `ignores non-positive reads`() {
        val stats = MicProbeStats()

        stats.add(shortArrayOf(10), -1)
        stats.add(shortArrayOf(10), 0)

        val snapshot = stats.snapshot()
        assertEquals(0L, snapshot.samples)
        assertEquals(0.0, snapshot.peak, 0.001)
        assertEquals(0.0, snapshot.rms, 0.001)
    }

    @Test
    fun `formats progress with count peak and rms`() {
        val text = MicProbe.formatProgress("MIC", MicProbeSnapshot(samples = 16000, peak = 350.0, rms = 42.0))

        assertTrue(text.contains("samples=16000"))
        assertTrue(text.contains("peak=350"))
        assertTrue(text.contains("rms=42"))
    }
}
