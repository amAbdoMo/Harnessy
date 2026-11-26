package io.harnessy.companion.nativeapp

import android.graphics.Bitmap
import android.util.Base64
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeBrowserShareFrameTest {
    @Rule
    @JvmField
    val compose = createComposeRule()

    @Test
    fun displaysLastDecodedFrameUntilTheShareChangesOrEnds() {
        val jpeg = tinyJpeg()
        val shareId = mutableStateOf<String?>("first-share")
        val payload = mutableStateOf<String?>(jpeg)
        compose.setContent {
            val frame = rememberBrowserShareFrame(shareId.value, payload.value)
            Text(if (frame == null) "Waiting" else "Frame")
        }
        fun waitForFrame() = compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithText("Frame").fetchSemanticsNodes().isNotEmpty()
        }

        waitForFrame()
        compose.runOnIdle { payload.value = "aW52YWxpZA==" }
        compose.onNodeWithText("Frame").assertIsDisplayed()

        compose.runOnIdle { shareId.value = "next-share" }
        compose.onNodeWithText("Waiting").assertIsDisplayed()

        compose.runOnIdle { payload.value = jpeg }
        waitForFrame()
        compose.runOnIdle { payload.value = null }
        compose.onNodeWithText("Waiting").assertIsDisplayed()
    }

    @Test
    fun highResolutionFramesKeepDimensionAndByteLimitsBeforeDecoding() {
        for ((width, height) in listOf(960 to 960, 960 to 540, 540 to 960)) {
            val jpeg = tinyJpeg(width, height)
            assertTrue(Base64.decode(jpeg, Base64.NO_WRAP).size <= 18_432)
            val frame = requireNotNull(decodeBrowserShareFrame(jpeg))
            try {
                assertEquals(width, frame.width)
                assertEquals(height, frame.height)
            } finally {
                frame.asAndroidBitmap().recycle()
            }
        }
        for ((width, height) in listOf(961 to 4, 4 to 961)) {
            assertNull(decodeBrowserShareFrame(tinyJpeg(width, height)))
        }
        val oversized = Base64.encodeToString(Base64.decode(tinyJpeg(), Base64.NO_WRAP).copyOf(18_433), Base64.NO_WRAP)
        assertNull(decodeBrowserShareFrame(oversized))
    }

    private fun tinyJpeg(width: Int = 4, height: Int = 4): String {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val output = ByteArrayOutputStream()
        try {
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output))
            return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } finally {
            bitmap.recycle()
        }
    }
}
