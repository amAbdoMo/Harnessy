package io.harnessy.companion.nativeapp.update

import android.content.Intent

/** Paired-PC update transport. Cancellation of either call must cancel its in-flight controller request. */
interface AndroidUpdateSource {
    suspend fun check(installedSha256: String, installedVersionCode: Long): AndroidUpdateOffer?
    suspend fun read(artifactId: String, offset: Int): ByteArray
}

/** Exact metadata authenticated by the paired companion channel. */
data class AndroidUpdateOffer(
    val artifactId: String,
    val baseSha256: String,
    val targetSha256: String,
    val versionCode: Long,
    val targetBytes: Long,
    val patchBytes: Long,
)

sealed interface AndroidUpdateCheckResult {
    data object Current : AndroidUpdateCheckResult
    data class Available(val offer: AndroidUpdateOffer) : AndroidUpdateCheckResult
}

sealed interface AndroidUpdateInstallResult {
    data class PermissionRequired(val settingsIntent: Intent) : AndroidUpdateInstallResult
    data object Committed : AndroidUpdateInstallResult
}

class AndroidUpdateException(message: String, cause: Throwable? = null) : Exception(message, cause)
