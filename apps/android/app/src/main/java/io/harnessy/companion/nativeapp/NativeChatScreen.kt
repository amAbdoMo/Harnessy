package io.harnessy.companion.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.CompanionPlatform.OperationKind
import io.harnessy.companion.nativeapp.markdown.NativeMessageBody
import io.harnessy.companion.presentation.DisplayModels.*
import kotlinx.coroutines.launch

/** Stateless native chat; actions carry the rendered foreground/session/draft identity. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeChatScreen(
    state: CompanionState,
    actions: NativeChatActions,
    openSettings: () -> Unit,
    resumeConnection: () -> Unit,
) {
    val screen = state.screen
    when {
        !state.connectionPaused && state.foreground && (screen == null || screen.metadataLoading) -> LoadingPcScreen(openSettings)
        screen?.pc == null || state.connectionPaused -> LinkPcScreen(state, actions, openSettings, resumeConnection)
        else -> PairedChatScreen(state, screen, actions, openSettings)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LoadingPcScreen(openSettings: () -> Unit) {
    Scaffold(topBar = { CompanionTopBar(stringResource(R.string.native_brand_name), openSettings) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).padding(24.dp),
            verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(Modifier.testTag("loading_pc"))
            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.native_loading_pc), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionTopBar(title: String, openSettings: () -> Unit) {
    CenterAlignedTopAppBar(title = { Text(title, style = MaterialTheme.typography.titleMedium) }, actions = {
        NativeFloatingIconButton(Icons.Default.Settings, stringResource(R.string.native_settings),
            openSettings, testTag = "open_settings", iconSize = 18.dp)
    }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LinkPcScreen(state: CompanionState, actions: NativeChatActions, openSettings: () -> Unit, resumeConnection: () -> Unit) {
    Scaffold(topBar = { CompanionTopBar(stringResource(R.string.native_brand_name), openSettings) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
            contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item {
                Text(stringResource(if (state.connectionPaused) R.string.native_connection_paused else R.string.pairing_title),
                    style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            }
            item { Text(stringResource(if (state.connectionPaused) R.string.native_pause_explanation else R.string.pairing_explanation)) }
            item {
                Button(onClick = if (state.connectionPaused) resumeConnection else actions::showPairing,
                    enabled = state.foreground, modifier = Modifier.testTag("link_pc")) {
                    Text(stringResource(if (state.connectionPaused) R.string.native_resume else R.string.pair_pc))
                }
            }
            state.screen?.let { screen ->
                item { FeedbackNotice(screen.composer.feedback) }
                screen.composer.review?.let { review -> item { DeliveryReviewCard(review, actions::resolveUnknown) } }
            }
            item { Text(stringResource(R.string.native_foreground_note), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PairedChatScreen(state: CompanionState, screen: Screen, actions: NativeChatActions, openSettings: () -> Unit) {
    val pc = screen.pc ?: return
    val workspaceExpansion = WorkspaceExpansionControls(pc.id, state.workspaceExpansion,
        state.workspacePreferenceFailed, actions::setWorkspaceExpansion)
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 600.dp
        val navigationWidth = if (maxWidth >= 840.dp) 288.dp else 240.dp
        val drawer = rememberDrawerState(DrawerValue.Closed)
        val scope = rememberCoroutineScope()
        val focus = LocalFocusManager.current
        val keyboard = LocalSoftwareKeyboardController.current
        // Retain window focus on a non-editor target while the wide pane is rearranged.
        val navigationFocus = remember { FocusRequester() }
        var managementDialog by remember(state.foregroundGeneration, pc.id) { mutableStateOf<SidebarManagementDialog?>(null) }
        var wideNavigationVisible by rememberSaveable { mutableStateOf(true) }
        val openSessions: () -> Unit = {
            focus.clearFocus(force = true)
            if (wide) navigationFocus.requestFocus()
            keyboard?.hide()
            if (wide) wideNavigationVisible = true else scope.launch { drawer.open() }
        }
        val closeSessions: () -> Unit = {
            focus.clearFocus(force = true)
            if (wide) navigationFocus.requestFocus()
            keyboard?.hide()
            if (wide) wideNavigationVisible = false else scope.launch { drawer.close() }
        }
        val sidebar = sidebarManagementActions(state, actions, closeSessions) { managementDialog = it }
        val refreshSidebar: () -> Unit = { actions.refresh(); actions.refreshManagementWorkspaces() }
        val chat: @Composable () -> Unit = {
            Scaffold(
                topBar = {
                    CenterAlignedTopAppBar(
                        title = {
                            if (screen.conversation.session == null) {
                                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
                                    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surface,
                                        shadowElevation = 1.dp) {
                                        Text(stringResource(R.string.native_work), style = MaterialTheme.typography.labelLarge,
                                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 7.dp))
                                    }
                                }
                            } else Text(screen.conversation.session.title.ifBlank { stringResource(R.string.native_untitled_conversation) },
                                style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        },
                        navigationIcon = {
                            if (!wide || !wideNavigationVisible) {
                                NativeFloatingIconButton(Icons.Default.Menu, stringResource(R.string.native_open_conversations),
                                    openSessions, testTag = "open_sessions")
                            }
                        },
                        actions = {
                            NativeConnectionStatus(pc.connection)
                            Spacer(Modifier.width(8.dp))
                            NativeFloatingIconButton(Icons.Default.Settings, stringResource(R.string.native_settings),
                                openSettings, testTag = "open_settings", iconSize = 18.dp)
                        },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                    )
                },
                bottomBar = { NativeComposer(state, screen, actions, if (wide) null else openSessions) },
            ) { padding ->
                Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
                    if (screen.conversation.session == null) NativeWorkLanding(screen, state.foreground, actions,
                        Modifier.widthIn(max = 760.dp).fillMaxSize())
                    else ConversationPane(screen, actions, Modifier.widthIn(max = 760.dp).fillMaxSize())
                }
            }
        }
        if (wide) {
            Box(Modifier.fillMaxSize()) {
                // A small, non-semantic focus origin lets arrow keys reach the visible controls.
                Box(Modifier.size(1.dp).focusRequester(navigationFocus).focusTarget())
                Row(Modifier.fillMaxSize()) {
                    if (wideNavigationVisible) {
                        Surface(Modifier.width(navigationWidth).fillMaxHeight(), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                            NativeSessionNavigation(screen.sessions, state.foreground,
                                SessionNavigationActions(refreshSidebar, { id ->
                                    navigationFocus.requestFocus()
                                    keyboard?.hide()
                                    actions.selectSession(id)
                                }, actions::loadMoreSessions, workspaceExpansion, sidebar),
                                Modifier.statusBarsPadding().navigationBarsPadding().imePadding())
                        }
                        VerticalDivider()
                    }
                    Box(Modifier.weight(1f)) { chat() }
                }
            }
        } else {
            ModalNavigationDrawer(drawerState = drawer, drawerContent = {
                ModalDrawerSheet(drawerState = drawer, modifier = Modifier.fillMaxWidth(0.8f),
                    drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
                    NativeSessionNavigation(screen.sessions, state.foreground,
                        SessionNavigationActions(refreshSidebar, { id ->
                            actions.selectSession(id)
                            scope.launch { drawer.close() }
                        }, actions::loadMoreSessions, workspaceExpansion, sidebar), Modifier.fillMaxWidth().imePadding())
                }
            }) { chat() }
        }
        managementDialog?.let { dialog -> NativeSessionManagementDialog(dialog, state, actions) { managementDialog = null } }
    }
}

/** Names the PC link separately from a conversation's read-only or running status. */
@Composable
internal fun NativeConnectionStatus(connection: Connection) {
    val label = when (connection) {
        Connection.ONLINE -> R.string.native_pc_online
        Connection.OFFLINE -> R.string.native_pc_offline
        Connection.CONNECTING -> R.string.native_pc_connecting
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(6.dp).background(if (connection == Connection.ONLINE) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
        Text(stringResource(label), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ConversationPane(screen: Screen, actions: NativeChatActions, modifier: Modifier) {
    val scroll = remember(screen.conversation.session?.id) { LazyListState() }
    val scope = rememberCoroutineScope()
    val awayFromLatest by remember(scroll) { derivedStateOf { scroll.firstVisibleItemIndex > 2 } }
    val entries = transcriptEntries(screen.conversation.rows)
    val expanded = remember(screen.conversation.session?.id) { mutableStateMapOf<String, Boolean>() }
    val retained = entries.filterIsInstance<TranscriptEntry.Activity>().map { it.key }.toSet()
    LaunchedEffect(retained) {
        expanded.keys.filterNot { it in retained }.forEach { expanded.remove(it) }
    }
    BoxWithConstraints(modifier) {
        val activityBodyHeight = minOf(400.dp, maxHeight / 2)
        LazyColumn(Modifier.fillMaxSize().testTag("transcript"), state = scroll, reverseLayout = true,
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (screen.composer.feedback != Feedback.NONE && screen.composer.feedback != Feedback.DELIVERY_UNKNOWN) {
                item(key = "feedback") {
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(16.dp)) {
                        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            FeedbackNotice(screen.composer.feedback)
                            if (screen.composer.feedback == Feedback.REFRESH_FAILED && screen.pc?.connection == Connection.ONLINE) {
                                TextButton(onClick = actions::refresh, modifier = Modifier.testTag("retry_conversation")) {
                                    Text(stringResource(R.string.native_retry))
                                }
                            }
                        }
                    }
                }
            }
            screen.composer.review?.let { review -> item(key = "delivery_review") { DeliveryReviewCard(review, actions::resolveUnknown) } }
            if (screen.conversation.rows.isEmpty()) item(key = "empty_history") {
                Text(stringResource(R.string.transcript_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            itemsIndexed(entries.asReversed(), key = { _, entry -> entry.key }) { index, entry ->
                when (entry) {
                    is TranscriptEntry.Message -> NativeChatMessage(entry.row)
                    is TranscriptEntry.Activity -> NativeToolActivity(entry,
                        ActivityDisclosure(expanded[entry.key] == true) {
                            expanded[entry.key] = expanded[entry.key] != true
                            scope.launch { scroll.animateScrollToItem(index) }
                        }, activityBodyHeight)
                }
            }
            if (screen.conversation.canLoadMore) item(key = "more_history") {
                TextButton(onClick = actions::loadMoreHistory, modifier = Modifier.testTag("load_more_history")) {
                    Text(stringResource(R.string.load_history))
                }
            }
        }
        if (awayFromLatest) NativeFloatingIconButton(Icons.Default.KeyboardArrowDown,
            stringResource(R.string.native_jump_latest), { scope.launch { scroll.animateScrollToItem(0) } },
            testTag = "jump_to_latest", modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
    }
}

@Composable
private fun NativeChatMessage(row: TextRow) {
    if (row.role == Role.TOOL || row.role == Role.NOTICE) {
        NativeActivityEvent(row)
        return
    }
    val author = stringResource(roleText(row.role))
    BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 5.dp).testTag("message_${row.id}").semantics { stateDescription = author }) {
        if (row.role == Role.USER) {
            Surface(modifier = Modifier.align(Alignment.CenterEnd).widthIn(max = maxWidth * 0.88f).testTag("user_message"),
                color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(20.dp), shadowElevation = 1.dp) {
                NativeMessageBody(row.text, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            }
        } else {
            NativeMessageBody(row.text, Modifier.fillMaxWidth().testTag("assistant_message"))
        }
    }
}

@Composable
internal fun FeedbackNotice(feedback: Feedback) {
    val resource = if (feedback == Feedback.REFRESH_FAILED) R.string.native_chat_read_error else feedbackText(feedback) ?: return
    Text(stringResource(resource), color = if (feedback == Feedback.INBOX_ADMITTED) MaterialTheme.colorScheme.primary
        else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}

@Composable
internal fun DeliveryReviewCard(review: DeliveryReview, onReview: () -> Unit) {
    val management = review.kind != OperationKind.SUBMIT_TEXT
    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(when (review.kind) {
                OperationKind.SELECT_SESSION_MODEL -> R.string.native_model_unknown
                OperationKind.OPEN_SESSION -> R.string.native_open_chat_unknown
                OperationKind.SUBMIT_TEXT -> R.string.delivery_unknown
                else -> R.string.native_management_unknown
            }),
                color = MaterialTheme.colorScheme.onErrorContainer)
            SelectionContainer {
                val target = if (management) stringResource(R.string.native_management_unknown_target, review.pcId, review.sessionId,
                    stringResource(managementOperationText(review.kind)), review.submissionId)
                    else stringResource(R.string.unknown_target, review.pcId, review.sessionId, review.submissionId)
                Text(target, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
            TextButton(onClick = onReview, modifier = Modifier.testTag("review_delivery")) {
                Text(stringResource(R.string.resolve_unknown))
            }
        }
    }
}
