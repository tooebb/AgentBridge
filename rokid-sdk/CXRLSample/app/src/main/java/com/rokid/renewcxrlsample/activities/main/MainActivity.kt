package com.rokid.renewcxrlsample.activities.main

import android.app.ComponentCaller
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.app.CONSTANT
import com.rokid.renewcxrlsample.app.CONSTANT.REQUEST_CODE_AUTH
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.ui.design.DevSampleScaffold
import com.rokid.renewcxrlsample.ui.design.DevStatusCard
import com.rokid.renewcxrlsample.ui.design.FlowStepIndicator
import com.rokid.renewcxrlsample.ui.theme.RenewCXRLSampleTheme
import com.rokid.renewcxrlsample.utils.SmartMarketLauncher

class MainActivity : ComponentActivity() {

    private val viewModel by viewModels<MainViewModel>()

    private val authLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (!viewModel.authFromHistory) {
            viewModel.parseAuthResult(result.resultCode, result.data)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            RenewCXRLSampleTheme {
                MainScreen(
                    viewModel = viewModel,
                    launchRokidAiMarket = {
                        SmartMarketLauncher.launchMarket(
                            this@MainActivity,
                            CONSTANT.ROKID_AI_PACKAGE
                        )
                    },
                    launchHiRokidMarket = {
                        SmartMarketLauncher.launchMarket(
                            this@MainActivity,
                            CONSTANT.HI_ROKID_PACKAGE
                        )
                    },
                    checkRokidAppInstalled = { viewModel.isRokidAppInstalled(this) },
                    checkAuth = { viewModel.checkAuth(this@MainActivity) },
                    toCustomView = { viewModel.toSession(this@MainActivity, CxrSessionType.CUSTOM_VIEW) },
                    toCustomApp = { viewModel.toSession(this@MainActivity, CxrSessionType.CUSTOM_APP) }
                )
            }
        }
        viewModel.isRokidAppInstalled(this)
        intent.getStringExtra(CONSTANT.EXTRA_TOKEN)?.let { viewModel.restoreSessionToken(it) }
    }

    override fun onActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
        caller: ComponentCaller
    ) {
        super.onActivityResult(requestCode, resultCode, data, caller)
        if (requestCode == REQUEST_CODE_AUTH && !viewModel.authFromHistory) {
            viewModel.parseAuthResult(resultCode, data)
        }
    }
}

@Composable
fun MainScreen(
    viewModel: MainViewModel,
    launchRokidAiMarket: () -> Unit = {},
    launchHiRokidMarket: () -> Unit = {},
    checkRokidAppInstalled: () -> Unit = {},
    checkAuth: () -> Unit = {},
    toCustomView: () -> Unit = {},
    toCustomApp: () -> Unit = {},
) {
    val info by viewModel.infoText.collectAsState()
    val isRokidAppInstalled by viewModel.isRokidAppInstalled.collectAsState(false)
    val isAuthenticated by viewModel.isAuthenticated.collectAsState(false)
    val step by viewModel.currentStep.collectAsState()

    val stepIndex = when (step) {
        HomeFlowStep.InstallCompanion -> 0
        HomeFlowStep.Authorize -> 1
        HomeFlowStep.SelectScene -> 2
    }

    DevSampleScaffold(
        title = stringResource(id = R.string.screen_title_main),
        subtitle = stringResource(id = R.string.home_subtitle)
    ) {
        FlowStepIndicator(
            steps = listOf(
                stringResource(id = R.string.flow_step_install),
                stringResource(id = R.string.flow_step_authorize),
                stringResource(id = R.string.flow_step_select_scene)
            ),
            currentIndex = stepIndex
        )

        DevStatusCard(
            title = stringResource(id = R.string.home_status_card_title),
            lines = listOf(
                stringResource(
                    id = R.string.home_install_status,
                    stringResource(
                        id = if (isRokidAppInstalled) {
                            R.string.home_install_state_installed
                        } else {
                            R.string.home_install_state_not_installed
                        }
                    )
                ),
                stringResource(
                    id = R.string.home_auth_status,
                    stringResource(
                        id = if (isAuthenticated) {
                            R.string.home_auth_state_authorized
                        } else {
                            R.string.home_auth_state_unauthorized
                        }
                    )
                ),
                stringResource(id = R.string.home_hint_line, info)
            )
        )

        when (step) {
            HomeFlowStep.InstallCompanion -> {
                Button(modifier = Modifier.fillMaxWidth(), onClick = launchRokidAiMarket) {
                    Text(stringResource(id = R.string.home_install_rokid_ai_mainland))
                }
                Button(modifier = Modifier.fillMaxWidth(), onClick = launchHiRokidMarket) {
                    Text(stringResource(id = R.string.home_install_hi_rokid_global))
                }
                Button(modifier = Modifier.fillMaxWidth(), onClick = checkRokidAppInstalled) {
                    Text(stringResource(id = R.string.home_recheck_install))
                }
            }
            HomeFlowStep.Authorize -> {
                Button(modifier = Modifier.fillMaxWidth(), onClick = checkAuth) {
                    Text(stringResource(id = R.string.main_check_auth))
                }
            }
            HomeFlowStep.SelectScene -> {
                Text(stringResource(id = R.string.main_choose_session_type))
                SceneSelectCard(
                    title = stringResource(id = R.string.main_to_custom_view),
                    features = stringResource(id = R.string.scene_card_features_custom_view),
                    onClick = toCustomView
                )
                SceneSelectCard(
                    title = stringResource(id = R.string.main_to_custom_app),
                    features = stringResource(id = R.string.scene_card_features_custom_app),
                    onClick = toCustomApp
                )
            }
        }
    }
}

@Composable
private fun SceneSelectCard(
    title: String,
    features: String,
    onClick: () -> Unit
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                features,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
fun MainScreenPreview() {
    RenewCXRLSampleTheme {
        MainScreen(viewModel = viewModel { MainViewModel() })
    }
}
