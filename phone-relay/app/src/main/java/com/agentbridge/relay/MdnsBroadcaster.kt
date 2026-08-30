package com.agentbridge.relay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log

class MdnsBroadcaster(private val context: Context, private val listenPort: Int) {
    private val handler = Handler(Looper.getMainLooper())
    private val retryPolicy = RetryPolicy()
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var retryAttempt = 0

    fun start() {
        if (registrationListener != null) return
        register()
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        unregister()
    }

    fun restart() {
        handler.removeCallbacksAndMessages(null)
        unregister()
        handler.postDelayed({ start() }, RESTART_DELAY_MS)
    }

    private fun register() {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        val info = NsdServiceInfo().apply {
            serviceName = RelayConfig.SERVICE_NAME
            serviceType = RelayConfig.SERVICE_TYPE
            setPort(listenPort)
            RelayConfig.TXT_RECORDS.forEach { (key, value) -> setAttribute(key, value) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "mDNS registered: ${serviceInfo.serviceName}")
                retryAttempt = 0
            }

            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS registration failed: $errorCode")
                registrationListener = null
                val delay = retryPolicy.delayMs(retryAttempt)
                retryAttempt++
                handler.postDelayed({ start() }, delay)
            }

            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "mDNS unregistered: ${serviceInfo.serviceName}")
            }

            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS unregistration failed: $errorCode")
            }
        }
        registrationListener = listener
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    private fun unregister() {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        val listener = registrationListener
        registrationListener = null
        if (listener != null) {
            runCatching { nsd.unregisterService(listener) }
        }
    }

    private companion object {
        const val TAG = "Relay"
        const val RESTART_DELAY_MS = 300L
    }
}
