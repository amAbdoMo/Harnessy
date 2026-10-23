package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import io.harnessy.companion.presentation.DisplayModels.Feedback
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.CompanionActions
import io.harnessy.companion.presentation.DisplayModels.Pairing
import io.harnessy.companion.presentation.DisplayModels.PairingState

/** Input is bound directly to transient repository state, not a saveable field or route argument. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativePairingScreen(pairing: Pairing, actions: CompanionActions) {
    val enrolling = pairing.state == PairingState.ENROLLING
    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.pair_pc)) }) },
        bottomBar = {
            Surface(shadowElevation = 3.dp) {
                Row(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = actions::cancelPairing, modifier = Modifier.weight(1f).testTag("cancel_pairing")) {
                        Text(stringResource(R.string.cancel))
                    }
                    Button(onClick = { actions.pairFromLink(pairing.link) }, enabled = !enrolling && pairing.link.isNotBlank() && pairing.feedback != Feedback.PAIRING_INVALID,
                        modifier = Modifier.weight(1f).testTag("pair_invitation")) {
                        Text(stringResource(R.string.native_pair))
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)
            .verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(stringResource(R.string.pairing_title), style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.pairing_explanation))
            if (!enrolling) {
                OutlinedTextField(value = pairing.link, onValueChange = actions::pairingLinkChanged,
                    label = { Text(stringResource(R.string.pairing_link_label)) },
                    placeholder = { Text(stringResource(R.string.pairing_link_hint)) },
                    modifier = Modifier.fillMaxWidth().testTag("pairing_link"), minLines = 3, maxLines = 5,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    isError = pairing.feedback == Feedback.PAIRING_INVALID,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
            } else {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.pairing_in_progress))
            }
            if (pairing.fingerprint.isNotEmpty()) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.large) {
                    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text(stringResource(R.string.fingerprint_hint), style = MaterialTheme.typography.bodyMedium)
                        SelectionContainer {
                            Text(pairing.fingerprint, modifier = Modifier.fillMaxWidth().testTag("phone_fingerprint"),
                                style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
            FeedbackNotice(pairing.feedback)
            Text(stringResource(R.string.pairing_limits), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
