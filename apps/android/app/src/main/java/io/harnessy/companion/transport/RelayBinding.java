package io.harnessy.companion.transport;

import io.harnessy.companion.protocol.Protocol;
import java.security.GeneralSecurityException;
import java.util.Map;

/** Socket-incarnation pinning for one phone channel on one authenticated HTTPS connection. Worker-only. */
final class RelayBinding {
    private final String origin;
    private final String phoneKey;
    private final String pcKey;
    private final String pcId;
    private final String channelId;
    private String phoneGeneration;
    private String pcGeneration;

    RelayBinding(Protocol.Inputs inputs) throws GeneralSecurityException {
        origin = inputs.origin;
        phoneKey = inputs.publicPhoneSpki;
        pcKey = inputs.pinnedPcSpki;
        pcId = Protocol.derivePcId(pcKey);
        channelId = inputs.channelId;
    }

    Map<String, Object> challenge(Object wire) throws GeneralSecurityException {
        Map<String, Object> challenge = Protocol.parseRelayChallenge(wire);
        if (phoneGeneration != null || !"phone".equals(challenge.get("role"))
            || !origin.equals(challenge.get("httpsOrigin")) || !phoneKey.equals(challenge.get("identityKey"))
            || !pcId.equals(challenge.get("targetPcId"))) throw new IllegalArgumentException("Relay binding mismatch");
        phoneGeneration = Protocol.parseSocketGeneration(challenge.get("socketGeneration"));
        return challenge;
    }

    void ready(Object wire) {
        Map<String, Object> ready = Protocol.parseRelayReady(wire);
        if (phoneGeneration == null || !pcId.equals(ready.get("targetPcId"))
            || !phoneGeneration.equals(ready.get("socketGeneration"))) throw new IllegalArgumentException("Relay readiness mismatch");
    }

    Map<String, Object> inbound(Object wire) throws GeneralSecurityException {
        Map<String, Object> forwarded = Protocol.parseRelayData(wire);
        if (phoneGeneration == null || !channelId.equals(forwarded.get("channelId"))
            || !pcId.equals(forwarded.get("targetPcId")) || !pcKey.equals(forwarded.get("sourceIdentityKey"))
            || !phoneGeneration.equals(forwarded.get("targetSocketGeneration"))) {
            throw new IllegalArgumentException("Relay channel mismatch");
        }
        String generation = Protocol.string(forwarded.get("sourceSocketGeneration"));
        if (pcGeneration == null) pcGeneration = generation;
        else if (!pcGeneration.equals(generation)) throw new IllegalArgumentException("PC incarnation changed");
        return Protocol.record(forwarded.get("payload"));
    }

    String pcId() { return pcId; }
    String phoneGeneration() { return phoneGeneration; }

    void clear() { phoneGeneration = null; pcGeneration = null; }
}
