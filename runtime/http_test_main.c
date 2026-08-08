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

    // 13. A head past the codec's arena budget is refused, never truncated: a
    // truncated head would silently drop the framing fields it was cut off at.
    {
        usize length = MAL_HTTP_CODEC_HEAD_MAX + 4096;
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
            check(result == MAL_HTTP_CODEC_ERROR
                      || mal_http_codec_event(&codec) != MAL_HTTP_CODEC_EVENT_HEAD,
                  "oversized head is refused rather than truncated");
            mal_http_codec_free(&codec);
        }
        free(wire);
    }

    // 14. The per-field limits are the same invariant as the arena one, and llhttp
    // 9.4.3 keeps reporting header bytes after a limit is hit. Truncating instead of
    // failing would silently drop whichever framing header sits past the cutoff, so
    // the two ends of the connection could frame the same bytes differently.
    {
        usize capacity = 32 * 1024;
        char *wire = malloc(capacity);
        check(wire != nullptr, "field-limit fixture allocates");
        if (wire != nullptr) {
            usize length = (usize) snprintf(
                wire, capacity, "POST /pad HTTP/1.1\r\nHost: x\r\n");
            for (usize i = 0; i <= MAL_HTTP_CODEC_FIELDS_MAX && length < capacity; i++) {
                int written = snprintf(
                    wire + length, capacity - length, "X-Pad-%zu: v\r\n", i);
                if (written <= 0 || (usize) written >= capacity - length) break;
                length += (usize) written;
            }
            int written = snprintf(
                wire + length, capacity - length,
                "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
            length += written > 0 ? (usize) written : 0;
            MalHttpCodec codec;
            mal_http_codec_init(&codec, HTTP_REQUEST);
            usize consumed = 0;
            MalHttpCodecResult result = mal_http_codec_execute(
                &codec, (const byte *) wire, length, &consumed);
            check(result == MAL_HTTP_CODEC_ERROR,
                  "a framing header past the field-count limit fails the message");
            mal_http_codec_free(&codec);

            length = (usize) snprintf(
                wire, capacity, "POST /pad HTTP/1.1\r\nHost: x\r\nX-Pad: ");
            usize padding = MAL_HTTP_CODEC_FIELD_MAX + 16;
            if (length + padding + 32 < capacity) {
                memset(wire + length, 'v', padding);
                length += padding;
                written = snprintf(
                    wire + length, capacity - length, "\r\nContent-Length: 0\r\n\r\n");
                length += written > 0 ? (usize) written : 0;
            }
            mal_http_codec_init(&codec, HTTP_REQUEST);
            consumed = 0;
            result = mal_http_codec_execute(
                &codec, (const byte *) wire, length, &consumed);
            check(result == MAL_HTTP_CODEC_ERROR,
                  "an over-long field value fails rather than truncating the head");
            mal_http_codec_free(&codec);
        }
        free(wire);
    }

    printf("httptest: %d/%d checks\n", g_pass, g_total);
    printf("httptest PASS %d/%d\n", g_pass, g_total);
    return g_pass == g_total ? 0 : 1;
}
