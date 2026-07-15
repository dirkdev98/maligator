#include <stdio.h>
#include <string.h>

#include "http.h"

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

    printf("httptest: %d/%d checks\n", g_pass, g_total);
    printf("httptest PASS %d/%d\n", g_pass, g_total);
    return g_pass == g_total ? 0 : 1;
}
