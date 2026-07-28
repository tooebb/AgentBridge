package com.rokid.renewcxrlsample.link

import android.util.Log
import com.rokid.cxr.link.callbacks.ICXRLinkCbk
import com.rokid.cxr.link.utils.GlassInfo
import com.rokid.renewcxrlsample.app.CXRLApplication
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Single [ICXRLinkCbk] for the process. Registered only from CustomView / CustomApp session init.
 * Sub-modules collect connection StateFlows instead of calling [com.rokid.cxr.link.CXRLink.setCXRLinkCbk].
 */
object CxrLinkConnectionHub {

    private const val TAG = "CxrLinkConnectionHub"

    private val _cxrlConnected = MutableStateFlow(false)
    val cxrlConnected: StateFlow<Boolean> = _cxrlConnected.asStateFlow()

    private val _btConnected = MutableStateFlow(false)
    val btConnected: StateFlow<Boolean> = _btConnected.asStateFlow()

    private val _wearingCheckOn = MutableStateFlow<Boolean?>(null)
    val wearingCheckOn: StateFlow<Boolean?> = _wearingCheckOn.asStateFlow()

    private val _deviceInfoText = MutableStateFlow("")
    val deviceInfoText: StateFlow<String> = _deviceInfoText.asStateFlow()

    private val _brightness = MutableStateFlow(8)
    val brightness: StateFlow<Int> = _brightness.asStateFlow()

    private val _volume = MutableStateFlow(10)
    val volume: StateFlow<Int> = _volume.asStateFlow()

    private val _glassAiInterrupt = MutableSharedFlow<Boolean>(extraBufferCapacity = 1)
    val glassAiInterrupt: SharedFlow<Boolean> = _glassAiInterrupt.asSharedFlow()

    val linkCallback: ICXRLinkCbk = object : ICXRLinkCbk {
        override fun onCXRLConnected(connected: Boolean) {
            Log.i(TAG, "onCXRLConnected: connected=$connected (bt=${_btConnected.value})")
            _cxrlConnected.value = connected
            syncApplicationSessionReady()
        }

        override fun onGlassBtConnected(connected: Boolean) {
            Log.i(TAG, "onGlassBtConnected: connected=$connected (cxr=${_cxrlConnected.value})")
            _btConnected.value = connected
            syncApplicationSessionReady()
        }

        override fun onGlassAiAssistStart() {}

        override fun onGlassAiAssistStop() {}

        override fun onGlassAiInterrupt(interruptWake: Boolean) {
            _glassAiInterrupt.tryEmit(interruptWake)
        }

        override fun onGlassDeviceInfo(deviceInfo: GlassInfo) {
            Log.d(TAG, "onGlassDeviceInfo: $deviceInfo")
            _deviceInfoText.value = deviceInfo.toString()
            _brightness.value = deviceInfo.brightness
            _volume.value = deviceInfo.sound
        }

        override fun onGlassWearingStatus(wearing: Boolean) {
            Log.d(TAG, "onGlassWearingStatus: wearing=$wearing")
            _wearingCheckOn.value = wearing
        }
    }

    fun reset() {
        Log.d(TAG, "reset: clearing link state")
        _cxrlConnected.value = false
        _btConnected.value = false
        _wearingCheckOn.value = null
        _deviceInfoText.value = ""
        _brightness.value = 8
        _volume.value = 10
    }

    fun updateWearingCheck(on: Boolean) {
        _wearingCheckOn.value = on
    }

    fun updateDeviceInfo(text: String) {
        _deviceInfoText.value = text
    }

    private fun syncApplicationSessionReady() {
        val ready = _cxrlConnected.value && _btConnected.value
        val app = runCatching { CXRLApplication.instance }.getOrNull() ?: return
        app.isSessionReady = ready
        Log.d(TAG, "syncApplicationSessionReady: isSessionReady=$ready")
    }
}
