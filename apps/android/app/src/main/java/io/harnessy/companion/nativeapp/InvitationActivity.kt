package io.harnessy.companion.nativeapp

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/** No-history/no-display entry: fresh links cross into the launcher through bounded application RAM. */
@AndroidEntryPoint
class InvitationActivity : ComponentActivity() {
    @Inject lateinit var inbox: InvitationInbox

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val incoming = intent
        val uri = incoming?.data
        val link = uri?.toString()
        val action = incoming?.action
        incoming?.apply {
            data = null
            clipData = null
            replaceExtras(null as Bundle?)
        }
        setIntent(Intent(this, InvitationActivity::class.java))
        // Restoration is not a new invitation delivery; the main task never receives the source Intent.
        if (savedInstanceState != null || uri == null || link == null) {
            finish()
            return
        }
        val permitted = action == Intent.ACTION_VIEW && uri.scheme == "harnessy" && uri.host == "pair"
        inbox.offer(if (permitted) link else "")
        startActivity(Intent(this, NativeActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        })
        finish()
    }
}
