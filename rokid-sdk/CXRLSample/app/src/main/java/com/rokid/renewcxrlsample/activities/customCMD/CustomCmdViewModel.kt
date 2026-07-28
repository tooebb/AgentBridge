package com.rokid.renewcxrlsample.activities.customCMD

import android.content.Context
import android.util.Base64
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.Caps
import com.rokid.cxr.link.CXRLink
import com.rokid.cxr.link.callbacks.ICustomCmdCbk
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.app.CXRLApplication
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.link.CxrLinkConnectionHub
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for custom command interactions.
 *
 * Responsibilities:
 * 1) Validate whether current entry type supports custom commands.
 * 2) Reuse an existing shared CXR link session created by CustomAppType flow.
 * 3) Send sample commands and parse response Caps payload for UI display.
 */
class CustomCmdViewModel : ViewModel() {
    private var appContext: Context? = null

    private val _tokenGot = MutableStateFlow(false)
    val tokenGot = _tokenGot.asStateFlow()

    private val _available = MutableStateFlow(false)
    val available = _available.asStateFlow()

    private val _from = MutableStateFlow("")
    val from = _from.asStateFlow()

    private val _ready = MutableStateFlow(false)
    val ready = _ready.asStateFlow()

    private val _status = MutableStateFlow("")
    val status = _status.asStateFlow()

    private val _entryLabel = MutableStateFlow("")
    val entryLabel = _entryLabel.asStateFlow()

    private var count = 0
    private lateinit var cxrLink: CXRLink

    /**
     * Initializes screen state and binds callbacks for link and custom command events.
     *
     * This page intentionally does not create a new link; it depends on a previously
     * established link from the CustomAppType path to keep one shared connection.
     */
    fun init(context: Context, token: String?, sessionType: CxrSessionType) {
        appContext = context.applicationContext
        _tokenGot.value = !token.isNullOrBlank()
        _available.value = sessionType == CxrSessionType.CUSTOM_APP
        _status.value = tr(R.string.custom_cmd_status_waiting_connection)
        _entryLabel.value = tr(sessionType.entryLabelRes)
        if (!_tokenGot.value || !_available.value) {
            return
        }
        val app = context.applicationContext as? CXRLApplication
        if (app?.sharedLink == null || !app.isSessionReady) {
            _ready.value = false
            _status.value = tr(R.string.custom_cmd_need_custom_app_connection)
            return
        }
        cxrLink = app.requireReadyLink()
        observeConnectionFromHub()
        cxrLink.setCXRCustomCmdCbk(object : ICustomCmdCbk {
            override fun onCustomCmdResult(key: String?, payload: ByteArray?) {
                // Ignore unrelated command channels and only parse the agreed demo key.
                if (key != "rk_custom_key") {
                    return
                }
                val caps = payload?.let { Caps.fromBytes(it) } ?: return
                _from.value = parseCaps(caps)
            }
        })
        _status.value = tr(R.string.custom_cmd_reuse_connection)
    }

    private fun observeConnectionFromHub() {
        viewModelScope.launch {
            CxrLinkConnectionHub.cxrlConnected.collect { connected ->
                _ready.value = connected
                _status.value = if (connected) {
                    tr(R.string.custom_cmd_connected_hint)
                } else {
                    tr(R.string.common_service_not_connected)
                }
            }
        }
        viewModelScope.launch {
            CxrLinkConnectionHub.btConnected.collect { connected ->
                if (!connected) {
                    _ready.value = false
                    _status.value = tr(R.string.common_bt_not_connected)
                }
            }
        }
    }

    /**
     * Sends a demo custom command to the glasses side.
     *
     * A monotonically increasing counter is appended so responses can be distinguished
     * during manual repeated tests.
     */
    fun sendMessage() {
        if (!_available.value || !::cxrLink.isInitialized || !_ready.value) {
            return
        }
        cxrLink.sendCustomCmd(
            "rk_custom_client",
            Caps().apply {
                write("rk_custom_key")
                write("from client click times = ${count++}")
            }
        )
    }

    /**
     * Unregisters custom command callback when leaving the page.
     */
    fun release() {
        if (::cxrLink.isInitialized) {
            runCatching {
                cxrLink.setCXRCustomCmdCbk(object : ICustomCmdCbk {
                    override fun onCustomCmdResult(key: String?, payload: ByteArray?) {}
                })
            }
        }
        _ready.value = false
    }

    /**
     * Recursively parses a Caps object into a readable string representation.
     *
     * The parser keeps type information (string/int/long/object/binary) so payload
     * structure remains debuggable from the UI without attaching a low-level inspector.
     */
    private fun parseCaps(caps: Caps): String {
        val builder = StringBuilder("{")
        for (i in 0 until caps.size()) {
            val value = caps.at(i)
            val text = when (value.type()) {
                Caps.Value.TYPE_STRING -> "string:${value.string}"
                Caps.Value.TYPE_INT32, Caps.Value.TYPE_UINT32 -> "int:${value.int}"
                Caps.Value.TYPE_INT64, Caps.Value.TYPE_UINT64 -> "long:${value.long}"
                Caps.Value.TYPE_FLOAT -> "float:${value.float}"
                Caps.Value.TYPE_DOUBLE -> "double:${value.double}"
                Caps.Value.TYPE_OBJECT -> parseCaps(value.`object`)
                Caps.Value.TYPE_BINARY -> value.binary?.let {
                    "binary:${Base64.encode(it.data, it.length)}"
                } ?: "binary:null"
                else -> "unknown:null"
            }
            builder.append(text).append(",")
        }
        if (builder.length > 1) {
            builder.deleteCharAt(builder.length - 1)
        }
        builder.append("}")
        return builder.toString()
    }

    private fun tr(@StringRes resId: Int, vararg args: Any): String {
        val context = appContext ?: return ""
        return context.getString(resId, *args)
    }
}
