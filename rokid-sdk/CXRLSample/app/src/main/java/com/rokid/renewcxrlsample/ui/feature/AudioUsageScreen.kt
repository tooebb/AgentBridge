package com.rokid.renewcxrlsample.ui.feature

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.activities.audio.AudioUsageViewModel
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.ui.components.PRIMARY_BUTTON_WIDTH
import com.rokid.renewcxrlsample.ui.components.statusLine
import com.rokid.renewcxrlsample.ui.components.statusLines
import com.rokid.renewcxrlsample.ui.design.DevSampleScaffold
import com.rokid.renewcxrlsample.ui.design.DevStatusCard
import com.rokid.renewcxrlsample.ui.design.PrerequisiteHint
import com.rokid.renewcxrlsample.ui.design.SceneSectionTitle
import com.rokid.renewcxrlsample.ui.design.SessionTypeBanner

@Composable
fun AudioUsageScreen(
    viewModel: AudioUsageViewModel,
    sessionType: CxrSessionType,
    onBack: () -> Unit,
    onShareAudio: () -> Unit = {}
) {
    val tokenGot by viewModel.tokenGot.collectAsState()
    val started by viewModel.audioStarted.collectAsState()
    val status by viewModel.status.collectAsState()
    val ready by viewModel.ready.collectAsState()
    val permissionGranted by viewModel.permissionGranted.collectAsState()
    val entryLabel by viewModel.entryLabel.collectAsState()
    val hasPlayableAudio by viewModel.hasPlayableAudio.collectAsState()
    val isPlaying by viewModel.isPlaying.collectAsState()
    val savedAudioPath by viewModel.savedAudioPath.collectAsState()
    val recordDurationText by viewModel.recordDurationText.collectAsState()
    val cleanupResult by viewModel.cleanupResult.collectAsState()
    val audioFileCountText by viewModel.audioFileCountText.collectAsState()
    val recentAudioFilesText by viewModel.recentAudioFilesText.collectAsState()

    DevSampleScaffold(
        title = stringResource(id = R.string.screen_title_audio),
        subtitle = stringResource(id = R.string.audio_subtitle),
        showBack = true,
        onBack = onBack
    ) {
        SessionTypeBanner(sessionType = sessionType)
        DevStatusCard(
            title = stringResource(id = R.string.status_panel_title),
            lines = statusLines(
                entryLabel,
                statusLine(R.string.common_status_prefix, status),
                recordDurationText,
                audioFileCountText
            )
        )
        Text(
            text = stringResource(id = R.string.feature_dev_hint_audio),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        SceneSectionTitle(stringResource(id = R.string.audio_listen_control))
        if (!tokenGot) {
            PrerequisiteHint(stringResource(id = R.string.token_required_hint))
        } else if (!permissionGranted) {
            PrerequisiteHint(stringResource(id = R.string.audio_no_microphone_permission))
        }
        Button(
            modifier = Modifier.fillMaxWidth(PRIMARY_BUTTON_WIDTH),
            onClick = { if (!started) viewModel.startAudio() else viewModel.stopAudio() },
            enabled = tokenGot && permissionGranted && (ready || started)
        ) {
            Text(
                stringResource(
                    id = if (!started) R.string.audio_start_listen else R.string.audio_stop_listen
                )
            )
        }
        SceneSectionTitle(stringResource(id = R.string.audio_playback_and_file_actions))
        Button(
            modifier = Modifier.fillMaxWidth(PRIMARY_BUTTON_WIDTH),
            onClick = { viewModel.togglePlaySavedAudio() },
            enabled = hasPlayableAudio
        ) {
            Text(
                stringResource(
                    id = if (isPlaying) R.string.audio_stop_playback else R.string.audio_play_saved_audio
                )
            )
        }
        Button(
            modifier = Modifier.fillMaxWidth(PRIMARY_BUTTON_WIDTH),
            onClick = onShareAudio,
            enabled = hasPlayableAudio
        ) { Text(stringResource(id = R.string.audio_share_file)) }
        Button(
            modifier = Modifier.fillMaxWidth(PRIMARY_BUTTON_WIDTH),
            onClick = { viewModel.clearHistoryAudioFiles(keepLatestCount = 3) }
        ) { Text(stringResource(id = R.string.audio_clear_history)) }
        DevStatusCard(
            title = stringResource(id = R.string.audio_file_info),
            lines = statusLines(
                stringResource(
                    id = R.string.common_file_prefix,
                    savedAudioPath.ifBlank { stringResource(id = R.string.common_none) }
                ),
                recentAudioFilesText,
                cleanupResult
            )
        )
    }
}
