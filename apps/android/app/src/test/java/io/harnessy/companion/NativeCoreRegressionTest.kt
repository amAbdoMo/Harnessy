package io.harnessy.companion

import io.harnessy.companion.protocol.ParserIdRegression
import io.harnessy.companion.protocol.ProtocolRegression
import org.junit.Test

/** Keeps the crypto, parser and delivery-fence regressions discoverable by Gradle/JUnit. */
class NativeCoreRegressionTest {
    @Test
    fun malformedFramesAndUnconfirmedPeersCannotAuthorizeApplicationTraffic() {
        ProtocolRegression.main(emptyArray())
    }

    @Test
    fun sessionIdentifiersAndSubscriptionSchemasRemainInteroperable() {
        ParserIdRegression.main(emptyArray())
    }

    @Test
    fun lostAcknowledgementsAndRetiredCallbacksCannotCauseAutomaticResubmission() {
        ControllerRegression.main(emptyArray())
    }
}
