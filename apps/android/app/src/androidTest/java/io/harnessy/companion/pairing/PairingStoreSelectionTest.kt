package io.harnessy.companion.pairing

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.harnessy.companion.protocol.Protocol
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingStoreSelectionTest {
    // Foreground startup selects saved.get(0), so the latest enrollment must remain first.
    @Test
    fun laterEnrollmentBecomesPrimaryAcrossForegroundReconstruction() =
        withPreferences("later-enrollment") { preferences ->
            val store = PairingStore(preferences)
            val main = pairing("main")
            val staging = pairing("staging")

            store.save(main)
            store.save(staging)

            val expected = listOf(staging, main)
            assertPairings(expected, store.list())
            assertPairings(expected, PairingStore(preferences).list())

            PairingStore(preferences).remove(staging.pc.id)
            assertPairings(listOf(main), PairingStore(preferences).list())
        }

    @Test
    fun reSavingAnExistingPairingPromotesItWithoutDuplicatingOrChangingTheOther() =
        withPreferences("resave-existing") { preferences ->
            val store = PairingStore(preferences)
            val main = pairing("main")
            val staging = pairing("staging")
            val refreshedStaging = PairingMetadata(
                PairingMetadata.PcIdentity(staging.pc.id, staging.pc.publicKeySpkiBase64Url, "Staging PC refreshed"),
                PairingMetadata.Grant(Protocol.randomId(16), "2"),
                staging.origin,
                staging.phoneKeyAlias,
            )

            store.save(staging)
            store.save(main)
            store.save(refreshedStaging)

            val expected = listOf(refreshedStaging, main)
            assertPairings(expected, store.list())
            assertPairings(expected, PairingStore(preferences).list())
        }

    private fun withPreferences(name: String, test: (SharedPreferences) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferenceName = "pairing_store_selection_test_${name}_${UUID.randomUUID()}"
        val preferences = context.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
        try {
            test(preferences)
        } finally {
            assertTrue(context.deleteSharedPreferences(preferenceName))
        }
    }

    private fun pairing(label: String): PairingMetadata {
        val publicKey = syntheticPublicKeySpkiBase64Url()
        return PairingMetadata(
            PairingMetadata.PcIdentity(Protocol.derivePcId(publicKey), publicKey, "Fixture $label PC"),
            PairingMetadata.Grant(Protocol.randomId(16), "1"),
            "https://$label.example.test",
            "harnessy.companion.pairing.${UUID.randomUUID()}",
        )
    }

    private fun syntheticPublicKeySpkiBase64Url(): String {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val publicKey = generator.generateKeyPair().public.encoded
        return Base64.encodeToString(publicKey, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private fun assertPairings(expected: List<PairingMetadata>, actual: List<PairingMetadata>) {
        assertEquals(expected.size, actual.size)
        assertEquals(expected.map { it.pc.id }, actual.map { it.pc.id })
        expected.zip(actual).forEach { (expectedPairing, actualPairing) ->
            assertEquals(expectedPairing.pc.id, actualPairing.pc.id)
            assertEquals(expectedPairing.pc.publicKeySpkiBase64Url, actualPairing.pc.publicKeySpkiBase64Url)
            assertEquals(expectedPairing.pc.displayName, actualPairing.pc.displayName)
            assertEquals(expectedPairing.grant.id, actualPairing.grant.id)
            assertEquals(expectedPairing.grant.generation, actualPairing.grant.generation)
            assertEquals(expectedPairing.origin, actualPairing.origin)
            assertEquals(expectedPairing.phoneKeyAlias, actualPairing.phoneKeyAlias)
        }
    }
}
