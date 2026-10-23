package io.harnessy.companion.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InvitationInboxTest {
    @Test
    fun aFreshInvitationIsConsumedOnceAndOnlyTheLatestDeliveryRemains() {
        val inbox = InvitationInbox()
        inbox.offer("harnessy://pair#first")
        inbox.offer("harnessy://pair#second")
        assertEquals("harnessy://pair#second", inbox.take())
        assertNull(inbox.take())
        assertNull(InvitationInbox().take())
    }

    @Test
    fun anInvalidDeliveryCannotRestoreAPreviousValidInvitation() {
        for (invalid in listOf("https://example.com/", "harnessy://pair#" + "界".repeat(1366), "\uD800")) {
            val inbox = InvitationInbox()
            inbox.offer("harnessy://pair#previous")
            inbox.offer(invalid)
            assertEquals("", inbox.take())
            assertNull(inbox.take())
        }
    }
}
