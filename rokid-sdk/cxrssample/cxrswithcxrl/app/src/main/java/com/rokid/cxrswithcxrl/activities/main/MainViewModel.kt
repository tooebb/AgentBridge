package com.rokid.cxrswithcxrl.activities.main

import android.util.Base64
import android.util.Log
import androidx.lifecycle.ViewModel
import com.rokid.cxr.CXRServiceBridge
import com.rokid.cxr.Caps
import com.rokid.cxrswithcxrl.receiver.KeyEventListener
import com.rokid.cxrswithcxrl.receiver.KeyReceiver
import com.rokid.cxrswithcxrl.receiver.KeyType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Diagnostic build: surface subscribe return value + connection state on screen
 * to determine whether CXR-S subscribe is failing or messages are being dropped upstream.
 */
class MainViewModel: ViewModel() {
    private val _capsFromClient = MutableStateFlow("subscribe: pending...")
    val capsFromClient = _capsFromClient.asStateFlow()

    private val _debugStatus = MutableStateFlow("init")
    val debugStatus = _debugStatus.asStateFlow()

    private val cxrBridge = CXRServiceBridge()

    private val cmdKey = "rk_custom_key"
    private val clientKey = "rk_custom_client"

    private val keyEventListener = object : KeyEventListener {
        override fun onKeyEvent(keyType: KeyType) {
            sendMessage("Listener: key action = ${keyType.name}")
        }
    }

    val keyReceiver = KeyReceiver(keyEventListener)

    private val connectionCallback = object : CXRServiceBridge.StatusListener{
        override fun onConnected(p0: String?, p1: String?, p2: Int) {
            Log.d("CXR", "onConnected: p0=$p0 p1=$p1 p2=$p2")
            val result = cxrBridge.subscribe(clientKey, msgCallback)
            Log.d("CXR", "subscribe in onConnected returned: $result")
            _debugStatus.value = "onConnected, sub=$result"
        }

        override fun onDisconnected() {
            Log.d("CXR", "onDisconnected")
            _debugStatus.value = "disconnected"
        }

        override fun onConnecting(p0: String?, p1: String?, p2: Int) {
            Log.d("CXR", "onConnecting: p0=$p0 p1=$p1 p2=$p2")
            _debugStatus.value = "connecting..."
        }

        override fun onARTCStatus(p0: Float, p1: Boolean) {}
        override fun onRokidAccountChanged(p0: String?) {}
        override fun onAudioNoise(p0: Float) {}
    }

    private val msgCallback = object : CXRServiceBridge.MsgCallback {
        override fun onReceive(name: String?, args: Caps?, bytes: ByteArray?) {
            val received = "RECV: name=$name, args=${args?.let { parseCaps(it) } ?: "null"}"
            Log.d("CXR", "onReceive: $received")
            _capsFromClient.value = received
        }
    }

    init {
        cxrBridge.setStatusListener(connectionCallback)
        // Try subscribe in init and capture return value.
        val result = cxrBridge.subscribe(clientKey, msgCallback)
        Log.d("CXR", "subscribe in init returned: $result (0=ok, -1=bad arg, -2=dup)")
        _capsFromClient.value = when (result) {
            0 -> "subscribe init: OK (0)"
            -1 -> "subscribe init: BAD ARG (-1)"
            -2 -> "subscribe init: DUP (-2)"
            else -> "subscribe init: $result"
        }
        _debugStatus.value = "init done, bridge set"
    }

    fun sendMessage(str: String){
        val result = cxrBridge.sendMessage(cmdKey, Caps().apply {
            write("message")
            write(str)
        })
        Log.d("CXR", "sendMessage result=$result")
    }

    private fun parseCaps(caps: Caps): String {
        val strBuilder = StringBuilder("{")
        for (i in 0 until caps.size()) {
            val capsValue = caps.at(i)
            val string = when (capsValue.type()) {
                Caps.Value.TYPE_STRING -> "string:${capsValue.string}"
                Caps.Value.TYPE_INT32, Caps.Value.TYPE_UINT32 -> "int:${capsValue.int}"
                Caps.Value.TYPE_INT64, Caps.Value.TYPE_UINT64 -> "long:${capsValue.long}"
                Caps.Value.TYPE_FLOAT -> "float:${capsValue.float}"
                Caps.Value.TYPE_DOUBLE -> "double:${capsValue.double}"
                Caps.Value.TYPE_OBJECT -> parseCaps(capsValue.`object`)
                Caps.Value.TYPE_BINARY -> capsValue.binary?.let {
                    "binary:${Base64.encode(it.data, it.length)}"
                } ?: "binary:null"
                else -> "unknown:null"
            }
            strBuilder.append("${string},")
        }
        if (strBuilder.length > 4) {
            strBuilder.deleteCharAt(strBuilder.length - 1)
        }
        strBuilder.append("}")
        return strBuilder.toString()
    }
}
