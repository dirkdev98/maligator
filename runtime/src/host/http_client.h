#pragma once

#include "./defaults.h"
#include "host_task.h"
#include "http_codec.h"

typedef struct MalHost MalHost;

typedef struct MalHttpClientResult {
    char *error;
} MalHttpClientResult;

typedef enum MalHttpClientProgressKind {
    MAL_HTTP_CLIENT_PROGRESS_RESPONSE_HEAD = 1,
    MAL_HTTP_CLIENT_PROGRESS_RESPONSE_BODY,
    MAL_HTTP_CLIENT_PROGRESS_RESPONSE_COMPLETE,
    MAL_HTTP_CLIENT_PROGRESS_WRITE_COMPLETE,
} MalHttpClientProgressKind;

typedef struct MalHttpClientProgress {
    MalHttpClientProgressKind kind;
    MalHttpCodecHead *head;
    byte *bytes;
    usize length;
    u64 token;
    bool end_stream;
} MalHttpClientProgress;

typedef enum MalHttpClientWriteResult {
    MAL_HTTP_CLIENT_WRITE_ACCEPTED = 1,
    MAL_HTTP_CLIENT_WRITE_WOULD_BLOCK,
    MAL_HTTP_CLIENT_WRITE_CLOSED,
} MalHttpClientWriteResult;

/* Start one streamed HTTP/1.1 request to a numeric IPv4 address. The host takes
 * ownership of request_head on success. A negative content length selects chunked
 * framing; nonnegative lengths are validated across accepted writes. */
bool mal_http_client_start(
    MalHost *host,
    const char *host_name,
    u16 port,
    byte *request_head,
    usize request_head_len,
    i64 content_length,
    bool head_request,
    MalHostHandle *operation);
MalHttpClientWriteResult mal_http_client_write_owned(
    MalHost *host,
    MalHostHandle operation,
    byte *bytes,
    usize length,
    u64 token,
    bool end_stream);
bool mal_http_client_read_credit(
    MalHost *host, MalHostHandle operation, usize bytes);
bool mal_http_client_response_complete_ack(
    MalHost *host, MalHostHandle operation);

/* Cancel by stable host operation identity. A matching active transport is
 * closed synchronously; its cancelled terminal task remains runtime-owned. */
bool mal_http_client_cancel(MalHost *host, MalHostHandle operation);
void mal_http_client_shutdown(MalHost *host);

void mal_http_client_result_free(void *data);
void mal_http_client_progress_free(void *data);
