package io.harnessy.companion.nativeapp

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.integerResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

private const val MAX_FRAME_WIDTH = 480
private const val MAX_FRAME_HEIGHT = 270
private const val MAX_FRAME_BYTES = 18_432

private fun decodeBrowserShareFrame(encoded: String): ImageBitmap? {
    val bytes = runCatching { Base64.decode(encoded, Base64.NO_WRAP) }.getOrNull() ?: return null
    if (bytes.isEmpty() || bytes.size > MAX_FRAME_BYTES) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outMimeType != "image/jpeg" || bounds.outWidth <= 0 || bounds.outHeight <= 0
        || bounds.outWidth > MAX_FRAME_WIDTH || bounds.outHeight > MAX_FRAME_HEIGHT) {
        return null
    }
    val options = BitmapFactory.Options().apply { inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888 }
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
    if (bitmap.width > MAX_FRAME_WIDTH || bitmap.height > MAX_FRAME_HEIGHT) {
        bitmap.recycle()
        return null
    }
    return bitmap.asImageBitmap()
}

/** Keeps a decoded image visible while replacing it within the same active share. */
@Composable
internal fun rememberBrowserShareFrame(shareId: String?, jpegBase64: String?): ImageBitmap? {
    if (shareId == null || jpegBase64 == null) return null
    return key(shareId) {
        val frame by produceState<ImageBitmap?>(null, jpegBase64) {
            withContext(Dispatchers.Default) { decodeBrowserShareFrame(jpegBase64) }?.let { value = it }
        }
        frame
    }
}

/** Native, view-only browser share. The encrypted companion link is the only data source. */
@Composable
fun NativeBrowserShareScreen(
    state: NativeUiState,
    viewModel: CompanionViewModel,
    close: () -> Unit,
    workBottomBar: (@Composable () -> Unit)? = null,
) {
    val share = state.companion.browserShare
    val pollMs = integerResource(R.integer.browser_share_poll_ms).toLong()
    BackHandler(onBack = close)
    DisposableEffect(Unit) {
        viewModel.startBrowserShareViewing()
        onDispose { viewModel.stopBrowserShareViewing() }
    }
    LaunchedEffect(pollMs) {
        while (isActive) {
            // Push is the normal path. The controller admits this poll only after an unacknowledged subscription
            // retired its channel, preserving compatibility with an older paired Desktop.
            viewModel.watchBrowserShare()
            delay(pollMs)
        }
    }

    val currentFrame = rememberBrowserShareFrame(share.shareId, share.jpegBase64)
    Scaffold(
        topBar = {
            Surface(color = MaterialTheme.colorScheme.background) {
                Row(Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 48.dp)
                    .padding(start = if (workBottomBar == null) 0.dp else 16.dp, end = 16.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    if (workBottomBar == null) {
                        NativeFloatingIconButton(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.native_back),
                            close, testTag = "close_browser_share")
                    }
                    Text(stringResource(R.string.native_browser_share_title),
                        style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f),
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(R.string.native_live_browser_view_only),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        bottomBar = { workBottomBar?.invoke() },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BrowserShareStatus(share, currentFrame != null)
            Surface(
                modifier = Modifier.widthIn(max = 960.dp).fillMaxWidth().weight(1f).testTag("browser_share_frame"),
                shape = RoundedCornerShape(28.dp),
                color = if (currentFrame != null) Color.Black else MaterialTheme.colorScheme.surfaceContainerLow,
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (currentFrame != null) {
                        Image(currentFrame, stringResource(R.string.native_browser_share_frame),
                            Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                    } else BrowserSharePlaceholder(share)
                }
            }
            if (share.status == NativeBrowserShareStatus.STOPPING) {
                Text(stringResource(R.string.native_browser_share_stopping), style = MaterialTheme.typography.bodyMedium)
            }
            Button(
                onClick = { share.shareId?.let { viewModel.stopBrowserShare(it) } },
                enabled = share.shareId != null && share.status != NativeBrowserShareStatus.STOPPING &&
                    share.status != NativeBrowserShareStatus.ENDED && !share.stopFailed,
                contentPadding = PaddingValues(horizontal = 24.dp, vertical = 10.dp),
                modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth().heightIn(min = 48.dp).testTag("stop_browser_share"),
            ) {
                Text(stringResource(R.string.native_browser_share_stop))
            }
            Spacer(Modifier.height(2.dp))
        }
    }
}

@Composable
private fun BrowserShareStatus(share: NativeBrowserShareState, hasFrame: Boolean) {
    val status = when (share.status) {
        NativeBrowserShareStatus.ENDED -> R.string.native_live_browser_ended
        NativeBrowserShareStatus.ERROR -> if (share.stopFailed) R.string.native_live_browser_stop_failed
            else R.string.native_live_browser_reconnecting
        NativeBrowserShareStatus.STOPPING -> R.string.native_browser_share_stopping
        NativeBrowserShareStatus.FRAME -> if (hasFrame) R.string.native_live_browser_live else R.string.native_live_browser_connecting
        NativeBrowserShareStatus.IDLE, NativeBrowserShareStatus.BUSY -> R.string.native_live_browser_connecting
    }
    Row(Modifier.widthIn(max = 960.dp).fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(8.dp).background(
            if (hasFrame && share.status == NativeBrowserShareStatus.FRAME) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(status), style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("browser_share_status"))
            Text(stringResource(R.string.native_browser_share_subtitle), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun BrowserSharePlaceholder(share: NativeBrowserShareState) {
    Column(Modifier.widthIn(max = 400.dp).padding(24.dp).verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        when (share.status) {
            NativeBrowserShareStatus.ENDED, NativeBrowserShareStatus.ERROR -> {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
                    Icon(Icons.Default.PlayArrow, null, Modifier.padding(16.dp).size(28.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            else -> CircularProgressIndicator(Modifier.size(28.dp).testTag("browser_share_loading"), strokeWidth = 2.dp)
        }
        val message = when (share.status) {
            NativeBrowserShareStatus.ENDED -> R.string.native_browser_share_ended
            NativeBrowserShareStatus.ERROR -> if (share.stopFailed) R.string.native_browser_share_stop_failed
                else R.string.native_browser_share_unavailable
            else -> R.string.native_browser_share_waiting
        }
        val tag = when (share.status) {
            NativeBrowserShareStatus.ENDED -> "browser_share_ended"
            NativeBrowserShareStatus.ERROR -> "browser_share_error"
            else -> "browser_share_waiting"
        }
        Text(stringResource(message), style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag(tag))
        if (share.status != NativeBrowserShareStatus.ERROR && share.status != NativeBrowserShareStatus.STOPPING) {
            Text(stringResource(R.string.native_live_browser_start_on_pc), textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
