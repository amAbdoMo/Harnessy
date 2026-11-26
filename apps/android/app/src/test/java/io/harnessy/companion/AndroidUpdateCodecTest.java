package io.harnessy.companion;

import io.harnessy.companion.protocol.ApplicationCodec;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Closed-wire and lifecycle regressions for explicit paired Android updates. */
public final class AndroidUpdateCodecTest {
    private static final String REQUEST = Protocol.encodeBase64Url(new byte[16]);
    private static final String SHA = "0".repeat(64);
    private static final String TARGET = "1".repeat(64);

    @Test
    public void exactRequestsAndBoundedResultsRoundTrip() {
        Map<String, Object> check = ApplicationCodec.parseRequest(ApplicationCodec.checkAndroidUpdate(REQUEST, SHA, 7));
        assertEquals("checkAndroidUpdate", check.get("type"));
        assertEquals(SHA, check.get("installedSha256"));
        assertEquals(7L, ((Number) check.get("versionCode")).longValue());

        Map<String, Object> read = ApplicationCodec.parseRequest(ApplicationCodec.readAndroidUpdate(REQUEST, TARGET, 12_288));
        assertEquals(TARGET, read.get("artifactId"));
        assertEquals(12_288L, ((Number) read.get("offset")).longValue());

        ApplicationCodec.Result offer = ApplicationCodec.result(json(Protocol.object("v", 1, "type", "androidUpdate",
            "requestId", REQUEST, "offer", Protocol.object("artifactId", TARGET, "baseSha256", SHA,
                "targetSha256", TARGET, "versionCode", 8, "targetBytes", 40_000, "patchBytes", 20_000))));
        assertEquals(ApplicationCodec.Type.ANDROID_UPDATE, offer.type);
        assertEquals(20_000, offer.androidUpdateOffer.patchBytes);

        byte[] raw = new byte[ApplicationCodec.ANDROID_UPDATE_CHUNK_BYTES];
        Arrays.fill(raw, (byte) 7);
        ApplicationCodec.Result chunk = ApplicationCodec.result(json(Protocol.object("v", 1, "type", "androidUpdateChunk",
            "requestId", REQUEST, "artifactId", TARGET, "offset", 0,
            "data", java.util.Base64.getEncoder().encodeToString(raw))));
        assertArrayEquals(raw, chunk.androidUpdateData);
        assertFalse(chunk.wire.containsKey("data"));
        Arrays.fill(chunk.androidUpdateData, (byte) 0);
    }

    @Test
    public void controllerCorrelatesOneRequestAndRetiresItWithTheConnection() throws Exception {
        ControllerRegression.Fixture fixture = new ControllerRegression.Fixture();
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        AtomicReference<ApplicationCodec.AndroidUpdateOffer> offered = new AtomicReference<>();
        AtomicReference<Exception> failed = new AtomicReference<>();
        fixture.controller.checkAndroidUpdate(SHA, 7, (value, error) -> { offered.set(value); failed.set(error); });
        Map<String, Object> check = fixture.latest().last("checkAndroidUpdate");
        assertNotNull(check);

        AtomicReference<Exception> concurrent = new AtomicReference<>();
        fixture.controller.readAndroidUpdate(TARGET, 0, (value, error) -> concurrent.set(error));
        assertNotNull(concurrent.get());
        fixture.latest().result(Protocol.object("v", 1, "type", "androidUpdate", "requestId", check.get("requestId"),
            "offer", Protocol.object("artifactId", TARGET, "baseSha256", SHA, "targetSha256", TARGET,
                "versionCode", 8, "targetBytes", 40_000, "patchBytes", 20_000)));
        assertNull(failed.get());
        assertEquals(TARGET, offered.get().artifactId);

        AtomicReference<Exception> retired = new AtomicReference<>();
        fixture.controller.readAndroidUpdate(TARGET, 0, (value, error) -> retired.set(error));
        fixture.latest().events.disconnected();
        assertNotNull(retired.get());
    }

    @Test(expected = IllegalArgumentException.class)
    public void unalignedReadIsRejectedBeforeTransport() {
        ApplicationCodec.readAndroidUpdate(REQUEST, TARGET, 1);
    }

    @Test(expected = IllegalArgumentException.class)
    public void noncanonicalChunkIsRejected() {
        ApplicationCodec.result(json(Protocol.object("v", 1, "type", "androidUpdateChunk", "requestId", REQUEST,
            "artifactId", TARGET, "offset", 0, "data", "YQ")));
    }

    private static byte[] json(Map<String, Object> value) {
        return StrictJson.stringify(value).getBytes(StandardCharsets.UTF_8);
    }
}
