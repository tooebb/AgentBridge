package com.rokid.cxrswithcxrl.agent

class ReconnectGuard {
    private var scheduled = false

    @Synchronized
    fun trySchedule(): Boolean {
        if (scheduled) {
            return false
        }
        scheduled = true
        return true
    }

    @Synchronized
    fun clear() {
        scheduled = false
    }
}
