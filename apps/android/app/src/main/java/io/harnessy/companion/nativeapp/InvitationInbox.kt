package io.harnessy.companion.nativeapp

import androidx.annotation.MainThread
import io.harnessy.companion.protocol.Invitation
import io.harnessy.companion.protocol.StrictJson
import javax.inject.Inject
import javax.inject.Singleton

/** Single-use bounded RAM handoff; never puts invitation secrets in the retained main-task Intent. */
@MainThread
@Singleton
class InvitationInbox @Inject constructor() {
    private var fresh: String? = null

    fun offer(link: String) {
        fresh = try {
            StrictJson.requireText(link, Invitation.MAX_LINK_BYTES)
            if (link.startsWith("harnessy://pair#")) link else ""
        } catch (invalid: IllegalArgumentException) {
            ""
        }
    }

    fun take(): String? {
        val delivered = fresh
        fresh = null
        return delivered
    }
}
