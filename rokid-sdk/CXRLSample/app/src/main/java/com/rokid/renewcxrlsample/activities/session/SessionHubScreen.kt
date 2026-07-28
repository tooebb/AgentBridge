package com.rokid.renewcxrlsample.activities.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.session.CxrFeature
import com.rokid.renewcxrlsample.session.CxrFeaturePolicy
import com.rokid.renewcxrlsample.session.CxrScenePhase
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.ui.components.booleanStatusLine
import com.rokid.renewcxrlsample.ui.components.statusLine
import com.rokid.renewcxrlsample.ui.components.statusLines
import com.rokid.renewcxrlsample.ui.design.AllowedFeaturesLegend
import com.rokid.renewcxrlsample.ui.design.CapabilityTile
import com.rokid.renewcxrlsample.ui.design.DevSampleScaffold
import com.rokid.renewcxrlsample.ui.design.DevStatusCard
import com.rokid.renewcxrlsample.ui.design.FlowStepIndicator
import com.rokid.renewcxrlsample.ui.design.PrerequisiteHint
import com.rokid.renewcxrlsample.ui.design.SceneSectionTitle
import com.rokid.renewcxrlsample.ui.design.SessionTypeBanner

@Composable
fun SessionHubScreen(
    viewModel: SessionHubViewModel,
    sessionType: CxrSessionType,
    onNavigateToFeature: (CxrFeature) -> Unit,
    onRequestInstall: () -> Unit = {},
) {
    val tokenGot by viewModel.tokenGot.collectAsState()
    val connected by viewModel.connected.collectAsState()
    val btConnected by viewModel.btConnected.collectAsState()
    val sessionReady by viewModel.sessionReady.collectAsState()
    val customViewOpened by viewModel.customViewOpened.collectAsState()
    val appInstalled by viewModel.appInstalled.collectAsState()
    val appOpened by viewModel.appOpened.collectAsState()
    val installing by viewModel.installing.collectAsState()
    val installNeedsStoragePermission by viewModel.installNeedsStoragePermission.collectAsState()
    val phase by viewModel.scenePhase.collectAsState()
    val capabilitiesEnabled by viewModel.capabilitiesEnabled.collectAsState()
    val wearing by viewModel.wearingCheckOn.collectAsState()
    val deviceInfo by viewModel.deviceInfoText.collectAsState()

    val hubStepIndex = when (phase) {
        CxrScenePhase.Connecting -> 0
        CxrScenePhase.SceneNotReady -> 1
        CxrScenePhase.CapabilitiesReady -> 2
    }

    DevSampleScaffold(
        title = stringResource(id = R.string.screen_title_session),
        subtitle = stringResource(id = R.string.session_hub_subtitle)
    ) {
        SessionTypeBanner(sessionType = sessionType)

        FlowStepIndicator(
            steps = listOf(
                stringResource(id = R.string.session_step_connection),
                stringResource(id = R.string.session_step_scene),
                stringResource(id = R.string.session_step_capabilities)
            ),
            currentIndex = hubStepIndex
        )

        DevStatusCard(
            title = stringResource(id = R.string.session_connection_card_title),
            lines = connectionStatusLines(
                sessionType = sessionType,
                tokenGot = tokenGot,
                connected = connected,
                btConnected = btConnected,
                sessionReady = sessionReady,
                wearing = wearing,
                deviceInfo = deviceInfo
            )
        )

        SceneSectionTitle(stringResource(id = R.string.device_info_section))
        Button(
            modifier = Modifier.fillMaxWidth(),
            onClick = { viewModel.queryWearingCheck() },
            enabled = sessionReady
        ) { Text(stringResource(id = R.string.device_wearing_check)) }
        Button(
            modifier = Modifier.fillMaxWidth(),
            onClick = { viewModel.fetchGlassDeviceInfo() },
            enabled = sessionReady
        ) { Text(stringResource(id = R.string.device_get_info)) }

        SceneControlSection(
            sessionType = sessionType,
            viewModel = viewModel,
            customViewOpened = customViewOpened,
            appInstalled = appInstalled,
            appOpened = appOpened,
            installing = installing,
            installNeedsStoragePermission = installNeedsStoragePermission,
            sessionReady = sessionReady,
            connectSuccess = connected && btConnected,
            onRequestInstall = onRequestInstall
        )

        SceneSectionTitle(stringResource(id = R.string.session_capabilities_section))
        AllowedFeaturesLegend(sessionType = sessionType)

        if (!capabilitiesEnabled) {
            PrerequisiteHint(
                message = when (sessionType) {
                    CxrSessionType.CUSTOM_VIEW -> stringResource(id = R.string.session_prereq_custom_view)
                    CxrSessionType.CUSTOM_APP -> stringResource(id = R.string.session_prereq_custom_app)
                }
            )
        }

        CxrFeaturePolicy.allowedFeatures(sessionType).forEach { feature ->
            val featureEnabled = when (feature) {
                CxrFeature.DEVICE_CONTROL -> sessionReady
                else -> capabilitiesEnabled
            }
            CapabilityTile(
                label = stringResource(id = feature.labelRes),
                enabled = featureEnabled,
                onClick = { onNavigateToFeature(feature) }
            )
        }
    }
}

@Composable
private fun SceneControlSection(
    sessionType: CxrSessionType,
    viewModel: SessionHubViewModel,
    customViewOpened: Boolean,
    appInstalled: Boolean,
    appOpened: Boolean,
    installing: Boolean,
    installNeedsStoragePermission: Boolean,
    sessionReady: Boolean,
    connectSuccess: Boolean,
    onRequestInstall: () -> Unit,
) {
    when (sessionType) {
        CxrSessionType.CUSTOM_VIEW -> {
            SceneSectionTitle(stringResource(id = R.string.session_control_custom_view_title))
            DevStatusCard(
                title = stringResource(id = R.string.session_custom_view_state_title),
                lines = listOf(
                    statusLine(
                        R.string.custom_view_view_status,
                        stringResource(
                            id = if (customViewOpened) R.string.custom_view_opened else R.string.custom_view_not_opened
                        )
                    )
                )
            )
            if (!connectSuccess) {
                PrerequisiteHint(stringResource(id = R.string.custom_view_wait_bt))
                return
            }
            if (!customViewOpened) {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { viewModel.openCustomView() }
                ) { Text(stringResource(id = R.string.custom_view_open)) }
            } else {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { viewModel.updateCustomView() }
                ) { Text(stringResource(id = R.string.custom_view_update)) }
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { viewModel.closeCustomView() }
                ) { Text(stringResource(id = R.string.custom_view_close)) }
            }
        }
        CxrSessionType.CUSTOM_APP -> {
            SceneSectionTitle(stringResource(id = R.string.session_control_custom_app_title))
            DevStatusCard(
                title = stringResource(id = R.string.session_app_control_status_title),
                lines = statusLines(
                    booleanStatusLine(
                        R.string.custom_app_install_status,
                        R.string.custom_app_install_ok,
                        R.string.custom_app_install_not,
                        appInstalled
                    ),
                    booleanStatusLine(
                        R.string.custom_app_scene_status,
                        R.string.custom_app_scene_opened,
                        R.string.custom_app_scene_closed,
                        appOpened
                    )
                )
            )
            if (!connectSuccess) {
                PrerequisiteHint(stringResource(id = R.string.custom_app_wait_connection))
                return
            }
            if (!appInstalled) {
                if (installNeedsStoragePermission) {
                    PrerequisiteHint(stringResource(id = R.string.custom_app_install_storage_permission_hint))
                }
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onRequestInstall,
                    enabled = !installing
                ) { Text(stringResource(id = R.string.custom_app_install_to_glasses)) }
                return
            }
            Button(
                modifier = Modifier.fillMaxWidth(),
                onClick = { viewModel.uninstallApp() }
            ) { Text(stringResource(id = R.string.custom_app_uninstall)) }
            if (!appOpened) {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { viewModel.openApp() }
                ) { Text(stringResource(id = R.string.custom_app_open_scene)) }
            } else {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { viewModel.stopApp() }
                ) { Text(stringResource(id = R.string.custom_app_stop_scene)) }
            }
        }
    }
}

@Composable
private fun connectionStatusLines(
    sessionType: CxrSessionType,
    tokenGot: Boolean,
    connected: Boolean,
    btConnected: Boolean,
    sessionReady: Boolean,
    wearing: Boolean?,
    deviceInfo: String,
): List<String> {
    val lines = mutableListOf(
        booleanStatusLine(
            R.string.custom_app_token_status,
            R.string.custom_app_token_ok,
            R.string.custom_app_token_missing,
            tokenGot
        )
    )
    if (sessionType == CxrSessionType.CUSTOM_VIEW) {
        lines += booleanStatusLine(
            R.string.custom_view_service_status,
            R.string.custom_view_connected,
            R.string.custom_view_not_connected,
            connected
        )
        lines += booleanStatusLine(
            R.string.custom_view_bt_status,
            R.string.custom_view_connected,
            R.string.custom_view_not_connected,
            btConnected
        )
    } else {
        lines += booleanStatusLine(
            R.string.custom_app_connection_status,
            R.string.custom_app_connection_ok,
            R.string.custom_app_connection_waiting,
            sessionReady
        )
    }
    wearing?.let {
        lines += stringResource(
            id = if (it) R.string.device_wearing_on else R.string.device_wearing_off
        )
    }
    if (deviceInfo.isNotBlank()) {
        lines += statusLine(R.string.device_info_line, deviceInfo)
    }
    return lines.filter { it.isNotBlank() }
}
