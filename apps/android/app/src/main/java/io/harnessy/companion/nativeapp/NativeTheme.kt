package io.harnessy.companion.nativeapp

import android.app.Activity
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import io.harnessy.companion.R

@Composable
fun NativeTheme(preference: ThemePreference, content: @Composable () -> Unit) {
    val dark = when (preference) {
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
    val context = LocalContext.current
    val deviceConfiguration = LocalConfiguration.current
    val colors = remember(context, dark, deviceConfiguration) {
        val configuration = Configuration(deviceConfiguration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }
        nativeColors(context.createConfigurationContext(configuration).resources)
    }
    val view = LocalView.current
    DisposableEffect(view, dark) {
        val window = (view.context as? Activity)?.window
        if (window != null) {
            val bars = WindowCompat.getInsetsController(window, view)
            bars.isAppearanceLightStatusBars = !dark
            if (Build.VERSION.SDK_INT >= 27) bars.isAppearanceLightNavigationBars = !dark
        }
        onDispose { }
    }
    val typography = remember {
        val defaults = Typography()
        defaults.copy(
            titleLarge = defaults.titleLarge.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
            titleMedium = defaults.titleMedium.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
            bodyLarge = defaults.bodyLarge.copy(fontSize = 16.sp, lineHeight = 23.sp),
            bodyMedium = defaults.bodyMedium.copy(fontSize = 14.sp, lineHeight = 21.sp),
            labelLarge = defaults.labelLarge.copy(fontSize = 12.sp, lineHeight = 16.sp),
            labelSmall = defaults.labelSmall.copy(fontSize = 10.sp, lineHeight = 14.sp),
        )
    }
    MaterialTheme(colorScheme = colors, typography = typography, content = content)
}

/** Reads the owning day/night palette even when the app overrides the device theme. */
private fun nativeColors(resources: Resources): ColorScheme {
    fun color(id: Int) = Color(resources.getColor(id, null))
    val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    val scheme = if (dark) darkColorScheme() else lightColorScheme()
    val base = color(R.color.harnessy_base)
    val surface = color(R.color.harnessy_surface)
    val primaryText = color(R.color.harnessy_primary)
    val secondaryText = color(R.color.harnessy_secondary)
    val layer = color(R.color.harnessy_layer)
    val selected = color(R.color.harnessy_selected)
    val accent = color(R.color.harnessy_accent)
    return scheme.copy(
        primary = accent, onPrimary = surface,
        primaryContainer = selected, onPrimaryContainer = primaryText,
        secondary = secondaryText, onSecondary = surface,
        secondaryContainer = layer, onSecondaryContainer = primaryText,
        tertiary = accent, onTertiary = surface,
        tertiaryContainer = selected, onTertiaryContainer = primaryText,
        background = base, onBackground = primaryText,
        surface = surface, onSurface = primaryText,
        surfaceVariant = layer, onSurfaceVariant = secondaryText,
        surfaceContainerLowest = base, surfaceContainerLow = surface,
        surfaceContainer = layer, surfaceContainerHigh = layer, surfaceContainerHighest = selected,
        surfaceTint = accent,
        outline = color(R.color.harnessy_border), outlineVariant = color(R.color.harnessy_border),
        error = color(R.color.harnessy_warning), onError = surface,
        errorContainer = color(R.color.harnessy_warning_bg), onErrorContainer = color(R.color.harnessy_warning),
    )
}
