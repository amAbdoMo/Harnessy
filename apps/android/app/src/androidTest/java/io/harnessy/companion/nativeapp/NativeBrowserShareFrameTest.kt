package io.harnessy.companion.nativeapp

import android.graphics.Bitmap
import android.util.Base64
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeBrowserShareFrameTest {
    @get:Rule
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

    private fun tinyJpeg(): String {
        val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
        val output = ByteArrayOutputStream()
        try {
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output))
            return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } finally {
            bitmap.recycle()
        }
    }
}
