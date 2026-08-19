package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectTrackerTest {

    @Test
    fun `not stale before threshold`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        assertFalse(tracker.isStale(60_000L))
    }

    @Test
    fun `stale after threshold`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        assertTrue(tracker.isStale(61_001L))
    }

    @Test
    fun `keeps original first failure across repeated failures`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        tracker.recordFailure(30_000L)
        tracker.recordFailure(50_000L)
        assertTrue(tracker.isStale(61_001L))
    }

    @Test
    fun `not stale when never failed`() {
        val tracker = ReconnectTracker()
        assertFalse(tracker.isStale(Long.MAX_VALUE))
    }

    @Test
    fun `reset after connected`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        tracker.markConnected()
        assertFalse(tracker.isStale(99_999L))
    }

    @Test
    fun `boundary exactly threshold is not stale`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        assertFalse(tracker.isStale(61_000L))
    }

    @Test
    fun `first failure at zero can become stale`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(0L)
        assertTrue(tracker.isStale(60_001L))
    }
}
