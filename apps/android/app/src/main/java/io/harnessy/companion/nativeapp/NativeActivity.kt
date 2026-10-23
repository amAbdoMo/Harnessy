package io.harnessy.companion.nativeapp

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.launch

/** The retained launcher accepts no secret-bearing Intent payload; fresh invitations arrive through RAM. */
@AndroidEntryPoint
class NativeActivity : ComponentActivity() {
    @Inject lateinit var invitationInbox: InvitationInbox
    private val viewModel: CompanionViewModel by viewModels()
    private var started = false
    private lateinit var content: ComposeView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        clearIncomingIntent(intent)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        else window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        content = ComposeView(this).apply {
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
        }
        setContentView(content)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.state.collect { state ->
                    if (Build.VERSION.SDK_INT >= 33) {
                        if (state.companion.pairing != null) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        started = true
        viewModel.start()
        consumeFreshInvitation()
        content.setContent { NativeCompanionApp(viewModel) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        clearIncomingIntent(intent)
        if (started) consumeFreshInvitation()
    }

    private fun consumeFreshInvitation() {
        invitationInbox.take()?.let { link ->
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            viewModel.importLink(link)
        }
    }

    private fun clearIncomingIntent(incoming: Intent?) {
        incoming?.apply {
            data = null
            clipData = null
            replaceExtras(null as Bundle?)
        }
        setIntent(Intent(this, NativeActivity::class.java))
    }

    override fun onStop() {
        started = false
        viewModel.stop()
        // STARTED collectors can miss the final clear emission; discard private UI snapshots synchronously.
        content.disposeComposition()
        setIntent(Intent(this, NativeActivity::class.java))
        super.onStop()
    }
}
