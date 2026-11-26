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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.harnessy.companion.R
import io.harnessy.companion.CompanionPlatform.OperationKind
import io.harnessy.companion.BuildConfig
import io.harnessy.companion.nativeapp.update.AndroidInstallStatus
import io.harnessy.companion.nativeapp.update.AndroidInstallStatusInbox
import io.harnessy.companion.presentation.DisplayModels.Connection

private const val WORK_TAB = "workTab"
private const val SETTINGS_ROUTE = "settings"
private const val BROWSER_ROUTE = "browserShare"

private fun workTabRoute(route: String) = "$route?$WORK_TAB=true"

private val workTabArguments = listOf(navArgument(WORK_TAB) {
    type = NavType.BoolType
    defaultValue = false
})

/** The ViewModel is Activity-scoped, outside the NavHost; destinations never own sockets or drafts. */
@Composable
fun NativeCompanionApp(viewModel: CompanionViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    if (BuildConfig.ANDROID_UPDATES_ENABLED) {
        val installStatus by AndroidInstallStatusInbox.status.collectAsStateWithLifecycle(minActiveState = Lifecycle.State.RESUMED)
        val activity = LocalContext.current
        LaunchedEffect(installStatus) {
            val result = installStatus ?: return@LaunchedEffect
            if (!AndroidInstallStatusInbox.consume(result)) return@LaunchedEffect
            when (result) {
                is AndroidInstallStatus.Confirm -> {
                    viewModel.androidUpdateConfirmationRequired()
                    try { activity.startActivity(result.intent) }
                    catch (_: android.content.ActivityNotFoundException) { viewModel.androidUpdateFinished(false) }
                }
                AndroidInstallStatus.Finished -> viewModel.androidUpdateFinished(true)
                AndroidInstallStatus.Failed -> viewModel.androidUpdateFinished(false)
            }
        }
    }
    val navigation = rememberNavController()
    val entry by navigation.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val browserAvailable = state.companion.screen?.pc?.connection == Connection.ONLINE &&
        !state.companion.connectionPaused
    val workNavigation: @Composable (WorkDestination) -> Unit = { selected ->
        NativeWorkNavigation(selected, browserAvailable) { destination ->
            when (destination) {
                WorkDestination.WORK -> navigation.popBackStack("chat", false)
                WorkDestination.BROWSER -> navigation.navigate(workTabRoute(BROWSER_ROUTE)) {
                    popUpTo("chat")
                    launchSingleTop = true
                }
                WorkDestination.SETTINGS -> navigation.navigate(workTabRoute(SETTINGS_ROUTE)) {
                    popUpTo("chat")
                    launchSingleTop = true
                }
            }
        }
    }
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
                        openSettings = { navigation.navigate(SETTINGS_ROUTE) { launchSingleTop = true } },
                        resumeConnection = viewModel::resumeConnection,
                        openBrowserShare = { navigation.navigate(BROWSER_ROUTE) { launchSingleTop = true } },
                        workBottomBar = { workNavigation(WorkDestination.WORK) })
                }
                composable("pairing") {
                    BackHandler(enabled = pairingVisible) { viewModel.cancelPairing() }
                    state.companion.pairing?.let { NativePairingScreen(it, viewModel) }
                }
                composable("$SETTINGS_ROUTE?$WORK_TAB={$WORK_TAB}", arguments = workTabArguments) { settingsEntry ->
                    val bottomBar: (@Composable () -> Unit)? = if (settingsEntry.arguments?.getBoolean(WORK_TAB) == true) {
                        { workNavigation(WorkDestination.SETTINGS) }
                    } else null
                    NativeSettingsScreen(state, viewModel, NativeSettingsActions(
                        goBack = { navigation.popBackStack() },
                        setTheme = viewModel::setTheme,
                        pauseConnection = viewModel::pauseConnection,
                        resumeConnection = viewModel::resumeConnection,
                        openBrowserShare = { navigation.navigate(BROWSER_ROUTE) { launchSingleTop = true } },
                        checkAndroidUpdate = viewModel::checkAndroidUpdate,
                        installAndroidUpdate = viewModel::installAndroidUpdate,
                    ), workBottomBar = bottomBar)
                }
                composable("$BROWSER_ROUTE?$WORK_TAB={$WORK_TAB}", arguments = workTabArguments) { browserEntry ->
                    val bottomBar: (@Composable () -> Unit)? = if (browserEntry.arguments?.getBoolean(WORK_TAB) == true) {
                        { workNavigation(WorkDestination.BROWSER) }
                    } else null
                    NativeBrowserShareScreen(state, viewModel,
                        close = {
                            viewModel.stopBrowserShareViewing()
                            navigation.popBackStack()
                        }, workBottomBar = bottomBar)
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
