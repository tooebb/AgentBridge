package com.rokid.renewcxrlsample.activities.session

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Environment
import android.util.Base64
import androidx.core.graphics.createBitmap
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.link.CXRLink
import com.rokid.cxr.link.callbacks.ICustomViewCbk
import com.rokid.cxr.link.callbacks.IGlassAppCbk
import com.rokid.cxr.link.utils.IconInfo
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.app.CONSTANT
import com.rokid.renewcxrlsample.dataBean.selfView.ImageViewProps
import com.rokid.renewcxrlsample.dataBean.selfView.LinearLayoutProps
import com.rokid.renewcxrlsample.dataBean.selfView.SelfViewJson
import com.rokid.renewcxrlsample.dataBean.selfView.TextViewProps
import com.rokid.renewcxrlsample.dataBean.selfView.UpdateViewJson
import com.rokid.renewcxrlsample.link.CxrLinkConnectionHub
import com.rokid.renewcxrlsample.navigation.CxrSceneNavigation
import com.rokid.renewcxrlsample.session.CxrScenePhase
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.utils.ApkInstallAccess
import com.rokid.renewcxrlsample.utils.BaseViewModel
import com.rokid.renewcxrlsample.utils.CxrSessionGate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.File

class SessionHubViewModel : BaseViewModel() {

    private lateinit var cxrLink: CXRLink
    private var appContext: Context? = null
    private var sessionType: CxrSessionType = CxrSessionType.CUSTOM_APP
    private var iconsString = ""
    private var customViewIconsSentForReadyLink = false
    private var customViewUpdateCount = 1
    private var lastSessionReadyForAppQuery = false

    private val _tokenGot = MutableStateFlow(false)
    val tokenGot = _tokenGot.asStateFlow()

    private val _connected = MutableStateFlow(false)
    val connected = _connected.asStateFlow()

    private val _btConnected = MutableStateFlow(false)
    val btConnected = _btConnected.asStateFlow()

    private val _customViewOpened = MutableStateFlow(false)
    val customViewOpened = _customViewOpened.asStateFlow()

    private val _appInstalled = MutableStateFlow(false)
    val appInstalled = _appInstalled.asStateFlow()

    private val _installing = MutableStateFlow(false)
    val installing = _installing.asStateFlow()

    private val _installNeedsStoragePermission = MutableStateFlow(false)
    val installNeedsStoragePermission = _installNeedsStoragePermission.asStateFlow()

    private val _appOpened = MutableStateFlow(false)
    val appOpened = _appOpened.asStateFlow()

    private val _sessionReady = MutableStateFlow(false)
    val sessionReady = _sessionReady.asStateFlow()

    val wearingCheckOn = CxrLinkConnectionHub.wearingCheckOn
    val deviceInfoText = CxrLinkConnectionHub.deviceInfoText

    private val _sessionType = MutableStateFlow(CxrSessionType.CUSTOM_APP)
    val currentSessionType = _sessionType.asStateFlow()

    val scenePhase: StateFlow<CxrScenePhase> = combine(
        _tokenGot,
        _connected,
        _btConnected,
        _sessionReady,
        _customViewOpened,
        _appOpened,
        _appInstalled,
        _sessionType
    ) { values ->
        val tokenOk = values[0] as Boolean
        val cxr = values[1] as Boolean
        val bt = values[2] as Boolean
        val ready = values[3] as Boolean
        val viewOpen = values[4] as Boolean
        val appOpen = values[5] as Boolean
        val installed = values[6] as Boolean
        val type = values[7] as CxrSessionType
        if (!tokenOk || !cxr || !bt || !ready) return@combine CxrScenePhase.Connecting
        val sceneReady = when (type) {
            CxrSessionType.CUSTOM_VIEW -> viewOpen
            CxrSessionType.CUSTOM_APP -> installed && appOpen
        }
        if (sceneReady) CxrScenePhase.CapabilitiesReady else CxrScenePhase.SceneNotReady
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), CxrScenePhase.Connecting)

    val capabilitiesEnabled: StateFlow<Boolean> = scenePhase
        .map { it == CxrScenePhase.CapabilitiesReady }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    private val customViewCallback = object : ICustomViewCbk {
        override fun onCustomViewOpened() {
            _customViewOpened.value = true
        }

        override fun onCustomViewUpdated() {
            logD("onCustomViewUpdated")
        }

        override fun onCustomViewClosed() {
            _customViewOpened.value = false
            if (sessionType == CxrSessionType.CUSTOM_VIEW) {
                CxrSceneNavigation.requestToSessionTypeSelection()
            }
        }

        override fun onCustomViewIconsSent() {
            logD("onCustomViewIconsSent")
        }

        override fun onCustomViewError(p0: Int, p1: String?) {
            logD("onCustomViewError: $p0, $p1")
            _customViewOpened.value = false
        }
    }

    private val appCallback = object : IGlassAppCbk {
        override fun onInstallAppResult(success: Boolean) {
            logI("[GlassApp] onInstallAppResult: success=$success")
            _installing.value = false
            if (success) {
                logI("[GlassApp] install ok, re-query installed state")
                checkApkInstalled()
            } else {
                logW("[GlassApp] install failed, appInstalled=false")
                _appInstalled.value = false
            }
        }

        override fun onUnInstallAppResult(success: Boolean) {
            logI("[GlassApp] onUnInstallAppResult: success=$success")
            if (success) {
                _appInstalled.value = false
                _appOpened.value = false
            }
        }

        override fun onOpenAppResult(success: Boolean) {
            logI(
                "[GlassApp] onOpenAppResult: success=$success entry=" +
                    "${CONSTANT.APP_PACKAGE_NAME}${CONSTANT.MAIN_PAGE}"
            )
            _appOpened.value = success
        }

        override fun onStopAppResult(success: Boolean) {
            logI("[GlassApp] onStopAppResult: success=$success")
            _appOpened.value = !success
        }

        override fun onGlassAppResume(resumed: Boolean) {
            logI("[GlassApp] onGlassAppResume: resumed=$resumed sessionType=$sessionType")
            if (sessionType != CxrSessionType.CUSTOM_APP) return
            _appOpened.value = resumed
            if (resumed) {
                CxrSceneNavigation.requestToCustomAppScene()
            } else {
                CxrSceneNavigation.requestToSessionTypeSelection()
            }
        }

        override fun onQueryAppResult(installed: Boolean) {
            logI(
                "[GlassApp] onQueryAppResult: installed=$installed " +
                    "targetPkg=${CONSTANT.APP_PACKAGE_NAME} " +
                    "sessionReady=${_sessionReady.value} cxr=${_connected.value} bt=${_btConnected.value}"
            )
            _appInstalled.value = installed
        }
    }

    fun init(context: Context, token: String?, type: CxrSessionType) {
        appContext = context.applicationContext
        sessionType = type
        _sessionType.value = type
        observeHub(type)
        if (token.isNullOrBlank()) {
            _tokenGot.value = false
            return
        }
        logD("init session type=$type token present")
        _tokenGot.value = true
        val link = CxrSessionGate.createSession(context, type, token)
        if (link == null) {
            logE("[GlassApp] init: createSession returned null, type=$type")
            return
        }
        cxrLink = link
        logI("[GlassApp] init: session created, link=$cxrLink")
        when (type) {
            CxrSessionType.CUSTOM_VIEW -> {
                cxrLink.setCXRCustomViewCbk(customViewCallback)
                iconsString = iconsMake(context)
            }
            CxrSessionType.CUSTOM_APP -> {
                logI("[GlassApp] init: schedule first appIsInstalled query")
                refreshInstallStorageState()
                checkApkInstalled()
            }
        }
    }

    fun refreshInstallStorageState() {
        val ctx = appContext ?: return
        _installNeedsStoragePermission.value =
            ApkInstallAccess.hasApkOnPublicPathWithoutPermission(ctx, resolveInstallApkCandidates())
    }

    fun onInstallStoragePermissionDenied() {
        _installNeedsStoragePermission.value = true
        _installing.value = false
    }

    private fun observeHub(type: CxrSessionType) {
        viewModelScope.launch {
            combine(
                CxrLinkConnectionHub.cxrlConnected,
                CxrLinkConnectionHub.btConnected
            ) { l, bt -> l to bt }
                .collect { (l, bt) ->
                    val wasReady = _sessionReady.value
                    _connected.value = l
                    _btConnected.value = bt
                    val ready = l && bt
                    _sessionReady.value = ready
                    logD(
                        "[GlassApp] observeHub: cxr=$l bt=$bt sessionReady=$ready " +
                            "(wasReady=$wasReady type=$type)"
                    )
                    if (!ready) {
                        customViewIconsSentForReadyLink = false
                        lastSessionReadyForAppQuery = false
                    } else if (type == CxrSessionType.CUSTOM_VIEW) {
                        maybeSendCustomViewIcons()
                    } else if (type == CxrSessionType.CUSTOM_APP && !lastSessionReadyForAppQuery) {
                        logI("[GlassApp] observeHub: link just ready, re-query appIsInstalled")
                        lastSessionReadyForAppQuery = true
                        checkApkInstalled()
                        // Auto-trigger install if app not installed yet
                        viewModelScope.launch {
                            kotlinx.coroutines.delay(2000) // wait for appIsInstalled callback
                            if (!_appInstalled.value) {
                                logI("[GlassApp] observeHub: app not installed, auto-triggering installAppIfCandidateReady")
                                installAppIfCandidateReady()
                            }
                        }
                    }
                }
        }
    }

    private fun maybeSendCustomViewIcons() {
        if (customViewIconsSentForReadyLink || iconsString.isEmpty() || !::cxrLink.isInitialized) return
        if (!_sessionReady.value) return
        cxrLink.customViewSetIcons(iconsString)
        customViewIconsSentForReadyLink = true
    }

    fun checkApkInstalled() {
        logGlassAppSnapshot("checkApkInstalled")
        if (!::cxrLink.isInitialized) {
            logW("[GlassApp] checkApkInstalled: cxrLink not initialized, skip")
            return
        }
        if (!_sessionReady.value) {
            logW(
                "[GlassApp] checkApkInstalled: session not ready yet " +
                    "(cxr=${_connected.value} bt=${_btConnected.value}); " +
                    "SDK may return installed=false until link ready"
            )
        }
        logI(
            "[GlassApp] checkApkInstalled: calling appIsInstalled " +
                "targetPkg=${CONSTANT.APP_PACKAGE_NAME}"
        )
        runCatching {
            cxrLink.appIsInstalled(appCallback)
        }.onFailure {
            logE("[GlassApp] checkApkInstalled: appIsInstalled failed: ${it.message}")
        }
    }

    private fun logGlassAppSnapshot(caller: String) {
        logI(
            "[$caller] snapshot: targetPkg=${CONSTANT.APP_PACKAGE_NAME}, " +
                "linkInit=${::cxrLink.isInitialized}, cxr=${_connected.value}, " +
                "bt=${_btConnected.value}, sessionReady=${_sessionReady.value}, " +
                "appInstalled=${_appInstalled.value}, appOpened=${_appOpened.value}, " +
                "installing=${_installing.value}"
        )
    }

    fun queryWearingCheck() {
        if (!::cxrLink.isInitialized || !_sessionReady.value) return
        runCatching {
            CxrLinkConnectionHub.updateWearingCheck(cxrLink.isWearingCheckOn())
        }.onFailure { logE("queryWearingCheck: ${it.message}") }
    }

    fun fetchGlassDeviceInfo() {
        if (!::cxrLink.isInitialized || !_sessionReady.value) return
        runCatching {
            cxrLink.getGlassDeviceInfo()
            CxrLinkConnectionHub.updateDeviceInfo("requested")
        }.onFailure { logE("fetchGlassDeviceInfo: ${it.message}") }
    }

    fun openCustomView() {
        if (!::cxrLink.isInitialized || !_sessionReady.value) return
        cxrLink.customViewOpen(selfViewTemplate.toJson())
    }

    fun closeCustomView() {
        if (!::cxrLink.isInitialized) return
        cxrLink.customViewClose()
    }

    fun updateCustomView() {
        if (!::cxrLink.isInitialized) return
        val updateViewJson = if (customViewUpdateCount % 2 == 0) {
            UpdateViewJson().apply {
                updateList.add(UpdateViewJson.UpdateJson(id = "imageView").apply {
                    props["name"] = "icon1"
                })
            }
        } else {
            UpdateViewJson().apply {
                updateList.add(UpdateViewJson.UpdateJson(id = "imageView").apply {
                    props["name"] = "icon2"
                })
            }
        }
        updateViewJson.updateList.add(UpdateViewJson.UpdateJson(id = "textView").apply {
            props["text"] = "Hello Rokid $customViewUpdateCount"
        })
        selfViewTemplate.children?.get(0)?.props = TextViewProps().apply {
            id = "textView"
            layout_width = "wrap_content"
            layout_height = "wrap_content"
            text = "Hello Rokid $customViewUpdateCount"
            textColor = "#00FF00"
            textSize = "16sp"
            gravity = "center"
            textStyle = "bold"
            paddingStart = "16dp"
            paddingEnd = "16dp"
        }.toJson()
        selfViewTemplate.children?.get(1)?.props = ImageViewProps().apply {
            id = "imageView"
            layout_width = "120dp"
            layout_height = "120dp"
            name = if (customViewUpdateCount % 2 == 0) "icon1" else "icon2"
            scaleType = "center"
        }.toJson()
        customViewUpdateCount++
        if (customViewUpdateCount >= Int.MAX_VALUE) customViewUpdateCount = 1
        cxrLink.customViewUpdate(updateViewJson.toJson())
    }

    fun openApp() {
        if (!::cxrLink.isInitialized) {
            logW("[GlassApp] openApp: cxrLink not initialized")
            return
        }
        val entry = "${CONSTANT.APP_PACKAGE_NAME}${CONSTANT.MAIN_PAGE}"
        logI("[GlassApp] openApp: appStart entry=$entry sessionReady=${_sessionReady.value}")
        runCatching {
            cxrLink.appStart(entry, appCallback)
        }.onFailure {
            logE("[GlassApp] openApp: appStart failed: ${it.message}")
        }
    }

    fun stopApp() {
        if (!::cxrLink.isInitialized) return
        logI("[GlassApp] stopApp: calling appStop")
        cxrLink.appStop(appCallback)
    }

    fun uninstallApp() {
        if (!::cxrLink.isInitialized) return
        logI("[GlassApp] uninstallApp: calling appUninstall targetPkg=${CONSTANT.APP_PACKAGE_NAME}")
        cxrLink.appUninstall(appCallback)
    }

    /** Try install directly if a candidate APK is already readable (no storage permission needed). */
    fun installAppIfCandidateReady(): Boolean {
        val candidates = resolveInstallApkCandidates()
        logI("[GlassApp] installAppIfCandidateReady: found ${candidates.size} candidates: ${candidates.map { it.absolutePath }}")
        if (candidates.isEmpty()) return false
        installApp()
        return true
    }

    fun installApp() {
        val appCtx = appContext ?: run {
            logE("[GlassApp] installApp: appContext null")
            return
        }
        refreshInstallStorageState()
        logGlassAppSnapshot("installApp")
        val candidates = resolveInstallApkCandidates()
        val paths = candidates.map { it.absolutePath }
        logI("[GlassApp] installApp: readable apk candidates=$paths")
        android.widget.Toast.makeText(appCtx, "候选APK: ${paths.size}个 ${paths.joinToString { it.takeLast(30) }}", android.widget.Toast.LENGTH_LONG).show()
        if (candidates.isEmpty()) {
            if (ApkInstallAccess.hasApkOnPublicPathWithoutPermission(appCtx, candidates)) {
                logE("[GlassApp] installApp: cxrL.apk on public storage but storage permission not granted")
                _installNeedsStoragePermission.value = true
            } else {
                logE("[GlassApp] installApp: cannot find readable cxrL.apk")
                _installNeedsStoragePermission.value = false
            }
            _installing.value = false
            _appInstalled.value = false
            return
        }
        _installNeedsStoragePermission.value = false
        candidates.forEach { apkFile ->
            logI("[GlassApp] installApp: try appUploadAndInstall path=${apkFile.absolutePath} size=${apkFile.length()}")
            val result = runCatching {
                cxrLink.appUploadAndInstall(apkFile.absolutePath, appCallback)
            }
            if (result.isSuccess) {
                _installing.value = true
                logI("[GlassApp] installApp: upload started")
                return
            }
            logE("[GlassApp] installApp failed: ${apkFile.absolutePath} ${result.exceptionOrNull()?.message}")
        }
        _installing.value = false
        _appInstalled.value = false
    }

    fun release() {
        if (!::cxrLink.isInitialized) return
        when (sessionType) {
            CxrSessionType.CUSTOM_VIEW -> {
                val shouldClose = _customViewOpened.value ||
                    runCatching { cxrLink.customViewIsOpen() }.getOrDefault(false)
                if (shouldClose) runCatching { cxrLink.customViewClose() }
                _customViewOpened.value = false
            }
            CxrSessionType.CUSTOM_APP -> {
                if (_appOpened.value) runCatching { cxrLink.appStop(appCallback) }
                _appOpened.value = false
            }
        }
    }

    private fun resolveInstallApkCandidates(): List<File> {
        val appCtx = appContext ?: return emptyList()
        val allPaths = listOfNotNull(
            appCtx.getExternalFilesDir(Environment.DIRECTORY_DCIM + File.separator + "Rokid")?.resolve("cxrL.apk"),
            appCtx.filesDir.resolve("cxrL.apk"),
            File("/sdcard/DCIM/Rokid/cxrL.apk"),
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM + File.separator + "Rokid")
                ?.resolve("cxrL.apk")
        )
        allPaths.forEach { file ->
            val readable = ApkInstallAccess.isReadableApkFile(appCtx, file)
            logD(
                "[GlassApp] apk candidate path=${file.absolutePath} " +
                    "exists=${file.exists()} canRead=${file.canRead()} readable=$readable"
            )
        }
        return allPaths.filter { ApkInstallAccess.isReadableApkFile(appCtx, it) }
    }

    private fun iconsMake(context: Context): String {
        val icon1OutputStream = ByteArrayOutputStream()
        drawableToBitmap(context.resources.getDrawable(R.drawable.icon1, null))
            .compress(Bitmap.CompressFormat.PNG, 100, icon1OutputStream)
        val icon1Base64 = IconInfo(
            "icon1",
            Base64.encodeToString(icon1OutputStream.toByteArray(), Base64.NO_WRAP)
        )
        icon1OutputStream.close()

        val icon2OutputStream = ByteArrayOutputStream()
        drawableToBitmap(context.resources.getDrawable(R.drawable.icon2, null))
            .compress(Bitmap.CompressFormat.PNG, 100, icon2OutputStream)
        val icon2Base64 = IconInfo(
            "icon2",
            Base64.encodeToString(icon2OutputStream.toByteArray(), Base64.NO_WRAP)
        )
        icon2OutputStream.close()

        return """[${listOf(icon1Base64, icon2Base64).joinToString(",") { "{ \"name\": \"${it.name}\", \"data\": \"${it.data}\" }" }}]""".trimIndent()
    }

    private fun drawableToBitmap(drawable: Drawable): Bitmap {
        if (drawable is BitmapDrawable) return drawable.bitmap
        val bitmap = createBitmap(
            drawable.intrinsicWidth.coerceAtLeast(1),
            drawable.intrinsicHeight.coerceAtLeast(1)
        )
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
        return bitmap
    }

    private val selfViewTemplate = SelfViewJson().apply {
        type = "LinearLayout"
        props = LinearLayoutProps().apply {
            id = "root"
            layout_width = "match_parent"
            layout_height = "match_parent"
            marginTop = "160dp"
            marginBottom = "80dp"
            backgroundColor = "#FF000000"
            orientation = "vertical"
            gravity = "center_horizontal"
        }.toJson()
        children = listOf(
            SelfViewJson().apply {
                type = "TextView"
                props = TextViewProps().apply {
                    id = "textView"
                    layout_width = "wrap_content"
                    layout_height = "wrap_content"
                    text = "Hello World"
                    textColor = "#00FF00"
                    textSize = "16sp"
                    gravity = "center"
                    textStyle = "bold"
                    paddingStart = "16dp"
                    paddingEnd = "16dp"
                }.toJson()
            },
            SelfViewJson().apply {
                type = "ImageView"
                props = ImageViewProps().apply {
                    id = "imageView"
                    layout_width = "120dp"
                    layout_height = "120dp"
                    name = "icon1"
                    scaleType = "center"
                }.toJson()
            }
        )
    }
}
