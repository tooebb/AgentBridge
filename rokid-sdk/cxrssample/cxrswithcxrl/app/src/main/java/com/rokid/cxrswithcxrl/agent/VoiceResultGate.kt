package com.rokid.cxrswithcxrl.agent

class VoiceResultGate {
    private var pending = false

    fun markPending() {
        pending = true
    }

    fun cancel() {
        pending = false
    }

    fun shouldDisplayResult(): Boolean {
        if (!pending) return false
        pending = false
        return true
    }
}
