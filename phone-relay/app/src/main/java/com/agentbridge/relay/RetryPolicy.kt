package com.agentbridge.relay

class RetryPolicy(
    private val baseDelayMs: Long = 1_000L,
    private val maxDelayMs: Long = 30_000L,
) {
    fun delayMs(attempt: Int): Long {
        var delay = baseDelayMs
        repeat(attempt.coerceAtLeast(0)) {
            delay = (delay * 2).coerceAtMost(maxDelayMs)
        }
        return delay
    }
}
