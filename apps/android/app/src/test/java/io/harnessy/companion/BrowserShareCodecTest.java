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
        Map<String, Object> subscribe = ApplicationCodec.parseRequest(ApplicationCodec.subscribeBrowserShare(REQUEST));
        assertEquals("subscribeBrowserShare", subscribe.get("type"));
        assertEquals(3, subscribe.size());
        Map<String, Object> unsubscribe = ApplicationCodec.parseRequest(
            ApplicationCodec.unsubscribeBrowserShare(Protocol.encodeBase64Url(new byte[] { 1, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0 }), REQUEST));
        assertEquals(REQUEST, unsubscribe.get("watchId"));

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

        Map<String, Object> subscription = fixture.latest().last("subscribeBrowserShare");
        fixture.latest().result(browserShare(subscription.get("requestId"), "idle", null, null));
        fixture.latest().result(browserShare(subscription.get("requestId"), "frame", FIRST_SHARE, "anBlZw=="));
        fixture.latest().result(browserShare(subscription.get("requestId"), "frame", SECOND_SHARE, "anBlZw=="));

        int beforeWrongStop = fixture.latest().requests.size();
        fixture.controller.stopBrowserShare(FIRST_SHARE);
        assertEquals(beforeWrongStop, fixture.latest().requests.size());
        fixture.controller.stopBrowserShare(SECOND_SHARE);
        Map<String, Object> stop = fixture.latest().last("stopBrowserShare");
        assertEquals(SECOND_SHARE, stop.get("shareId"));
        fixture.latest().result(browserShare(subscription.get("requestId"), "frame", SECOND_SHARE, "bGF0ZQ=="));
        assertEquals(BrowserShare.Status.STOPPING, fixture.browserShare.status);
        fixture.latest().result(browserShare(stop.get("requestId"), "ended", null, null));
        assertEquals(BrowserShare.Status.ENDED, fixture.browserShare.status);

        fixture.latest().result(browserShare(subscription.get("requestId"), "frame", SECOND_SHARE, "bGF0ZQ=="));
        assertEquals(BrowserShare.Status.ENDED, fixture.browserShare.status);

        fixture.controller.stopBrowserShareViewing();
        Map<String, Object> unsubscribe = fixture.latest().last("unsubscribeBrowserShare");
        assertEquals(subscription.get("requestId"), unsubscribe.get("watchId"));
        int afterClose = fixture.latest().requests.size();
        fixture.latest().result(browserShare(stop.get("requestId"), "ended", null, null));
        assertEquals(afterClose, fixture.latest().requests.size());
        assertTrue(fixture.screen.pc.connection == io.harnessy.companion.presentation.DisplayModels.Connection.ONLINE);
    }

    @Test
    public void unacknowledgedSubscriptionFallsBackToPollingAfterReconnect() throws Exception {
        ControllerRegression.Fixture fixture = new ControllerRegression.Fixture();
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.controller.startBrowserShareViewing();
        assertTrue(fixture.latest().last("subscribeBrowserShare") != null);

        fixture.latest().events.disconnected();
        fixture.advance(5000);
        fixture.confirm();
        assertNull(fixture.latest().last("subscribeBrowserShare"));
        fixture.controller.watchBrowserShare();
        assertTrue(fixture.latest().last("watchBrowserShare") != null);
    }

    private static Map<String, Object> browserShare(Object requestId, String status, String shareId, String jpeg) {
        Map<String, Object> result = new LinkedHashMap<>(Protocol.object("v", 1, "type", "browserShare",
            "requestId", requestId, "status", status));
        if ("frame".equals(status)) { result.put("shareId", shareId); result.put("jpeg", jpeg); }
        return result;
    }

    private static String json(Map<String, Object> value) { return StrictJson.stringify(value); }
}
