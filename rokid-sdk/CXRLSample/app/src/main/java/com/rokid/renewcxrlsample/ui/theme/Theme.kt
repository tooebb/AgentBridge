package com.rokid.renewcxrlsample.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColorScheme = lightColorScheme(
    primary = BluePrimary,
    onPrimary = Color.White,
    primaryContainer = BluePrimaryContainer,
    onPrimaryContainer = BlueOnPrimaryContainer,
    secondary = BlueSecondary,
    surface = Color.White,
    surfaceVariant = BlueSurfaceVariant,
    onSurface = Color(0xFF1C1B1F),
    onSurfaceVariant = BlueSecondary,
    error = Color(0xFFB3261E),
)

private val DarkColorScheme = darkColorScheme(
    primary = BluePrimary80,
    onPrimary = Color(0xFF1C1B1F),
    primaryContainer = BluePrimaryContainerDark,
    onPrimaryContainer = BlueOnPrimaryContainerDark,
    secondary = BlueSecondary,
    surface = Color(0xFF121212),
    surfaceVariant = BluePrimaryContainerDark,
    onSurface = Color.White,
    onSurfaceVariant = BluePrimary80,
    error = Color(0xFFF2B8B5),
)

@Composable
fun RenewCXRLSampleTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
