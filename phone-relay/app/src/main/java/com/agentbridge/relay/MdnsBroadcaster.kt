package com.agentbridge.relay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

class MdnsBroadcaster(private val context: Context, private val listenPort: Int) {
    private var nsdManager: NsdManager? = null
    private var listener: NsdManager.RegistrationListener? = null

    fun start() {
        if (listener != null) return
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        val info = NsdServiceInfo().apply {
            serviceName = RelayConfig.SERVICE_NAME
            serviceType = RelayConfig.SERVICE_TYPE
            setPort(listenPort)
            RelayConfig.TXT_RECORDS.forEach { (key, value) -> setAttribute(key, value) }
        }
        val registrationListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "mDNS registered: ${serviceInfo.serviceName}")
            }

            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS registration failed: $errorCode")
            }

            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
        }
        nsdManager = nsd
        listener = registrationListener
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener)
    }

    fun stop() {
        val nsd = nsdManager
        val registrationListener = listener
        listener = null
        nsdManager = null
        if (nsd != null && registrationListener != null) {
            runCatching { nsd.unregisterService(registrationListener) }
        }
    }

    private companion object { const val TAG = "Relay" }
}
