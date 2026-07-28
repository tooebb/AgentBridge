package com.rokid.renewcxrlsample.ui.feature

import androidx.compose.foundation.Image
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
import com.rokid.renewcxrlsample.activities.photo.PhotoUsageViewModel
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
fun PhotoUsageScreen(
    viewModel: PhotoUsageViewModel,
    sessionType: CxrSessionType,
    onBack: () -> Unit
) {
    val tokenGot by viewModel.tokenGot.collectAsState()
    val taking by viewModel.photoTaking.collectAsState()
    val status by viewModel.status.collectAsState()
    val ready by viewModel.ready.collectAsState()
    val permissionGranted by viewModel.permissionGranted.collectAsState()
    val entryLabel by viewModel.entryLabel.collectAsState()
    val image by viewModel.photo.collectAsState()

    DevSampleScaffold(
        title = stringResource(id = R.string.screen_title_photo),
        subtitle = stringResource(id = R.string.photo_subtitle),
        showBack = true,
        onBack = onBack
    ) {
        SessionTypeBanner(sessionType = sessionType)
        DevStatusCard(
            title = stringResource(id = R.string.status_panel_title),
            lines = statusLines(entryLabel, statusLine(R.string.common_status_prefix, status))
        )
        Text(
            text = stringResource(id = R.string.feature_dev_hint_photo),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        SceneSectionTitle(stringResource(id = R.string.common_actions))
        if (!tokenGot) {
            PrerequisiteHint(stringResource(id = R.string.token_required_hint))
        } else if (!permissionGranted) {
            PrerequisiteHint(stringResource(id = R.string.photo_no_camera_permission))
        }
        Button(
            modifier = Modifier.fillMaxWidth(PRIMARY_BUTTON_WIDTH),
            onClick = { viewModel.takePhoto() },
            enabled = tokenGot && !taking && ready && permissionGranted
        ) {
            Text(
                stringResource(id = if (taking) R.string.photo_taking else R.string.photo_take_action)
            )
        }
        SceneSectionTitle(stringResource(id = R.string.photo_preview))
        image?.let { Image(bitmap = it, contentDescription = null) }
            ?: Text(stringResource(id = R.string.photo_no_result))
    }
}
