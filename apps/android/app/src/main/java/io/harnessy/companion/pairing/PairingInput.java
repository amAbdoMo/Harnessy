package io.harnessy.companion.pairing;

/** Input-size and control-character checks only; this does not decode or trust an invitation. */
public final class PairingInput {
    public static final int MAX_LINK_CHARACTERS = 4096;

    private PairingInput() {}

    /** Returns exact transient text without trimming; the protocol owner must still parse and authenticate it. */
    public static String checkedText(String input) {
        if (input == null || input.length() > MAX_LINK_CHARACTERS) {
            throw new IllegalArgumentException("Invalid pairing input length");
        }
        String link = input;
        if (link.isEmpty()) throw new IllegalArgumentException("Empty pairing input");
        for (int index = 0; index < link.length(); index++) {
            if (Character.isISOControl(link.charAt(index))) {
                throw new IllegalArgumentException("Control character in pairing input");
            }
        }
        return link;
    }
}
