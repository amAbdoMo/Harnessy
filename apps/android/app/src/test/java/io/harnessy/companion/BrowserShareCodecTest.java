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
import static org.junit.Assert.fail;

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
        assertEquals(subscribe, ApplicationCodec.parseRequest(ApplicationCodec.subscribeBrowserShare(REQUEST, false)));
        Map<String, Object> highResolution = ApplicationCodec.parseRequest(ApplicationCodec.subscribeBrowserShare(REQUEST, true));
        assertEquals(Boolean.TRUE, highResolution.get("highResolution"));
        assertEquals(4, highResolution.size());
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

    @Test
    public void highResolutionOptInRejectsEveryValueExceptTrueAndOtherRequestKinds() {
        for (Object value : new Object[] { false, null, "true", 1 }) {
            rejectsRequest(Protocol.object("v", 1, "type", "subscribeBrowserShare", "requestId", REQUEST,
                "highResolution", value));
        }
        rejectsRequest(Protocol.object("v", 1, "type", "watchBrowserShare", "requestId", REQUEST,
            "highResolution", true));
        rejectsRequest(Protocol.object("v", 1, "type", "stopBrowserShare", "requestId", REQUEST,
            "shareId", FIRST_SHARE, "highResolution", true));
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
    public void unacknowledgedHighResolutionRetriesPlainSubscriptionBeforePollingAndReprobesOnReopen() throws Exception {
        ControllerRegression.Fixture fixture = new ControllerRegression.Fixture();
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.controller.startBrowserShareViewing();
        assertEquals(Boolean.TRUE, fixture.latest().last("subscribeBrowserShare").get("highResolution"));

        fixture.latest().events.disconnected();
        fixture.advance(5000);
        fixture.confirm();
        assertEquals(3, fixture.latest().last("subscribeBrowserShare").size());
        fixture.controller.watchBrowserShare();
        assertNull(fixture.latest().last("watchBrowserShare"));

        fixture.latest().events.disconnected();
        fixture.advance(5000);
        fixture.confirm();
        assertNull(fixture.latest().last("subscribeBrowserShare"));
        fixture.controller.watchBrowserShare();
        assertTrue(fixture.latest().last("watchBrowserShare") != null);

        fixture.controller.stopBrowserShareViewing();
        fixture.controller.startBrowserShareViewing();
        assertEquals(Boolean.TRUE, fixture.latest().last("subscribeBrowserShare").get("highResolution"));
    }

    @Test
    public void acknowledgedHighResolutionReconnectsWithoutDowngrading() throws Exception {
        ControllerRegression.Fixture fixture = new ControllerRegression.Fixture();
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.controller.startBrowserShareViewing();
        Object request = fixture.latest().last("subscribeBrowserShare").get("requestId");
        fixture.latest().result(browserShare(request, "idle", null, null));
        fixture.latest().events.disconnected();
        fixture.advance(5000);
        fixture.confirm();
        assertEquals(Boolean.TRUE, fixture.latest().last("subscribeBrowserShare").get("highResolution"));
        fixture.controller.watchBrowserShare();
        assertNull(fixture.latest().last("watchBrowserShare"));
    }

    @Test
    public void leavingTheActivityBeforeAcknowledgementDoesNotDowngradeThePc() throws Exception {
        ControllerRegression.Fixture fixture = new ControllerRegression.Fixture();
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.controller.startBrowserShareViewing();
        fixture.controller.stop();
        fixture.advance(5000);
        fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.controller.startBrowserShareViewing();
        assertEquals(Boolean.TRUE, fixture.latest().last("subscribeBrowserShare").get("highResolution"));
    }

    private static void rejectsRequest(Map<String, Object> request) {
        try {
            ApplicationCodec.parseRequest(json(request).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            fail("Unexpected request accepted: " + request);
        } catch (IllegalArgumentException invalidRequest) {
            // Exact-field validation rejects unsupported options before transport admission.
        }
    }

    private static Map<String, Object> browserShare(Object requestId, String status, String shareId, String jpeg) {
        Map<String, Object> result = new LinkedHashMap<>(Protocol.object("v", 1, "type", "browserShare",
            "requestId", requestId, "status", status));
        if ("frame".equals(status)) { result.put("shareId", shareId); result.put("jpeg", jpeg); }
        return result;
    }

    private static String json(Map<String, Object> value) { return StrictJson.stringify(value); }
}
