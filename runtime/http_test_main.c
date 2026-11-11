#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "http_codec.h"

/*
 * Unit test for the HTTP codec (llhttp). Pure function over byte fixtures; no
 * sockets or VM. Every inbound request on every surface — node:http and Mal.serve —
 * parses here, so this is the one place that pins strict framing: the ambiguities
 * below are exactly the ones a front-end proxy may resolve differently, and a
 * disagreement between the two is a request-smuggling differential.
 *
 * The strict fixtures are individually malformed heads, not a pipelined attack
 * sequence: each asserts the codec refuses to publish a head, never that some
 * smuggled request is reachable.
 */

static int g_pass = 0;
static int g_total = 0;

static void check(bool ok, const char *name) {
    g_total++;
    if (ok) {
        g_pass++;
    } else {
        printf("httptest CHECK FAIL: %s\n", name);
    }
}

static bool codec_slice_eq(const byte *ptr, usize len, const char *want) {
    return ptr != nullptr && len == strlen(want) && memcmp(ptr, want, len) == 0;
}

/* Feed a whole request head and report whether the codec published one. */
static bool codec_accepts(const char *wire) {
    MalHttpCodec codec;
    if (!mal_http_codec_init(&codec, HTTP_REQUEST)) return false;
    usize consumed = 0;
    MalHttpCodecResult result = mal_http_codec_execute(
        &codec, (const byte *) wire, strlen(wire), &consumed);
    bool accepted = result != MAL_HTTP_CODEC_ERROR
        && mal_http_codec_event(&codec) == MAL_HTTP_CODEC_EVENT_HEAD;
    mal_http_codec_free(&codec);
    return accepted;
}

/* Drive a fixture to completion, reporting whether the codec ever failed it. Some
 * framing errors are only decidable once llhttp resumes past the paused head, so a
 * published head does not yet mean the message was accepted. */
static bool codec_message_fails(const char *wire) {
    MalHttpCodec codec;
    if (!mal_http_codec_init(&codec, HTTP_REQUEST)) return true;
    usize offset = 0;
    usize length = strlen(wire);
    bool failed = false;
    usize guard = 0;
    while (guard++ < 256) {
        if (mal_http_codec_event(&codec) != MAL_HTTP_CODEC_EVENT_NONE) {
            if (mal_http_codec_event(&codec) == MAL_HTTP_CODEC_EVENT_COMPLETE) break;
            mal_http_codec_clear_event(&codec);
            continue;
        }
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &codec, (const byte *) wire + offset, length - offset, &consumed);
        if (result == MAL_HTTP_CODEC_ERROR) {
            failed = true;
            break;
        }
        offset += consumed;
        if (consumed == 0 && mal_http_codec_event(&codec) == MAL_HTTP_CODEC_EVENT_NONE) {
            break;
        }
    }
    mal_http_codec_free(&codec);
    return failed;
}

/* Everything a request codec reports for one input, folded into a digest: each event
 * in order with its head metadata, fields and body bytes, then whether and after how
 * many consumed bytes it failed. */
typedef struct CodecTrace {
    u64 digest;
    usize events;
    bool failed;
} CodecTrace;

static u64 trace_mix(u64 digest, const void *data, usize length) {
    const byte *bytes = data;
    for (usize i = 0; i < length; i++) digest = (digest ^ bytes[i]) * UINT64_C(0x100000001b3);
    return digest;
}

static u64 fuzz_next(u64 *state) {
    *state += UINT64_C(0x9e3779b97f4a7c15);
    u64 mixed = (*state ^ (*state >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    mixed = (mixed ^ (mixed >> 27)) * UINT64_C(0x94d049bb133111eb);
    return mixed ^ (mixed >> 31);
}

/* Feed `wire` whole, or in pieces of 1..max_piece bytes drawn from `seed`. */
static CodecTrace codec_trace(const byte *wire, usize length, u64 seed, usize max_piece) {
    CodecTrace trace = {.digest = UINT64_C(0xcbf29ce484222325)};
    MalHttpCodec codec;
    if (!mal_http_codec_init(&codec, HTTP_REQUEST)) {
        trace.failed = true;
        return trace;
    }
    usize offset = 0;
    u64 state = seed;
    bool resumed_at_end = false;
    for (usize turn = 0; turn < 4 * length + 64; turn++) {
        MalHttpCodecEventKind event = mal_http_codec_event(&codec);
        if (event == MAL_HTTP_CODEC_EVENT_HEAD) {
            MalHttpCodecHead *head = mal_http_codec_take_head(&codec);
            if (head == nullptr) {
                trace.failed = true;
                break;
            }
            i64 framing[] = {head->content_length, head->chunked, head->keep_alive,
                head->upgrade, head->minor_version, (i64) head->field_count};
            trace.digest = trace_mix(trace.digest, "H", 1);
            trace.digest = trace_mix(trace.digest, mal_http_codec_head_method(head), head->method_length);
            trace.digest = trace_mix(trace.digest, mal_http_codec_head_target(head), head->target_length);
            trace.digest = trace_mix(trace.digest, framing, sizeof framing);
            for (usize i = 0; i < head->field_count; i++) {
                const MalHttpCodecField *field = &head->fields[i];
                trace.digest = trace_mix(trace.digest, mal_http_codec_field_name(head, field), field->name_length);
                trace.digest = trace_mix(trace.digest, ":", 1);
                trace.digest = trace_mix(trace.digest, mal_http_codec_field_value(head, field), field->value_length);
            }
            mal_http_codec_head_free(head);
            trace.events++;
            continue;
        }
        if (event == MAL_HTTP_CODEC_EVENT_BODY) {
            usize body_length = 0;
            byte *body = mal_http_codec_take_body(&codec, &body_length);
            // Body slicing follows the input pieces; only the bytes are invariant.
            trace.digest = trace_mix(trace.digest, body, body_length);
            free(body);
            continue;
        }
        if (event == MAL_HTTP_CODEC_EVENT_COMPLETE) {
            mal_http_codec_clear_event(&codec);
            trace.digest = trace_mix(trace.digest, "C", 1);
            trace.events++;
            continue;
        }
        // At the end of input an empty slice still resumes a paused message.
        bool resume = offset == length;
        if (resume && resumed_at_end) break;
        resumed_at_end = resume;
        usize supplied = length - offset;
        if (max_piece != 0) {
            usize piece = 1 + (usize) (fuzz_next(&state) % max_piece);
            if (piece < supplied) supplied = piece;
        }
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(&codec, wire + offset, supplied, &consumed);
        if (consumed > supplied) {
            trace.failed = true;
            break;
        }
        offset += consumed;
        if (result == MAL_HTTP_CODEC_ERROR) {
            trace.failed = true;
            break;
        }
        if (consumed == 0 && mal_http_codec_event(&codec) == MAL_HTTP_CODEC_EVENT_NONE) break;
    }
    trace.digest = trace_mix(trace.digest, &trace.failed, sizeof trace.failed);
    mal_http_codec_free(&codec);
    return trace;
}

static bool codec_traces_equal(CodecTrace left, CodecTrace right) {
    return left.digest == right.digest && left.events == right.events && left.failed == right.failed;
}

/* Parse one head from a complete request head fixture. */
static MalHttpCodecHead *codec_head_of(MalHttpCodec *codec, const char *wire) {
    if (!mal_http_codec_init(codec, HTTP_REQUEST)) return nullptr;
    usize consumed = 0;
    MalHttpCodecResult result = mal_http_codec_execute(
        codec, (const byte *) wire, strlen(wire), &consumed);
    return result == MAL_HTTP_CODEC_EVENT ? mal_http_codec_take_head(codec) : nullptr;
}

int main(void) {
    // 1. Simple GET / HTTP/1.1 with one header.
    {
        const char *wire = "GET /index.html HTTP/1.1\r\nHost: example.com\r\n\r\n";
        MalHttpCodec codec;
        check(mal_http_codec_init(&codec, HTTP_REQUEST), "request codec initializes");
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &codec, (const byte *) wire, strlen(wire), &consumed);
        MalHttpCodecHead *head = result == MAL_HTTP_CODEC_EVENT
            ? mal_http_codec_take_head(&codec) : nullptr;
        check(head != nullptr, "simple GET parses");
        if (head != nullptr) {
            check(codec_slice_eq(
                      mal_http_codec_head_method(head), head->method_length, "GET"),
                  "method=GET");
            check(codec_slice_eq(
                      mal_http_codec_head_target(head), head->target_length,
                      "/index.html"),
                  "target=/index.html");
            check(head->minor_version == 1, "minor=1");
            check(head->field_count == 1, "one header");
            check(head->keep_alive, "1.1 keep-alive default");
            check(head->content_length == -1, "no content-length");
            check(consumed == strlen(wire), "consumed == full (empty body)");
            check(codec_slice_eq(
                      mal_http_codec_field_name(head, &head->fields[0]),
                      head->fields[0].name_length, "Host")
                      && codec_slice_eq(
                          mal_http_codec_field_value(head, &head->fields[0]),
                          head->fields[0].value_length, "example.com"),
                  "Host field name and value");
        }
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);
    }

    // 2. POST with Content-Length; the head pause reports the first body byte.
    {
        const char *wire = "POST /api HTTP/1.1\r\nContent-Type: application/json\r\n"
                           "Content-Length: 7\r\n\r\n{\"a\":1}";
        MalHttpCodec codec;
        mal_http_codec_init(&codec, HTTP_REQUEST);
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &codec, (const byte *) wire, strlen(wire), &consumed);
        MalHttpCodecHead *head = result == MAL_HTTP_CODEC_EVENT
            ? mal_http_codec_take_head(&codec) : nullptr;
        check(head != nullptr && head->content_length == 7, "content-length=7");
        check(head != nullptr
                  && codec_slice_eq(
                      mal_http_codec_head_method(head), head->method_length, "POST"),
              "method=POST");
        check(strcmp(wire + consumed, "{\"a\":1}") == 0, "body begins at consumed");
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);
    }

    // 3. Incomplete (headers not terminated yet) publishes nothing.
    {
        const char *wire = "GET / HTTP/1.1\r\nHost: x";
        MalHttpCodec codec;
        mal_http_codec_init(&codec, HTTP_REQUEST);
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &codec, (const byte *) wire, strlen(wire), &consumed);
        check(result == MAL_HTTP_CODEC_OK
                  && mal_http_codec_event(&codec) == MAL_HTTP_CODEC_EVENT_NONE,
              "partial request publishes no head");
        mal_http_codec_free(&codec);
    }

    // 4. Malformed request line.
    check(!codec_accepts("GARBAGE\r\n\r\n"), "malformed request line is rejected");

    // 5. HTTP/1.0 defaults to close; Connection: keep-alive overrides.
    {
        MalHttpCodec codec;
        MalHttpCodecHead *head =
            codec_head_of(&codec, "GET / HTTP/1.0\r\nHost: x\r\n\r\n");
        check(head != nullptr && !head->keep_alive, "1.0 defaults to close");
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);

        head = codec_head_of(
            &codec, "GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n");
        check(head != nullptr && head->keep_alive,
              "1.0 Connection: keep-alive -> persistent");
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);
    }

    // 6. HTTP/1.1 Connection: close overrides the default.
    {
        MalHttpCodec codec;
        MalHttpCodecHead *head =
            codec_head_of(&codec, "GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
        check(head != nullptr && !head->keep_alive,
              "1.1 Connection: close -> not persistent");
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);
    }

    // 7. Transfer-Encoding: chunked is reported as framing, not as a length.
    {
        MalHttpCodec codec;
        MalHttpCodecHead *head = codec_head_of(
            &codec, "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n");
        check(head != nullptr && head->chunked, "chunked detected");
        check(head != nullptr && head->content_length == -1,
              "chunked has no content-length");
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);
    }

    // 8. The codec yields fragmented heads, decoded body data, and message
    // boundaries without buffering a whole request.
    {
        const char *wire =
            "POST /one HTTP/1.1\r\nHost: example.test\r\nX-Dup: one\r\n"
            "X-Dup: two\r\nTransfer-Encoding: chunked\r\n\r\n"
            "2\r\nhe\r\n3\r\nllo\r\n0\r\nTrailer: value\r\n\r\n"
            "GET /two HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n";
        MalHttpCodec codec;
        check(mal_http_codec_init(&codec, HTTP_REQUEST), "request codec initializes");
        usize offset = 0;
        usize heads = 0;
        usize completes = 0;
        char body[16] = {0};
        usize body_length = 0;
        usize turns = 0;
        bool valid_heads = true;
        while ((offset < strlen(wire) || completes < 2) && turns++ < 4096) {
            usize supplied = offset < strlen(wire) ? 1 : 0;
            usize consumed_now = 0;
            MalHttpCodecResult result = mal_http_codec_execute(
                &codec, (const byte *) wire + offset, supplied, &consumed_now);
            if (result == MAL_HTTP_CODEC_ERROR || consumed_now > supplied) {
                valid_heads = false;
                break;
            }
            offset += consumed_now;
            MalHttpCodecEventKind event = mal_http_codec_event(&codec);
            if (event == MAL_HTTP_CODEC_EVENT_HEAD) {
                MalHttpCodecHead *head = mal_http_codec_take_head(&codec);
                if (heads == 0) {
                    valid_heads = valid_heads
                        && codec_slice_eq(
                            mal_http_codec_head_method(head), head->method_length, "POST")
                        && codec_slice_eq(
                            mal_http_codec_head_target(head), head->target_length, "/one")
                        && head->field_count == 4 && head->chunked
                        && head->content_length == -1 && head->keep_alive;
                } else {
                    valid_heads = valid_heads
                        && codec_slice_eq(
                            mal_http_codec_head_method(head), head->method_length, "GET")
                        && codec_slice_eq(
                            mal_http_codec_head_target(head), head->target_length, "/two")
                        && !head->keep_alive;
                }
                heads++;
                mal_http_codec_head_free(head);
            } else if (event == MAL_HTTP_CODEC_EVENT_BODY) {
                usize length = 0;
                byte *bytes = mal_http_codec_take_body(&codec, &length);
                if (body_length + length > sizeof(body)) {
                    valid_heads = false;
                    free(bytes);
                    break;
                }
                memcpy(body + body_length, bytes, length);
                body_length += length;
                free(bytes);
            } else if (event == MAL_HTTP_CODEC_EVENT_COMPLETE) {
                completes++;
                mal_http_codec_clear_event(&codec);
            } else if (supplied > 0 && consumed_now == 0) {
                valid_heads = false;
                break;
            }
        }
        check(valid_heads, "fragmented codec heads preserve metadata");
        check(heads == 2 && completes == 2, "codec preserves pipelined boundaries");
        check(body_length == 5 && memcmp(body, "hello", 5) == 0,
              "codec incrementally dechunks body bytes");
        mal_http_codec_free(&codec);
    }

    // 9. Response parsing preserves the reason phrase and framing metadata.
    {
        const char *wire =
            "HTTP/1.1 425 Custom Too Early\r\nContent-Length: 2\r\n\r\nok";
        MalHttpCodec codec;
        check(mal_http_codec_init(&codec, HTTP_RESPONSE), "response codec initializes");
        usize consumed_now = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &codec, (const byte *) wire, strlen(wire), &consumed_now);
        check(result == MAL_HTTP_CODEC_EVENT
                  && mal_http_codec_event(&codec) == MAL_HTTP_CODEC_EVENT_HEAD,
              "response codec yields head before body");
        MalHttpCodecHead *head = mal_http_codec_take_head(&codec);
        check(head != nullptr && head->status_code == 425
                  && codec_slice_eq(
                      mal_http_codec_head_status(head), head->status_length,
                      "Custom Too Early")
                  && head->content_length == 2,
              "response codec preserves status metadata");
        mal_http_codec_head_free(head);
        mal_http_codec_free(&codec);
    }

    // 10. Strict framing: every ambiguity a proxy could resolve differently is
    // refused before a head is published, so no surface can act on it.
    {
        check(!codec_accepts(
                  "POST / HTTP/1.1\r\nContent-Length: 1\r\n"
                  "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n"),
              "codec rejects transfer-encoding plus content-length");
        check(!codec_accepts("GET / HTTP/1.1\nHost: x\n\n"),
              "codec rejects bare LF line endings");
        check(!codec_accepts("GET / HTTP/1.1\r\nHost : x\r\n\r\n"),
              "codec rejects whitespace before the field colon");
        check(!codec_accepts("GET / HTTP/1.1\r\nHost: x\r\n X-Folded: y\r\n\r\n"),
              "codec rejects obs-fold continuation lines");
        check(!codec_accepts(
                  "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"),
              "codec rejects conflicting duplicate content-length");
        // An unrecognized coding is only decidable once llhttp picks body framing,
        // one step past the paused head — so assert the message fails rather than
        // that no head appears. No body byte is ever delivered under it.
        check(codec_message_fails(
                  "POST / HTTP/1.1\r\nTransfer-Encoding: xchunked\r\n\r\nx"),
              "codec fails a message with an unrecognized transfer coding");
        check(!codec_accepts(
                  "POST / HTTP/1.1\r\nTransfer-Encoding: chunked, gzip\r\n\r\n"),
              "codec rejects chunked that is not the final coding");
        check(!codec_accepts(
                  "POST / HTTP/1.1\r\nTransfer-Encoding:\r\n\r\n"),
              "codec rejects an empty transfer-encoding value");
        check(!codec_accepts("GET /a\rb HTTP/1.1\r\nHost: x\r\n\r\n"),
              "codec rejects control bytes in the request target");
        check(!codec_accepts("GET / HTTP/1.1\r\nHost: a\rb\r\n\r\n"),
              "codec rejects control bytes in a field value");
    }

    // 11. A chunked body split across reads decodes intact. The decoder is
    // incremental, so a partial body never rewrites already-delivered bytes.
    {
        const char *head_bytes =
            "POST /split HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n";
        const char *parts[] = {"5\r\nHELLO\r\n", "0\r\n\r\n"};
        MalHttpCodec codec;
        mal_http_codec_init(&codec, HTTP_REQUEST);
        usize consumed = 0;
        mal_http_codec_execute(
            &codec, (const byte *) head_bytes, strlen(head_bytes), &consumed);
        mal_http_codec_head_free(mal_http_codec_take_head(&codec));

        char body[16] = {0};
        usize body_length = 0;
        bool complete = false;
        bool ok = true;
        for (usize part = 0; ok && part < 2; part++) {
            usize offset = 0;
            usize length = strlen(parts[part]);
            usize guard = 0;
            while (guard++ < 64) {
                usize now = 0;
                MalHttpCodecResult result = mal_http_codec_execute(
                    &codec, (const byte *) parts[part] + offset, length - offset, &now);
                if (result == MAL_HTTP_CODEC_ERROR) {
                    ok = false;
                    break;
                }
                offset += now;
                MalHttpCodecEventKind event = mal_http_codec_event(&codec);
                if (event == MAL_HTTP_CODEC_EVENT_BODY) {
                    usize chunk = 0;
                    byte *bytes = mal_http_codec_take_body(&codec, &chunk);
                    if (body_length + chunk > sizeof(body)) {
                        ok = false;
                        free(bytes);
                        break;
                    }
                    memcpy(body + body_length, bytes, chunk);
                    body_length += chunk;
                    free(bytes);
                    continue;
                }
                if (event == MAL_HTTP_CODEC_EVENT_COMPLETE) {
                    complete = true;
                    mal_http_codec_clear_event(&codec);
                    break;
                }
                if (offset == length && now == 0) break;
            }
        }
        check(ok && body_length == 5 && memcmp(body, "HELLO", 5) == 0,
              "chunked body split across reads decodes intact");
        check(complete, "split chunked body reaches message completion");
        mal_http_codec_free(&codec);
    }

    // 12. Real request heads commonly exceed the inline field/arena budget.
    // Crossing both thresholds must preserve every field and its insertion order.
    {
        char wire[8192];
        usize length = (usize) snprintf(
            wire, sizeof(wire), "GET /many HTTP/1.1\r\n");
        bool built = length < sizeof(wire);
        for (usize i = 0; built && i < 40; i++) {
            int written = snprintf(
                wire + length, sizeof(wire) - length,
                "X-Request-%02zu: value-%02zu-abcdefghijklmnopqrstuvwxyz0123456789\r\n",
                i, i);
            built = written > 0 && (usize) written < sizeof(wire) - length;
            if (built) length += (usize) written;
        }
        if (built) {
            int written = snprintf(
                wire + length, sizeof(wire) - length,
                "Connection: close\r\n\r\n");
            built = written > 0 && (usize) written < sizeof(wire) - length;
            if (built) length += (usize) written;
        }

        MalHttpCodec codec;
        bool initialized = built && mal_http_codec_init(&codec, HTTP_REQUEST);
        check(initialized, "large request codec initializes");
        usize consumed_now = 0;
        MalHttpCodecResult result = initialized
            ? mal_http_codec_execute(
                  &codec, (const byte *) wire, length, &consumed_now)
            : MAL_HTTP_CODEC_ERROR;
        MalHttpCodecHead *head = result == MAL_HTTP_CODEC_EVENT
            ? mal_http_codec_take_head(&codec) : nullptr;
        bool valid = head != nullptr && head->field_count == 41
            && head->fields != head->inline_fields
            && head->arena != head->inline_arena;
        if (valid) {
            const MalHttpCodecField *field = &head->fields[39];
            valid = codec_slice_eq(
                        mal_http_codec_field_name(head, field),
                        field->name_length, "X-Request-39")
                && codec_slice_eq(
                    mal_http_codec_field_value(head, field),
                    field->value_length,
                    "value-39-abcdefghijklmnopqrstuvwxyz0123456789");
        }
        check(valid, "large request spills fields and arena without truncation");
        mal_http_codec_head_free(head);
        if (initialized) mal_http_codec_free(&codec);
    }

    // 13. A head past the header budget is refused, never truncated: a truncated head
    // would silently drop the framing fields it was cut off at.
    {
        usize length = MAL_HTTP_CODEC_DEFAULT_HEADER_SIZE + 4096;
        char *wire = malloc(length + 1);
        check(wire != nullptr, "oversized head fixture allocates");
        if (wire != nullptr) {
            int written = snprintf(wire, length + 1, "GET /big HTTP/1.1\r\nX-Pad: ");
            usize offset = written > 0 ? (usize) written : 0;
            memset(wire + offset, 'a', length - offset);
            wire[length] = '\0';
            MalHttpCodec codec;
            mal_http_codec_init(&codec, HTTP_REQUEST);
            usize consumed = 0;
            MalHttpCodecResult result = mal_http_codec_execute(
                &codec, (const byte *) wire, length, &consumed);
            check(result == MAL_HTTP_CODEC_ERROR && codec.header_overflow,
                  "oversized head overflows rather than truncating");
            mal_http_codec_free(&codec);
        }
        free(wire);
    }

    // 14. Field counts and sizes share the byte budget. llhttp 9.4.3 keeps reporting
    // header bytes after a limit is hit, so truncating instead of failing would drop
    // whichever framing header sits past the cutoff and let the two ends of the
    // connection frame the same bytes differently.
    {
        usize capacity = 96 * 1024;
        char *wire = malloc(capacity);
        check(wire != nullptr, "header budget fixture allocates");
        if (wire != nullptr) {
            usize length = (usize) snprintf(wire, capacity, "POST /pad HTTP/1.1\r\nHost: x\r\n");
            for (usize i = 0; i < 300; i++)
                length += (usize) snprintf(wire + length, capacity - length, "X-Pad-%zu: v\r\n", i);
            length += (usize) snprintf(wire + length, capacity - length, "Content-Length: 0\r\n\r\n");
            MalHttpCodec codec;
            mal_http_codec_init(&codec, HTTP_REQUEST);
            usize consumed = 0;
            MalHttpCodecResult result = mal_http_codec_execute(
                &codec, (const byte *) wire, length, &consumed);
            MalHttpCodecHead *head = result == MAL_HTTP_CODEC_EVENT
                ? mal_http_codec_take_head(&codec) : nullptr;
            check(head != nullptr && head->field_count == 302,
                  "fields beyond the former count ceiling fit within the budget");
            mal_http_codec_head_free(head);
            mal_http_codec_free(&codec);

            length = (usize) snprintf(wire, capacity, "POST /pad HTTP/1.1\r\nHost: x\r\n");
            // Only names and values count, so the raw head runs past twice the budget.
            for (usize i = 0; length < 2 * MAL_HTTP_CODEC_DEFAULT_HEADER_SIZE; i++)
                length += (usize) snprintf(wire + length, capacity - length, "X-Pad-%zu: v\r\n", i);
            length += (usize) snprintf(
                wire + length, capacity - length, "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
            mal_http_codec_init(&codec, HTTP_REQUEST);
            consumed = 0;
            result = mal_http_codec_execute(&codec, (const byte *) wire, length, &consumed);
            check(result == MAL_HTTP_CODEC_ERROR && codec.header_overflow,
                  "a framing header past the budget fails the message");
            mal_http_codec_free(&codec);

            // Node fails once the tracked bytes reach the budget: the target, names and values.
            for (usize extra = 0; extra < 2; extra++) {
                // "/" and "X" are tracked with the value.
                usize value = MAL_HTTP_CODEC_DEFAULT_HEADER_SIZE - 3 + extra;
                length = (usize) snprintf(wire, capacity, "GET / HTTP/1.1\r\nX: ");
                memset(wire + length, 'v', value);
                length += value;
                length += (usize) snprintf(wire + length, capacity - length, "\r\n\r\n");
                mal_http_codec_init(&codec, HTTP_REQUEST);
                consumed = 0;
                result = mal_http_codec_execute(&codec, (const byte *) wire, length, &consumed);
                check(extra == 0 ? result == MAL_HTTP_CODEC_EVENT : codec.header_overflow,
                      extra == 0 ? "a head one byte under the budget parses"
                                 : "a head reaching the budget overflows");
                if (result == MAL_HTTP_CODEC_EVENT) mal_http_codec_head_free(mal_http_codec_take_head(&codec));
                mal_http_codec_free(&codec);
            }

            length = (usize) snprintf(wire, capacity, "POST /pad HTTP/1.1\r\nX-Pad: ");
            memset(wire + length, 'v', 20 * 1024);
            length += 20 * 1024;
            length += (usize) snprintf(wire + length, capacity - length, "\r\nContent-Length: 0\r\n\r\n");
            mal_http_codec_init(&codec, HTTP_REQUEST);
            mal_http_codec_set_max_header_size(&codec, 64 * 1024);
            consumed = 0;
            result = mal_http_codec_execute(&codec, (const byte *) wire, length, &consumed);
            head = result == MAL_HTTP_CODEC_EVENT ? mal_http_codec_take_head(&codec) : nullptr;
            check(head != nullptr && head->fields[0].value_length == 20 * 1024,
                  "a raised budget accepts a field past the default size");
            mal_http_codec_head_free(head);
            mal_http_codec_free(&codec);
        }
        free(wire);
    }

    // 14. Seeded fuzzing: llhttp parses incrementally, so splitting the same bytes
    // differently must never change what the codec reports. A difference would let
    // a peer's segmentation change request framing. Mutations of valid pipelined
    // requests exercise malformed input; the sanitizer lane checks memory safety.
    {
        static const char *const corpus[] = {
            "POST /one HTTP/1.1\r\nHost: example.test\r\nX-Dup: one\r\nX-Dup: two\r\n"
            "Transfer-Encoding: chunked\r\n\r\n2;ext=1\r\nhe\r\n3\r\nllo\r\n0\r\n"
            "Trailer: value\r\n\r\nGET /two HTTP/1.1\r\nHost: example.test\r\n\r\n",
            "PUT /upload?x=1 HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\n\r\nhello world"
            "DELETE /item HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
            "GET / HTTP/1.0\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n"
            "OPTIONS * HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\n\r\n",
            "PATCH /p HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n"
            "a\r\n0123456789\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n",
        };
        const usize corpus_count = sizeof corpus / sizeof corpus[0];
        u64 seed = UINT64_C(0x5eed);
        bool fragments_agree = true;
        for (usize entry = 0; entry < corpus_count; entry++) {
            const byte *wire = (const byte *) corpus[entry];
            usize length = strlen(corpus[entry]);
            CodecTrace whole = codec_trace(wire, length, 0, 0);
            fragments_agree = fragments_agree && !whole.failed && whole.events >= 2;
            for (usize round = 0; round < 200; round++) {
                usize max_piece = 1 + (usize) (fuzz_next(&seed) % 17);
                fragments_agree = fragments_agree
                    && codec_traces_equal(whole, codec_trace(wire, length, fuzz_next(&seed), max_piece));
            }
        }
        check(fragments_agree, "fragmenting valid pipelined requests keeps every event");

        static const byte alphabet[] = "\r\n :;\t\0-0aZ%/\x7f\x80\xff";
        byte mutated[512];
        bool mutations_agree = true;
        usize failures = 0;
        for (usize round = 0; round < 20000 && mutations_agree; round++) {
            const char *source = corpus[fuzz_next(&seed) % corpus_count];
            usize length = strlen(source);
            memcpy(mutated, source, length);
            usize edits = 1 + (usize) (fuzz_next(&seed) % 4);
            for (usize edit = 0; edit < edits && length > 1; edit++) {
                usize at = (usize) (fuzz_next(&seed) % length);
                byte value = alphabet[fuzz_next(&seed) % (sizeof alphabet - 1)];
                switch (fuzz_next(&seed) % 3) {
                    case 0:
                        mutated[at] = value;
                        break;
                    case 1:
                        if (length < sizeof mutated) {
                            memmove(mutated + at + 1, mutated + at, length - at);
                            mutated[at] = value;
                            length++;
                        }
                        break;
                    default:
                        memmove(mutated + at, mutated + at + 1, length - at - 1);
                        length--;
                        break;
                }
            }
            CodecTrace whole = codec_trace(mutated, length, 0, 0);
            if (whole.failed) failures++;
            mutations_agree = codec_traces_equal(
                whole, codec_trace(mutated, length, fuzz_next(&seed), 1 + (usize) (fuzz_next(&seed) % 9)));
            if (!mutations_agree) {
                fprintf(stderr, "httptest: fragmentation changed the parse of mutation %zu: ", round);
                fwrite(mutated, 1, length, stderr);
                fputc('\n', stderr);
            }
        }
        check(mutations_agree, "fragmenting mutated requests keeps every event and failure");
        check(failures > 0, "mutations reach the codec's error paths");
    }

    printf("httptest: %d/%d checks\n", g_pass, g_total);
    printf("httptest PASS %d/%d\n", g_pass, g_total);
    return g_pass == g_total ? 0 : 1;
}
