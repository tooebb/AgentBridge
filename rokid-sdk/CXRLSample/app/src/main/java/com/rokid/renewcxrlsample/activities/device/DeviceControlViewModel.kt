package com.rokid.renewcxrlsample.activities.device

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.link.CXRLink
import com.rokid.renewcxrlsample.app.CXRLApplication
import com.rokid.renewcxrlsample.link.CxrLinkConnectionHub
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class DeviceControlViewModel : ViewModel() {

    private val _brightness = MutableStateFlow(8)
    val brightness: StateFlow<Int> = _brightness.asStateFlow()

    private val _volume = MutableStateFlow(10)
    val volume: StateFlow<Int> = _volume.asStateFlow()

    init {
        viewModelScope.launch {
            CxrLinkConnectionHub.brightness.collect { _brightness.value = it }
        }
        viewModelScope.launch {
            CxrLinkConnectionHub.volume.collect { _volume.value = it }
        }
    }

    fun setBrightness(level: Int) {
        val link = readyLinkOrNull() ?: return
        _brightness.value = level
        link.setGlassBrightness(level)
    }

    fun setVolume(level: Int) {
        val link = readyLinkOrNull() ?: return
        _volume.value = level
        link.setGlassVolume(level)
    }

    fun refreshDeviceInfo() {
        val link = readyLinkOrNull() ?: return
        link.getGlassDeviceInfo()
    }

    private fun readyLinkOrNull(): CXRLink? =
        runCatching { CXRLApplication.instance.requireReadyLink() }.getOrNull()
}
