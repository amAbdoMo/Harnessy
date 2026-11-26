package io.harnessy.companion.nativeapp

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
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
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun NativeBrowserShareScreen(
    state: NativeUiState,
    viewModel: CompanionViewModel,
    close: () -> Unit,
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
            CenterAlignedTopAppBar(
                title = { Text(stringResource(R.string.native_browser_share_title), style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    NativeFloatingIconButton(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.native_back),
                        close, testTag = "close_browser_share")
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).statusBarsPadding().navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.fillMaxWidth().weight(1f).widthIn(max = 960.dp)
                    .background(Color.Black).testTag("browser_share_frame"),
                contentAlignment = Alignment.Center,
            ) {
                if (currentFrame != null) {
                    Image(currentFrame, stringResource(R.string.native_browser_share_frame),
                        Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                } else {
                    when (share.status) {
                        NativeBrowserShareStatus.ENDED -> Text(stringResource(R.string.native_browser_share_ended),
                            color = Color.White, modifier = Modifier.testTag("browser_share_ended"))
                        NativeBrowserShareStatus.ERROR -> Text(stringResource(
                            if (share.stopFailed) R.string.native_browser_share_stop_failed else R.string.native_browser_share_unavailable),
                            color = Color.White, modifier = Modifier.testTag("browser_share_error"))
                        else -> Column(horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            CircularProgressIndicator(color = Color.White, modifier = Modifier.testTag("browser_share_loading"))
                            Text(stringResource(R.string.native_browser_share_waiting), color = Color.White)
                        }
                    }
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
                modifier = Modifier.fillMaxWidth().widthIn(max = 480.dp).testTag("stop_browser_share"),
            ) {
                Text(stringResource(R.string.native_browser_share_stop))
            }
            Spacer(Modifier.height(2.dp))
        }
    }
}
