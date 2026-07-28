package com.rokid.renewcxrlsample.activities.main

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.annotation.StringRes
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.activities.session.CxrSessionActivity
import com.rokid.renewcxrlsample.app.CONSTANT
import com.rokid.renewcxrlsample.app.CONSTANT.REQUEST_CODE_AUTH
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.utils.BaseViewModel
import com.rokid.sprite.aiapp.externalapp.auth.AuthResult
import com.rokid.sprite.aiapp.externalapp.auth.AuthorizationHelper
import com.rokid.sprite.aiapp.externalapp.auth.GlassPermission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import androidx.lifecycle.viewModelScope

enum class CompanionAppType {
    None,
    RokidAi,
    HiRokid,
}

class MainViewModel : BaseViewModel() {

    private var appContext: Context? = null

    private val _isRokidAppInstalled = MutableStateFlow(false)
    val isRokidAppInstalled = _isRokidAppInstalled.asStateFlow()

    private val _isAuthenticated = MutableStateFlow(false)
    val isAuthenticated = _isAuthenticated.asStateFlow()

    private var token = ""

    private val _isConnectHiRokid = MutableStateFlow(false)
    val isConnectHiRokid = _isConnectHiRokid.asStateFlow()

    private val _infoText = MutableStateFlow("")
    val infoText = _infoText.asStateFlow()

    private val _companionAppType = MutableStateFlow(CompanionAppType.None)
    val companionAppType = _companionAppType.asStateFlow()

    val currentStep = combine(_isRokidAppInstalled, _isAuthenticated) { installed, auth ->
        when {
            !installed -> HomeFlowStep.InstallCompanion
            !auth -> HomeFlowStep.Authorize
            else -> HomeFlowStep.SelectScene
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeFlowStep.InstallCompanion)

    fun isRokidAppInstalled(act: Activity) {
        appContext = act.applicationContext
        _isConnectHiRokid.value = AuthorizationHelper.isConnectHiRokid()
        when {
            AuthorizationHelper.isRequiredRokidAppInstalled(act) -> {
                _isRokidAppInstalled.value = true
                _companionAppType.value = CompanionAppType.RokidAi
                _infoText.value = tr(R.string.main_install_rokid_ai_ok)
            }
            AuthorizationHelper.isRequiredHiRokidInstalled(act) -> {
                _isRokidAppInstalled.value = true
                _companionAppType.value = CompanionAppType.HiRokid
                _infoText.value = tr(R.string.main_install_hi_rokid_ok)
            }
            else -> {
                _isRokidAppInstalled.value = false
                _companionAppType.value = CompanionAppType.None
                _infoText.value = tr(R.string.main_install_wrong)
            }
        }
    }

    var authFromHistory = false

    fun checkAuth(act: Activity) {
        AuthorizationHelper.requestAuthorization(
            act,
            arrayOf(GlassPermission.MICROPHONE, GlassPermission.CAMERA, GlassPermission.MEDIA),// 后续功能的权限---麦克风、相机、Media（文件）
            REQUEST_CODE_AUTH
        )?.let {
            authFromHistory = true
            parseAuthResult(it.first, it.second)
        } ?: run {
            authFromHistory = false
        }
    }

    fun parseAuthResult(resultCode: Int, data: Intent?) {
        AuthorizationHelper.parseAuthorizationResult(resultCode, data).let { result ->
            when (result) {
                is AuthResult.AuthSuccess -> {
                    token = result.token
                    _isAuthenticated.value = token.isNotBlank()
                    _infoText.value = if (_isAuthenticated.value) {
                        tr(R.string.auth_success)
                    } else {
                        tr(R.string.auth_failed)
                    }
                }
                is AuthResult.AuthFail -> {
                    token = ""
                    _isAuthenticated.value = false
                    _infoText.value = tr(R.string.auth_failed)
                }
                is AuthResult.AuthCancel -> {
                    token = ""
                    _isAuthenticated.value = false
                    _infoText.value = tr(R.string.auth_cancelled)
                }
            }
        }
    }

    fun restoreSessionToken(sessionToken: String) {
        if (sessionToken.isBlank()) return
        token = sessionToken
        _isAuthenticated.value = true
        _infoText.value = tr(R.string.auth_success)
    }

    fun toSession(context: Activity, type: CxrSessionType) {
        if (token.isBlank()) return
        context.startActivity(
            Intent(context, CxrSessionActivity::class.java).apply {
                putExtra(CONSTANT.EXTRA_TOKEN, token)
                putExtra(CONSTANT.EXTRA_SESSION_TYPE, type.wireValue)
            }
        )
        context.finish()
    }

    private fun tr(@StringRes resId: Int, vararg args: Any): String {
        val context = appContext ?: return ""
        return context.getString(resId, *args)
    }
}
