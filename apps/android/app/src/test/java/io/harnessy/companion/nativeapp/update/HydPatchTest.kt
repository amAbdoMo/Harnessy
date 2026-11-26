package io.harnessy.companion.nativeapp.update

import java.io.DataOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HydPatchTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun reconstructsTheTargetFromExistingAndChangedBytes() {
        val source = folder.newFile().apply { writeText("old hello") }
        val patch = folder.newFile()
        DataOutputStream(patch.outputStream()).use { output ->
            output.writeBytes("HYD1")
            output.writeInt(2)
            output.writeInt(-1)
            output.writeInt(4)
            output.writeBytes("new ")
            output.writeInt(4)
            output.writeInt(5)
        }
        val target = folder.newFile()
        val hash = HydPatch.apply(source, patch, target, expectedTargetBytes = 9)
        assertArrayEquals("new hello".toByteArray(), target.readBytes())
        assertEquals(sha256(target), hash)
        assertThrows(AndroidUpdateException::class.java) { HydPatch.apply(source, patch, target, expectedTargetBytes = 8) }
    }

    @Test fun refusesReadsBeyondTheInstalledApk() {
        val source = folder.newFile().apply { writeText("old") }
        val patch = folder.newFile()
        DataOutputStream(patch.outputStream()).use { output ->
            output.writeBytes("HYD1")
            output.writeInt(1)
            output.writeInt(3)
            output.writeInt(1)
        }
        assertThrows(AndroidUpdateException::class.java) { HydPatch.apply(source, patch, folder.newFile(), expectedTargetBytes = 1) }
    }
}
