#pragma once

#include "./defaults.h"

/*
 * Minimal HTTP/1.1 request parser (host layer). Zero-copy: parsed fields point
 * into the caller's buffer, which must stay alive while the request is used. Covers
 * the mass-market surface (request line + headers + Content-Length + keep-alive +
 * chunked detection); the full grammar/edge cases can be hardened, or picohttpparser
 * swapped in, later. Response serialization + chunked *decoding* live in the server
 * loop that uses this.
 */

#define MAL_HTTP_MAX_HEADERS 64

typedef struct MalHttpHeader {
    const char *name;
    usize name_len;
    const char *value;
    usize value_len;
} MalHttpHeader;

typedef struct MalHttpRequest {
    const char *method;
    usize method_len;
    const char *target; // request-target (origin-form: path?query)
    usize target_len;
    int minor_version; // HTTP/1.<minor>; 0 or 1

    MalHttpHeader headers[MAL_HTTP_MAX_HEADERS];
    usize header_count;

    i64 content_length; // -1 when absent
    bool chunked;       // Transfer-Encoding: chunked
    bool keep_alive;    // effective persistent-connection decision
} MalHttpRequest;

typedef enum MalHttpParse {
    MAL_HTTP_OK = 0,         // headers fully parsed; *consumed = start of body
    MAL_HTTP_INCOMPLETE = 1, // need more bytes (no blank line yet)
    MAL_HTTP_ERROR = 2,      // malformed
} MalHttpParse;

/*
 * Parse the request line + headers from buf[0..len). On MAL_HTTP_OK, *consumed is
 * the byte offset just past the terminating blank line (where the body begins).
 * On INCOMPLETE the caller should read more and retry from the buffer start.
 */
MalHttpParse mal_http_parse_request(
    const char *buf, usize len, MalHttpRequest *req, usize *consumed);

/* Case-insensitive header lookup (first match). Returns false when absent. */
bool mal_http_header(
    const MalHttpRequest *req, const char *name, const char **value, usize *value_len);

/*
 * Decode a chunked request body IN PLACE: buf points at the first chunk-size line,
 * len is the bytes available. On MAL_HTTP_OK the decoded body occupies
 * buf[0..*decoded_len) and *consumed is the number of raw bytes the chunked encoding
 * used (body-plus-framing); INCOMPLETE means more bytes are needed; ERROR means
 * malformed. (Trailers are not supported: a chunk-ext or trailer field -> ERROR.)
 */
MalHttpParse mal_http_dechunk(char *buf, usize len, usize *decoded_len, usize *consumed);
