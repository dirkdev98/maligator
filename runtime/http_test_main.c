#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "http.h"
#include "http_codec.h"

/*
 * Unit test for the HTTP/1.1 request parser. Pure
 * function over byte fixtures; no sockets or VM. Verifies request-line parsing,
 * headers (incl. case-insensitive lookup), Content-Length / chunked framing,
 * keep-alive semantics, and the INCOMPLETE / ERROR verdicts.
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

static bool field_eq(const char *ptr, usize len, const char *want) {
    return len == strlen(want) && memcmp(ptr, want, len) == 0;
}

static bool codec_slice_eq(const byte *ptr, usize len, const char *want) {
    return ptr != nullptr && len == strlen(want) && memcmp(ptr, want, len) == 0;
}

int main(void) {
    MalHttpRequest req;
    usize consumed;

    // 1. Simple GET / HTTP/1.1 with one header.
    {
        const char *r = "GET /index.html HTTP/1.1\r\nHost: example.com\r\n\r\n";
        MalHttpParse p = mal_http_parse_request(r, strlen(r), &req, &consumed);
        check(p == MAL_HTTP_OK, "simple GET parses");
        check(field_eq(req.method, req.method_len, "GET"), "method=GET");
        check(field_eq(req.target, req.target_len, "/index.html"), "target=/index.html");
        check(req.minor_version == 1, "minor=1");
        check(req.header_count == 1, "one header");
        check(req.keep_alive, "1.1 keep-alive default");
        check(req.content_length == -1, "no content-length");
        check(consumed == strlen(r), "consumed == full (empty body)");
        const char *v;
        usize vlen;
        check(mal_http_header(&req, "host", &v, &vlen) && field_eq(v, vlen, "example.com"),
            "case-insensitive Host lookup");
    }

    // 2. POST with Content-Length + a body; body starts at *consumed.
    {
        const char *r = "POST /api HTTP/1.1\r\nContent-Type: application/json\r\n"
                        "Content-Length: 7\r\n\r\n{\"a\":1}";
        MalHttpParse p = mal_http_parse_request(r, strlen(r), &req, &consumed);
        check(p == MAL_HTTP_OK, "POST parses");
        check(field_eq(req.method, req.method_len, "POST"), "method=POST");
        check(req.content_length == 7, "content-length=7");
        check(strcmp(r + consumed, "{\"a\":1}") == 0, "body begins at consumed");
        const char *v;
        usize vlen;
        check(mal_http_header(&req, "Content-Type", &v, &vlen)
                  && field_eq(v, vlen, "application/json"),
            "Content-Type value (OWS trimmed)");
    }

    // 3. Incomplete (headers not terminated yet).
    {
        const char *r = "GET / HTTP/1.1\r\nHost: x";
        MalHttpParse p = mal_http_parse_request(r, strlen(r), &req, &consumed);
        check(p == MAL_HTTP_INCOMPLETE, "partial request is INCOMPLETE");
    }

    // 4. Malformed request line.
    {
        const char *r = "GARBAGE\r\n\r\n";
        MalHttpParse p = mal_http_parse_request(r, strlen(r), &req, &consumed);
        check(p == MAL_HTTP_ERROR, "malformed request line is ERROR");
    }

    // 5. HTTP/1.0 defaults to close; Connection: keep-alive overrides.
    {
        const char *r0 = "GET / HTTP/1.0\r\nHost: x\r\n\r\n";
        mal_http_parse_request(r0, strlen(r0), &req, &consumed);
        check(!req.keep_alive, "1.0 defaults to close");
        const char *r1 = "GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n";
        mal_http_parse_request(r1, strlen(r1), &req, &consumed);
        check(req.keep_alive, "1.0 Connection: keep-alive -> persistent");
    }

    // 6. HTTP/1.1 Connection: close overrides default.
    {
        const char *r = "GET / HTTP/1.1\r\nConnection: close\r\n\r\n";
        mal_http_parse_request(r, strlen(r), &req, &consumed);
        check(!req.keep_alive, "1.1 Connection: close -> not persistent");
    }

    // 7. Transfer-Encoding: chunked.
    {
        const char *r = "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        mal_http_parse_request(r, strlen(r), &req, &consumed);
        check(req.chunked, "chunked detected");
        check(req.content_length == -1, "chunked has no content-length");
    }

    // 8. The llhttp codec yields fragmented heads, decoded body data, and
    // message boundaries without buffering a whole request.
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

    // 10. Strict framing rejects request-smuggling ambiguity before publishing a head.
    {
        const char *wire =
            "POST / HTTP/1.1\r\nContent-Length: 1\r\n"
            "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
        MalHttpCodec codec;
        mal_http_codec_init(&codec, HTTP_REQUEST);
        usize consumed_now = 0;
        check(mal_http_codec_execute(
                  &codec, (const byte *) wire, strlen(wire), &consumed_now)
                  == MAL_HTTP_CODEC_ERROR,
              "codec rejects transfer-encoding plus content-length");
        mal_http_codec_free(&codec);
    }

    printf("httptest: %d/%d checks\n", g_pass, g_total);
    printf("httptest PASS %d/%d\n", g_pass, g_total);
    return g_pass == g_total ? 0 : 1;
}
