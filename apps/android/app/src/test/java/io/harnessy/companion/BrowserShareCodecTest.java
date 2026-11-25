package io.harnessy.companion;

import io.harnessy.companion.protocol.ApplicationCodec;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Protocol and controller regressions for the explicit native browser-share viewer. */
public final class BrowserShareCodecTest {
    private static final String REQUEST = Protocol.encodeBase64Url(new byte[16]);
    private static final String FIRST_SHARE = "e7ceaa5b-761d-4e48-9abc-9fa732df8617";
    private static final String SECOND_SHARE = "f7ceaa5b-761d-4e48-9abc-9fa732df8617";

    @Test
    public void browserShareRequestsAndBoundedResultsUseTheClosedWire() {
        Map<String, Object> discovery = ApplicationCodec.parseRequest(ApplicationCodec.watchBrowserShare(REQUEST, null));
        assertEquals("watchBrowserShare", discovery.get("type"));
        assertEquals(3, discovery.size());
        Map<String, Object> exact = ApplicationCodec.parseRequest(ApplicationCodec.watchBrowserShare(REQUEST, FIRST_SHARE));
        assertEquals(FIRST_SHARE, exact.get("shareId"));
        Map<String, Object> stop = ApplicationCodec.parseRequest(ApplicationCodec.stopBrowserShare(REQUEST, FIRST_SHARE));
        assertEquals(FIRST_SHARE, stop.get("shareId"));

        ApplicationCodec.Result idle = ApplicationCodec.result(json(Protocol.object("v", 1, "type", "browserShare",
            "requestId", REQUEST, "status", "idle")));
        assertEquals(ApplicationCodec.Type.BROWSER_SHARE, idle.type);
        assertEquals("idle", idle.status);
        assertNull(idle.shareId);
        ApplicationCodec.Result frame = ApplicationCodec.result(json(Protocol.object("v", 1, "type", "browserShare",
            "requestId", REQUEST, "status", "frame", "shareId", FIRST_SHARE, "jpeg", "anBlZw==")));
        assertEquals(FIRST_SHARE, frame.shareId);
        assertEquals("anBlZw==", frame.jpeg);
    }

    @Test(expected = IllegalArgumentException.class)
    public void oversizedOrNoncanonicalJpegIsRejectedBeforeRetention() {
        StringBuilder oversized = new StringBuilder(ApplicationCodec.MAX_JPEG_BASE64_CHARS + 1);
        for (int index = 0; index < ApplicationCodec.MAX_JPEG_BASE64_CHARS + 1; index++) oversized.append('A');
        ApplicationCodec.result(json(Protocol.object("v", 1, "type", "browserShare", "requestId", REQUEST,
            "status", "frame", "shareId", FIRST_SHARE, "jpeg", oversized.toString())));
    }

    @Test
    public void stopBindsToTheNewestShareAndLateLifecycleRepliesAreIgnored() throws Exception {
        ControllerRegression.Fixture fixture = new ControllerRegression.Fixture();
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.controller.startBrowserShareViewing();

        fixture.controller.watchBrowserShare();
        Map<String, Object> firstWatch = fixture.latest().last("watchBrowserShare");
        fixture.latest().result(browserShare(firstWatch.get("requestId"), "frame", FIRST_SHARE, "anBlZw=="));
        fixture.controller.watchBrowserShare();
        Map<String, Object> secondWatch = fixture.latest().last("watchBrowserShare");
        assertEquals(FIRST_SHARE, secondWatch.get("shareId"));
        fixture.latest().result(browserShare(secondWatch.get("requestId"), "frame", SECOND_SHARE, "anBlZw=="));

        int beforeWrongStop = fixture.latest().requests.size();
        fixture.controller.stopBrowserShare(FIRST_SHARE);
        assertEquals(beforeWrongStop, fixture.latest().requests.size());
        fixture.controller.stopBrowserShare(SECOND_SHARE);
        Map<String, Object> stop = fixture.latest().last("stopBrowserShare");
        assertEquals(SECOND_SHARE, stop.get("shareId"));
        fixture.latest().result(browserShare(stop.get("requestId"), "ended", null, null));
        assertEquals(BrowserShare.Status.ENDED, fixture.browserShare.status);

        fixture.controller.watchBrowserShare();
        Map<String, Object> discovery = fixture.latest().last("watchBrowserShare");
        fixture.latest().result(browserShare(discovery.get("requestId"), "idle", null, null));
        assertEquals(BrowserShare.Status.ENDED, fixture.browserShare.status);

        fixture.controller.stopBrowserShareViewing();
        int afterClose = fixture.latest().requests.size();
        fixture.latest().result(browserShare(stop.get("requestId"), "ended", null, null));
        assertEquals(afterClose, fixture.latest().requests.size());
        assertTrue(fixture.screen.pc.connection == io.harnessy.companion.presentation.DisplayModels.Connection.ONLINE);
    }

    private static Map<String, Object> browserShare(Object requestId, String status, String shareId, String jpeg) {
        Map<String, Object> result = new LinkedHashMap<>(Protocol.object("v", 1, "type", "browserShare",
            "requestId", requestId, "status", status));
        if ("frame".equals(status)) { result.put("shareId", shareId); result.put("jpeg", jpeg); }
        return result;
    }

    private static String json(Map<String, Object> value) { return StrictJson.stringify(value); }
}
