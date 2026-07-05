#include "http.h"

#include <string.h>

static bool mal_http_is_ows(char c) {
    return c == ' ' || c == '\t';
}

/* ASCII case-insensitive compare of a[0..alen) against the C-string b. */
static bool mal_http_ci_eq(const char *a, usize alen, const char *b) {
    usize blen = 0;
    while (b[blen] != '\0') {
        blen++;
    }
    if (alen != blen) {
        return false;
    }
    for (usize i = 0; i < alen; i++) {
        char x = a[i];
        char y = b[i];
        if (x >= 'A' && x <= 'Z') {
            x = (char) (x - 'A' + 'a');
        }
        if (y >= 'A' && y <= 'Z') {
            y = (char) (y - 'A' + 'a');
        }
        if (x != y) {
            return false;
        }
    }
    return true;
}

/* Case-insensitive substring search of `needle` within value[0..len). */
static bool mal_http_ci_contains(const char *value, usize len, const char *needle) {
    usize nlen = strlen(needle);
    if (nlen == 0 || len < nlen) {
        return false;
    }
    for (usize i = 0; i + nlen <= len; i++) {
        bool match = true;
        for (usize j = 0; j < nlen; j++) {
            char x = value[i + j];
            char y = needle[j];
            if (x >= 'A' && x <= 'Z') {
                x = (char) (x - 'A' + 'a');
            }
            if (y >= 'A' && y <= 'Z') {
                y = (char) (y - 'A' + 'a');
            }
            if (x != y) {
                match = false;
                break;
            }
        }
        if (match) {
            return true;
        }
    }
    return false;
}

/*
 * Read one line from buf[*pos..len). A line ends at CRLF (preferred) or a lone LF.
 * On success sets line + line_len (excluding the terminator), advances *pos past
 * the terminator, and returns true. Returns false if no full line is present yet.
 */
static bool mal_http_read_line(
    const char *buf, usize len, usize *pos, const char **line, usize *line_len) {
    usize start = *pos;
    for (usize i = start; i < len; i++) {
        if (buf[i] == '\n') {
            usize end = i;
            if (end > start && buf[end - 1] == '\r') {
                end--;
            }
            *line = buf + start;
            *line_len = end - start;
            *pos = i + 1;
            return true;
        }
    }
    return false;
}

bool mal_http_header(
    const MalHttpRequest *req, const char *name, const char **value, usize *value_len) {
    for (usize i = 0; i < req->header_count; i++) {
        if (mal_http_ci_eq(req->headers[i].name, req->headers[i].name_len, name)) {
            *value = req->headers[i].value;
            *value_len = req->headers[i].value_len;
            return true;
        }
    }
    return false;
}

MalHttpParse mal_http_dechunk(char *buf, usize len, usize *decoded_len, usize *consumed) {
    usize r = 0; // read cursor over the raw chunked bytes
    usize w = 0; // write cursor for the decoded body (in place; w <= r always)
    for (;;) {
        // Chunk-size line: hex digits terminated by CRLF (chunk-extensions unsupported).
        usize p = r;
        while (p + 1 < len && !(buf[p] == '\r' && buf[p + 1] == '\n')) {
            p++;
        }
        if (p + 1 >= len) {
            return MAL_HTTP_INCOMPLETE; // size line not fully arrived
        }
        usize size = 0;
        for (usize i = r; i < p; i++) {
            char ch = buf[i];
            int digit;
            if (ch >= '0' && ch <= '9') {
                digit = ch - '0';
            } else if (ch >= 'a' && ch <= 'f') {
                digit = ch - 'a' + 10;
            } else if (ch >= 'A' && ch <= 'F') {
                digit = ch - 'A' + 10;
            } else {
                return MAL_HTTP_ERROR; // chunk-ext / bad hex
            }
            size = size * 16 + (usize) digit;
            if (size > ((usize) 1 << 40)) {
                return MAL_HTTP_ERROR;
            }
        }
        r = p + 2; // past the size line's CRLF

        if (size == 0) {
            // Last chunk: expect the terminating CRLF (empty trailer).
            if (r + 1 >= len) {
                return MAL_HTTP_INCOMPLETE;
            }
            if (buf[r] != '\r' || buf[r + 1] != '\n') {
                return MAL_HTTP_ERROR; // trailer fields unsupported
            }
            r += 2;
            *decoded_len = w;
            *consumed = r;
            return MAL_HTTP_OK;
        }

        if (r + size + 2 > len) {
            return MAL_HTTP_INCOMPLETE; // chunk data + trailing CRLF not all here
        }
        memmove(buf + w, buf + r, size);
        w += size;
        r += size;
        if (buf[r] != '\r' || buf[r + 1] != '\n') {
            return MAL_HTTP_ERROR;
        }
        r += 2;
    }
}

MalHttpParse mal_http_parse_request(
    const char *buf, usize len, MalHttpRequest *req, usize *consumed) {
    memset(req, 0, sizeof(*req));
    req->content_length = -1;

    usize pos = 0;
    const char *line;
    usize line_len;

    // --- request line: METHOD SP request-target SP HTTP/1.x ---
    if (!mal_http_read_line(buf, len, &pos, &line, &line_len)) {
        return MAL_HTTP_INCOMPLETE;
    }
    usize sp1 = 0;
    while (sp1 < line_len && line[sp1] != ' ') {
        sp1++;
    }
    if (sp1 == 0 || sp1 >= line_len) {
        return MAL_HTTP_ERROR;
    }
    req->method = line;
    req->method_len = sp1;

    usize target_start = sp1 + 1;
    usize sp2 = target_start;
    while (sp2 < line_len && line[sp2] != ' ') {
        sp2++;
    }
    if (sp2 <= target_start || sp2 >= line_len) {
        return MAL_HTTP_ERROR;
    }
    req->target = line + target_start;
    req->target_len = sp2 - target_start;

    const char *version = line + sp2 + 1;
    usize version_len = line_len - (sp2 + 1);
    // Expect "HTTP/1.N".
    if (version_len != 8 || memcmp(version, "HTTP/1.", 7) != 0) {
        return MAL_HTTP_ERROR;
    }
    char minor = version[7];
    if (minor < '0' || minor > '9') {
        return MAL_HTTP_ERROR;
    }
    req->minor_version = minor - '0';

    // --- headers, until a blank line ---
    for (;;) {
        if (!mal_http_read_line(buf, len, &pos, &line, &line_len)) {
            return MAL_HTTP_INCOMPLETE;
        }
        if (line_len == 0) {
            break; // blank line: end of headers
        }
        if (req->header_count >= MAL_HTTP_MAX_HEADERS) {
            return MAL_HTTP_ERROR;
        }
        usize colon = 0;
        while (colon < line_len && line[colon] != ':') {
            colon++;
        }
        if (colon == 0 || colon >= line_len) {
            return MAL_HTTP_ERROR;
        }
        const char *value = line + colon + 1;
        usize value_len = line_len - (colon + 1);
        // Trim OWS around the value.
        while (value_len > 0 && mal_http_is_ows(value[0])) {
            value++;
            value_len--;
        }
        while (value_len > 0 && mal_http_is_ows(value[value_len - 1])) {
            value_len--;
        }
        MalHttpHeader *h = &req->headers[req->header_count++];
        h->name = line;
        h->name_len = colon;
        h->value = value;
        h->value_len = value_len;
    }

    *consumed = pos;

    // --- derive framing / connection semantics ---
    const char *v;
    usize vlen;
    if (mal_http_header(req, "Transfer-Encoding", &v, &vlen)) {
        req->chunked = mal_http_ci_contains(v, vlen, "chunked");
    }
    if (!req->chunked && mal_http_header(req, "Content-Length", &v, &vlen)) {
        i64 n = 0;
        if (vlen == 0) {
            return MAL_HTTP_ERROR;
        }
        for (usize i = 0; i < vlen; i++) {
            if (v[i] < '0' || v[i] > '9') {
                return MAL_HTTP_ERROR;
            }
            n = n * 10 + (v[i] - '0');
            if (n > (i64) 1 << 40) { // sanity cap (~1 TB)
                return MAL_HTTP_ERROR;
            }
        }
        req->content_length = n;
    }

    // Persistent connection: HTTP/1.1 defaults on, 1.0 off; Connection overrides.
    req->keep_alive = req->minor_version >= 1;
    if (mal_http_header(req, "Connection", &v, &vlen)) {
        if (mal_http_ci_contains(v, vlen, "close")) {
            req->keep_alive = false;
        } else if (mal_http_ci_contains(v, vlen, "keep-alive")) {
            req->keep_alive = true;
        }
    }

    return MAL_HTTP_OK;
}
