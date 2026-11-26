package io.harnessy.companion.nativeapp.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

internal class AndroidUpdatePackage(private val context: Context) {
    data class Installed(val sourceApk: File, val versionCode: Long)

    fun installed(): Installed {
        val application = context.applicationInfo
        if (!application.splitSourceDirs.isNullOrEmpty()) {
            throw AndroidUpdateException("Split APK installations are not supported by staging updates")
        }
        val sourceApk = File(application.sourceDir)
        if (!sourceApk.isFile || sourceApk.length() !in 1..MAX_ANDROID_UPDATE_BYTES) {
            throw AndroidUpdateException("Installed APK is unavailable or exceeds the staging size limit")
        }
        return Installed(sourceApk, versionCode(packageInfo(context.packageName)))
    }

    fun verify(candidate: File, offer: AndroidUpdateOffer) {
        if (candidate.length() != offer.targetBytes) throw AndroidUpdateException("Reconstructed APK size is incorrect")
        val current = packageInfo(context.packageName)
        val update = archiveInfo(candidate) ?: throw AndroidUpdateException("Reconstructed APK cannot be parsed")
        if (update.packageName != context.packageName || versionCode(update) != offer.versionCode
            || signerDigests(update) != signerDigests(current)) {
            throw AndroidUpdateException("Reconstructed APK identity does not match the installed app")
        }
    }

    fun commit(candidate: File): AndroidUpdateInstallResult {
        val installer = context.packageManager.packageInstaller
        val parameters = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(candidate.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val sessionId = installer.createSession(parameters)
        var committed = false
        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, candidate.length()).use { output ->
                    FileInputStream(candidate).use { input -> input.copyTo(output) }
                    session.fsync(output)
                }
                AndroidInstallStatusInbox.expect(sessionId)
                session.commit(statusIntent(sessionId).intentSender)
                committed = true
            }
        } finally {
            if (!committed) {
                AndroidInstallStatusInbox.accept(sessionId, AndroidInstallStatus.Failed)
                installer.abandonSession(sessionId)
            }
        }
        return AndroidUpdateInstallResult.ConfirmationRequested
    }

    private fun statusIntent(sessionId: Int): PendingIntent {
        val intent = Intent(context, AndroidUpdateInstallReceiver::class.java)
            .setAction("${context.packageName}.android-update.INSTALL_STATUS")
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(context, sessionId, intent, flags)
    }

    private fun packageInfo(packageName: String): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        return context.packageManager.getPackageInfo(packageName, flags)
    }

    private fun archiveInfo(candidate: File): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        return context.packageManager.getPackageArchiveInfo(candidate.absolutePath, flags)
    }

    @Suppress("DEPRECATION")
    private fun versionCode(packageInfo: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else packageInfo.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signerDigests(packageInfo: PackageInfo): List<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            packageInfo.signingInfo?.apkContentsSigners
                ?: throw AndroidUpdateException("APK signing information is unavailable")
        } else packageInfo.signatures ?: throw AndroidUpdateException("APK signing information is unavailable")
        return signatures.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }.sorted()
    }
}
