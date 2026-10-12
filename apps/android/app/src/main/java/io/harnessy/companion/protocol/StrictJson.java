package io.harnessy.companion.protocol;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Bounded RFC 8259 JSON with fatal UTF-8, unique keys, scalar Unicode and immutable collections. */
public final class StrictJson {
    public static final int MAX_BYTES = 98_304;
    private static final int MAX_DEPTH = 32;
    private static final int MAX_NODES = 8192;
    private static final int MAX_MEMBERS = 128;
    private static final int MAX_ITEMS = 512;

    private StrictJson() { }

    public static Object parse(String json) { return parse(json, MAX_BYTES); }

    /** Bounds the complete UTF-8 input before allocating parsed collections. */
    public static Object parse(String json, int maxBytes) {
        checkLimit(maxBytes);
        requireText(json, maxBytes);
        Parser parser = new Parser(json);
        Object result = parser.value(0);
        parser.space();
        if (parser.offset != json.length()) throw invalid();
        return result;
    }

    public static Object parse(byte[] json) { return parse(json, MAX_BYTES); }

    public static Object parse(byte[] json, int maxBytes) {
        checkLimit(maxBytes);
        if (json == null || json.length > maxBytes) throw invalid();
        return parse(decodeUtf8(json), maxBytes);
    }

    public static String decodeUtf8(byte[] bytes) {
        if (bytes == null || bytes.length > MAX_BYTES) throw invalid();
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException malformedUtf8) {
            throw new IllegalArgumentException("Invalid UTF-8", malformedUtf8);
        }
    }

    public static String stringify(Object value) { return stringify(value, MAX_BYTES); }

    /** Accepts only JSON primitives, string-keyed maps and lists; cycles exceed the fixed depth bound. */
    public static String stringify(Object value, int maxBytes) {
        checkLimit(maxBytes);
        Encoder encoder = new Encoder(maxBytes);
        encoder.value(value, 0);
        String result = encoder.out.toString();
        requireText(result, maxBytes);
        return result;
    }

    /** Copies a bounded JSON value into recursively immutable maps and lists. */
    public static Object freeze(Object value) { return parse(stringify(value)); }

    public static int utf8Length(String value) {
        if (value == null) throw invalid();
        long bytes = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x80) bytes++;
            else if (c < 0x800) bytes += 2;
            else if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw invalid();
                bytes += 4;
            } else if (Character.isLowSurrogate(c)) throw invalid();
            else bytes += 3;
            if (bytes > Integer.MAX_VALUE) throw invalid();
        }
        return (int) bytes;
    }

    public static void requireText(String value, int maxBytes) {
        if (value == null || value.length() > maxBytes || utf8Length(value) > maxBytes) throw invalid();
    }

    private static void checkLimit(int maxBytes) {
        if (maxBytes < 1 || maxBytes > MAX_BYTES) throw invalid();
    }

    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid or over-budget JSON"); }

    private static final class Parser {
        final String text;
        int offset;
        int nodes;
        Parser(String text) { this.text = text; }
        void space() {
            while (offset < text.length()) {
                char c = text.charAt(offset);
                if (c != ' ' && c != '\n' && c != '\r' && c != '\t') return;
                offset++;
            }
        }
        boolean take(char c) {
            if (offset < text.length() && text.charAt(offset) == c) { offset++; return true; }
            return false;
        }
        void expect(char c) { if (!take(c)) throw invalid(); }
        Object value(int depth) {
            if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw invalid();
            space();
            if (offset == text.length()) throw invalid();
            char c = text.charAt(offset);
            if (c == '"') return string();
            if (c == '{') {
                offset++;
                Map<String, Object> map = new LinkedHashMap<>();
                space();
                if (take('}')) return Collections.unmodifiableMap(map);
                do {
                    space();
                    String key = string();
                    if (utf8Length(key) > 256 || map.containsKey(key) || map.size() >= MAX_MEMBERS) throw invalid();
                    space(); expect(':');
                    map.put(key, value(depth + 1));
                    space();
                    if (take('}')) return Collections.unmodifiableMap(map);
                    expect(',');
                } while (true);
            }
            if (c == '[') {
                offset++;
                List<Object> list = new ArrayList<>();
                space();
                if (take(']')) return Collections.unmodifiableList(list);
                do {
                    if (list.size() >= MAX_ITEMS) throw invalid();
                    list.add(value(depth + 1));
                    space();
                    if (take(']')) return Collections.unmodifiableList(list);
                    expect(',');
                } while (true);
            }
            if (text.startsWith("true", offset)) { offset += 4; return Boolean.TRUE; }
            if (text.startsWith("false", offset)) { offset += 5; return Boolean.FALSE; }
            if (text.startsWith("null", offset)) { offset += 4; return null; }
            return number();
        }
        String string() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (offset < text.length()) {
                char c = text.charAt(offset++);
                if (c == '"') {
                    String result = out.toString();
                    utf8Length(result);
                    return result;
                }
                if (c < 0x20) throw invalid();
                if (c == '\\') {
                    if (offset == text.length()) throw invalid();
                    c = text.charAt(offset++);
                    switch (c) {
                        case '"': case '\\': case '/': out.append(c); break;
                        case 'b': out.append('\b'); break;
                        case 'f': out.append('\f'); break;
                        case 'n': out.append('\n'); break;
                        case 'r': out.append('\r'); break;
                        case 't': out.append('\t'); break;
                        case 'u':
                            int code = 0;
                            for (int i = 0; i < 4; i++) {
                                if (offset == text.length()) throw invalid();
                                char digitChar = text.charAt(offset++);
                                int digit = digitChar >= '0' && digitChar <= '9' ? digitChar - '0'
                                    : digitChar >= 'a' && digitChar <= 'f' ? digitChar - 'a' + 10
                                    : digitChar >= 'A' && digitChar <= 'F' ? digitChar - 'A' + 10 : -1;
                                if (digit < 0) throw invalid();
                                code = code * 16 + digit;
                            }
                            out.append((char) code); break;
                        default: throw invalid();
                    }
                } else out.append(c);
            }
            throw invalid();
        }
        boolean digit() { return offset < text.length() && text.charAt(offset) >= '0' && text.charAt(offset) <= '9'; }
        Object number() {
            int start = offset;
            take('-');
            if (take('0')) { if (digit()) throw invalid(); }
            else {
                if (!digit() || text.charAt(offset) == '0') throw invalid();
                while (digit()) offset++;
            }
            if (take('.')) {
                if (!digit()) throw invalid();
                while (digit()) offset++;
            }
            if (take('e') || take('E')) {
                if (!take('+')) take('-');
                if (!digit()) throw invalid();
                while (digit()) offset++;
            }
            if (offset - start > 128) throw invalid();
            try {
                BigDecimal number = new BigDecimal(text.substring(start, offset));
                if (number.precision() > 128 || number.scale() < -308 || number.scale() > 308) throw invalid();
                return number;
            } catch (NumberFormatException malformedNumber) { throw invalid(); }
        }
    }

    private static final class Encoder {
        final StringBuilder out = new StringBuilder();
        final int maxBytes;
        int nodes;
        Encoder(int maxBytes) { this.maxBytes = maxBytes; }
        void value(Object value, int depth) {
            if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw invalid();
            if (value == null) out.append("null");
            else if (value instanceof String) string((String) value);
            else if (value instanceof Boolean) out.append(value);
            else if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long
                || value instanceof BigDecimal) {
                String number = value.toString();
                new Parser(number).number();
                out.append(number);
            } else if (value instanceof Map) {
                Map<?, ?> map = (Map<?, ?>) value;
                if (map.size() > MAX_MEMBERS) throw invalid();
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String)) throw invalid();
                    requireText((String) entry.getKey(), 256);
                    if (!first) out.append(',');
                    first = false;
                    string((String) entry.getKey()); out.append(':'); value(entry.getValue(), depth + 1);
                }
                out.append('}');
            } else if (value instanceof List) {
                List<?> list = (List<?>) value;
                if (list.size() > MAX_ITEMS) throw invalid();
                out.append('[');
                for (int i = 0; i < list.size(); i++) {
                    if (i != 0) out.append(',');
                    value(list.get(i), depth + 1);
                }
                out.append(']');
            } else throw invalid();
            if (out.length() > maxBytes) throw invalid();
        }
        void string(String value) {
            requireText(value, maxBytes);
            out.append('"');
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                switch (c) {
                    case '"': out.append("\\\""); break;
                    case '\\': out.append("\\\\"); break;
                    case '\b': out.append("\\b"); break;
                    case '\f': out.append("\\f"); break;
                    case '\n': out.append("\\n"); break;
                    case '\r': out.append("\\r"); break;
                    case '\t': out.append("\\t"); break;
                    default:
                        if (c < 0x20) {
                            out.append("\\u00").append("0123456789abcdef".charAt(c >> 4))
                                .append("0123456789abcdef".charAt(c & 15));
                        } else out.append(c);
                }
                if (out.length() > maxBytes) throw invalid();
            }
            out.append('"');
        }
    }
}
