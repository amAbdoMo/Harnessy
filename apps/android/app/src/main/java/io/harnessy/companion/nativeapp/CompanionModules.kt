package io.harnessy.companion.nativeapp

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.android.scopes.ViewModelScoped
import dagger.hilt.components.SingletonComponent
import io.harnessy.companion.AndroidCompanionPlatform
import io.harnessy.companion.CompanionController
import io.harnessy.companion.ControllerLimits
import io.harnessy.companion.R
import io.harnessy.companion.transport.TransportLimits
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object PlatformModule {
    /** Never construct a second platform IO/signing/quiescence owner in a screen or ViewModel. */
    @Provides
    @Singleton
    fun platform(@ApplicationContext context: Context): AndroidCompanionPlatform {
        val resources = context.resources
        fun integer(id: Int) = resources.getInteger(id)
        val frames = TransportLimits.Frames(
            integer(R.integer.frame_bytes), integer(R.integer.retained_frames),
            integer(R.integer.retained_bytes).toLong(), integer(R.integer.socket_queue_bytes).toLong(),
        )
        val activity = TransportLimits.Activity(
            integer(R.integer.idle_ms), integer(R.integer.lifetime_ms), integer(R.integer.tick_ms),
        )
        val limits = TransportLimits(frames, TransportLimits.Deadlines(
            integer(R.integer.connect_ms), integer(R.integer.handshake_ms),
            integer(R.integer.write_ms), activity,
        ))
        return AndroidCompanionPlatform(context, limits, integer(R.integer.io_queue))
    }
}

@Module
@InstallIn(ViewModelComponent::class)
object ControllerModule {
    @Provides
    @ViewModelScoped
    fun controller(
        platform: AndroidCompanionPlatform,
        @ApplicationContext context: Context,
    ): CompanionController = CompanionController(
        platform, ControllerLimits(context.resources.getIntArray(R.array.controller_budgets)),
        context.getString(R.string.linked_pc),
    )
}
