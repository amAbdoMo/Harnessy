package io.harnessy.companion.nativeapp.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal sealed interface AndroidInstallStatus {
    data class Confirm(val intent: Intent) : AndroidInstallStatus
    data object Finished : AndroidInstallStatus
    data object Failed : AndroidInstallStatus
}

/** Only the session this process committed may put a system prompt on screen. */
internal object AndroidInstallStatusInbox {
    private var sessionId: Int? = null
    private val pending = MutableStateFlow<AndroidInstallStatus?>(null)
    val status = pending.asStateFlow()

    @Synchronized fun expect(id: Int) { sessionId = id; pending.value = null }

    @Synchronized fun accept(id: Int, status: AndroidInstallStatus) {
        if (sessionId != id) return
        if (status !is AndroidInstallStatus.Confirm) sessionId = null
        pending.value = status
    }

    fun consume(status: AndroidInstallStatus): Boolean = pending.compareAndSet(status, null)
}

class AndroidUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "${context.packageName}.android-update.INSTALL_STATUS") return
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val status = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> confirmation(intent)?.let { AndroidInstallStatus.Confirm(it) }
                ?: AndroidInstallStatus.Failed
            PackageInstaller.STATUS_SUCCESS -> AndroidInstallStatus.Finished
            else -> AndroidInstallStatus.Failed
        }
        AndroidInstallStatusInbox.accept(sessionId, status)
    }

    private fun confirmation(intent: Intent): Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        }
}
