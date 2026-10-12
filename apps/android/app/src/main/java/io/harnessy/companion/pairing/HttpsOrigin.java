package io.harnessy.companion.pairing;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** ASCII HTTPS origin only. Parsing performs no DNS lookup and grants no trust or network access. */
public final class HttpsOrigin {
    private HttpsOrigin() {}

    /** Normalizes scheme/host case, root slash, and port 443; rejects credentials and URL suffixes. */
    public static String canonical(String input) {
        if (input == null || input.isEmpty() || input.length() > 2048) {
            throw new IllegalArgumentException("Invalid HTTPS origin length");
        }
        requireAscii(input);
        final URI origin;
        try {
            origin = new URI(input);
        } catch (URISyntaxException invalidUri) {
            throw new IllegalArgumentException("Invalid HTTPS origin", invalidUri);
        }
        requireOrigin(origin);
        String host = origin.getHost().toLowerCase(Locale.ROOT);
        int port = origin.getPort();
        return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
    }

    private static void requireAscii(String input) {
        for (int index = 0; index < input.length(); index++) {
            char character = input.charAt(index);
            if (character <= 32 || character >= 127 || character == '\\' || character == '%') {
                throw new IllegalArgumentException("HTTPS origin must use unescaped ASCII");
            }
        }
    }

    private static void requireOrigin(URI origin) {
        if (!"https".equalsIgnoreCase(origin.getScheme()) || origin.getHost() == null
            || origin.getRawUserInfo() != null || origin.getRawQuery() != null
            || origin.getRawFragment() != null || origin.isOpaque()) {
            throw new IllegalArgumentException("Expected credential-free HTTPS origin");
        }
        String path = origin.getRawPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) {
            throw new IllegalArgumentException("HTTPS origin cannot include a path");
        }
        if (origin.getHost().endsWith(".") || origin.getRawAuthority().endsWith(":")) {
            throw new IllegalArgumentException("Ambiguous HTTPS authority");
        }
        if (origin.getPort() != -1 && (origin.getPort() < 1 || origin.getPort() > 65535)) {
            throw new IllegalArgumentException("Invalid HTTPS port");
        }
    }
}
