package io.harnessy.companion.nativeapp.update

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.DigestOutputStream
import java.security.MessageDigest

internal object HydPatch {
    private val magic = byteArrayOf('H'.code.toByte(), 'Y'.code.toByte(), 'D'.code.toByte(), '1'.code.toByte())
    private const val MAX_OPERATIONS = 65_536L
    private const val COPY_BUFFER_BYTES = 32 * 1024

    fun apply(source: File, patch: File, target: File, expectedTargetBytes: Long): String {
        if (expectedTargetBytes !in 1..MAX_ANDROID_UPDATE_BYTES || source.length() > MAX_ANDROID_UPDATE_BYTES
            || patch.length() > MAX_ANDROID_UPDATE_BYTES) {
            throw AndroidUpdateException("Android update patch input exceeds its size limit")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            DataInputStream(BufferedInputStream(FileInputStream(patch))).use { input ->
                RandomAccessFile(source, "r").use { installed ->
                    DigestOutputStream(BufferedOutputStream(FileOutputStream(target)), digest).use { output ->
                        applyRecords(input, installed, output, expectedTargetBytes)
                    }
                }
            }
        } catch (failure: EOFException) {
            throw AndroidUpdateException("Android update patch ended early", failure)
        } catch (failure: IOException) {
            throw AndroidUpdateException("Android update patch could not be applied", failure)
        }
        return digest.digest().toHex()
    }

    private fun applyRecords(
        input: DataInputStream,
        installed: RandomAccessFile,
        output: DigestOutputStream,
        expectedTargetBytes: Long,
    ) {
        val header = ByteArray(magic.size)
        input.readFully(header)
        if (!header.contentEquals(magic)) throw AndroidUpdateException("Invalid Android update patch header")
        val operationCount = input.readInt().toLong() and 0xffff_ffffL
        if (operationCount > MAX_OPERATIONS) throw AndroidUpdateException("Android update patch has too many operations")
        var producedBytes = 0L
        val buffer = ByteArray(COPY_BUFFER_BYTES)
        repeat(operationCount.toInt()) {
            val sourceOffset = input.readInt()
            val length = input.readInt().toLong() and 0xffff_ffffL
            if (length == 0L || length > expectedTargetBytes - producedBytes) {
                throw AndroidUpdateException("Android update patch has an invalid operation length")
            }
            if (sourceOffset == -1) {
                copyExactly(length, buffer, { bytes -> input.readFully(buffer, 0, bytes) }, output)
            } else {
                if (sourceOffset < 0 || sourceOffset.toLong() + length > installed.length()) {
                    throw AndroidUpdateException("Android update patch reads outside the installed APK")
                }
                installed.seek(sourceOffset.toLong())
                copyExactly(length, buffer, { bytes -> installed.readFully(buffer, 0, bytes) }, output)
            }
            producedBytes += length
        }
        if (producedBytes != expectedTargetBytes || input.read() != -1) {
            throw AndroidUpdateException("Android update patch output does not match its manifest")
        }
    }

    private inline fun copyExactly(
        length: Long,
        buffer: ByteArray,
        read: (Int) -> Unit,
        output: DigestOutputStream,
    ) {
        var remaining = length
        while (remaining > 0) {
            val bytes = minOf(remaining, buffer.size.toLong()).toInt()
            read(bytes)
            output.write(buffer, 0, bytes)
            remaining -= bytes
        }
    }
}

internal fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
        val buffer = ByteArray(32 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            digest.update(buffer, 0, read)
        }
    }
    return digest.digest().toHex()
}

internal fun ByteArray.toHex(): String = joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
