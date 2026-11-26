package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.CompanionActions
import io.harnessy.companion.presentation.DisplayModels.Feedback
import io.harnessy.companion.presentation.DisplayModels.Pairing
import io.harnessy.companion.presentation.DisplayModels.PairingState

/** Input is bound directly to transient repository state, not a saveable field or route argument. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativePairingScreen(pairing: Pairing, actions: CompanionActions) {
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { NativeCompactHeaderTitle(stringResource(R.string.pair_pc)) },
                expandedHeight = 48.dp,
                navigationIcon = {
                    NativeFloatingIconButton(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.native_back),
                        actions::cancelPairing, testTag = "pairing_back")
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            Surface(color = MaterialTheme.colorScheme.background) {
                Box(Modifier.fillMaxWidth().navigationBarsPadding().imePadding(), contentAlignment = Alignment.Center) {
                    PairingActions(pairing, actions)
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 720.dp).fillMaxSize()
                .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp)) {
                Text(stringResource(R.string.pairing_title), style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() })
                Text(stringResource(R.string.pairing_explanation), style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                PairingInvitation(pairing, actions)
                if (pairing.fingerprint.isNotEmpty()) PairingFingerprint(pairing.fingerprint)
                FeedbackNotice(pairing.feedback)
                Text(stringResource(R.string.pairing_limits), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun PairingActions(pairing: Pairing, actions: CompanionActions) {
    Row(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(onClick = actions::cancelPairing,
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("cancel_pairing")) {
            Text(stringResource(R.string.cancel))
        }
        Button(onClick = { actions.pairFromLink(pairing.link) },
            enabled = pairing.state != PairingState.ENROLLING && pairing.link.isNotBlank() && pairing.feedback != Feedback.PAIRING_INVALID,
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("pair_invitation")) {
            Text(stringResource(R.string.native_pair))
        }
    }
}

@Composable
private fun PairingInvitation(pairing: Pairing, actions: CompanionActions) {
    Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(28.dp)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (pairing.state == PairingState.ENROLLING) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.pairing_in_progress))
            } else {
                OutlinedTextField(value = pairing.link, onValueChange = actions::pairingLinkChanged,
                    label = { Text(stringResource(R.string.pairing_link_label)) },
                    placeholder = { Text(stringResource(R.string.pairing_link_hint)) },
                    modifier = Modifier.fillMaxWidth().testTag("pairing_link"), minLines = 3, maxLines = 5,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    isError = pairing.feedback == Feedback.PAIRING_INVALID, shape = RoundedCornerShape(16.dp),
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
            }
        }
    }
}

@Composable
private fun PairingFingerprint(fingerprint: String) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(28.dp)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.fingerprint_hint), style = MaterialTheme.typography.bodyMedium)
            SelectionContainer {
                Text(fingerprint, modifier = Modifier.fillMaxWidth().testTag("phone_fingerprint"),
                    style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
            }
        }
    }
}
