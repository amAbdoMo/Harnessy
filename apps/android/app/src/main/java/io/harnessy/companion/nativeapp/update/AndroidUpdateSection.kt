package io.harnessy.companion.nativeapp.update

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R

sealed interface AndroidUpdateSectionState {
    data object Idle : AndroidUpdateSectionState
    data object Checking : AndroidUpdateSectionState
    data object Current : AndroidUpdateSectionState
    data class Available(val offer: AndroidUpdateOffer) : AndroidUpdateSectionState
    data object Installing : AndroidUpdateSectionState
    data object Finishing : AndroidUpdateSectionState
    data object AwaitingConfirmation : AndroidUpdateSectionState
    data object Failed : AndroidUpdateSectionState
}

data class AndroidUpdateSectionActions(
    val check: () -> Unit,
    val install: (AndroidUpdateOffer) -> Unit,
)

@Composable
fun AndroidUpdateSection(state: AndroidUpdateSectionState, actions: AndroidUpdateSectionActions) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.android_update_title), style = MaterialTheme.typography.titleSmall)
        when (state) {
            AndroidUpdateSectionState.Idle -> UpdateCheckButton(actions.check)
            AndroidUpdateSectionState.Checking -> Text(stringResource(R.string.android_update_checking))
            AndroidUpdateSectionState.Current -> {
                Text(stringResource(R.string.android_update_current))
                UpdateCheckButton(actions.check)
            }
            is AndroidUpdateSectionState.Available -> {
                val downloadSize = Formatter.formatShortFileSize(LocalContext.current, state.offer.patchBytes)
                Text(stringResource(R.string.android_update_available, state.offer.versionCode, downloadSize))
                Button(onClick = { actions.install(state.offer) }, modifier = Modifier.testTag("install_android_update")) {
                    Text(stringResource(R.string.android_update_install))
                }
            }
            AndroidUpdateSectionState.Installing -> Text(stringResource(R.string.android_update_installing))
            AndroidUpdateSectionState.Finishing -> Text(stringResource(R.string.android_update_finishing))
            AndroidUpdateSectionState.AwaitingConfirmation -> Text(stringResource(R.string.android_update_awaiting_confirmation))
            AndroidUpdateSectionState.Failed -> {
                Text(stringResource(R.string.android_update_failed), color = MaterialTheme.colorScheme.error)
                UpdateCheckButton(actions.check)
            }
        }
    }
}

@Composable
private fun UpdateCheckButton(check: () -> Unit) {
    Button(onClick = check, modifier = Modifier.testTag("check_android_update")) {
        Text(stringResource(R.string.android_update_check))
    }
}
