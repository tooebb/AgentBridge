package com.rokid.renewcxrlsample.app

import android.app.Application
import com.rokid.cxr.link.CXRLink

class CXRLApplication : Application() {

    companion object {
        lateinit var instance: CXRLApplication
    }

    var sharedLink: CXRLink? = null
    var isSessionReady: Boolean = false

    fun requireReadyLink(): CXRLink {
        check(sharedLink != null && isSessionReady) {
            "CXRLink session not ready: complete configCXRSession and connect first"
        }
        return sharedLink!!
    }

    fun resetSession() {
        sharedLink = null
        isSessionReady = false
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }
}
