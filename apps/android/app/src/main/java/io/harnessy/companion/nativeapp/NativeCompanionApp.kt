package io.harnessy.companion.nativeapp

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import io.harnessy.companion.R
import io.harnessy.companion.CompanionPlatform.OperationKind

/** The ViewModel is Activity-scoped, outside the NavHost; destinations never own sockets or drafts. */
@Composable
fun NativeCompanionApp(viewModel: CompanionViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val navigation = rememberNavController()
    val entry by navigation.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val pairingVisible = state.companion.pairing != null && state.companion.foreground
    LaunchedEffect(pairingVisible, route) {
        if (pairingVisible && route != "pairing") {
            navigation.navigate("pairing") { launchSingleTop = true; popUpTo("chat") }
        } else if (!pairingVisible && route == "pairing") {
            if (!navigation.popBackStack("chat", false)) {
                navigation.navigate("chat") { popUpTo("pairing") { inclusive = true } }
            }
        }
    }
    NativeTheme(state.theme) {
        Surface(Modifier.fillMaxSize()) {
            NavHost(navigation, startDestination = "chat") {
                composable("chat") {
                    NativeChatScreen(state.companion.copy(workspaceExpansion = state.workspaceExpansion,
                        workspacePreferenceFailed = state.workspacePreferenceFailed), viewModel,
                        openSettings = { navigation.navigate("settings") { launchSingleTop = true } },
                        resumeConnection = viewModel::resumeConnection)
                }
                composable("pairing") {
                    BackHandler(enabled = pairingVisible) { viewModel.cancelPairing() }
                    state.companion.pairing?.let { NativePairingScreen(it, viewModel) }
                }
                composable("settings") {
                    NativeSettingsScreen(state, viewModel, NativeSettingsActions(
                        goBack = { navigation.popBackStack() },
                        setTheme = viewModel::setTheme,
                        pauseConnection = viewModel::pauseConnection,
                        resumeConnection = viewModel::resumeConnection,
                    ))
                }
            }
            state.confirmation?.takeIf { state.companion.foreground }?.let { confirmation ->
                val forget = confirmation as? Confirmation.Forget
                val reviewKind = (confirmation as? Confirmation.Review)?.kind
                AlertDialog(
                    onDismissRequest = viewModel::dismissConfirmation,
                    title = { Text(stringResource(if (forget != null) R.string.forget_title else R.string.resolve_title)) },
                    text = {
                        Text(if (forget != null) stringResource(R.string.forget_explanation, forget.name)
                            else stringResource(when (reviewKind) {
                                OperationKind.SELECT_SESSION_MODEL -> R.string.native_model_resolve
                                OperationKind.OPEN_SESSION -> R.string.native_open_chat_resolve
                                OperationKind.SUBMIT_TEXT, null -> R.string.resolve_explanation
                                else -> R.string.native_management_resolve_explanation
                            }))
                    },
                    dismissButton = { TextButton(onClick = viewModel::dismissConfirmation) { Text(stringResource(R.string.cancel)) } },
                    confirmButton = {
                        TextButton(onClick = viewModel::confirm) {
                            Text(stringResource(if (forget != null) R.string.forget_pairing else R.string.resolve_confirm))
                        }
                    },
                )
            }
        }
    }
}
