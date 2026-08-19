package com.rokid.cxrswithcxrl.agent

class ReconnectTracker(private val staleMs: Long = 60_000L) {
    private var firstFailureAt: Long? = null

    fun recordFailure(now: Long) {
        if (firstFailureAt == null) {
            firstFailureAt = now
        }
    }

    fun markConnected() {
        firstFailureAt = null
    }

    fun isStale(now: Long): Boolean {
        val failedAt = firstFailureAt ?: return false
        return now - failedAt > staleMs
    }
}
