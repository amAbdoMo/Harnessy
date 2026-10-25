package io.harnessy.companion.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.CompanionActions
import io.harnessy.companion.presentation.DisplayModels.Connection
import io.harnessy.companion.presentation.DisplayModels.Feedback
import io.harnessy.companion.presentation.DisplayModels.ManagementAccess

data class NativeSettingsActions(
    val goBack: () -> Unit,
    val setTheme: (ThemePreference) -> Unit,
    val pauseConnection: () -> Unit,
    val resumeConnection: () -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeSettingsScreen(state: NativeUiState, actions: CompanionActions, settings: NativeSettingsActions) {
    val companion = state.companion
    val pc = companion.screen?.pc
    val metadataReady = companion.screen?.metadataLoading == false
    var detailsExpanded by remember { mutableStateOf(false) }
    var capabilitiesExpanded by remember { mutableStateOf(false) }
    Scaffold(topBar = {
        CenterAlignedTopAppBar(title = { Text(stringResource(R.string.native_settings), style = MaterialTheme.typography.titleMedium) },
            navigationIcon = {
                NativeFloatingIconButton(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.native_back),
                    settings.goBack, testTag = "back_to_chat")
            }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background))
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            LazyColumn(Modifier.widthIn(max = 680.dp).fillMaxSize().testTag("settings"),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                item {
                    SettingsHeading(R.string.native_appearance)
                    SettingsSurface {
                        ThemeOptions(state, settings.setTheme)
                        if (state.preferenceFailed) Text(stringResource(R.string.native_preference_failed),
                            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                item {
                    SettingsHeading(R.string.native_connection)
                    SettingsSurface {
                        Text(pc?.displayName?.takeIf { it.isNotBlank() } ?: stringResource(R.string.native_app_name),
                            style = MaterialTheme.typography.titleMedium)
                        if (companion.connectionPaused) Text(stringResource(R.string.native_connection_paused),
                            style = MaterialTheme.typography.bodyMedium)
                        else if (!metadataReady) Text(stringResource(R.string.native_loading_pc), style = MaterialTheme.typography.bodyMedium)
                        else if (pc != null) NativeConnectionStatus(pc.connection)
                        else Text(stringResource(R.string.no_linked_pc), style = MaterialTheme.typography.bodyMedium)
                        if (companion.connectionPaused) {
                            Button(onClick = settings.resumeConnection, enabled = companion.foreground, modifier = Modifier.testTag("resume_connection")) {
                                Text(stringResource(R.string.native_resume))
                            }
                        } else if (pc != null) {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                OutlinedButton(onClick = settings.pauseConnection, enabled = companion.foreground,
                                    modifier = Modifier.testTag("pause_connection")) { Text(stringResource(R.string.native_pause)) }
                                TextButton(onClick = actions::refresh, enabled = companion.foreground && pc.connection == Connection.ONLINE,
                                    modifier = Modifier.testTag("settings_refresh")) { Text(stringResource(R.string.refresh)) }
                                TextButton(onClick = actions::showPairing, enabled = companion.foreground && metadataReady,
                                    modifier = Modifier.testTag("pair_pc")) { Text(stringResource(R.string.pair_pc)) }
                            }
                        } else {
                            Button(onClick = actions::showPairing, enabled = companion.foreground && metadataReady,
                                modifier = Modifier.testTag("pair_pc")) {
                                Text(stringResource(R.string.pair_pc))
                            }
                        }
                        companion.screen?.composer?.feedback?.let { ConnectionFeedback(it) }
                        companion.screen?.composer?.review?.let { DeliveryReviewCard(it, actions::resolveUnknown) }
                        SettingsDisclosure(R.string.native_connection_details, detailsExpanded, "connection_details") {
                            detailsExpanded = !detailsExpanded
                        }
                        if (detailsExpanded) {
                            Text(stringResource(R.string.native_foreground_note), style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (pc != null) TextButton(onClick = { actions.forgetPairing(pc.id) }, enabled = companion.foreground,
                                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                                modifier = Modifier.testTag("forget_pairing")) { Text(stringResource(R.string.forget_pairing)) }
                        }
                    }
                }
                item {
                    SettingsHeading(R.string.native_pc_controls)
                    SettingsSurface {
                        ChatManagementStatus(companion.screen?.sessions?.management?.access ?: ManagementAccess.UNAVAILABLE)
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        SettingsDisclosure(R.string.native_managed_summary, capabilitiesExpanded, "managed_capabilities") {
                            capabilitiesExpanded = !capabilitiesExpanded
                        }
                        if (!capabilitiesExpanded) Text(stringResource(R.string.native_managed_details),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else {
                            CapabilityRow(R.string.native_accounts, R.string.native_accounts_unavailable)
                            CapabilityRow(R.string.native_models, R.string.native_models_unavailable)
                            CapabilityRow(R.string.native_push, R.string.native_push_unavailable)
                            Text(stringResource(R.string.native_literal_text), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ThemeOptions(state: NativeUiState, setTheme: (ThemePreference) -> Unit) {
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ThemePreference.entries.forEach { theme ->
            val label = when (theme) {
                ThemePreference.SYSTEM -> R.string.native_theme_system
                ThemePreference.LIGHT -> R.string.native_theme_light
                ThemePreference.DARK -> R.string.native_theme_dark
            }
            val selected = state.theme == theme
            Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(14.dp))
                .background(if (selected) MaterialTheme.colorScheme.surfaceContainer else Color.Transparent)
                .selectable(selected = selected, enabled = !state.savingTheme, role = Role.RadioButton,
                    onClick = { setTheme(theme) }).testTag("theme_${theme.name.lowercase()}")
                .padding(horizontal = 4.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                RadioButton(selected = selected, onClick = null, enabled = !state.savingTheme)
                Text(stringResource(label), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, minLines = 2)
            }
        }
    }
}

@Composable
private fun ChatManagementStatus(access: ManagementAccess) {
    Text(stringResource(R.string.native_chat_management), style = MaterialTheme.typography.titleSmall)
    val status = when (access) {
        ManagementAccess.ENABLED -> R.string.native_chat_management_enabled
        ManagementAccess.DISABLED -> R.string.native_manage_permission_title
        ManagementAccess.CHECKING -> R.string.native_manage_access_checking
        ManagementAccess.UNAVAILABLE -> R.string.native_manage_unavailable
    }
    Text(stringResource(status), style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.testTag("settings_chat_management"))
    val details = when (access) {
        ManagementAccess.ENABLED -> R.string.native_chat_management_actions
        ManagementAccess.DISABLED -> R.string.native_manage_permission_required
        ManagementAccess.CHECKING, ManagementAccess.UNAVAILABLE -> null
    }
    details?.let { Text(stringResource(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
private fun ConnectionFeedback(feedback: Feedback) {
    when (feedback) {
        Feedback.NONE, Feedback.REFRESH_FAILED, Feedback.SEND_FAILED,
        Feedback.DELIVERY_UNKNOWN, Feedback.INBOX_ADMITTED -> Unit
        else -> FeedbackNotice(feedback)
    }
}

@Composable
private fun SettingsHeading(resource: Int) {
    Text(stringResource(resource), style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp).semantics { heading() })
}

@Composable
private fun SettingsSurface(content: @Composable ColumnScope.() -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(20.dp), shadowElevation = 1.dp) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

@Composable
private fun SettingsDisclosure(title: Int, expanded: Boolean, tag: String, toggle: () -> Unit) {
    val expansion = stringResource(if (expanded) R.string.native_expanded else R.string.native_collapsed)
    TextButton(onClick = toggle, modifier = Modifier.fillMaxWidth().testTag(tag).semantics { stateDescription = expansion },
        contentPadding = PaddingValues(horizontal = 0.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Icon(if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, null)
    }
}

@Composable
private fun CapabilityRow(title: Int, explanation: Int) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.labelLarge)
        Text(stringResource(explanation), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
