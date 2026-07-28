#pragma once

#include "./defaults.h"
#include "host_task.h"

typedef struct MalHost MalHost;

typedef struct MalHttpClientHeader {
    char *name;
    usize name_len;
    char *value;
    usize value_len;
} MalHttpClientHeader;

typedef struct MalHttpClientResult {
    int status;
    int minor_version;
    char *status_message;
    usize status_message_len;
    MalHttpClientHeader headers[64];
    usize header_count;
    byte *body;
    usize body_len;
    char *error;
} MalHttpClientResult;

/* Start one buffered HTTP/1.1 request to a numeric IPv4 address. The host takes
 * ownership of request_bytes on success and publishes exactly one terminal task. */
bool mal_http_client_start(
    MalHost *host,
    const char *host_name,
    u16 port,
    byte *request_bytes,
    usize request_len,
    bool head_request,
    MalHostHandle *operation);

/* Cancel by stable host operation identity. A matching active transport is
 * closed synchronously; its cancelled terminal task remains runtime-owned. */
bool mal_http_client_cancel(MalHost *host, MalHostHandle operation);
void mal_http_client_shutdown(MalHost *host);

void mal_http_client_result_free(void *data);
