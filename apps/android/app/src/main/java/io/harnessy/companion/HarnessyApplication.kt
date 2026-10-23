package io.harnessy.companion

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/** Hilt owns the single serialized Android platform adapter for this process. */
@HiltAndroidApp
class HarnessyApplication : Application()
