package com.rokid.cxrswithcxrl.agent

class ActionDeduper(private val windowMs: Long = 600L) {
    private var lastKey: String? = null
    private var lastAt: Long = 0L

    fun shouldSend(taskId: String, action: String, nowMs: Long): Boolean {
        val key = "$taskId:$action"
        if (key == lastKey && nowMs - lastAt < windowMs) {
            return false
        }
        lastKey = key
        lastAt = nowMs
        return true
    }
}
