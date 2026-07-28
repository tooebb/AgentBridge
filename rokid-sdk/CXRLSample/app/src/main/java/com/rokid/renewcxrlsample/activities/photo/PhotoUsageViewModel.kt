package com.rokid.renewcxrlsample.activities.photo

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Log
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.link.CXRLink
import com.rokid.cxr.link.callbacks.IImageStreamCbk
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.app.CXRLApplication
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.link.CxrLinkConnectionHub
import com.rokid.sprite.aiapp.externalapp.auth.AuthorizationHelper
import com.rokid.sprite.aiapp.externalapp.auth.GlassPermission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Business ViewModel for photo capability.
 *
 * Reuses global connection, registers image callbacks,
 * and manages capture requests with result state.
 */
class PhotoUsageViewModel : ViewModel() {
    private var appContext: Context? = null

    private val _tokenGot = MutableStateFlow(false)
    val tokenGot = _tokenGot.asStateFlow()

    private val _photoTaking = MutableStateFlow(false)
    val photoTaking = _photoTaking.asStateFlow()

    private val _status = MutableStateFlow("")
    val status = _status.asStateFlow()

    private val _ready = MutableStateFlow(false)
    val ready = _ready.asStateFlow()

    private val _permissionGranted = MutableStateFlow(false)
    val permissionGranted = _permissionGranted.asStateFlow()

    private val _entryLabel = MutableStateFlow("")
    val entryLabel = _entryLabel.asStateFlow()

    private val _photo = MutableStateFlow<ImageBitmap?>(null)
    val photo = _photo.asStateFlow()

    private lateinit var cxrLink: CXRLink

    /**
     * Initializes page state and binds global CXRLink connection.
     */
    fun init(context: Context, token: String?, sessionType: CxrSessionType) {
        appContext = context.applicationContext
        _status.value = tr(R.string.photo_wait_take)
        _entryLabel.value = tr(sessionType.entryLabelRes)
        _tokenGot.value = !token.isNullOrBlank()
        if (!_tokenGot.value) {
            return
        }
        val app = context.applicationContext as? CXRLApplication
        if (app?.sharedLink == null || !app.isSessionReady) {
            _ready.value = false
            _status.value = tr(R.string.photo_need_connection)
            return
        }
        cxrLink = app.requireReadyLink()
        observeConnectionFromHub()
        cxrLink.setCXRImageCbk(object : IImageStreamCbk {
            override fun onImageReceived(data: ByteArray?) {
                _photoTaking.value = false
                _status.value = tr(R.string.photo_success)
                val bitmap = BitmapFactory.decodeByteArray(data, 0, data?.size ?: 0)
                _photo.value = bitmap?.asImageBitmap()
            }

            override fun onImageError(code: Int, msg: String?) {
                _photoTaking.value = false
                _status.value = tr(R.string.photo_failed, code, msg ?: "")
                _photo.value = null
            }
        })
        refreshGlassPermission()
        _status.value = if (_permissionGranted.value) {
            tr(R.string.photo_reuse_connection_wait_take)
        } else {
            tr(R.string.photo_no_camera_permission)
        }
    }

    private fun refreshGlassPermission() {
        _permissionGranted.value = AuthorizationHelper.hasGlassPermission(GlassPermission.CAMERA)
    }

    private fun resolveOperationalStatus(connected: Boolean): String = when {
        !_permissionGranted.value -> tr(R.string.photo_no_camera_permission)
        connected -> tr(R.string.photo_connected_wait_take)
        else -> tr(R.string.common_service_not_connected)
    }

    private fun observeConnectionFromHub() {
        viewModelScope.launch {
            CxrLinkConnectionHub.cxrlConnected.collect { connected ->
                refreshGlassPermission()
                _ready.value = connected && _permissionGranted.value
                _status.value = resolveOperationalStatus(connected)
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
     * Triggers a photo capture request.
     */
    fun takePhoto() {
        refreshGlassPermission()
        if (!_permissionGranted.value) {
            _photoTaking.value = false
            _status.value = tr(R.string.photo_no_camera_permission)
            Log.e("Take Photo", "takePhoto: Permission Denied")
            return
        }

        if (!::cxrLink.isInitialized || !_ready.value) return
        _photoTaking.value = true
        _status.value = tr(R.string.photo_taking_status)
        _photo.value = null
        cxrLink.takePhoto(1024, 768, 80).let {
            if (!it) {
                _photoTaking.value = false
                _status.value = tr(R.string.photo_failed, 0, "")
            }
        }
    }

    /**
     * Clears image callback and transient page state when leaving the page.
     */
    fun release() {
        if (::cxrLink.isInitialized) {
            runCatching {
                cxrLink.setCXRImageCbk(object : IImageStreamCbk {
                    override fun onImageReceived(data: ByteArray?) {}
                    override fun onImageError(code: Int, msg: String?) {}
                })
            }
        }
        _photoTaking.value = false
        _photo.value = null
    }

    private fun tr(@StringRes resId: Int, vararg args: Any): String {
        val context = appContext ?: return ""
        return context.getString(resId, *args)
    }
}
