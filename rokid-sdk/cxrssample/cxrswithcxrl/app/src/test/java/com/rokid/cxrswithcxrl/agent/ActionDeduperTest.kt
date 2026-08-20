package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionDeduperTest {

    @Test
    fun shouldSend_rejectsDuplicateTaskAndActionWithinWindow() {
        val deduper = ActionDeduper(windowMs = 600L)

        assertTrue(deduper.shouldSend("task-1", "reject", nowMs = 1_000L))
        assertFalse(deduper.shouldSend("task-1", "reject", nowMs = 1_500L))
    }

    @Test
    fun shouldSend_allowsDifferentTaskOrAction() {
        val deduper = ActionDeduper(windowMs = 600L)

        assertTrue(deduper.shouldSend("task-1", "reject", nowMs = 1_000L))
        assertTrue(deduper.shouldSend("task-2", "reject", nowMs = 1_100L))
        assertTrue(deduper.shouldSend("task-2", "approve", nowMs = 1_200L))
    }

    @Test
    fun shouldSend_allowsSameTaskAndActionAfterWindow() {
        val deduper = ActionDeduper(windowMs = 600L)

        assertTrue(deduper.shouldSend("task-1", "reject", nowMs = 1_000L))
        assertTrue(deduper.shouldSend("task-1", "reject", nowMs = 1_600L))
    }
}
