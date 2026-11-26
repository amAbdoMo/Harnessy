package io.harnessy.companion.nativeapp.update

internal const val MAX_ANDROID_UPDATE_BYTES = 64L * 1024 * 1024
internal const val ANDROID_UPDATE_CHUNK_BYTES = 12_288

internal fun validateOffer(offer: AndroidUpdateOffer, installedSha256: String, installedVersionCode: Long) {
    if (!offer.artifactId.isLowerHexSha256() || !offer.baseSha256.isLowerHexSha256()
        || !offer.targetSha256.isLowerHexSha256()) {
        throw AndroidUpdateException("Android update contains an invalid SHA-256 value")
    }
    if (offer.baseSha256 != installedSha256 || offer.versionCode <= installedVersionCode
        || offer.versionCode > 2_100_000_000) {
        throw AndroidUpdateException("Android update does not apply to this installation")
    }
    if (offer.targetBytes !in 1..MAX_ANDROID_UPDATE_BYTES || offer.patchBytes !in 8 until offer.targetBytes) {
        throw AndroidUpdateException("Android update exceeds the staging size limit")
    }
}

internal fun String.isLowerHexSha256(): Boolean =
    length == 64 && all { character -> character in '0'..'9' || character in 'a'..'f' }
