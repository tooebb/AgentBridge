package com.rokid.renewcxrlsample.ui.feature

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.activities.device.DeviceControlViewModel
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceControlScreen(
    viewModel: DeviceControlViewModel,
    onBack: () -> Unit
) {
    val brightness by viewModel.brightness.collectAsState()
    val volume by viewModel.volume.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.refreshDeviceInfo()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(id = R.string.device_control)) },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text(stringResource(id = R.string.nav_back)) }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = stringResource(id = R.string.brightness),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(id = R.string.device_level_format, brightness),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Slider(
                        value = brightness.toFloat(),
                        onValueChange = { viewModel.setBrightness(it.roundToInt()) },
                        valueRange = 0f..15f,
                        steps = 14
                    )
                }
            }

            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = stringResource(id = R.string.volume),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(id = R.string.device_level_format, volume),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Slider(
                        value = volume.toFloat(),
                        onValueChange = { viewModel.setVolume(it.roundToInt()) },
                        valueRange = 0f..15f,
                        steps = 14
                    )
                }
            }

            Button(
                onClick = { viewModel.refreshDeviceInfo() },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(id = R.string.refresh_device_info))
            }

            Card(
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = stringResource(id = R.string.device_control_hint_title),
                        style = MaterialTheme.typography.labelLarge
                    )
                    Text(
                        text = stringResource(id = R.string.device_control_hint_body),
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }
    }
}
