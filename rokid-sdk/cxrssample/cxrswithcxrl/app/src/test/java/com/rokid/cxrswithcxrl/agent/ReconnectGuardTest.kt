package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectGuardTest {

    @Test
    fun `first schedule allowed`() {
        assertTrue(ReconnectGuard().trySchedule())
    }

    @Test
    fun `second schedule blocked until clear`() {
        val guard = ReconnectGuard()

        assertTrue(guard.trySchedule())
        assertFalse(guard.trySchedule())
        guard.clear()
        assertTrue(guard.trySchedule())
    }
}
