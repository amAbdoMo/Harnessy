package io.harnessy.companion.nativeapp.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.harnessy.companion.BuildConfig
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidUpdateEngine(context: Context, private val source: AndroidUpdateSource) {
    private val applicationContext = context.applicationContext
    private val updatePackage = AndroidUpdatePackage(applicationContext)

    suspend fun check(): AndroidUpdateCheckResult = withContext(Dispatchers.IO) {
        requireEnabled()
        val installed = updatePackage.installed()
        val installedSha256 = sha256(installed.sourceApk)
        val offer = source.check(installedSha256, installed.versionCode)
            ?: return@withContext AndroidUpdateCheckResult.Current
        validateOffer(offer, installedSha256, installed.versionCode)
        AndroidUpdateCheckResult.Available(offer)
    }

    suspend fun install(offer: AndroidUpdateOffer): AndroidUpdateInstallResult = withContext(Dispatchers.IO) {
        requireEnabled()
        if (!applicationContext.packageManager.canRequestPackageInstalls()) {
            return@withContext AndroidUpdateInstallResult.PermissionRequired(unknownSourcesIntent())
        }
        val installed = updatePackage.installed()
        val installedSha256 = sha256(installed.sourceApk)
        validateOffer(offer, installedSha256, installed.versionCode)
        val directory = File(applicationContext.cacheDir, "android-update").apply { mkdirs() }
        val patch = File.createTempFile("patch-", ".hyd", directory)
        val candidate = File.createTempFile("candidate-", ".apk", directory)
        try {
            download(offer, patch)
            if (sha256(patch) != offer.artifactId) throw AndroidUpdateException("Downloaded Android patch hash is incorrect")
            if (HydPatch.apply(installed.sourceApk, patch, candidate, offer.targetBytes) != offer.targetSha256) {
                throw AndroidUpdateException("Reconstructed Android APK hash is incorrect")
            }
            updatePackage.verify(candidate, offer)
            updatePackage.commit(candidate)
        } finally {
            patch.delete()
            candidate.delete()
        }
    }

    private suspend fun download(offer: AndroidUpdateOffer, patch: File) {
        BufferedOutputStream(FileOutputStream(patch)).use { output ->
            var offset = 0
            while (offset.toLong() < offer.patchBytes) {
                val expected = minOf(ANDROID_UPDATE_CHUNK_BYTES.toLong(), offer.patchBytes - offset).toInt()
                val chunk = source.read(offer.artifactId, offset)
                if (chunk.size != expected) throw AndroidUpdateException("Android update source returned an invalid chunk")
                output.write(chunk)
                offset += chunk.size
            }
        }
    }

    private fun unknownSourcesIntent(): Intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${applicationContext.packageName}"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun requireEnabled() {
        if (!BuildConfig.ANDROID_UPDATES_ENABLED) throw AndroidUpdateException("Android updates are disabled in this build")
    }
}
