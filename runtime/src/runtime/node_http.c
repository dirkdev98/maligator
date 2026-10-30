// Portions derived from Node.js lib/_http_outgoing.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_http.h"
#include "node_https.h"

#if MAL_NODE

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "async_context.h"
#include "array_object.h"
#include "array_buffer_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "web_host_timer.h"
#include "host.h"
#include "http_client.h"
#include "intrinsics.h"
#include "node_dns.h"
#include "node_events.h"
#include "node_inspect.h"
#include "node_module.h"
#include "node_net.h"
#include "posix_fs.h"
#include "mal_tls.h"
#include "node_stream.h"
#include "node_buffer.h"
#include "net.h"
#include "object.h"
#include "object_ops.h"
#include "perf_stats.h"
#include "server.h"
#include "tcp.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "web_headers_object.h"
#include "web_websocket.h"
#include "vm_ops.h"

#define HTTP_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define HTTP_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)
#define HTTP_RESPONSE_WRITE_SEGMENT (256 * 1024)
#define HTTP_RESPONSE_WRITE_HIGH_WATER (256 * 1024)
#define HTTP_RESPONSE_WRITE_LOW_WATER (128 * 1024)

typedef struct MalNodeHttpStatus {
    int code;
    const char *reason;
} MalNodeHttpStatus;

static const MalNodeHttpStatus http_statuses[] = {
    {100, "Continue"},
    {101, "Switching Protocols"},
    {102, "Processing"},
    {103, "Early Hints"},
    {200, "OK"},
    {201, "Created"},
    {202, "Accepted"},
    {203, "Non-Authoritative Information"},
    {204, "No Content"},
    {205, "Reset Content"},
    {206, "Partial Content"},
    {207, "Multi-Status"},
    {208, "Already Reported"},
    {226, "IM Used"},
    {300, "Multiple Choices"},
    {301, "Moved Permanently"},
    {302, "Found"},
    {303, "See Other"},
    {304, "Not Modified"},
    {305, "Use Proxy"},
    {307, "Temporary Redirect"},
    {308, "Permanent Redirect"},
    {400, "Bad Request"},
    {401, "Unauthorized"},
    {402, "Payment Required"},
    {403, "Forbidden"},
    {404, "Not Found"},
    {405, "Method Not Allowed"},
    {406, "Not Acceptable"},
    {407, "Proxy Authentication Required"},
    {408, "Request Timeout"},
    {409, "Conflict"},
    {410, "Gone"},
    {411, "Length Required"},
    {412, "Precondition Failed"},
    {413, "Payload Too Large"},
    {414, "URI Too Long"},
    {415, "Unsupported Media Type"},
    {416, "Range Not Satisfiable"},
    {417, "Expectation Failed"},
    {418, "I'm a Teapot"},
    {421, "Misdirected Request"},
    {422, "Unprocessable Entity"},
    {423, "Locked"},
    {424, "Failed Dependency"},
    {425, "Too Early"},
    {426, "Upgrade Required"},
    {428, "Precondition Required"},
    {429, "Too Many Requests"},
    {431, "Request Header Fields Too Large"},
    {451, "Unavailable For Legal Reasons"},
    {500, "Internal Server Error"},
    {501, "Not Implemented"},
    {502, "Bad Gateway"},
    {503, "Service Unavailable"},
    {504, "Gateway Timeout"},
    {505, "HTTP Version Not Supported"},
    {506, "Variant Also Negotiates"},
    {507, "Insufficient Storage"},
    {508, "Loop Detected"},
    {509, "Bandwidth Limit Exceeded"},
    {510, "Not Extended"},
    {511, "Network Authentication Required"},
};

typedef struct MalNodeHttpServerState {
    MalVm *vm;
    MalValue receiver;
    MalAsyncContext *async_context;
    MalHttpServer *native;
    u16 port;
    char host[16];
    u32 headers_timeout_ms;
    u32 request_timeout_ms;
    u32 keep_alive_timeout_ms;
    u32 max_connections;
    bool listening_pending;
    bool closing;
    bool close_ready;
#if MAL_REALMS
    MalRealm *realm;
#endif
    /* Handshakes the reactor finished, in order, awaiting their 'secureConnection' turn. */
    struct MalNodeHttpSocketState *secure_head;
    struct MalNodeHttpSocketState *secure_tail;
    struct MalNodeHttpTlsError *tls_errors;
    struct MalNodeHttpTlsError *tls_errors_tail;
    /* ClientHellos awaiting SNICallback or addContext selection, in arrival order. */
    struct MalNodeHttpSocketState *hello_head;
    struct MalNodeHttpSocketState *hello_tail;
    struct MalNodeHttpServerState *next;
} MalNodeHttpServerState;

typedef struct MalNodeHttpTlsError {
    int error;
    char failure[48];
    struct MalNodeHttpTlsError *next;
} MalNodeHttpTlsError;

typedef struct MalNodeHttpSocketState {
    MalVm *vm;
    /* Undefined until the facade is built, which a queued handshake defers to its dispatch. */
    MalValue receiver;
    MalHttpConn *conn;
    MalNodeHttpServerState *secure_server;
    struct MalNodeHttpSocketState *secure_next;
    MalNodeHttpServerState *hello_server;
    struct MalNodeHttpSocketState *hello_next;
    /* The ClientHello's server name (owned), or null without SNI. */
    char *hello_name;
    usize hello_name_length;
    bool hello_pending;
    struct MalNodeHttpSocketState *previous;
    struct MalNodeHttpSocketState *next;
} MalNodeHttpSocketState;

typedef struct MalNodeHttpCopiedHeader {
    char *name;
    usize name_len;
    char *value;
    usize value_len;
} MalNodeHttpCopiedHeader;

typedef struct MalNodeHttpResponseHeader {
    char *name;
    usize name_len;
    MalValue value;
} MalNodeHttpResponseHeader;

#define MAL_NODE_HTTP_INLINE_RESPONSE_HEADERS 8
#define MAL_NODE_HTTP_MAX_RESPONSE_HEADERS 64

typedef struct MalNodeHttpResponseNameView {
    const c16 *units;
    usize length;
} MalNodeHttpResponseNameView;

typedef enum MalNodeHttpRequestReadyKind {
    HTTP_REQUEST_READY_NONE,
    HTTP_REQUEST_READY_DISPATCH,
    HTTP_REQUEST_READY_READ,
    HTTP_REQUEST_READY_WRITE,
    HTTP_REQUEST_READY_RESPONSE,
    HTTP_REQUEST_READY_COMPLETION,
} MalNodeHttpRequestReadyKind;

typedef struct MalNodeHttpResponseWrite {
    u64 token;
    byte *bytes;
    usize length;
    usize offset;
    MalValue callback;
    MalAsyncContext *async_context;
    bool end_write;
    struct MalNodeHttpResponseWrite *next;
} MalNodeHttpResponseWrite;

typedef struct MalNodeHttpRequestBody {
    byte *bytes;
    usize length;
    struct MalNodeHttpRequestBody *next;
} MalNodeHttpRequestBody;

typedef struct MalNodeHttpRequestState {
    MalVm *vm;
    MalValue server_receiver;
    MalAsyncContext *async_context;
    MalAsyncContext *end_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalHttpConn *conn;
    char *method;
    usize method_len;
    char *target;
    usize target_len;
    int minor_version;
    usize header_count;
    MalValue request;
    MalValue response;
    MalValue end_callback;
    MalValue request_destroy_error;
    MalNodeHttpResponseHeader *response_headers;
    usize response_header_count;
    usize response_header_capacity;
    MalNodeHttpResponseWrite *write_head;
    MalNodeHttpResponseWrite *write_tail;
    usize queued_write_bytes;
    usize active_write_bytes;
    u64 next_write_token;
    u64 ready_write_token;
    // The framing an implicit commit asked for, read by a writeHead that a wrapper reaches.
    i64 implicit_length;
    // A write acknowledgement waits here while another ready kind holds the queue slot.
    bool write_ready_pending;
    MalNodeHttpRequestBody *body_head;
    MalNodeHttpRequestBody *body_tail;
    bool request_transport_complete;
    bool request_terminal_delivered;
    bool request_end_success;
    bool request_end_counted;
    bool request_read_started;
    bool request_auto_discard;
    bool response_transport_complete;
    bool response_terminal_delivered;
    bool response_end_counted;
    bool pending;
    bool finish_pending;
    bool response_in_flight;
    bool write_in_flight;
    bool backpressured;
    bool final_submitted;
    bool suppress_response_body;
    bool response_succeeded;
    bool response_failed;
    bool committing_headers;
    bool head_committed;
    bool implicit_commit;
    bool implicit_streaming;
    bool ending;
    bool ended;
    bool response_indexed;
    bool request_indexed;
    MalNodeHttpRequestReadyKind ready_kind;
    struct MalNodeHttpRequestState *response_index_next;
    struct MalNodeHttpRequestState *request_index_next;
    struct MalNodeHttpRequestState *ready_next;
    struct MalNodeHttpRequestState *previous;
    struct MalNodeHttpRequestState *next;
    MalNodeHttpResponseHeader
        inline_response_headers[MAL_NODE_HTTP_INLINE_RESPONSE_HEADERS];
    MalNodeHttpCopiedHeader headers[];
} MalNodeHttpRequestState;

static_assert(offsetof(MalNodeHttpRequestState, headers) == sizeof(MalNodeHttpRequestState),
              "request header descriptors must immediately follow request state");
static_assert(offsetof(MalNodeHttpRequestState, headers) % alignof(MalNodeHttpCopiedHeader) == 0,
              "request header descriptors must be aligned");
static_assert(sizeof(MalNodeHttpRequestState) <= 512,
              "request state common case should remain at most 512 bytes");

typedef struct MalNodeHttpClientState {
    MalVm *vm;
    MalAsyncContext *async_context;
    MalAsyncContext *end_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalValue request;
    MalValue response;
    MalValue end_callback;
    MalHostHandle operation;
    char *host;
    u16 port;
    bool secure;
    bool keep_alive;
    /* https `ca`; null trusts the host roots. */
    char *ca;
    usize ca_len;
    char *cert;
    usize cert_len;
    char *key;
    usize key_len;
    char *method;
    usize method_len;
    char *path;
    usize path_len;
    char *headers;
    usize headers_len;
    MalNodeHttpResponseWrite *write_head;
    MalNodeHttpResponseWrite *write_tail;
    usize queued_write_bytes;
    usize active_write_bytes;
    u64 next_write_token;
    i64 content_length;
    u32 timeout_ms;
    MalValue destroy_error;
    MalValue response_destroy_error;
    bool has_content_length;
    bool headers_committed;
    bool write_in_flight;
    bool final_submitted;
    bool upload_complete;
    bool backpressured;
    bool response_head_seen;
    bool response_complete;
    bool response_destroyed;
    bool ending;
    bool ended;
    bool cancelled;
    bool aborted;
    bool terminal_pending;
    struct MalNodeHttpClientState *next;
} MalNodeHttpClientState;

// Value-holding lists belong to, and are traced on, their isolate's mutator.
static MAL_ISOLATE_LOCAL MalNodeHttpServerState *http_servers;
/* OutgoingMessage.prototype as installed; a patch changes its shape and disables the fast path. */
static MAL_ISOLATE_LOCAL MalShape *http_outgoing_prototype_shape;
static MAL_ISOLATE_LOCAL usize http_outgoing_prototype_properties;
static MAL_ISOLATE_LOCAL MalNodeHttpSocketState *http_sockets;
static MAL_ISOLATE_LOCAL MalNodeHttpRequestState *http_requests;
static MAL_ISOLATE_LOCAL MalNodeHttpRequestState *http_requests_tail;
static MAL_ISOLATE_LOCAL MalNodeHttpRequestState **http_response_index;
static MAL_ISOLATE_LOCAL usize http_response_index_capacity;
static MAL_ISOLATE_LOCAL usize http_response_index_count;
static MAL_ISOLATE_LOCAL MalNodeHttpRequestState **http_request_index;
static MAL_ISOLATE_LOCAL usize http_request_index_capacity;
static MAL_ISOLATE_LOCAL usize http_request_index_count;
static MAL_ISOLATE_LOCAL MalNodeHttpClientState *http_clients;
// Clients dispatching their terminal: unlinked so lookups miss them, but still traced.
static MAL_ISOLATE_LOCAL MalNodeHttpClientState *http_clients_terminating;
static MAL_ISOLATE_LOCAL bool http_roots_installed;
static void http_response_complete(void *data, bool success);
static void http_queue_request_body(void *data, byte *owned_bytes, usize length);
static void http_queue_request_end(void *data, bool success);
static MalValue http_client_error(MalVm *vm, const char *message);
static void http_define(MalVm *vm, MalValue receiver, const char *name, MalValue value);
static bool http_emit(MalVm *vm, MalValue receiver, const char *event);
static MalNodeHttpClientState *http_client_response_state(MalValue receiver);
static void http_client_cancel(
    MalVm *vm, MalNodeHttpClientState *state, bool aborted, MalValue error);

#define HTTP_RESPONSE_INDEX_INITIAL_CAPACITY 16

static usize http_response_index_bucket(MalObject *object, usize capacity) {
    uintptr_t hash = (uintptr_t) object >> 3;
    hash ^= hash >> 17;
    hash *= (uintptr_t) 0xed5ad4bbU;
    hash ^= hash >> 11;
    return (usize) hash & (capacity - 1);
}

static bool http_response_index_resize(usize capacity) {
    MalNodeHttpRequestState **buckets = calloc(capacity, sizeof(*buckets));
    if (buckets == nullptr) return false;
    for (usize i = 0; i < http_response_index_capacity; i++) {
        MalNodeHttpRequestState *state = http_response_index[i];
        while (state != nullptr) {
            MalNodeHttpRequestState *next = state->response_index_next;
            MalObject *object = mal_value_to_object(state->response);
            usize bucket = http_response_index_bucket(object, capacity);
            state->response_index_next = buckets[bucket];
            buckets[bucket] = state;
            state = next;
        }
    }
    free(http_response_index);
    http_response_index = buckets;
    http_response_index_capacity = capacity;
    MAL_PERF_COUNT(http_response_index_rehashes);
    return true;
}

static bool http_response_index_insert(MalNodeHttpRequestState *state) {
    if (http_response_index_capacity == 0) {
        if (!http_response_index_resize(HTTP_RESPONSE_INDEX_INITIAL_CAPACITY)) {
            return false;
        }
    } else if (http_response_index_count >= http_response_index_capacity * 3 / 4) {
        if (http_response_index_capacity <= SIZE_MAX / 2) {
            // Chaining remains correct at the current capacity when optional
            // growth cannot allocate; only the first table allocation is fatal.
            (void) http_response_index_resize(http_response_index_capacity * 2);
        }
    }
    MalObject *object = mal_value_to_object(state->response);
    usize bucket = http_response_index_bucket(object, http_response_index_capacity);
    state->response_index_next = http_response_index[bucket];
    http_response_index[bucket] = state;
    state->response_indexed = true;
    http_response_index_count++;
    MAL_PERF_COUNT(http_response_index_inserts);
#if MAL_PERF_STATS
    if (mal_perf_stats_enabled
        && http_response_index_count > mal_perf_stats.http_response_index_peak_entries) {
        mal_perf_stats.http_response_index_peak_entries = http_response_index_count;
    }
#endif
    return true;
}

static void http_response_index_remove(MalNodeHttpRequestState *state) {
    if (!state->response_indexed) return;
    MalObject *object = mal_value_to_object(state->response);
    usize bucket = http_response_index_bucket(object, http_response_index_capacity);
    MalNodeHttpRequestState **link = &http_response_index[bucket];
    while (*link != nullptr && *link != state) link = &(*link)->response_index_next;
    if (*link == state) {
        *link = state->response_index_next;
        http_response_index_count--;
        MAL_PERF_COUNT(http_response_index_removes);
    }
    state->response_indexed = false;
    state->response_index_next = nullptr;
}

static bool http_request_index_resize(usize capacity) {
    MalNodeHttpRequestState **buckets = calloc(capacity, sizeof(*buckets));
    if (buckets == nullptr) return false;
    for (usize i = 0; i < http_request_index_capacity; i++) {
        MalNodeHttpRequestState *state = http_request_index[i];
        while (state != nullptr) {
            MalNodeHttpRequestState *next = state->request_index_next;
            usize bucket = http_response_index_bucket(
                mal_value_to_object(state->request), capacity);
            state->request_index_next = buckets[bucket];
            buckets[bucket] = state;
            state = next;
        }
    }
    free(http_request_index);
    http_request_index = buckets;
    http_request_index_capacity = capacity;
    return true;
}

static bool http_request_index_insert(MalNodeHttpRequestState *state) {
    if (http_request_index_capacity == 0) {
        if (!http_request_index_resize(HTTP_RESPONSE_INDEX_INITIAL_CAPACITY)) {
            return false;
        }
    } else if (http_request_index_count >= http_request_index_capacity * 3 / 4
               && http_request_index_capacity <= SIZE_MAX / 2) {
        (void) http_request_index_resize(http_request_index_capacity * 2);
    }
    usize bucket = http_response_index_bucket(
        mal_value_to_object(state->request), http_request_index_capacity);
    state->request_index_next = http_request_index[bucket];
    http_request_index[bucket] = state;
    state->request_indexed = true;
    http_request_index_count++;
    return true;
}

static void http_request_index_remove(MalNodeHttpRequestState *state) {
    if (!state->request_indexed) return;
    usize bucket = http_response_index_bucket(
        mal_value_to_object(state->request), http_request_index_capacity);
    MalNodeHttpRequestState **link = &http_request_index[bucket];
    while (*link != nullptr && *link != state) link = &(*link)->request_index_next;
    if (*link == state) {
        *link = state->request_index_next;
        http_request_index_count--;
    }
    state->request_indexed = false;
    state->request_index_next = nullptr;
}

static MalNodeHttpRequestState *http_request_state(MalValue receiver) {
    if (!mal_value_is_object(receiver) || http_request_index_capacity == 0) {
        return nullptr;
    }
    usize bucket = http_response_index_bucket(
        mal_value_to_object(receiver), http_request_index_capacity);
    for (MalNodeHttpRequestState *state = http_request_index[bucket]; state != nullptr;
         state = state->request_index_next) {
        if (mal_value_to_object(state->request) == mal_value_to_object(receiver)) {
            return state;
        }
    }
    return nullptr;
}

static char *http_copy_bytes(const char *bytes, usize length) {
    char *copy = malloc(length + 1);
    if (copy == nullptr) return nullptr;
    memcpy(copy, bytes, length);
    copy[length] = '\0';
    return copy;
}

static bool http_request_snapshot_add_string(usize *size, usize length) {
    if (length == SIZE_MAX) return false;
    usize allocation_length = length + 1;
    if (*size > SIZE_MAX - allocation_length) return false;
    *size += allocation_length;
    return true;
}

static char *http_request_snapshot_copy(
    char **cursor, const char *bytes, usize length) {
    char *copy = *cursor;
    memcpy(copy, bytes, length);
    copy[length] = '\0';
    *cursor += length + 1;
    MAL_PERF_COUNT(http_request_copy_operations);
    MAL_PERF_ADD(http_request_copy_bytes, length + 1);
    return copy;
}

static void http_request_free(MalNodeHttpRequestState *request) {
    http_response_index_remove(request);
    http_request_index_remove(request);
    for (usize i = 0; i < request->response_header_count; i++) {
        free(request->response_headers[i].name);
    }
    if (request->response_headers != request->inline_response_headers) {
        free(request->response_headers);
    }
    MalNodeHttpRequestBody *body = request->body_head;
    while (body != nullptr) {
        MalNodeHttpRequestBody *next = body->next;
        free(body->bytes);
        free(body);
        body = next;
    }
    MalNodeHttpResponseWrite *write = request->write_head;
    while (write != nullptr) {
        MalNodeHttpResponseWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    MAL_PERF_COUNT(http_request_state_direct_frees);
    free(request);
}

static void http_request_remove(MalNodeHttpRequestState *request) {
    if (request->previous == nullptr) {
        http_requests = request->next;
    } else {
        request->previous->next = request->next;
    }
    if (request->next == nullptr) {
        http_requests_tail = request->previous;
    } else {
        request->next->previous = request->previous;
    }
    MAL_PERF_COUNT(http_request_removes);
    http_request_free(request);
}

static bool http_request_enqueue_ready(
    MalNodeHttpRequestState *request, MalNodeHttpRequestReadyKind kind) {
    // The root list owns request lifetime; this intrusive queue grants one
    // dispatch, write acknowledgement, or completion macrotask at a time.
    if (request->ready_kind != HTTP_REQUEST_READY_NONE) return false;
    MalHost *host = mal_host(request->vm);
    if (host == nullptr) return false;
    request->ready_kind = kind;
    request->ready_next = nullptr;
    if (host->ready_http_requests_tail == nullptr) {
        host->ready_http_requests = request;
    } else {
        host->ready_http_requests_tail->ready_next = request;
    }
    host->ready_http_requests_tail = request;
    if (kind == HTTP_REQUEST_READY_DISPATCH) {
        MAL_PERF_COUNT(http_dispatch_enqueues);
    }
    return true;
}

static void http_request_queue_completion(MalNodeHttpRequestState *request) {
    if (request->finish_pending) return;
    request->finish_pending = true;
    MalHost *host = mal_host(request->vm);
    if (host != nullptr) {
        host->pending_http_completions++;
        MAL_PERF_COUNT(http_completion_enqueues);
    }
    (void) http_request_enqueue_ready(request, HTTP_REQUEST_READY_COMPLETION);
}

static void http_request_maybe_complete(MalNodeHttpRequestState *request) {
    if (request->response_terminal_delivered
        && request->request_terminal_delivered) {
        http_request_queue_completion(request);
    }
}

// The pending write gates the response's next segment, including its final one.
static void http_request_schedule_write(MalNodeHttpRequestState *request) {
    if (request->ready_kind == HTTP_REQUEST_READY_NONE && request->write_ready_pending) {
        (void) http_request_enqueue_ready(request, HTTP_REQUEST_READY_WRITE);
    }
}

static void http_request_schedule_response(MalNodeHttpRequestState *request) {
    if (request->ready_kind == HTTP_REQUEST_READY_NONE
        && request->response_transport_complete
        && !request->response_terminal_delivered) {
        (void) http_request_enqueue_ready(request, HTTP_REQUEST_READY_RESPONSE);
    }
}

static void http_request_schedule_read(MalNodeHttpRequestState *request) {
    if (request->ready_kind == HTTP_REQUEST_READY_NONE
        && (request->body_head != nullptr
            || (request->request_transport_complete
                && !request->request_terminal_delivered))) {
        (void) http_request_enqueue_ready(request, HTTP_REQUEST_READY_READ);
    }
}

static MalNodeHttpRequestState *http_response_state(MalValue receiver) {
    MAL_PERF_COUNT(http_response_index_lookups);
    if (!mal_value_is_object(receiver) || http_response_index_capacity == 0) {
        MAL_PERF_COUNT(http_response_index_misses);
        return nullptr;
    }
    MalObject *object = mal_value_to_object(receiver);
    usize bucket = http_response_index_bucket(object, http_response_index_capacity);
    usize probes = 0;
    for (MalNodeHttpRequestState *state = http_response_index[bucket]; state != nullptr;
         state = state->response_index_next) {
        probes++;
        if (mal_value_to_object(state->response) == object) {
            MAL_PERF_COUNT(http_response_index_hits);
            MAL_PERF_ADD(http_response_index_probes, probes);
#if MAL_PERF_STATS
            if (mal_perf_stats_enabled
                && probes > mal_perf_stats.http_response_index_max_probes) {
                mal_perf_stats.http_response_index_max_probes = probes;
            }
#endif
            return state;
        }
    }
    MAL_PERF_COUNT(http_response_index_misses);
    MAL_PERF_ADD(http_response_index_probes, probes);
#if MAL_PERF_STATS
    if (mal_perf_stats_enabled
        && probes > mal_perf_stats.http_response_index_max_probes) {
        mal_perf_stats.http_response_index_max_probes = probes;
    }
#endif
    return nullptr;
}

static MalValue http_incoming_read(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_request_state(receiver);
    usize credit = 16 * 1024;
    if (argc > 0 && mal_ops_is_number(args[0])) {
        f64 number = mal_ops_number_as_f64(args[0]);
        if (isfinite(number) && number > 0) {
            if (number > 256 * 1024) number = 256 * 1024;
            credit = (usize) floor(number);
        }
    }
    if (state != nullptr && state->conn != nullptr
        && !state->request_transport_complete) {
        state->request_read_started = true;
        (void) mal_http_conn_request_read_credit(state->conn, credit);
        return mal_value_new_undefined();
    }
    MalNodeHttpClientState *client = http_client_response_state(receiver);
    if (client != nullptr && client->operation != 0
        && !client->response_complete && !client->cancelled) {
        (void) mal_http_client_read_credit(
            mal_host(vm), client->operation, credit);
    }
    return mal_value_new_undefined();
}

static MalValue http_incoming_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_request_state(receiver);
    if (state != nullptr && state->conn != nullptr
        && !state->request_transport_complete) {
        mal_object_set(
            mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) "destroyed"),
            mal_value_new_boolean(true));
        mal_object_set(
            mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) "readable"),
            mal_value_new_boolean(false));
        MalPropertyLookup readable_state = mal_object_get_own(
            mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) "_readableState"));
        if (readable_state.present && mal_value_is_object(readable_state.desc.value)) {
            mal_object_set(
                mal_value_to_object(readable_state.desc.value),
                mal_intrinsic_string_key(vm, (const byte *) "destroyed"),
                mal_value_new_boolean(true));
        }
        state->request_destroy_error = argc > 0
            ? args[0] : mal_value_new_undefined();
        mal_http_conn_abort(state->conn);
        return receiver;
    }
    MalNodeHttpClientState *client = http_client_response_state(receiver);
    if (client != nullptr && !client->cancelled) {
        client->response_destroyed = true;
        client->response_destroy_error = argc > 0
            ? args[0] : mal_value_new_undefined();
        mal_object_set(
            mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) "destroyed"),
            mal_value_new_boolean(true));
        mal_object_set(
            mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) "readable"),
            mal_value_new_boolean(false));
        MalPropertyLookup readable_state = mal_object_get_own(
            mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) "_readableState"));
        if (readable_state.present
            && mal_value_is_object(readable_state.desc.value)) {
            mal_object_set(
                mal_value_to_object(readable_state.desc.value),
                mal_intrinsic_string_key(vm, (const byte *) "destroyed"),
                mal_value_new_boolean(true));
        }
        http_client_cancel(
            vm, client, false, client->response_destroy_error);
        // Node's IncomingMessage._destroy aborts a response not yet read to its end at once.
        MalValue ended = mal_value_new_undefined();
        if (!client->response_complete
            || (mal_vm_get_static(vm, receiver, (const byte *) "readableEnded", &ended)
                && !mal_value_is_truthy(ended))) {
            http_define(vm, receiver, "aborted", mal_value_new_boolean(true));
            http_emit(vm, receiver, "aborted");
        }
        return receiver;
    }
    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE]);
    MalPropertyLookup destroy = mal_object_get_own(
        prototype, mal_intrinsic_string_key(vm, (const byte *) "destroy"));
    if (!destroy.present || !mal_value_is_callable(destroy.desc.value)) {
        return receiver;
    }
    return mal_vm_call_value(
        vm, destroy.desc.value, receiver, args, argc).value;
}

static void http_queue_request(
    void *data,
    MalVm *vm,
    MalHttpConn *conn,
    const MalHttpCodecHead *head) {
    (void) vm;
    MalNodeHttpServerState *server = data;
    if (head->field_count > (SIZE_MAX - (usize) sizeof(MalNodeHttpRequestState))
            / (usize) sizeof(MalNodeHttpCopiedHeader)) {
        goto fail;
    }
    usize snapshot_size = (usize) sizeof(MalNodeHttpRequestState)
        + head->field_count * (usize) sizeof(MalNodeHttpCopiedHeader);
    if (!http_request_snapshot_add_string(&snapshot_size, head->method_length)
        || !http_request_snapshot_add_string(&snapshot_size, head->target_length)) {
        goto fail;
    }
    for (usize i = 0; i < head->field_count; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        if (!http_request_snapshot_add_string(&snapshot_size, field->name_length)
            || !http_request_snapshot_add_string(&snapshot_size, field->value_length)) {
            goto fail;
        }
    }

    MalNodeHttpRequestState *state = calloc(1, snapshot_size);
    if (state == nullptr) goto fail;
    MAL_PERF_COUNT(http_request_state_allocations);
    state->vm = server->vm;
    state->server_receiver = server->receiver;
    state->async_context = server->async_context;
#if MAL_REALMS
    state->realm = server->realm;
#endif
    state->conn = conn;
    state->request = mal_value_new_undefined();
    state->response = mal_value_new_undefined();
    state->end_callback = mal_value_new_undefined();
    state->request_destroy_error = mal_value_new_undefined();
    state->response_headers = state->inline_response_headers;
    state->response_header_capacity = MAL_NODE_HTTP_INLINE_RESPONSE_HEADERS;
    state->pending = true;
    state->next_write_token = 1;
    state->method_len = head->method_length;
    state->target_len = head->target_length;
    state->minor_version = head->minor_version;
    state->header_count = head->field_count;
    char *cursor = (char *) &state->headers[head->field_count];
    state->method = http_request_snapshot_copy(
        &cursor, (const char *) mal_http_codec_head_method(head),
        head->method_length);
    state->target = http_request_snapshot_copy(
        &cursor, (const char *) mal_http_codec_head_target(head),
        head->target_length);
    for (usize i = 0; i < head->field_count; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        const char *name = (const char *) mal_http_codec_field_name(head, field);
        const char *value = (const char *) mal_http_codec_field_value(head, field);
        state->headers[i].name_len = field->name_length;
        state->headers[i].value_len = field->value_length;
        state->headers[i].name = http_request_snapshot_copy(
            &cursor, name, field->name_length);
        state->headers[i].value = http_request_snapshot_copy(
            &cursor, value, field->value_length);
    }
    MAL_PERF_ADD(http_request_packed_headers, head->field_count);
    if (http_requests_tail == nullptr) {
        http_requests = state;
    } else {
        http_requests_tail->next = state;
    }
    state->previous = http_requests_tail;
    http_requests_tail = state;
    MAL_PERF_COUNT(http_request_inserts);
    mal_http_conn_on_request_stream(
        conn, http_queue_request_body, http_queue_request_end, state);
    mal_http_conn_on_response_complete(conn, http_response_complete, state);
    (void) http_request_enqueue_ready(state, HTTP_REQUEST_READY_DISPATCH);
    return;

fail:
    mal_http_conn_respond(
        conn, 500, "Internal Server Error", nullptr, 0,
        "request allocation failed", 25);
}

static void http_queue_request_body(void *data, byte *owned_bytes, usize length) {
    MalNodeHttpRequestState *state = data;
    MalNodeHttpRequestBody *body = malloc(sizeof(*body));
    if (body == nullptr) {
        free(owned_bytes);
        mal_http_conn_abort(state->conn);
        return;
    }
    body->bytes = owned_bytes;
    body->length = length;
    body->next = nullptr;
    if (state->body_tail == nullptr) state->body_head = body;
    else state->body_tail->next = body;
    state->body_tail = body;
    MAL_PERF_COUNT(http_request_body_allocations);
    http_request_schedule_read(state);
}

static void http_queue_request_end(void *data, bool success) {
    MalNodeHttpRequestState *state = data;
    if (state->request_transport_complete) return;
    state->request_transport_complete = true;
    state->request_end_success = success;
    MalHost *host = mal_host(state->vm);
    if (host != nullptr) {
        host->pending_http_completions++;
        state->request_end_counted = true;
    }
    http_request_schedule_read(state);
}

static MalNodeHttpServerState *http_server_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    MalObject *object = mal_value_to_object(receiver);
    for (MalNodeHttpServerState *state = http_servers; state != nullptr;
         state = state->next) {
        if (mal_value_to_object(state->receiver) == object) return state;
    }
    return nullptr;
}

static bool http_call_method(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 argc) {
    MalValue roots[] = {receiver, mal_value_new_undefined(),
                        mal_value_new_undefined(), mal_value_new_undefined(),
                        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc && i < 3; i++) roots[i + 2] = args[i];
    bool found = mal_vm_get_static(vm, roots[0], (const byte *) name, &roots[1]);
    if (found) {
        mal_vm_call_value(vm, roots[1], roots[0], argc > 0 ? roots + 2 : nullptr, argc);
    }
    bool ok = found && vm->completion.kind != MAL_COMPLETION_THROW;
    mal_gc_unroot(&root);
    return ok;
}

static bool http_emit(MalVm *vm, MalValue receiver, const char *event) {
    MalValue name = mal_intrinsic_static_string_key(vm, (const byte *) event).value;
    MalRootSpan root;
    mal_gc_root(&root, &name, 1);
    bool ok = http_call_method(vm, receiver, "emit", &name, 1);
    mal_gc_unroot(&root);
    return ok;
}

static bool http_emit_error(MalVm *vm, MalValue receiver, MalValue error) {
    MalValue args[] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "error")), error,
    };
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    bool ok = http_call_method(vm, receiver, "emit", args, 2);
    mal_gc_unroot(&root);
    return ok;
}

static bool http_once(
    MalVm *vm, MalValue receiver, const char *event, MalValue callback) {
    MalValue args[] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event)), callback,
    };
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    bool ok = http_call_method(vm, receiver, "once", args, 2);
    mal_gc_unroot(&root);
    return ok;
}

static void http_native_close_complete(void *data) {
    MalNodeHttpServerState *state = data;
    state->native = nullptr;
    state->close_ready = true;
}

static void http_define(
    MalVm *vm, MalValue receiver, const char *name, MalValue value) {
    mal_object_set(
        mal_value_to_object(receiver),
        mal_intrinsic_string_key(vm, (const byte *) name), value);
}

static void http_define_own(
    MalVm *vm, MalValue receiver, const char *name, MalValue value) {
    MalPropertyDesc desc = {
        .flags = HTTP_VISIBLE,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(
        mal_value_to_object(receiver),
        mal_intrinsic_string_key(vm, (const byte *) name), &desc);
}

static MalValue http_ascii_value(MalVm *vm, const char *bytes, usize length) {
    return mal_value_from_string(
        mal_string_new_ascii(&vm->heap, (const byte *) bytes, length));
}

typedef struct HttpCommonName {
    const char *name;
    u8 length;
} HttpCommonName;

#define HTTP_COMMON_NAME(literal) {literal, sizeof(literal) - 1}

/* Header names most peers send. Matching the wire bytes reuses one cached atom per name
 * instead of allocating a lowercase copy that property-key conversion then atomizes. */
static const HttpCommonName http_common_header_names[] = {
    HTTP_COMMON_NAME("host"), HTTP_COMMON_NAME("user-agent"), HTTP_COMMON_NAME("accept"),
    HTTP_COMMON_NAME("accept-encoding"), HTTP_COMMON_NAME("accept-language"),
    HTTP_COMMON_NAME("connection"), HTTP_COMMON_NAME("keep-alive"),
    HTTP_COMMON_NAME("content-type"), HTTP_COMMON_NAME("content-length"),
    HTTP_COMMON_NAME("content-encoding"), HTTP_COMMON_NAME("transfer-encoding"),
    HTTP_COMMON_NAME("cookie"), HTTP_COMMON_NAME("set-cookie"),
    HTTP_COMMON_NAME("cache-control"), HTTP_COMMON_NAME("origin"),
    HTTP_COMMON_NAME("referer"), HTTP_COMMON_NAME("authorization"),
    HTTP_COMMON_NAME("if-none-match"), HTTP_COMMON_NAME("if-modified-since"),
    HTTP_COMMON_NAME("date"), HTTP_COMMON_NAME("server"), HTTP_COMMON_NAME("etag"),
    HTTP_COMMON_NAME("last-modified"), HTTP_COMMON_NAME("location"),
    HTTP_COMMON_NAME("vary"), HTTP_COMMON_NAME("x-forwarded-for"),
};

static const HttpCommonName http_common_methods[] = {
    HTTP_COMMON_NAME("GET"), HTTP_COMMON_NAME("POST"), HTTP_COMMON_NAME("PUT"),
    HTTP_COMMON_NAME("DELETE"), HTTP_COMMON_NAME("HEAD"), HTTP_COMMON_NAME("PATCH"),
    HTTP_COMMON_NAME("OPTIONS"),
};

/** The lowercase common name equal to `bytes` ignoring ASCII case, or nullptr. */
static const char *http_common_header_name(
    const char *bytes, usize length, bool *wire_lowercase) {
    for (usize i = 0; i < countof(http_common_header_names); i++) {
        const HttpCommonName *candidate = &http_common_header_names[i];
        if (candidate->length != length) continue;
        bool lowercase = true;
        usize j = 0;
        for (; j < length; j++) {
            char unit = bytes[j];
            if (unit == candidate->name[j]) continue;
            if ((char) mal_ascii_to_lower((u8) unit) != candidate->name[j]) break;
            lowercase = false;
        }
        if (j == length) {
            *wire_lowercase = lowercase;
            return candidate->name;
        }
    }
    return nullptr;
}

/** Atomized lowercase and raw-case names for one incoming header field. */
static void http_incoming_header_names(
    MalVm *vm, const char *bytes, usize length, MalValue *lower_out, MalValue *raw_out) {
    bool wire_lowercase = false;
    const char *common = http_common_header_name(bytes, length, &wire_lowercase);
    MalValue atom = common == nullptr ? mal_value_new_undefined()
        : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) common));
    if (lower_out != nullptr) {
        *lower_out = common != nullptr ? atom
            : mal_value_from_string(mal_headers_new_lowercase_name(vm, bytes, length));
    }
    if (raw_out != nullptr) {
        *raw_out = common != nullptr && wire_lowercase ? atom
            : http_ascii_value(vm, bytes, length);
    }
}

static MalValue http_method_value(MalVm *vm, const char *bytes, usize length) {
    for (usize i = 0; i < countof(http_common_methods); i++) {
        if (http_common_methods[i].length == length &&
            memcmp(http_common_methods[i].name, bytes, length) == 0) {
            return mal_value_from_string(
                mal_intrinsic_ascii(vm, (const byte *) http_common_methods[i].name));
        }
    }
    return http_ascii_value(vm, bytes, length);
}

static bool http_native_is(MalValue value, MalNativeFunctionCallback callback) {
    return mal_value_is_native_function_object(value)
        && mal_value_to_native_function_object(value)->callback == callback;
}

static void http_throw_headers_sent(MalVm *vm, const char *action) {
    char message[64];
    snprintf(message, sizeof message,
             "Cannot %s headers after they are sent to the client", action);
    mal_node_throw_code(
        vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "ERR_HTTP_HEADERS_SENT");
}

static MalValue http_socket_address(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    if (!mal_value_is_native_function_object(callee)) {
        return mal_value_new_undefined();
    }
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1),
        mal_native_function_object_get_slot(function, 2),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    http_define_own(vm, roots[3], "address", roots[0]);
    http_define_own(vm, roots[3], "family", roots[1]);
    http_define_own(vm, roots[3], "port", roots[2]);
    MalValue result = roots[3];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_endpoint_family(MalVm *vm, MalNetAddressFamily family) {
    const char *name = family == MAL_NET_ADDRESS_IPV4
        ? "IPv4" : family == MAL_NET_ADDRESS_IPV6 ? "IPv6" : nullptr;
    return name == nullptr
        ? mal_value_new_undefined()
        : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name));
}

static void http_socket_unqueue_secure(MalNodeHttpSocketState *state) {
    MalNodeHttpServerState *server = state->secure_server;
    if (server == nullptr) return;
    MalNodeHttpSocketState *previous = nullptr;
    for (MalNodeHttpSocketState *at = server->secure_head; at != nullptr; at = at->secure_next) {
        if (at == state) {
            if (previous == nullptr) server->secure_head = at->secure_next;
            else previous->secure_next = at->secure_next;
            if (server->secure_tail == at) server->secure_tail = previous;
            break;
        }
        previous = at;
    }
    state->secure_server = nullptr;
    state->secure_next = nullptr;
}

static void http_socket_unqueue_hello(MalNodeHttpSocketState *state) {
    MalNodeHttpServerState *server = state->hello_server;
    if (server != nullptr) {
        MalNodeHttpSocketState *previous = nullptr;
        for (MalNodeHttpSocketState *at = server->hello_head; at != nullptr; at = at->hello_next) {
            if (at == state) {
                if (previous == nullptr) server->hello_head = at->hello_next;
                else previous->hello_next = at->hello_next;
                if (server->hello_tail == at) server->hello_tail = previous;
                break;
            }
            previous = at;
        }
    }
    state->hello_server = nullptr;
    state->hello_next = nullptr;
}

static void http_socket_release(void *data) {
    MalNodeHttpSocketState *state = data;
    http_socket_unqueue_secure(state);
    http_socket_unqueue_hello(state);
    free(state->hello_name);
    if (state->previous == nullptr) http_sockets = state->next;
    else state->previous->next = state->next;
    if (state->next != nullptr) state->next->previous = state->previous;
    MAL_PERF_COUNT(http_socket_context_releases);
    free(state);
}

static MalValue http_server_socket_facade(MalVm *vm, MalHttpConn *conn) {
    MalNodeHttpSocketState *state = mal_http_conn_context(conn);
    if (state != nullptr && !mal_value_is_undefined(state->receiver)) {
        MAL_PERF_COUNT(http_socket_context_reuses);
        return state->receiver;
    }
    MalNetEndpoint local_endpoint;
    MalNetEndpoint remote_endpoint;
    bool have_local = mal_http_conn_local_endpoint(conn, &local_endpoint);
    bool have_remote = mal_http_conn_remote_endpoint(conn, &remote_endpoint);
    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]);
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    if (have_local) {
        roots[2] = http_ascii_value(vm, local_endpoint.address,
            strlen(local_endpoint.address));
        roots[3] = http_endpoint_family(vm, local_endpoint.family);
    }
    if (have_remote) {
        roots[4] = http_ascii_value(vm, remote_endpoint.address,
            strlen(remote_endpoint.address));
        roots[5] = http_endpoint_family(vm, remote_endpoint.family);
    }
    MalValue address_slots[] = {
        roots[2], roots[3], have_local
            ? mal_value_from_i32(local_endpoint.port) : mal_value_new_undefined(),
    };
    roots[6] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "address"),
            http_socket_address, address_slots, countof(address_slots)));
    if (vm->node_http_socket_append_plan.source == nullptr) {
        static const char *names[] = {
            "_events", "_eventsCount", "_maxListeners",
            "encrypted", "readable", "writable",
            "remoteAddress", "remotePort", "remoteFamily",
            "localAddress", "localPort", "localFamily", "address",
        };
        MalShape *source = mal_shape_root(&vm->heap);
        MalShape *shape = source;
        for (usize i = 0; i < countof(names); i++) {
            shape = mal_shape_add_property(
                shape, mal_intrinsic_string_key(vm, (const byte *) names[i]),
                HTTP_VISIBLE);
        }
        (void) mal_object_append_plan_init(
            &vm->node_http_socket_append_plan, source, shape,
            (u32) countof(names));
    }
    MalValue values[] = {
        roots[1], mal_value_from_i32(0), mal_value_new_undefined(),
        mal_value_new_boolean(mal_http_conn_is_tls(conn)), mal_value_new_boolean(true),
        mal_value_new_boolean(true), roots[4],
        have_remote ? mal_value_from_i32(remote_endpoint.port)
                    : mal_value_new_undefined(),
        roots[5], roots[2],
        have_local ? mal_value_from_i32(local_endpoint.port)
                   : mal_value_new_undefined(),
        roots[3], roots[6],
    };
    if (mal_object_try_append_shaped_values(
            mal_value_to_object(roots[0]), &vm->node_http_socket_append_plan,
            values, (u32) countof(values))) {
        MAL_PERF_COUNT(http_bulk_shaped_objects);
        MAL_PERF_ADD(http_bulk_shaped_slots, countof(values));
        MAL_PERF_ADD(http_property_definitions_avoided, countof(values));
        MAL_PERF_ADD(http_shape_transitions_avoided, countof(values));
    } else {
        http_define_own(vm, roots[0], "_events", values[0]);
        http_define_own(vm, roots[0], "_eventsCount", values[1]);
        http_define_own(vm, roots[0], "_maxListeners", values[2]);
        http_define_own(vm, roots[0], "encrypted", values[3]);
        http_define_own(vm, roots[0], "readable", values[4]);
        http_define_own(vm, roots[0], "writable", values[5]);
        http_define_own(vm, roots[0], "remoteAddress", values[6]);
        http_define_own(vm, roots[0], "remotePort", values[7]);
        http_define_own(vm, roots[0], "remoteFamily", values[8]);
        http_define_own(vm, roots[0], "localAddress", values[9]);
        http_define_own(vm, roots[0], "localPort", values[10]);
        http_define_own(vm, roots[0], "localFamily", values[11]);
        http_define_own(vm, roots[0], "address", values[12]);
    }
    if (state != nullptr) {
        state->receiver = roots[0];
    } else if (conn != nullptr) {
        state = malloc(sizeof(*state));
        if (state == nullptr) {
            mal_gc_unroot(&root);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        *state = (MalNodeHttpSocketState) {
            .vm = vm, .receiver = roots[0], .conn = conn, .next = http_sockets,
        };
        if (!mal_http_conn_attach_context(conn, state, http_socket_release)) {
            free(state);
            mal_gc_unroot(&root);
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                               "Failed to initialize HTTP connection");
            return mal_value_new_undefined();
        }
        if (http_sockets != nullptr) http_sockets->previous = state;
        http_sockets = state;
        MAL_PERF_COUNT(http_socket_context_creations);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static void http_incoming_message_dispatch_shapes(MalVm *vm) {
    if (vm->node_http_incoming_message_dispatch_append_plan.source != nullptr) return;

    static const char *source_names[] = {
        "_events", "_eventsCount", "_maxListeners", "destroyed", "_malStreamKind",
        "_readableState", "_malReadableQueue", "_malBlockedPipes",
        "_malReadableIndex", "_malFlowing", "_malPaused", "_malReading",
        "_malReadScheduled", "readable", "readableEnded",
    };
    static const char *dispatch_names[] = {
        "method", "url", "headers", "rawHeaders", "httpVersion",
        "httpVersionMajor", "httpVersionMinor", "complete", "aborted", "upgrade",
        "trailers", "rawTrailers", "socket", "connection",
    };
    static_assert(countof(source_names) + countof(dispatch_names)
                      <= MAL_SHAPE_MAX_INLINE_SLOTS,
                  "IncomingMessage dispatch shape exceeds inline slots");
    MalShape *root = mal_shape_root(&vm->heap);
    MalShape *shape = root;
    for (usize i = 0; i < countof(source_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) source_names[i]),
            HTTP_VISIBLE);
    }
    MalShape *source = shape;
    for (usize i = 0; i < countof(dispatch_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) dispatch_names[i]),
            HTTP_VISIBLE);
    }
    MalShape *final = shape;
    MalShapeAppendPlan source_plan = {0};
    MalShapeAppendPlan dispatch_plan = {0};
    (void) mal_object_append_plan_init(
        &source_plan, root, source, (u32) countof(source_names));
    (void) mal_object_append_plan_init(
        &dispatch_plan, source, final, (u32) countof(dispatch_names));
    vm->node_http_incoming_message_source_append_plan = source_plan;
    vm->node_http_incoming_message_dispatch_append_plan = dispatch_plan;
}

static void http_server_response_shapes(MalVm *vm) {
    if (vm->node_http_server_response_dispatch_append_plan.source != nullptr) return;

    static const char *parent_names[] = {
        "_events", "_eventsCount", "_maxListeners", "destroyed", "_malStreamKind",
    };
    static const char *constructor_names[] = {
        "statusCode", "statusMessage", "headersSent", "_header", "finished",
        "writableEnded", "writableFinished",
    };
    static const char *dispatch_names[] = {"socket", "connection"};
    static_assert(countof(parent_names) + countof(constructor_names)
                      + countof(dispatch_names) <= MAL_SHAPE_MAX_INLINE_SLOTS,
                   "ServerResponse dispatch shape exceeds inline slots");
    MalShape *root = mal_shape_root(&vm->heap);
    MalShape *shape = root;
    for (usize i = 0; i < countof(parent_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) parent_names[i]),
            HTTP_VISIBLE);
    }
    MalShape *parent = shape;
    for (usize i = 0; i < countof(constructor_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) constructor_names[i]),
            HTTP_VISIBLE);
    }
    MalShape *constructor = shape;
    for (usize i = 0; i < countof(dispatch_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) dispatch_names[i]),
            HTTP_VISIBLE);
    }
    MalShape *dispatch = shape;
    MalShapeAppendPlan root_plan = {0};
    MalShapeAppendPlan constructor_plan = {0};
    MalShapeAppendPlan dispatch_plan = {0};
    (void) mal_object_append_plan_init(
        &root_plan, root, constructor,
        (u32) (countof(parent_names) + countof(constructor_names)));
    (void) mal_object_append_plan_init(
        &constructor_plan, parent, constructor,
        (u32) countof(constructor_names));
    (void) mal_object_append_plan_init(
        &dispatch_plan, constructor, dispatch, (u32) countof(dispatch_names));
    vm->node_http_server_response_root_append_plan = root_plan;
    vm->node_http_server_response_constructor_append_plan = constructor_plan;
    vm->node_http_server_response_dispatch_append_plan = dispatch_plan;
}

static void http_initialize_shaped_object(
    MalVm *vm, MalValue object, const MalShapeAppendPlan *plan,
    const char *const *names, const MalValue *values, usize count) {
    if (mal_object_try_append_shaped_values(
            mal_value_to_object(object), plan, values, (u32) count)) {
        MAL_PERF_COUNT(http_bulk_shaped_objects);
        MAL_PERF_ADD(http_bulk_shaped_slots, count);
        MAL_PERF_ADD(http_property_definitions_avoided, count);
        MAL_PERF_ADD(http_shape_transitions_avoided, count);
        return;
    }
    for (usize i = 0; i < count; i++) {
        http_define_own(vm, object, names[i], values[i]);
    }
}

static const MalShapeAppendPlan *http_readable_state_append_plan(MalVm *vm) {
    if (vm->node_http_readable_state_append_plan.source != nullptr) {
        return &vm->node_http_readable_state_append_plan;
    }
    static const char *names[] = {
        "encoding", "decoder", "ended", "endEmitted", "destroyed",
        "objectMode", "highWaterMark", "reading",
    };
    MalShape *source = mal_shape_root(&vm->heap);
    MalShape *shape = source;
    for (usize i = 0; i < countof(names); i++) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) names[i]),
            HTTP_VISIBLE);
    }
    (void) mal_object_append_plan_init(
        &vm->node_http_readable_state_append_plan, source, shape,
        (u32) countof(names));
    return &vm->node_http_readable_state_append_plan;
}

static usize http_object_property_count(const MalObject *object) {
    return (usize) object->shape->inline_count
        + (mal_object_overflow(object) == nullptr ? 0 : mal_table_size(mal_object_overflow(object)));
}

static bool http_prototype_shape_matches(
    MalValue value, MalShape *shape, usize property_count) {
    return mal_value_is_object(value) && mal_value_to_object(value)->shape == shape
        && http_object_property_count(mal_value_to_object(value)) == property_count;
}

static bool http_can_construct_canonical(
    MalVm *vm, MalValue prototype_value, bool readable) {
    MalValue object_prototype = vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue event_prototype =
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE];
    MalValue stream_prototype = vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE];
    MalValue readable_prototype =
        vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE];
    MalValue expected = readable
        ? vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_PROTOTYPE]
        : vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_PROTOTYPE];
    if (!mal_value_is_object(prototype_value)
        || mal_value_to_object(prototype_value) != mal_value_to_object(expected)
        || !http_prototype_shape_matches(
            object_prototype, vm->node_http_object_prototype_shape,
            vm->node_http_object_prototype_properties)
        || !http_prototype_shape_matches(
            event_prototype, vm->node_http_event_emitter_prototype_shape,
            vm->node_http_event_emitter_prototype_properties)
        || !http_prototype_shape_matches(
            stream_prototype, vm->node_http_stream_prototype_shape,
            vm->node_http_stream_prototype_properties)
        || !http_prototype_shape_matches(
            expected, readable
                ? vm->node_http_incoming_message_prototype_shape
                : vm->node_http_server_response_prototype_shape,
            readable
                ? vm->node_http_incoming_message_prototype_properties
                : vm->node_http_server_response_prototype_properties)) {
        return false;
    }
    MalObject *object = mal_value_to_object(object_prototype);
    MalObject *events = mal_value_to_object(event_prototype);
    MalObject *stream = mal_value_to_object(stream_prototype);
    MalObject *prototype = mal_value_to_object(expected);
    if (mal_object_get_prototype(events) != object
        || mal_object_get_prototype(stream) != events) {
        return false;
    }
    if (!readable) {
        MalObject *outgoing = mal_object_get_prototype(prototype);
        return outgoing != nullptr
            && http_prototype_shape_matches(mal_value_from_object(outgoing),
                http_outgoing_prototype_shape, http_outgoing_prototype_properties)
            && mal_object_get_prototype(outgoing) == stream;
    }
    if (!http_prototype_shape_matches(
            readable_prototype, vm->node_http_readable_prototype_shape,
            vm->node_http_readable_prototype_properties)) {
        return false;
    }
    MalObject *readable_object = mal_value_to_object(readable_prototype);
    return mal_object_get_prototype(prototype) == readable_object
        && mal_object_get_prototype(readable_object) == stream;
}

/* Requests and responses carry the runtime's stream and dispatch fields plus what
 * frameworks add per request (Express sets about fifteen on each request), and
 * an emitter's _events holds a handful of event names. Reserving that up front
 * replaces a chain of slot migrations per request with one allocation. */
enum {
    HTTP_INCOMING_MESSAGE_SLOTS = 48,
    HTTP_SERVER_RESPONSE_SLOTS = 32,
    HTTP_EVENTS_SLOTS = 8,
};

static MalValue http_new_incoming_message(MalVm *vm) {
    MalValue constructor =
        vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR];
    MalValue prototype_value = mal_vm_function_prototype(
        vm, constructor);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    if (!http_can_construct_canonical(vm, prototype_value, true)) {
        return mal_vm_construct_value(vm, constructor, nullptr, 0).value;
    }
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_object(
        mal_object_new_reserved(&vm->heap, prototype, HTTP_INCOMING_MESSAGE_SLOTS));
    roots[1] = mal_value_from_object(
        mal_object_new_reserved(&vm->heap, nullptr, HTTP_EVENTS_SLOTS));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    roots[4] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));

    static const char *state_names[] = {
        "encoding", "decoder", "ended", "endEmitted", "destroyed",
        "objectMode", "highWaterMark", "reading",
    };
    MalValue state_values[] = {
        mal_value_new_null(), mal_value_new_null(), mal_value_new_boolean(false),
        mal_value_new_boolean(false), mal_value_new_boolean(false),
        mal_value_new_boolean(false), mal_value_from_i32(16384),
        mal_value_new_boolean(false),
    };
    http_initialize_shaped_object(
        vm, roots[2], http_readable_state_append_plan(vm),
        state_names, state_values, countof(state_values));

    http_incoming_message_dispatch_shapes(vm);
    static const char *request_names[] = {
        "_events", "_eventsCount", "_maxListeners", "destroyed", "_malStreamKind",
        "_readableState", "_malReadableQueue", "_malBlockedPipes",
        "_malReadableIndex", "_malFlowing", "_malPaused", "_malReading",
        "_malReadScheduled", "readable", "readableEnded",
    };
    MalValue request_values[] = {
        roots[1], mal_value_from_i32(0), mal_value_new_undefined(),
        mal_value_new_boolean(false), mal_value_from_i32(STREAM_READABLE),
        roots[2], roots[3], roots[4], mal_value_from_i32(0),
        mal_value_new_boolean(false), mal_value_new_boolean(true),
        mal_value_new_boolean(false), mal_value_new_boolean(false),
        mal_value_new_boolean(true), mal_value_new_boolean(false),
    };
    http_initialize_shaped_object(
        vm, roots[0], &vm->node_http_incoming_message_source_append_plan,
        request_names, request_values, countof(request_values));
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_new_server_response(MalVm *vm) {
    MalValue constructor =
        vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_CONSTRUCTOR];
    MalValue prototype_value = mal_vm_function_prototype(
        vm, constructor);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    if (!http_can_construct_canonical(vm, prototype_value, false)) {
        return mal_vm_construct_value(vm, constructor, nullptr, 0).value;
    }
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_object(
        mal_object_new_reserved(&vm->heap, prototype, HTTP_SERVER_RESPONSE_SLOTS));
    roots[1] = mal_value_from_object(
        mal_object_new_reserved(&vm->heap, nullptr, HTTP_EVENTS_SLOTS));
    http_server_response_shapes(vm);
    static const char *names[] = {
        "_events", "_eventsCount", "_maxListeners", "destroyed", "_malStreamKind",
        "statusCode", "statusMessage", "headersSent", "_header", "finished",
        "writableEnded", "writableFinished",
    };
    MalValue values[] = {
        roots[1], mal_value_from_i32(0), mal_value_new_undefined(),
        mal_value_new_boolean(false), mal_value_from_i32(STREAM_LEGACY),
        mal_value_from_i32(200), mal_value_new_undefined(),
        mal_value_new_boolean(false), mal_value_new_null(),
        mal_value_new_boolean(false), mal_value_new_boolean(false),
        mal_value_new_boolean(false),
    };
    http_initialize_shaped_object(
        vm, roots[0], &vm->node_http_server_response_root_append_plan,
        names, values, countof(values));
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

// RFC 9110 tchar: visible ASCII without the separators ()<>@,;:\\"/[]?={}.
static inline bool http_token_unit(c16 unit) {
    static const u64 token_bits[2] = {0x03ff6cfa00000000ull, 0x57ffffffc7fffffeull};
    return unit < 128 && ((token_bits[unit >> 6] >> (unit & 63)) & 1) != 0;
}

static bool http_response_name(
    MalVm *vm, MalValue value, char **out, usize *out_length) {
    if (!mal_value_is_string(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Header name must be a valid HTTP token");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    if (length == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Header name must not be empty");
        return false;
    }
    char *name = malloc(length + 1);
    if (name == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        bool valid = http_token_unit(unit);
        if (!valid) {
            free(name);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Invalid HTTP header name");
            return false;
        }
        name[i] = unit >= 'A' && unit <= 'Z' ? (char) (unit + 0x20) : (char) unit;
    }
    name[length] = '\0';
    *out = name;
    *out_length = length;
    return true;
}

static bool http_response_name_view(
    MalVm *vm, MalValue value, MalNodeHttpResponseNameView *out) {
    MAL_PERF_COUNT(http_response_header_name_coercions);
    if (!mal_value_is_string(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Header name must be a valid HTTP token");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    if (length == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Header name must not be empty");
        return false;
    }
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        bool valid = http_token_unit(unit);
        if (!valid) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Invalid HTTP header name");
            return false;
        }
    }
    out->units = units;
    out->length = length;
    return true;
}

static bool http_header_value_segment_scan(const MalStringSegment *segment, byte **bytes) {
    if (segment->latin1) {
        const u8 *units = segment->latin1_units;
        for (usize i = 0; i < segment->length; i++) {
            if (units[i] != '\t' && (units[i] < 0x20 || units[i] == 0x7f)) return false;
        }
        if (*bytes != nullptr && segment->length > 0) {
            memcpy(*bytes, units, segment->length);
            *bytes += segment->length;
        }
        return true;
    }
    for (usize i = 0; i < segment->length; i++) {
        c16 unit = segment->utf16_units[i];
        if (unit != '\t' && (unit < 0x20 || unit == 0x7f || unit > 0xff)) return false;
        if (*bytes != nullptr) *(*bytes)++ = (byte) unit;
    }
    return true;
}

/* Checks a header value segment by segment, copying its bytes when `bytes` is
 * non-null, so neither a concatenation is flattened nor Latin-1 widened. A flat
 * value, nearly every one, is a single segment and needs no iterator. */
static bool http_header_value_scan(const MalString *string, byte *bytes) {
    MalStringSegment segment;
    usize length = mal_string_length(string);
    if (mal_string_try_get_segment(string, 0, length, &segment)) {
        return http_header_value_segment_scan(&segment, &bytes);
    }
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, string, 0, length);
    bool valid = true;
    while (valid && mal_string_iterator_next(&iterator, &segment)) {
        valid = http_header_value_segment_scan(&segment, &bytes);
    }
    mal_string_iterator_dispose(&iterator);
    return valid;
}

static bool http_header_value_valid(MalVm *vm, MalValue value) {
    if (mal_value_is_array_object(value)) {
        MalArrayObject *array = mal_value_to_array_object(value);
        for (u32 i = 0; i < mal_array_object_length(array); i++) {
            MalValue element = mal_value_new_undefined();
            MalRootSpan root;
            mal_gc_root(&root, &element, 1);
            bool valid = mal_vm_get_property(vm, value, mal_key_index(i), &element)
                && http_header_value_valid(vm, element);
            mal_gc_unroot(&root);
            if (!valid) {
                return false;
            }
        }
        return true;
    }
    if (mal_value_is_undefined(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid value for HTTP header");
        return false;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    if (!http_header_value_scan(string, nullptr)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid character in HTTP header value");
        return false;
    }
    return true;
}

static bool http_header_value_bytes(
    MalVm *vm, MalValue value, byte **out, usize *out_length) {
    if (mal_value_is_undefined(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid value for HTTP header");
        return false;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    usize length = mal_string_length(string);
    byte *bytes = malloc(length + 1);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    if (!http_header_value_scan(string, bytes)) {
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid character in HTTP header value");
        return false;
    }
    bytes[length] = '\0';
    *out = bytes;
    *out_length = length;
    return true;
}

static MalValue http_validate_header_name(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalNodeHttpResponseNameView name;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!http_response_name_view(vm, value, &name)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

// lib/_http_common.js checkIsHttpToken.
static MalValue http_is_valid_header_name(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) new_target, (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) return mal_value_new_boolean(false);
    MalString *string = mal_value_to_string(args[0]);
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    if (length == 0) return mal_value_new_boolean(false);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        bool valid = (unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z')
            || (unit >= '0' && unit <= '9') || (unit < 0x80 && strchr("!#$%&'*+-.^_`|~", (int) unit) != nullptr && unit != 0);
        if (!valid) return mal_value_new_boolean(false);
    }
    return mal_value_new_boolean(true);
}

// lib/_http_outgoing.js isValidHeaderValue: strict admits HTAB, 0x20-0x7e and 0x80-0xff;
// relaxed rejects only NUL, CR, LF and code units above 0xff.
static MalValue http_is_valid_header_value(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    bool lenient = false;
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        MalValue options = args[1];
        if (!mal_value_is_object(options) || mal_value_is_callable(options) || mal_value_is_array_object(options)) {
            char received[320];
            mal_node_describe_received(vm, options, received, sizeof received);
            char message[400];
            snprintf(message, sizeof message, "The \"options\" argument must be of type object. %s", received);
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
            return mal_value_new_undefined();
        }
        MalValue validation = mal_value_new_undefined();
        MalRootSpan root;
        mal_gc_root(&root, &validation, 1);
        bool ok = mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "httpValidation"), &validation);
        if (ok && mal_value_is_string(validation) && mal_string_equals_ascii(mal_value_to_string(validation), "relaxed")) {
            lenient = true;
        } else if (ok && !mal_value_is_undefined(validation)
            && !(mal_value_is_string(validation) && mal_string_equals_ascii(mal_value_to_string(validation), "strict"))) {
            char shown[256] = "";
            if (mal_value_is_string(validation)) {
                usize length = 0;
                byte *text = mal_string_to_utf8(mal_value_to_string(validation), &length);
                snprintf(shown, sizeof shown, "'%.*s'", text == nullptr ? 0 : (int) length, text == nullptr ? "" : (const char *) text);
                free(text);
            } else {
                mal_node_describe_received(vm, validation, shown, sizeof shown);
            }
            char message[400];
            snprintf(message, sizeof message,
                "The property 'options.httpValidation' must be one of: 'strict', 'relaxed'. Received %s",
                strncmp(shown, "Received ", 9) == 0 ? shown + 9 : shown);
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
            ok = false;
        }
        mal_gc_unroot(&root);
        if (!ok) return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(value) || mal_value_is_symbol(value)) return mal_value_new_boolean(false);
    MalString *string = mal_value_is_string(value) ? mal_value_to_string(value) : mal_ops_to_string(&vm->heap, value);
    if (string == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        bool valid = lenient ? unit != 0 && unit != '\r' && unit != '\n' && unit <= 0xff
            : unit == '\t' || (unit >= 0x20 && unit <= 0x7e) || (unit >= 0x80 && unit <= 0xff);
        if (!valid) return mal_value_new_boolean(false);
    }
    return mal_value_new_boolean(true);
}

// Node's OutgoingMessage, which also accepts the `OutgoingMessage.call(this)` subclass idiom.
static MalValue http_outgoing_message_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args, (void) argc;
    MalValue roots[] = {receiver};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(new_target) || !mal_value_is_object(roots[0])) {
        MalValue prototype = mal_vm_function_prototype(vm, mal_value_is_undefined(new_target) ? callee : new_target);
        roots[0] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_is_object(prototype)
            ? mal_value_to_object(prototype)
            : mal_value_to_object(mal_vm_function_prototype(vm, callee))));
    }
    MalCompletion initialized = mal_vm_call_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR], roots[0], nullptr, 0);
    if (initialized.kind != MAL_COMPLETION_THROW) {
        http_define_own(vm, roots[0], "writable", mal_value_new_boolean(true));
        http_define_own(vm, roots[0], "destroyed", mal_value_new_boolean(false));
        http_define_own(vm, roots[0], "finished", mal_value_new_boolean(false));
    }
    MalValue result = mal_value_is_undefined(new_target) && mal_value_is_object(receiver)
        ? mal_value_new_undefined() : roots[0];
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue http_validate_header_value(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalNodeHttpResponseNameView name;
    MalValue name_value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!http_response_name_view(vm, name_value, &name)
        || !http_header_value_valid(
            vm, argc > 1 ? args[1] : mal_value_new_undefined())) {
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static char *http_response_name_materialize(
    MalVm *vm, const MalNodeHttpResponseNameView *view) {
    char *name = malloc(view->length + 1);
    if (name == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    for (usize i = 0; i < view->length; i++) {
        name[i] = (char) mal_ascii_to_lower(view->units[i]);
    }
    name[view->length] = '\0';
    MAL_PERF_COUNT(http_response_header_name_materializations);
    return name;
}

static i64 http_response_header_byte_index(
    const MalNodeHttpRequestState *state, const char *name, usize length) {
    for (usize i = 0; i < state->response_header_count; i++) {
        if (state->response_headers[i].name_len == length
            && memcmp(state->response_headers[i].name, name, length) == 0) {
            return (i64) i;
        }
    }
    return -1;
}

static i64 http_response_header_view_index(
    const MalNodeHttpRequestState *state,
    const MalNodeHttpResponseNameView *view) {
    for (usize i = 0; i < state->response_header_count; i++) {
        const MalNodeHttpResponseHeader *header = &state->response_headers[i];
        if (header->name_len != view->length) continue;
        bool equal = true;
        for (usize j = 0; j < view->length; j++) {
            if ((c16) (u8) header->name[j]
                != mal_ascii_to_lower(view->units[j])) {
                equal = false;
                break;
            }
        }
        if (equal) return (i64) i;
    }
    return -1;
}

static bool http_response_headers_reserve(
    MalNodeHttpRequestState *state, usize required) {
    if (required > MAL_NODE_HTTP_MAX_RESPONSE_HEADERS) return false;
    if (required <= state->response_header_capacity) return true;
    usize capacity = state->response_header_capacity * 2;
    while (capacity < required) capacity *= 2;
    if (capacity > MAL_NODE_HTTP_MAX_RESPONSE_HEADERS) capacity = MAL_NODE_HTTP_MAX_RESPONSE_HEADERS;
    MalNodeHttpResponseHeader *headers;
    if (state->response_headers == state->inline_response_headers) {
        headers = malloc(capacity * sizeof(*headers));
        if (headers != nullptr) {
            memcpy(headers, state->inline_response_headers,
                   state->response_header_count * sizeof(*headers));
        }
    } else {
        headers = realloc(
            state->response_headers, capacity * sizeof(*headers));
    }
    if (headers == nullptr) return false;
    state->response_headers = headers;
    state->response_header_capacity = capacity;
    MAL_PERF_COUNT(http_response_header_spills);
    return true;
}

/* Node's ERR_HTTP_HEADERS_SENT once the head is committed. A response without a live
 * exchange, or one serializing its head right now, rejects changes as well. */
static bool http_response_headers_mutable(
    MalVm *vm, MalNodeHttpRequestState *state, const char *action) {
    if (state != nullptr && state->head_committed) {
        http_throw_headers_sent(vm, action);
        return false;
    }
    if (state == nullptr || state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ServerResponse is not writable");
        return false;
    }
    return true;
}

// appendHeader's value list: one level of each array, in order.
static MalValue http_header_values_concat(MalVm *vm, MalValue first, MalValue second) {
    MalValue parts[] = {first, second};
    MalRootSpan root;
    mal_gc_root(&root, parts, countof(parts));
    u64 count = 0;
    for (usize i = 0; i < countof(parts); i++) {
        count += mal_value_is_array_object(parts[i])
            ? mal_array_object_length(mal_value_to_array_object(parts[i])) : 1;
    }
    if (count > INT32_MAX) {
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalArrayObject *combined = mal_intrinsic_new_dense_array(vm, (u32) count);
    u32 index = 0;
    for (usize i = 0; i < countof(parts); i++) {
        if (!mal_value_is_array_object(parts[i])) {
            mal_array_object_store(combined, mal_key_index(index++), parts[i]);
            continue;
        }
        MalArrayObject *array = mal_value_to_array_object(parts[i]);
        for (u32 j = 0; j < mal_array_object_length(array); j++) {
            MalValue element = mal_value_new_undefined();
            (void) mal_array_object_dense_get(array, j, &element);
            mal_array_object_store(combined, mal_key_index(index++), element);
        }
    }
    mal_gc_unroot(&root);
    return mal_value_from_array_object(combined);
}

static bool http_response_store_header(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue name_value,
    MalValue value, bool append) {
    MalNodeHttpResponseNameView name;
    // Converting the value runs user code, which can commit the head meanwhile.
    if (!http_response_name_view(vm, name_value, &name)
        || !http_header_value_valid(vm, value)
        || !http_response_headers_mutable(vm, state, append ? "append" : "set")) {
        return false;
    }
    i64 index = http_response_header_view_index(state, &name);
    if (index < 0) {
        if (state->response_header_count == MAL_NODE_HTTP_MAX_RESPONSE_HEADERS) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Too many response headers");
            return false;
        }
        if (!http_response_headers_reserve(
                state, state->response_header_count + 1)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Response header allocation failed");
            return false;
        }
        char *stored_name = http_response_name_materialize(vm, &name);
        if (stored_name == nullptr) return false;
        index = (i64) state->response_header_count++;
        state->response_headers[index].name = stored_name;
        state->response_headers[index].name_len = name.length;
        MAL_PERF_COUNT(http_response_header_insertions);
        if (mal_perf_stats_enabled
            && state->response_header_count
                > mal_perf_stats.http_response_header_max_count) {
            mal_perf_stats.http_response_header_max_count =
                state->response_header_count;
        }
    } else if (append) {
        value = http_header_values_concat(
            vm, state->response_headers[index].value, value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    } else {
        MAL_PERF_COUNT(http_response_header_replacements);
        MAL_PERF_COUNT(http_response_header_allocation_free_lookups);
    }
    state->response_headers[index].value = value;
    return true;
}

static void http_response_delete_header(MalNodeHttpRequestState *state, i64 index) {
    free(state->response_headers[index].name);
    for (usize i = (usize) index + 1; i < state->response_header_count; i++) {
        state->response_headers[i - 1] = state->response_headers[i];
    }
    state->response_header_count--;
}

static MalValue http_response_set_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (!http_response_headers_mutable(vm, state, "set")) {
        return mal_value_new_undefined();
    }
    if (argc < 2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "setHeader requires a name and value");
        return mal_value_new_undefined();
    }
    if (!http_response_store_header(vm, state, args[0], args[1], false)) {
        return mal_value_new_undefined();
    }
    return receiver;
}

static MalValue http_response_get_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr || argc < 1) return mal_value_new_undefined();
    MalNodeHttpResponseNameView name;
    if (!http_response_name_view(vm, args[0], &name)) {
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_view_index(state, &name);
    MAL_PERF_COUNT(http_response_header_allocation_free_lookups);
    return index < 0 ? mal_value_new_undefined()
                     : state->response_headers[index].value;
}

static MalValue http_response_has_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    MalValue value = http_response_get_header(
        vm, receiver, args, argc, new_target, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(!mal_value_is_undefined(value));
}

static MalValue http_response_remove_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr || argc < 1) return mal_value_new_undefined();
    if (!http_response_headers_mutable(vm, state, "remove")) {
        return mal_value_new_undefined();
    }
    MalNodeHttpResponseNameView name;
    if (!http_response_name_view(vm, args[0], &name)) {
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_view_index(state, &name);
    MAL_PERF_COUNT(http_response_header_allocation_free_lookups);
    if (index >= 0) http_response_delete_header(state, index);
    return mal_value_new_undefined();
}

static MalValue http_response_get_headers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    MalValue object = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &object, 1);
    if (state != nullptr) {
        for (usize i = 0; i < state->response_header_count; i++) {
            MalValue name = http_ascii_value(
                vm, state->response_headers[i].name,
                state->response_headers[i].name_len);
            MalKey key;
            if (mal_vm_value_to_property_key(vm, name, &key)) {
                mal_object_set(
                    mal_value_to_object(object), key,
                    state->response_headers[i].value);
            }
        }
    }
    mal_gc_unroot(&root);
    return object;
}

static MalValue http_response_get_header_names(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    u32 count = state == nullptr ? 0 : (u32) state->response_header_count;
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, count);
    MalValue result = mal_value_from_array_object(array);
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (u32 i = 0; i < count; i++) {
        MalValue name = http_ascii_value(
            vm, state->response_headers[i].name,
            state->response_headers[i].name_len);
        mal_array_object_store(
            array, mal_key_index(i),
            name);
    }
    mal_gc_unroot(&root);
    return result;
}

static bool http_response_start(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue receiver,
    i64 automatic_length, bool streaming);
static bool http_response_start_implicit(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue receiver,
    i64 automatic_length, bool streaming);
static bool http_response_pump(MalNodeHttpRequestState *state);

static bool http_response_chunk_owned(
    MalVm *vm, MalValue chunk, byte **out, usize *out_length) {
    usize length;
    byte *owned;
    if (mal_value_is_string(chunk)) {
        MalString *string = mal_value_to_string(chunk);
        owned = mal_string_to_utf8(string, &length);
        if (owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
    } else if (mal_value_is_typed_array_object(chunk)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(chunk);
        if (mal_typed_array_object_is_out_of_bounds(array)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Response chunk is out of bounds");
            return false;
        }
        length = mal_typed_array_object_byte_length(array);
        owned = malloc(length == 0 ? 1 : length);
        if (owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        if (length > 0) {
            mal_typed_array_copy_bytes(owned, false, array->buffer->data + array->byte_offset,
                                       array->buffer->shared_memory != nullptr, length);
        }
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Response chunk must be a string or Buffer");
        return false;
    }
    *out = owned;
    *out_length = length;
    return true;
}

static bool http_response_enqueue(
    MalVm *vm, MalNodeHttpRequestState *state,
    byte *bytes, usize length, MalValue callback, bool end_write) {
    if (length > SIZE_MAX - state->queued_write_bytes) {
        free(bytes);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    MalNodeHttpResponseWrite *write = calloc(1, sizeof(*write));
    if (write == nullptr) {
        free(bytes);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    write->token = state->next_write_token++;
    write->bytes = bytes;
    write->length = length;
    write->callback = callback;
    write->async_context = mal_async_context_capture(vm);
    write->end_write = end_write;
    if (state->write_tail == nullptr) state->write_head = write;
    else state->write_tail->next = write;
    state->write_tail = write;
    state->queued_write_bytes += length;
    return true;
}

static void http_response_rollback_enqueue(
    MalNodeHttpRequestState *state, MalNodeHttpResponseWrite *previous_tail) {
    MalNodeHttpResponseWrite *write = state->write_tail;
    if (previous_tail == nullptr) state->write_head = nullptr;
    else previous_tail->next = nullptr;
    state->write_tail = previous_tail;
    state->queued_write_bytes -= write->length;
    free(write->bytes);
    free(write);
}

static MalValue http_response_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr && mal_value_is_object(receiver)) {
        MalValue destroyed;
        if (!mal_vm_get_property(
                vm, receiver,
                mal_intrinsic_string_key(vm, (const byte *) "destroyed"),
                &destroyed)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_boolean(destroyed) && mal_value_to_boolean(destroyed)) {
            return mal_value_new_boolean(false);
        }
    }
    if (state != nullptr && state->response_failed) {
        return mal_value_new_boolean(false);
    }
    if (state == nullptr || state->ending || state->ended
        || state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "write after end");
        return mal_value_new_undefined();
    }
    byte *bytes;
    usize length;
    if (argc < 1 || !http_response_chunk_owned(vm, args[0], &bytes, &length)) {
        return mal_value_new_undefined();
    }
    MalValue callback = argc > 1 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    MalNodeHttpResponseWrite *previous_tail = state->write_tail;
    if (!http_response_enqueue(vm, state, bytes, length, callback, false)) {
        return mal_value_new_undefined();
    }
    if (!http_response_start_implicit(vm, state, receiver, -1, true)) {
        http_response_rollback_enqueue(state, previous_tail);
        return mal_value_new_undefined();
    }
    if (!http_response_pump(state)) {
        return mal_value_new_undefined();
    }
    bool below_high_water = state->queued_write_bytes < HTTP_RESPONSE_WRITE_HIGH_WATER;
    if (!below_high_water) state->backpressured = true;
    return mal_value_new_boolean(below_high_water);
}

static const char *http_status_reason(int status) {
    for (usize i = 0; i < countof(http_statuses); i++) {
        if (http_statuses[i].code == status) return http_statuses[i].reason;
    }
    return "unknown";
}

static bool http_string_equal_ci(MalValue value, const char *ascii) {
    if (!mal_value_is_string(value)) return false;
    return mal_string_equals_ascii_ci(mal_value_to_string(value), ascii);
}

static bool http_block_reserve(
    char **block, usize *length, usize *capacity, usize count) {
    if (count > SIZE_MAX - *length) return false;
    usize required = *length + count;
    if (required > *capacity) {
        usize next = *capacity == 0 ? 256 : *capacity;
        while (next < required) {
            if (next > SIZE_MAX / 2) {
                next = required;
                break;
            }
            next *= 2;
        }
        char *grown = realloc(*block, next);
        if (grown == nullptr) return false;
        *block = grown;
        *capacity = next;
    }
    return true;
}

static bool http_block_append(
    char **block, usize *length, usize *capacity,
    const char *bytes, usize count) {
    if (!http_block_reserve(block, length, capacity, count)) return false;
    memcpy(*block + *length, bytes, count);
    *length += count;
    return true;
}

static bool http_serialize_header_line(
    MalVm *vm, char **block, usize *length, usize *capacity,
    const char *name, usize name_length, MalValue value) {
    if (mal_value_is_undefined(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid value for HTTP header");
        return false;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    usize start = *length;
    usize value_length = mal_string_length(string);
    if (!http_block_append(block, length, capacity, name, name_length) ||
        !http_block_append(block, length, capacity, ": ", 2) ||
        !http_block_reserve(block, length, capacity, value_length + 2)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    // The value's bytes go straight into the block; a rejected value leaves no line.
    if (!http_header_value_scan(string, (byte *) *block + *length)) {
        *length = start;
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid character in HTTP header value");
        return false;
    }
    *length += value_length;
    memcpy(*block + *length, "\r\n", 2);
    *length += 2;
    return true;
}

static bool http_serialize_header(
    MalVm *vm, char **block, usize *length, usize *capacity,
    const char *name, usize name_length, MalValue value) {
    if (!mal_value_is_array_object(value)) {
        return http_serialize_header_line(
            vm, block, length, capacity, name, name_length, value);
    }
    MalArrayObject *array = mal_value_to_array_object(value);
    u32 count = mal_array_object_length(array);
    if (count == 0) return true;
    bool cookie = name_length == 6 && memcmp(name, "cookie", 6) == 0;
    if (!cookie) {
        for (u32 i = 0; i < count; i++) {
            MalValue element = mal_value_new_undefined();
            MalRootSpan root;
            mal_gc_root(&root, &element, 1);
            bool serialized = mal_vm_get_property(
                    vm, value, mal_key_index(i), &element)
                && http_serialize_header_line(
                    vm, block, length, capacity, name, name_length, element);
            mal_gc_unroot(&root);
            if (!serialized) {
                return false;
            }
        }
        return true;
    }
    if (!http_block_append(block, length, capacity, name, name_length)
        || !http_block_append(block, length, capacity, ": ", 2)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (u32 i = 0; i < count; i++) {
        MalValue element = mal_value_new_undefined();
        MalRootSpan root;
        mal_gc_root(&root, &element, 1);
        byte *bytes;
        usize value_length;
        bool converted = mal_vm_get_property(
                vm, value, mal_key_index(i), &element)
            && http_header_value_bytes(vm, element, &bytes, &value_length);
        mal_gc_unroot(&root);
        if (!converted) {
            return false;
        }
        bool appended = (i == 0
                || http_block_append(block, length, capacity, "; ", 2))
            && http_block_append(
                block, length, capacity, (const char *) bytes, value_length);
        free(bytes);
        if (!appended) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
    }
    if (!http_block_append(block, length, capacity, "\r\n", 2)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    return true;
}

static bool http_response_serialize_headers(
    MalVm *vm, MalNodeHttpRequestState *state, char **out, usize *out_length) {
    char *block = nullptr;
    usize length = 0;
    usize capacity = 0;
    for (usize i = 0; i < state->response_header_count; i++) {
        MalNodeHttpResponseHeader *header = &state->response_headers[i];
        if ((header->name_len == 14
                && memcmp(header->name, "content-length", 14) == 0)
            || (header->name_len == 10
                && memcmp(header->name, "connection", 10) == 0)
            || (header->name_len == 17
                && memcmp(header->name, "transfer-encoding", 17) == 0)) {
            continue;
        }
        if (!http_serialize_header(
                vm, &block, &length, &capacity, header->name,
                header->name_len, header->value)) {
            free(block);
            return false;
        }
    }
    *out = block;
    *out_length = length;
    return true;
}

static MalNodeHttpClientState *http_client_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    MalObject *object = mal_value_to_object(receiver);
    for (MalNodeHttpClientState *state = http_clients; state != nullptr;
         state = state->next) {
        if (mal_value_to_object(state->request) == object) return state;
    }
    return nullptr;
}

static MalNodeHttpClientState *http_client_response_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    MalObject *object = mal_value_to_object(receiver);
    for (MalNodeHttpClientState *state = http_clients; state != nullptr;
         state = state->next) {
        if (!mal_value_is_undefined(state->response)
            && mal_value_to_object(state->response) == object) {
            return state;
        }
    }
    return nullptr;
}

static void http_client_free(MalNodeHttpClientState *state) {
    free(state->host);
    free(state->ca);
    free(state->cert);
    free(state->key);
    free(state->method);
    free(state->path);
    free(state->headers);
    MalNodeHttpResponseWrite *write = state->write_head;
    while (write != nullptr) {
        MalNodeHttpResponseWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    free(state);
}

static void http_cleanup(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalNodeHttpServerState **server_link = &http_servers;
    while (*server_link != nullptr) {
        MalNodeHttpServerState *state = *server_link;
        if (state->vm != vm) {
            server_link = &state->next;
            continue;
        }
        // Transport callbacks retain request/server state until every connection is closed.
        if (state->native != nullptr) {
            mal_http_server_close_connections(state->native, false);
            if (state->native != nullptr) {
                mal_http_server_close(state->native, http_native_close_complete, state);
            }
        }
        *server_link = state->next;
        free(state);
    }
    if (host != nullptr) {
        host->ready_http_requests = nullptr;
        host->ready_http_requests_tail = nullptr;
        host->pending_http_completions = 0;
    }
    MalNodeHttpRequestState *request = http_requests;
    while (request != nullptr) {
        MalNodeHttpRequestState *next = request->next;
        if (request->vm == vm) http_request_remove(request);
        request = next;
    }
    MalNodeHttpClientState **client_link = &http_clients;
    while (*client_link != nullptr) {
        MalNodeHttpClientState *state = *client_link;
        if (state->vm != vm) {
            client_link = &state->next;
            continue;
        }
        (void) mal_http_client_cancel(host, state->operation);
        *client_link = state->next;
        http_client_free(state);
    }
    // The indices are shared by VMs on this mutator; live rows keep their storage.
    if (http_response_index_count == 0) {
        free(http_response_index);
        http_response_index = nullptr;
        http_response_index_capacity = 0;
    }
    if (http_request_index_count == 0) {
        free(http_request_index);
        http_request_index = nullptr;
        http_request_index_capacity = 0;
    }
}

static bool http_client_ascii_string(
    MalVm *vm, MalValue value, char **out, usize *length) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    usize count = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    char *bytes = malloc(count + 1);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (usize i = 0; i < count; i++) {
        if (units[i] == 0 || units[i] > 0x7f) {
            free(bytes);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "HTTP URL components must be ASCII");
            return false;
        }
        bytes[i] = (char) units[i];
    }
    bytes[count] = '\0';
    *out = bytes;
    *length = count;
    return true;
}

static bool http_client_parse_url(
    MalVm *vm, MalValue value, char **protocol_out, char **host_out,
    u16 *port_out, char **path_out, usize *path_len_out) {
    char *url;
    usize url_len;
    if (!http_client_ascii_string(vm, value, &url, &url_len)) return false;
    char *separator = strstr(url, "://");
    if (separator == nullptr || separator == url) goto invalid_url;
    usize protocol_len = (usize) (separator - url) + 1;
    char *protocol = http_copy_bytes(url, protocol_len);
    if (protocol == nullptr) goto allocation;
    for (usize i = 0; i < protocol_len; i++) {
        if (protocol[i] >= 'A' && protocol[i] <= 'Z') {
            protocol[i] = (char) (protocol[i] + 0x20);
        }
    }
    char *authority = separator + 3;
    char *authority_end = authority;
    while (authority_end < url + url_len && *authority_end != '/'
           && *authority_end != '?' && *authority_end != '#') {
        authority_end++;
    }
    // The authority reaches both the resolver and the serialized `Host:` line, so a
    // control byte here would inject a header (or a whole request) into the wire.
    for (const char *cursor = authority; cursor < authority_end; cursor++) {
        unsigned char ch = (unsigned char) *cursor;
        if (ch <= 0x20 || ch == 0x7f) {
            free(protocol);
            goto invalid_authority;
        }
    }
    char *colon = memchr(authority, ':', (usize) (authority_end - authority));
    char *host_end = colon == nullptr ? authority_end : colon;
    if (host_end == authority) {
        free(protocol);
        goto invalid_url;
    }
    usize host_len = (usize) (host_end - authority);
    char *host = http_copy_bytes(authority, host_len);
    if (host == nullptr) {
        free(protocol);
        goto allocation;
    }
    for (usize i = 0; i < host_len; i++) {
        if (host[i] >= 'A' && host[i] <= 'Z') host[i] = (char) (host[i] + 0x20);
    }
    u16 port = strcmp(protocol, "https:") == 0 ? 443 : 80;
    if (colon != nullptr) {
        usize parsed = 0;
        if (colon + 1 == authority_end) {
            free(protocol);
            free(host);
            goto invalid_url;
        }
        for (char *cursor = colon + 1; cursor < authority_end; cursor++) {
            if (*cursor < '0' || *cursor > '9') {
                free(protocol);
                free(host);
                goto invalid_url;
            }
            parsed = parsed * 10 + (usize) (*cursor - '0');
            if (parsed > 65535) {
                free(protocol);
                free(host);
                goto invalid_port;
            }
        }
        port = (u16) parsed;
    }
    char *fragment = memchr(
        authority_end, '#', (usize) (url + url_len - authority_end));
    char *path_start = authority_end;
    if (path_start == url + url_len || *path_start == '#') path_start = nullptr;
    const char *path_end = fragment != nullptr ? fragment : url + url_len;
    bool query_only = path_start != nullptr && path_start[0] == '?';
    const char *path_bytes = path_start == nullptr ? "/" : path_start;
    usize path_len = path_start == nullptr ? 1 : (usize) (path_end - path_start);
    char *path = malloc(path_len + (query_only ? 2 : 1));
    if (path == nullptr) {
        free(protocol);
        free(host);
        goto allocation;
    }
    usize path_offset = 0;
    if (query_only) path[path_offset++] = '/';
    memcpy(path + path_offset, path_bytes, path_len);
    path_len += path_offset;
    path[path_len] = '\0';
    for (usize i = 0; i < path_len; i++) {
        unsigned char ch = (unsigned char) path[i];
        if (ch <= 0x20 || ch == 0x7f) {
            free(protocol);
            free(host);
            free(path);
            goto invalid_path;
        }
    }
    free(url);
    *protocol_out = protocol;
    *host_out = host;
    *port_out = port;
    *path_out = path;
    *path_len_out = path_len;
    return true;

allocation:
    free(url);
    mal_vm_throw_allocation_error(vm);
    return false;
invalid_port:
    free(url);
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                       "HTTP port must be an integer from 0 through 65535");
    return false;
invalid_path:
    free(url);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "HTTP path contains invalid characters");
    return false;
invalid_authority:
    free(url);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "HTTP authority contains invalid characters");
    return false;
invalid_url:
    free(url);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "HTTP request URL must be an absolute URL");
    return false;
}

static bool http_client_serialize_headers(
    MalVm *vm, MalValue headers_value, char **out, usize *out_length,
    bool *has_content_length, i64 *content_length, bool *keep_alive) {
    *out = nullptr;
    *out_length = 0;
    *has_content_length = false;
    *content_length = -1;
    if (mal_value_is_undefined(headers_value) || mal_value_is_null(headers_value)) {
        return true;
    }
    if (!mal_value_is_object(headers_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The headers option must be an object");
        return false;
    }
    MalValue roots[] = {
        headers_value, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = mal_vm_own_property_keys(vm, roots[0], &roots[1]);
    char *block = nullptr;
    usize length = 0;
    usize capacity = 0;
    if (!ok) goto done;
    MalArrayObject *keys = mal_value_to_array_object(roots[1]);
    for (u32 i = 0; i < mal_array_object_length(keys); i++) {
        mal_array_object_dense_get(keys, i, &roots[2]);
        MalKey key;
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_value_to_property_key(vm, roots[2], &key)
            || !mal_vm_get_own_property(vm, roots[0], key, &present, &desc)) {
            ok = false;
            break;
        }
        if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)
            || key.kind == MAL_KEY_SYMBOL) {
            continue;
        }
        char *name;
        usize name_len;
        if (!http_response_name(vm, roots[2], &name, &name_len)
            || !mal_vm_get_property(vm, roots[0], key, &roots[3])) {
            ok = false;
            break;
        }
        bool host_managed = name_len == 4 && memcmp(name, "host", 4) == 0;
        bool content_length_header = name_len == 14
            && memcmp(name, "content-length", 14) == 0;
        bool connection_header = name_len == 10
            && memcmp(name, "connection", 10) == 0;
        bool transfer_encoding = name_len == 17
            && memcmp(name, "transfer-encoding", 17) == 0;
        if (!http_header_value_valid(vm, roots[3])) {
            free(name);
            ok = false;
            break;
        }
        if (transfer_encoding) {
            free(name);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Transfer-Encoding is managed by the HTTP client");
            ok = false;
            break;
        }
        if (content_length_header) {
            byte *bytes = nullptr;
            usize value_length;
            ok = http_header_value_bytes(vm, roots[3], &bytes, &value_length);
            u64 parsed = 0;
            if (ok && value_length == 0) ok = false;
            for (usize j = 0; ok && j < value_length; j++) {
                byte digit = bytes[j];
                if (digit < '0' || digit > '9') {
                    ok = false;
                    break;
                }
                u64 next = (u64) (digit - '0');
                if (parsed > ((u64) INT64_MAX - next) / 10) {
                    ok = false;
                    break;
                }
                parsed = parsed * 10 + next;
            }
            free(bytes);
            free(name);
            if (!ok) {
                if (vm->completion.kind != MAL_COMPLETION_THROW) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                                       "Invalid content-length header");
                }
                break;
            }
            *has_content_length = true;
            *content_length = (i64) parsed;
            continue;
        }
        if (connection_header) {
            byte *bytes = nullptr;
            usize value_length = 0;
            ok = http_header_value_bytes(vm, roots[3], &bytes, &value_length);
            for (usize j = 0; ok && j < value_length;) {
                while (j < value_length && (bytes[j] == ' ' || bytes[j] == '\t' || bytes[j] == ',')) j++;
                usize start = j;
                while (j < value_length && bytes[j] != ',') j++;
                usize end = j;
                while (end > start && (bytes[end - 1] == ' ' || bytes[end - 1] == '\t')) end--;
                if (end - start == 5 && (bytes[start] | 0x20) == 'c'
                    && (bytes[start + 1] | 0x20) == 'l' && (bytes[start + 2] | 0x20) == 'o'
                    && (bytes[start + 3] | 0x20) == 's' && (bytes[start + 4] | 0x20) == 'e') {
                    *keep_alive = false;
                }
            }
            free(bytes);
            free(name);
            if (!ok) break;
            continue;
        }
        if (host_managed) {
            free(name);
            continue;
        }
        ok = http_serialize_header(
            vm, &block, &length, &capacity, name, name_len, roots[3]);
        free(name);
        if (!ok) break;
    }
done:
    mal_gc_unroot(&root);
    if (!ok) {
        free(block);
        return false;
    }
    *out = block;
    *out_length = length;
    return true;
}

static bool http_client_enqueue(
    MalVm *vm, MalNodeHttpClientState *state,
    byte *bytes, usize length, MalValue callback, bool end_write) {
    if (length > SIZE_MAX - state->queued_write_bytes) {
        free(bytes);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    MalNodeHttpResponseWrite *write = calloc(1, sizeof(*write));
    if (write == nullptr) {
        free(bytes);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    write->token = state->next_write_token++;
    write->bytes = bytes;
    write->length = length;
    write->callback = callback;
    write->async_context = mal_async_context_capture(vm);
    write->end_write = end_write;
    if (state->write_tail == nullptr) state->write_head = write;
    else state->write_tail->next = write;
    state->write_tail = write;
    state->queued_write_bytes += length;
    return true;
}

static void http_client_rollback_enqueue(
    MalNodeHttpClientState *state, MalNodeHttpResponseWrite *previous_tail) {
    MalNodeHttpResponseWrite *write = state->write_tail;
    if (previous_tail == nullptr) state->write_head = nullptr;
    else previous_tail->next = nullptr;
    state->write_tail = previous_tail;
    state->queued_write_bytes -= write->length;
    free(write->bytes);
    free(write);
}

static bool http_client_start_request(
    MalVm *vm, MalNodeHttpClientState *state,
    i64 automatic_length, bool streaming) {
    if (state->headers_committed) return true;
    i64 content_length = state->has_content_length
        ? state->content_length : automatic_length;
    if (streaming && !state->has_content_length) content_length = -1;
    char host_header[320];
    int host_header_length = state->port == (state->secure ? 443 : 80)
        ? snprintf(host_header, sizeof(host_header), "Host: %s\r\n", state->host)
        : snprintf(host_header, sizeof(host_header), "Host: %s:%u\r\n",
            state->host, (unsigned)state->port);
    if (host_header_length < 0 || (usize) host_header_length >= sizeof(host_header)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "HTTP host header is too large");
        return false;
    }
    usize request_len = state->method_len + 1 + state->path_len + 11
        + state->headers_len + (usize) host_header_length;
    byte *request = malloc(request_len);
    if (request == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize offset = 0;
#define HTTP_CLIENT_COPY(bytes, count) do { \
    usize copy_count = (count); \
    if (copy_count > 0) memcpy(request + offset, (bytes), copy_count); \
    offset += copy_count; \
} while (0)
    HTTP_CLIENT_COPY(state->method, state->method_len);
    HTTP_CLIENT_COPY(" ", 1);
    HTTP_CLIENT_COPY(state->path, state->path_len);
    HTTP_CLIENT_COPY(" HTTP/1.1\r\n", 11);
    HTTP_CLIENT_COPY(state->headers, state->headers_len);
    HTTP_CLIENT_COPY(host_header, (usize) host_header_length);
#undef HTTP_CLIENT_COPY
    MalTlsClientIdentity identity = {
        (const byte *) state->cert, state->cert_len, (const byte *) state->key, state->key_len,
    };
    bool reused;
    if (!mal_http_client_start(
            mal_host(vm), state->host, state->port, state->secure,
            (const byte *) state->ca, state->ca_len, &identity, state->keep_alive,
            request, request_len,
            content_length,
            state->method_len == 4 && memcmp(state->method, "HEAD", 4) == 0,
            state->timeout_ms, &state->operation, &reused)) {
        free(request);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start HTTP request");
        return false;
    }
    state->headers_committed = true;
    // Node learns this when the agent assigns a socket; ours picks one as the head commits.
    http_define(vm, state->request, "reusedSocket", mal_value_new_boolean(reused));
    return true;
}

static bool http_client_pump(MalVm *vm, MalNodeHttpClientState *state) {
    if (!state->headers_committed || state->write_in_flight
        || state->final_submitted || state->cancelled) {
        return true;
    }
    MalNodeHttpResponseWrite *write = state->write_head;
    if (write == nullptr) return true;
    usize selected = write->length - write->offset;
    if (selected > HTTP_RESPONSE_WRITE_SEGMENT) {
        selected = HTTP_RESPONSE_WRITE_SEGMENT;
    }
    bool completes_write = write->offset + selected == write->length;
    bool end_stream = write->end_write && completes_write;
    byte *segment;
    bool transfer = write->offset == 0 && selected == write->length;
    if (transfer) {
        segment = write->bytes;
    } else {
        segment = malloc(selected == 0 ? 1 : selected);
        if (segment == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        if (selected > 0) memcpy(segment, write->bytes + write->offset, selected);
    }
    MalHttpClientWriteResult result = mal_http_client_write_owned(
        mal_host(vm), state->operation, segment, selected,
        write->token, end_stream);
    if (result != MAL_HTTP_CLIENT_WRITE_ACCEPTED) {
        if (!transfer) free(segment);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           result == MAL_HTTP_CLIENT_WRITE_WOULD_BLOCK
                               ? "HTTP upload transport is backpressured"
                               : "HTTP upload transport rejected an accepted write");
        http_client_cancel(vm, state, false, vm->completion.value);
        return false;
    }
    if (transfer) write->bytes = nullptr;
    state->active_write_bytes = selected;
    state->write_in_flight = true;
    if (end_stream) state->final_submitted = true;
    return true;
}

static MalValue http_client_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpClientState *state = http_client_state(receiver);
    if (state != nullptr && state->cancelled) {
        return mal_value_new_boolean(false);
    }
    if (state == nullptr || state->ending || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_boolean(false);
    }
    byte *bytes;
    usize length;
    if (argc < 1 || !http_response_chunk_owned(vm, args[0], &bytes, &length)) {
        return mal_value_new_boolean(false);
    }
    MalValue callback = argc > 1 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    MalNodeHttpResponseWrite *previous_tail = state->write_tail;
    if (!http_client_enqueue(vm, state, bytes, length, callback, false)) {
        return mal_value_new_boolean(false);
    }
    if (!http_client_start_request(vm, state, -1, true)) {
        http_client_rollback_enqueue(state, previous_tail);
        return mal_value_new_boolean(false);
    }
    if (!http_client_pump(vm, state)) {
        return mal_value_new_boolean(false);
    }
    bool below_high_water = state->queued_write_bytes < HTTP_RESPONSE_WRITE_HIGH_WATER;
    if (!below_high_water) state->backpressured = true;
    return mal_value_new_boolean(below_high_water);
}

static void http_client_cancel(
    MalVm *vm, MalNodeHttpClientState *state, bool aborted, MalValue error) {
    if (state->cancelled) return;
    state->cancelled = true;
    state->aborted = aborted;
    state->destroy_error = error;
    http_define(vm, state->request, "destroyed", mal_value_new_boolean(true));
    http_define(vm, state->request, "aborted", mal_value_new_boolean(aborted));
    http_define(vm, state->request, "writable", mal_value_new_boolean(false));
    if (state->operation == 0) {
        state->terminal_pending = true;
    } else if (!mal_http_client_cancel(mal_host(vm), state->operation)) {
        state->operation = 0;
        state->terminal_pending = true;
    }
}

static MalValue http_client_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpClientState *state = http_client_state(receiver);
    if (state == nullptr) return receiver;
    MalValue error = argc > 0 ? args[0] : mal_value_new_undefined();
    http_client_cancel(vm, state, false, error);
    return receiver;
}

/* Milliseconds of permitted socket inactivity. Zero is Node's "disable the socket
 * timeout", which this transport deliberately cannot express — every outbound
 * request stays bounded — so it is refused instead of silently reinterpreted. */
static bool http_client_timeout_ms(MalVm *vm, MalValue value, u32 *out) {
    f64 number = mal_ops_is_number(value) ? mal_ops_number_as_f64(value) : (f64) NAN;
    if (!isfinite(number) || floor(number) != number || number < 1
        || number > 2147483647.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "HTTP request timeout must be an integer from 1 through "
                           "2147483647 milliseconds");
        return false;
    }
    *out = (u32) number;
    return true;
}

static MalValue http_client_set_timeout(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpClientState *state = http_client_state(receiver);
    if (state == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Request is not active");
        return mal_value_new_undefined();
    }
    u32 timeout_ms;
    if (argc < 1 || !http_client_timeout_ms(vm, args[0], &timeout_ms)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The timeout argument must be a number");
        }
        return mal_value_new_undefined();
    }
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        if (!mal_value_is_callable(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The callback argument must be a function");
            return mal_value_new_undefined();
        }
        MalValue bound = mal_async_context_bind_callback(
            vm, args[1], mal_async_context_capture(vm));
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !http_once(vm, receiver, "timeout", bound)) {
            return mal_value_new_undefined();
        }
    }
    state->timeout_ms = timeout_ms;
    // Before the head is committed the value travels with the request; afterwards
    // it retunes the live transport, so both orderings reach the same deadline.
    if (state->operation != 0 && !state->cancelled) {
        (void) mal_http_client_set_timeout(
            mal_host(vm), state->operation, timeout_ms);
    }
    return receiver;
}

static MalValue http_client_abort(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpClientState *state = http_client_state(receiver);
    if (state != nullptr) {
        http_client_cancel(
            vm, state, true, mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue http_client_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpClientState *state = http_client_state(receiver);
    if (state != nullptr && state->cancelled) {
        return receiver;
    }
    if (state == nullptr || state->ending || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_undefined();
    }
    state->ending = true;
    bool sole_callback = argc == 1 && mal_value_is_callable(args[0]);
    byte *bytes;
    usize length;
    if (argc > 0 && !sole_callback && !mal_value_is_undefined(args[0])) {
        if (!http_response_chunk_owned(vm, args[0], &bytes, &length)) {
            state->ending = false;
            return mal_value_new_undefined();
        }
    } else {
        bytes = malloc(1);
        length = 0;
        if (bytes == nullptr) {
            state->ending = false;
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
    }
    bool fresh = !state->headers_committed && state->write_head == nullptr;
    MalNodeHttpResponseWrite *previous_tail = state->write_tail;
    if (!http_client_enqueue(
            vm, state, bytes, length, mal_value_new_undefined(), true)) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    if (!http_client_start_request(
            vm, state, fresh ? (i64) length : -1, !fresh)) {
        http_client_rollback_enqueue(state, previous_tail);
        state->ending = false;
        return mal_value_new_undefined();
    }
    state->end_callback = argc > 0 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    state->end_context = mal_async_context_capture(vm);
    if (!mal_value_is_undefined(state->end_callback)) {
        MalValue bound = mal_async_context_bind_callback(
            vm, state->end_callback, state->end_context);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !http_once(vm, receiver, "finish", bound)) {
            http_client_cancel(vm, state, false, vm->completion.value);
            state->ending = false;
            return mal_value_new_undefined();
        }
    }
    if (!http_client_pump(vm, state)) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    state->ended = true;
    http_define(vm, receiver, "finished", mal_value_new_boolean(true));
    http_define(vm, receiver, "writableEnded", mal_value_new_boolean(true));
    return receiver;
}

static void http_response_write_ready(void *data, u64 token) {
    MalNodeHttpRequestState *state = data;
    state->ready_write_token = token;
    state->write_ready_pending = true;
    http_request_schedule_write(state);
}

static bool http_response_content_length(
    MalVm *vm, MalNodeHttpRequestState *state, i64 *out) {
    i64 index = http_response_header_byte_index(state, "content-length", 14);
    if (index < 0) return false;
    byte *bytes;
    usize length;
    if (!http_header_value_bytes(
            vm, state->response_headers[index].value, &bytes, &length)) {
        return false;
    }
    u64 value = 0;
    bool valid = length > 0;
    for (usize i = 0; valid && i < length; i++) {
        byte digit = bytes[i];
        if (digit < '0' || digit > '9') {
            valid = false;
            break;
        }
        u64 next = (u64) (digit - '0');
        if (value > ((u64) INT64_MAX - next) / 10) {
            valid = false;
            break;
        }
        value = value * 10 + next;
    }
    free(bytes);
    if (!valid) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Invalid content-length header");
        return false;
    }
    *out = (i64) value;
    return true;
}

typedef struct MalNodeHttpHeadText {
    MalVm *vm;
    // Rooted by the caller.
    MalValue *text;
} MalNodeHttpHeadText;

static void http_response_head_text(void *data, const byte *head, usize length) {
    MalNodeHttpHeadText *sink = data;
    *sink->text = mal_value_from_string(
        mal_string_new_latin1_copy(&sink->vm->heap, (const u8 *) head, length));
}

static bool http_response_start_commit(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue receiver,
    i64 automatic_length, bool streaming) {
    MalValue status_value;
    if (!mal_vm_get_property(
            vm, receiver, mal_intrinsic_string_key(vm, (const byte *) "statusCode"),
            &status_value)) {
        return false;
    }
    f64 status_number;
    if (!mal_vm_to_number(vm, status_value, &status_number)
        || !isfinite(status_number) || floor(status_number) != status_number
        || status_number < 100 || status_number > 999) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Invalid status code");
        }
        return false;
    }
    bool head = state->method_len == 4 && memcmp(state->method, "HEAD", 4) == 0;
    bool entity_forbidden = (status_number >= 100 && status_number < 200)
        || status_number == 204 || status_number == 304;
    state->suppress_response_body = head || entity_forbidden;

    i64 declared_content_length = automatic_length;
    i64 explicit_content_length;
    bool has_content_length = http_response_content_length(
        vm, state, &explicit_content_length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    if (has_content_length) declared_content_length = explicit_content_length;
    if (entity_forbidden || (head && !has_content_length)) {
        declared_content_length = -1;
    }
    bool chunked = streaming && !state->suppress_response_body
        && !has_content_length && state->minor_version >= 1;
    if (streaming && !chunked && !has_content_length
        && !state->suppress_response_body && state->minor_version == 0) {
        declared_content_length = -1;
        mal_http_conn_close_after_response(state->conn);
    }

    MalValue status_message_value;
    if (!mal_vm_get_property(
            vm, receiver,
            mal_intrinsic_string_key(vm, (const byte *) "statusMessage"),
            &status_message_value)) {
        return false;
    }
    byte *status_message = nullptr;
    const char *reason = http_status_reason((int) status_number);
    if (mal_value_is_nil(status_message_value)) {
        // Node's writeHead, which commits its implicit heads too, records the default.
        http_define(vm, receiver, "statusMessage", mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) reason)));
    } else {
        usize status_message_length;
        if (!http_header_value_bytes(
                vm, status_message_value, &status_message,
                &status_message_length)) {
            return false;
        }
        (void) status_message_length;
        reason = (const char *) status_message;
    }
    char *headers;
    usize headers_length;
    if (!http_response_serialize_headers(vm, state, &headers, &headers_length)) {
        free(status_message);
        return false;
    }
    i64 connection_header = http_response_header_byte_index(state, "connection", 10);
    if (connection_header >= 0
        && http_string_equal_ci(
            state->response_headers[connection_header].value, "close")) {
        mal_http_conn_close_after_response(state->conn);
    }
    mal_http_conn_on_response_complete(state->conn, http_response_complete, state);
    mal_http_conn_on_response_write(
        state->conn, http_response_write_ready, state);
    // Node's `_header`: the head exactly as it went on the wire.
    MalValue head_text = mal_value_new_null();
    MalRootSpan head_root;
    mal_gc_root(&head_root, &head_text, 1);
    MalNodeHttpHeadText sink = {vm, &head_text};
    bool started = mal_http_conn_response_start(
        state->conn, (int) status_number, reason,
        headers == nullptr ? "" : headers, headers_length,
        declared_content_length,
        state->suppress_response_body ? 0 : declared_content_length,
        chunked, http_response_head_text, &sink);
    free(status_message);
    free(headers);
    if (!started) {
        mal_gc_unroot(&head_root);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start HTTP response");
        return false;
    }
    state->response_in_flight = true;
    state->head_committed = true;
    http_define(vm, receiver, "headersSent", mal_value_new_boolean(true));
    http_define(vm, receiver, "_header", head_text);
    mal_gc_unroot(&head_root);
    return true;
}

static bool http_response_start(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue receiver,
    i64 automatic_length, bool streaming) {
    if (state->response_in_flight) return true;
    if (state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ServerResponse is not writable");
        return false;
    }
    state->committing_headers = true;
    bool started = http_response_start_commit(
        vm, state, receiver, automatic_length, streaming);
    state->committing_headers = false;
    return started;
}

static void http_throw_invalid_status(MalVm *vm, MalValue value) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return;
    usize length;
    byte *text = mal_string_to_utf8(string, &length);
    char *message = text == nullptr ? nullptr : malloc(length + 32);
    if (message == nullptr) {
        free(text);
        mal_vm_throw_allocation_error(vm);
        return;
    }
    snprintf(message, length + 32, "Invalid status code: %.*s", (int) length,
             (const char *) text);
    free(text);
    mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message,
                        "ERR_HTTP_INVALID_STATUS_CODE");
    free(message);
}

// ERR_INVALID_ARG_VALUE: `reason` is the sentence before " Received <inspected value>".
static void http_throw_invalid_arg_value(MalVm *vm, const char *reason, MalValue value) {
    MalTextBuffer text = {0};
    mal_text_buffer_append_ascii(&text, (const byte *) reason);
    mal_text_buffer_append_ascii(&text, (const byte *) " Received ");
    MalNodeInspectOptions options = {.options = mal_value_new_undefined()};
    if (!mal_node_util_inspect_into(vm, &text, value, &options)) {
        mal_text_buffer_dispose(&text);
        return;
    }
    mal_node_throw_code_string(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               mal_text_buffer_finish(&vm->heap, &text), "ERR_INVALID_ARG_VALUE");
}

/* writeHead's headers: an object's own enumerable keys replace headers as setHeader
 * does, and a flat [name, value, ...] list first removes its names, then appends
 * each pair so that repeated names all reach the wire. */
static bool http_response_merge_head_headers(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue headers) {
    MalValue roots[] = {
        headers, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = true;
    if (mal_value_is_array_object(roots[0])) {
        MalArrayObject *list = mal_value_to_array_object(roots[0]);
        if (mal_array_object_length(list) % 2 != 0) {
            http_throw_invalid_arg_value(
                vm, "The argument 'headers' is invalid.", roots[0]);
            ok = false;
        }
        for (u32 i = 0; ok && i < mal_array_object_length(list); i += 2) {
            ok = mal_vm_get_property(vm, roots[0], mal_key_index(i), &roots[1]);
            // Node's removeHeader("") finds nothing rather than rejecting the name.
            if (!ok || (mal_value_is_string(roots[1])
                        && mal_string_length(mal_value_to_string(roots[1])) == 0)) {
                continue;
            }
            MalNodeHttpResponseNameView name;
            ok = http_response_name_view(vm, roots[1], &name)
                && http_response_headers_mutable(vm, state, "remove");
            if (!ok) break;
            i64 index = http_response_header_view_index(state, &name);
            if (index >= 0) http_response_delete_header(state, index);
        }
        for (u32 i = 0; ok && i < mal_array_object_length(list); i += 2) {
            ok = mal_vm_get_property(vm, roots[0], mal_key_index(i), &roots[1])
                && mal_vm_get_property(vm, roots[0], mal_key_index(i + 1), &roots[2]);
            if (ok && mal_value_is_truthy(roots[1])) {
                ok = http_response_store_header(vm, state, roots[1], roots[2], true);
            }
        }
    } else if (mal_value_is_object(roots[0])) {
        ok = mal_vm_own_property_keys(vm, roots[0], &roots[3]);
        MalArrayObject *keys = ok ? mal_value_to_array_object(roots[3]) : nullptr;
        for (u32 i = 0; ok && i < mal_array_object_length(keys); i++) {
            (void) mal_array_object_dense_get(keys, i, &roots[1]);
            if (!mal_value_is_string(roots[1])
                || mal_string_length(mal_value_to_string(roots[1])) == 0) {
                continue;
            }
            MalKey key;
            bool present;
            MalPropertyDesc desc;
            ok = mal_vm_value_to_property_key(vm, roots[1], &key)
                && mal_vm_get_own_property(vm, roots[0], key, &present, &desc);
            if (!ok || !present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) continue;
            ok = mal_vm_get_property(vm, roots[0], key, &roots[2])
                && http_response_store_header(vm, state, roots[1], roots[2], false);
        }
    }
    mal_gc_unroot(&root);
    return ok;
}

/* The head of a response whose connection failed: status line and headers, without
 * the framing fields the transport would have added. */
static bool http_response_record_head(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue receiver, i32 status) {
    MalValue message = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &message, 1);
    byte *reason_bytes = nullptr;
    usize reason_length = 0;
    char *headers = nullptr;
    usize headers_length = 0;
    char *head = nullptr;
    usize head_length = 0;
    usize head_capacity = 0;
    bool ok = mal_vm_get_static(vm, receiver, (const byte *) "statusMessage", &message)
        && (mal_value_is_nil(message)
            || http_header_value_bytes(vm, message, &reason_bytes, &reason_length))
        && http_response_serialize_headers(vm, state, &headers, &headers_length);
    mal_gc_unroot(&root);
    if (ok) {
        const char *reason = reason_bytes != nullptr
            ? (const char *) reason_bytes : http_status_reason(status);
        char status_line[32];
        int status_length = snprintf(status_line, sizeof status_line, "HTTP/1.1 %d ", status);
        ok = http_block_append(&head, &head_length, &head_capacity, status_line,
                               (usize) status_length)
            && http_block_append(&head, &head_length, &head_capacity, reason,
                                 reason_bytes != nullptr ? reason_length : strlen(reason))
            && http_block_append(&head, &head_length, &head_capacity, "\r\n", 2)
            && http_block_append(&head, &head_length, &head_capacity,
                                 headers == nullptr ? "" : headers, headers_length)
            && http_block_append(&head, &head_length, &head_capacity, "\r\n", 2);
        if (!ok) mal_vm_throw_allocation_error(vm);
    }
    free(reason_bytes);
    free(headers);
    if (!ok) {
        free(head);
        return false;
    }
    MalValue head_text = mal_value_new_null();
    MalRootSpan head_root;
    mal_gc_root(&head_root, &head_text, 1);
    http_response_head_text(&(MalNodeHttpHeadText) {vm, &head_text}, (const byte *) head, head_length);
    free(head);
    state->head_committed = true;
    http_define(vm, receiver, "headersSent", mal_value_new_boolean(true));
    http_define(vm, receiver, "_header", head_text);
    mal_gc_unroot(&head_root);
    return true;
}

// Node's ServerResponse.prototype.writeHead. The head commits here, so it is framed
// as Node frames a head that writeHead stored: chunked unless it has a length.
static MalValue http_response_write_head(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (!http_response_headers_mutable(vm, state, "write")) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        receiver,
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 2 ? args[2] : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    f64 number;
    bool ok = mal_vm_to_number(vm, roots[1], &number);
    i32 status = ok ? mal_ops_number_to_i32(number) : 0;
    if (ok && (status < 100 || status > 999)) {
        http_throw_invalid_status(vm, roots[1]);
        ok = false;
    }
    if (ok && mal_value_is_string(roots[2])) {
        http_define(vm, roots[0], "statusMessage", roots[2]);
    } else if (ok) {
        ok = mal_vm_get_static(vm, roots[0], (const byte *) "statusMessage", &roots[4]);
        if (ok && !mal_value_is_truthy(roots[4])) {
            http_define(vm, roots[0], "statusMessage", mal_value_from_string(
                mal_intrinsic_ascii(vm, (const byte *) http_status_reason(status))));
        }
        if (mal_value_is_nil(roots[3])) roots[3] = roots[2];
    }
    if (ok) {
        http_define(vm, roots[0], "statusCode", mal_value_from_i32(status));
        ok = http_response_merge_head_headers(vm, state, roots[3]);
    }
    if (ok && state->response_failed) {
        // With the exchange gone the head is only recorded, as Node stores it unsent.
        ok = http_response_record_head(vm, state, roots[0], status);
    } else if (ok) {
        bool implicit = state->implicit_commit;
        ok = http_response_start(
            vm, state, roots[0], implicit ? state->implicit_length : -1,
            !implicit || state->implicit_streaming);
    }
    mal_gc_unroot(&root);
    return ok ? receiver : mal_value_new_undefined();
}

// Node's ServerResponse.prototype._implicitHeader.
static MalValue http_response_implicit_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalValue roots[] = {receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_vm_get_static(vm, roots[0], (const byte *) "statusCode", &roots[1])) {
        (void) http_call_method(vm, roots[0], "writeHead", &roots[1], 1);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Node commits an implicit head through this._implicitHeader(), which calls
 * this.writeHead(this.statusCode); middleware such as on-headers wraps writeHead to
 * adjust headers first. Untouched methods commit directly, and a wrapper that
 * returns without committing still gets the head that the write needs. */
static bool http_response_start_implicit(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue receiver,
    i64 automatic_length, bool streaming) {
    if (state->head_committed) return true;
    MalValue roots[] = {receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = mal_vm_get_static(
        vm, roots[0], (const byte *) "_implicitHeader", &roots[1]);
    bool implicit_header_wrapped =
        ok && !http_native_is(roots[1], http_response_implicit_header);
    bool write_head_wrapped = false;
    if (ok && !implicit_header_wrapped) {
        ok = mal_vm_get_static(vm, roots[0], (const byte *) "writeHead", &roots[1]);
        write_head_wrapped = ok && !http_native_is(roots[1], http_response_write_head);
    }
    if (implicit_header_wrapped || write_head_wrapped) {
        state->implicit_commit = true;
        state->implicit_length = automatic_length;
        state->implicit_streaming = streaming;
        if (implicit_header_wrapped) {
            mal_vm_call_value(vm, roots[1], roots[0], nullptr, 0);
        } else {
            (void) http_response_implicit_header(
                vm, roots[0], nullptr, 0, mal_value_new_undefined(),
                mal_value_new_undefined());
        }
        state->implicit_commit = false;
        ok = vm->completion.kind != MAL_COMPLETION_THROW;
    }
    ok = ok && http_response_start(vm, state, roots[0], automatic_length, streaming);
    mal_gc_unroot(&root);
    return ok;
}

static bool http_response_pump(MalNodeHttpRequestState *state) {
    if (!state->response_in_flight || state->write_in_flight
        || state->final_submitted) {
        return true;
    }
    MalNodeHttpResponseWrite *write = state->write_head;
    if (write == nullptr) {
        if (!state->ending) return true;
        byte *empty = malloc(1);
        if (empty == nullptr) {
            mal_vm_throw_allocation_error(state->vm);
            mal_http_conn_abort(state->conn);
            return false;
        }
        if (!mal_http_conn_response_write_owned(
                state->conn, empty, 0, 0, true)) {
            free(empty);
            mal_vm_throw_error(state->vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                               "HTTP response transport rejected finalization");
            mal_http_conn_abort(state->conn);
            return false;
        }
        state->write_in_flight = true;
        state->active_write_bytes = 0;
        state->final_submitted = true;
        return true;
    }
    usize selected = write->length - write->offset;
    if (selected > HTTP_RESPONSE_WRITE_SEGMENT) {
        selected = HTTP_RESPONSE_WRITE_SEGMENT;
    }
    bool completes_write = write->offset + selected == write->length;
    bool end_stream = write->end_write && completes_write;
    byte *segment;
    bool transfer = !state->suppress_response_body
        && write->offset == 0 && selected == write->length;
    usize wire_length = state->suppress_response_body ? 0 : selected;
    if (transfer) {
        segment = write->bytes;
    } else {
        segment = malloc(wire_length == 0 ? 1 : wire_length);
        if (segment == nullptr) {
            mal_vm_throw_allocation_error(state->vm);
            mal_http_conn_abort(state->conn);
            return false;
        }
        if (wire_length > 0) {
            memcpy(segment, write->bytes + write->offset, wire_length);
        }
    }
    if (!mal_http_conn_response_write_owned(
            state->conn, segment, wire_length, write->token, end_stream)) {
        if (!transfer) free(segment);
        mal_vm_throw_error(state->vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "HTTP response transport rejected an accepted write");
        mal_http_conn_abort(state->conn);
        return false;
    }
    if (transfer) write->bytes = nullptr;
    state->active_write_bytes = selected;
    state->write_in_flight = true;
    if (end_stream) state->final_submitted = true;
    return true;
}

static void http_response_complete(void *data, bool success) {
    MalNodeHttpRequestState *state = data;
    if (state->response_transport_complete) return;
    state->response_in_flight = false;
    if (success || state->ready_kind != HTTP_REQUEST_READY_WRITE) {
        state->write_in_flight = false;
    }
    state->response_succeeded = success;
    state->response_failed = !success;
    state->response_transport_complete = true;
    MalHost *host = mal_host(state->vm);
    if (host != nullptr) {
        host->pending_http_completions++;
        state->response_end_counted = true;
    }
    if (!success) state->ended = true;
    if (success && !state->request_transport_complete
        && !state->request_read_started) {
        state->request_auto_discard = true;
        mal_http_conn_request_discard(state->conn);
    } else if (!success || state->request_terminal_delivered) {
        state->conn = nullptr;
    }
    http_request_schedule_response(state);
}

static void http_response_dispatch_write(
    MalVm *vm, MalNodeHttpRequestState *state) {
    MalNodeHttpResponseWrite *write = state->write_head;
    if (write == nullptr || !state->write_in_flight
        || write->token != state->ready_write_token) {
        return;
    }
    write->offset += state->active_write_bytes;
    state->queued_write_bytes -= state->active_write_bytes;
    state->active_write_bytes = 0;
    state->write_in_flight = false;
    MalValue callback = mal_value_new_undefined();
    MalAsyncContext *callback_context = nullptr;
    if (write->offset == write->length) {
        state->write_head = write->next;
        if (state->write_head == nullptr) state->write_tail = nullptr;
        callback = write->callback;
        callback_context = write->async_context;
        free(write->bytes);
        free(write);
    }
    MalRootSpan root;
    mal_gc_root(&root, &callback, 1);
    if (!mal_value_is_undefined(callback)) {
        MalAsyncContextScope scope;
        mal_async_context_scope_enter(vm, &scope, callback_context);
        mal_vm_call_value(vm, callback, mal_value_new_undefined(), nullptr, 0);
        mal_async_context_scope_exit(vm, &scope);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && state->backpressured
        && !state->ended
        && state->queued_write_bytes <= HTTP_RESPONSE_WRITE_LOW_WATER) {
        state->backpressured = false;
        http_emit(vm, state->response, "drain");
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        http_response_pump(state);
    }
    mal_gc_unroot(&root);
}

static void http_request_dispatch_read(
    MalVm *vm, MalNodeHttpRequestState *state) {
    bool has_request = !mal_value_is_undefined(state->request);
    MalNodeHttpRequestBody *body = state->body_head;
    if (body != nullptr) {
        state->body_head = body->next;
        if (state->body_head == nullptr) state->body_tail = nullptr;
        MalValue chunk = mal_value_new_undefined();
        if (has_request) {
            chunk = mal_node_buffer_from_owned_bytes(vm, body->bytes, body->length);
            body->bytes = nullptr;
            MAL_PERF_COUNT(http_request_body_transfers);
        }
        free(body->bytes);
        free(body);
        MalRootSpan root;
        mal_gc_root(&root, &chunk, 1);
        if (has_request && vm->completion.kind != MAL_COMPLETION_THROW) {
            (void) http_call_method(vm, state->request, "push", &chunk, 1);
        }
        mal_gc_unroot(&root);
    } else if (state->request_transport_complete
               && !state->request_terminal_delivered) {
        MalHttpConn *conn = state->conn;
        state->request_terminal_delivered = true;
        if (state->request_end_counted) {
            mal_host(vm)->pending_http_completions--;
            state->request_end_counted = false;
        }
        if (has_request && state->request_end_success) {
            http_define(vm, state->request, "complete", mal_value_new_boolean(true));
            MalValue end = mal_value_new_null();
            (void) http_call_method(vm, state->request, "push", &end, 1);
        } else if (has_request) {
            http_define(vm, state->request, "aborted", mal_value_new_boolean(true));
            http_define(vm, state->request, "destroyed", mal_value_new_boolean(true));
            http_emit(vm, state->request, "aborted");
            if (vm->completion.kind != MAL_COMPLETION_THROW
                && !mal_value_is_nil(state->request_destroy_error)) {
                MalValue args[] = {
                    mal_value_from_string(
                        mal_intrinsic_ascii(vm, (const byte *) "error")),
                    state->request_destroy_error,
                };
                MalRootSpan root;
                mal_gc_root(&root, args, countof(args));
                (void) http_call_method(vm, state->request, "emit", args, 2);
                mal_gc_unroot(&root);
            }
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                http_emit(vm, state->request, "close");
            }
        }
        if (conn != nullptr && state->request_end_success) {
            mal_http_conn_request_release(conn);
        }
        if (state->response_transport_complete) state->conn = nullptr;
        http_request_maybe_complete(state);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        http_request_schedule_write(state);
        http_request_schedule_read(state);
    }
}

static void http_response_dispatch_terminal(
    MalVm *vm, MalNodeHttpRequestState *request) {
    request->response_terminal_delivered = true;
    if (request->response_end_counted) {
        mal_host(vm)->pending_http_completions--;
        request->response_end_counted = false;
    }
    if (!mal_value_is_undefined(request->response)
        && request->response_succeeded) {
        http_define(
            vm, request->response, "writableFinished",
            mal_value_new_boolean(true));
        http_emit(vm, request->response, "finish");
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            http_define(
                vm, request->response, "destroyed", mal_value_new_boolean(true));
            http_emit(vm, request->response, "close");
        }
    } else if (!mal_value_is_undefined(request->response)) {
        http_define(
            vm, request->response, "destroyed",
            mal_value_new_boolean(true));
        MalValue roots[] = {
            http_client_error(vm, "HTTP response closed before completion"),
            mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        for (MalNodeHttpResponseWrite *write = request->write_head;
             write != nullptr && vm->completion.kind != MAL_COMPLETION_THROW;
             write = write->next) {
            roots[1] = write->callback;
            if (!mal_value_is_undefined(roots[1])) {
                MalAsyncContextScope scope;
                mal_async_context_scope_enter(
                    vm, &scope, write->async_context);
                mal_vm_call_value(
                    vm, roots[1], mal_value_new_undefined(), roots, 1);
                mal_async_context_scope_exit(vm, &scope);
            }
        }
        roots[1] = request->end_callback;
        if (vm->completion.kind != MAL_COMPLETION_THROW
            && !mal_value_is_undefined(roots[1])) {
            MalAsyncContextScope scope;
            mal_async_context_scope_enter(
                vm, &scope, request->end_context);
            mal_vm_call_value(
                vm, roots[1], request->response, roots, 1);
            mal_async_context_scope_exit(vm, &scope);
        }
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            http_emit(vm, request->response, "close");
        }
        mal_gc_unroot(&root);
    }
    if (request->request_auto_discard
        && !request->request_terminal_delivered
        && !mal_value_is_undefined(request->request)
        && vm->completion.kind != MAL_COMPLETION_THROW) {
        (void) http_call_method(vm, request->request, "resume", nullptr, 0);
    }
    http_request_maybe_complete(request);
}

static MalValue http_response_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr && mal_value_is_object(receiver)) {
        MalValue destroyed;
        if (!mal_vm_get_property(
                vm, receiver,
                mal_intrinsic_string_key(vm, (const byte *) "destroyed"),
                &destroyed)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_boolean(destroyed) && mal_value_to_boolean(destroyed)) {
            return receiver;
        }
    }
    if (state != nullptr && state->response_failed) return receiver;
    if (state == nullptr || state->ending || state->ended
        || state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_undefined();
    }
    state->ending = true;
    bool sole_callback = argc == 1 && mal_value_is_callable(args[0]);
    byte *bytes;
    usize length;
    if (argc > 0 && !sole_callback && !mal_value_is_undefined(args[0])) {
        if (!http_response_chunk_owned(vm, args[0], &bytes, &length)) {
            state->ending = false;
            return mal_value_new_undefined();
        }
    } else {
        bytes = malloc(1);
        length = 0;
        if (bytes == nullptr) {
            state->ending = false;
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
    }
    bool fresh_response = !state->response_in_flight && state->write_head == nullptr;
    MalNodeHttpResponseWrite *previous_tail = state->write_tail;
    if (!http_response_enqueue(
            vm, state, bytes, length, mal_value_new_undefined(), true)) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    if (!http_response_start_implicit(
            vm, state, receiver, fresh_response ? (i64) length : -1,
            !fresh_response)) {
        http_response_rollback_enqueue(state, previous_tail);
        state->ending = false;
        return mal_value_new_undefined();
    }
    state->end_callback = argc > 0 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    state->end_context = mal_async_context_capture(vm);
    if (!mal_value_is_undefined(state->end_callback)) {
        MalValue bound = mal_async_context_bind_callback(
            vm, state->end_callback, state->end_context);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !http_once(vm, receiver, "finish", bound)) {
            mal_http_conn_abort(state->conn);
            state->ending = false;
            return mal_value_new_undefined();
        }
    }
    if (!http_response_pump(state)) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    state->ended = true;
    http_define(vm, receiver, "finished", mal_value_new_boolean(true));
    http_define(vm, receiver, "writableEnded", mal_value_new_boolean(true));
    return receiver;
}

static void http_client_mark(MalNodeHttpClientState *state) {
    mal_gc_mark_value(state->request);
    mal_gc_mark_value(state->response);
    mal_gc_mark_value(state->end_callback);
    mal_gc_mark_value(state->destroy_error);
    mal_gc_mark_value(state->response_destroy_error);
    mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
    mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->end_context));
    for (MalNodeHttpResponseWrite *write = state->write_head;
         write != nullptr; write = write->next) {
        mal_gc_mark_value(write->callback);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) write->async_context));
    }
}

static void http_scan_roots(MalVm *vm, void *data) {
    (void) data;
    // Keep the socket and its listeners alive between requests until transport close.
    for (MalNodeHttpSocketState *state = http_sockets; state != nullptr;
         state = state->next) {
        if (state->vm == vm) mal_gc_mark_value(state->receiver);
    }
    for (MalNodeHttpServerState *state = http_servers; state != nullptr;
         state = state->next) {
        if (state->vm == vm) {
            mal_gc_mark_value(state->receiver);
            mal_gc_mark_value(mal_async_internal_value(
                (MalHeapHeader *) state->async_context));
        }
    }
    for (MalNodeHttpRequestState *state = http_requests; state != nullptr;
         state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->server_receiver);
        mal_gc_mark_value(state->request);
        mal_gc_mark_value(state->response);
        mal_gc_mark_value(state->end_callback);
        mal_gc_mark_value(state->request_destroy_error);
        mal_gc_mark_value(mal_async_internal_value(
            (MalHeapHeader *) state->async_context));
        mal_gc_mark_value(mal_async_internal_value(
            (MalHeapHeader *) state->end_context));
        for (usize i = 0; i < state->response_header_count; i++) {
            mal_gc_mark_value(state->response_headers[i].value);
        }
        for (MalNodeHttpResponseWrite *write = state->write_head;
             write != nullptr; write = write->next) {
            mal_gc_mark_value(write->callback);
            mal_gc_mark_value(mal_async_internal_value(
                (MalHeapHeader *) write->async_context));
        }
    }
    for (MalNodeHttpClientState *state = http_clients; state != nullptr;
         state = state->next) {
        if (state->vm == vm) http_client_mark(state);
    }
    for (MalNodeHttpClientState *state = http_clients_terminating; state != nullptr;
         state = state->next) {
        if (state->vm == vm) http_client_mark(state);
    }
}

static bool http_header_names_equal_ci(
    const char *left, usize left_length,
    const char *right, usize right_length) {
    if (left_length != right_length) return false;
    for (usize i = 0; i < left_length; i++) {
        if (mal_ascii_to_lower((u8) left[i])
            != mal_ascii_to_lower((u8) right[i])) {
            return false;
        }
    }
    return true;
}

static bool http_incoming_singleton_header(const MalString *name) {
    static const char *singletons[] = {
        "age", "authorization", "content-length", "content-type", "etag",
        "expires", "from", "host", "if-modified-since", "if-unmodified-since",
        "last-modified", "location", "max-forwards", "proxy-authorization",
        "referer", "retry-after", "server", "user-agent",
    };
    for (usize i = 0; i < countof(singletons); i++) {
        if (mal_string_equals_ascii_ci(name, singletons[i])) {
            return true;
        }
    }
    return false;
}

static bool http_incoming_header_add(
    MalVm *vm, MalValue headers, MalValue lower_name,
    MalValue value, MalValue *scratch) {
    MalObject *object = mal_value_to_object(headers);
    MalKey key;
    if (!mal_vm_value_to_property_key(vm, lower_name, &key)) {
        return false;
    }
    MalString *name = key.kind == MAL_KEY_STRING
        ? mal_value_to_string(key.value)
        : mal_value_to_string(lower_name);
    MalPropertyLookup existing = mal_object_get_own(object, key);
    bool set_cookie = mal_string_equals_ascii_ci(name, "set-cookie");
    if (set_cookie) {
        if (!existing.present || !mal_value_is_array_object(existing.desc.value)) {
            *scratch = mal_value_from_array_object(
                mal_intrinsic_new_dense_array(vm, 0));
            mal_object_set(object, key, *scratch);
        } else {
            *scratch = existing.desc.value;
        }
        MalArrayObject *cookies = mal_value_to_array_object(*scratch);
        mal_array_object_store(
            cookies, mal_key_index((i32) mal_array_object_length(cookies)), value);
        return true;
    }
    if (!existing.present) {
        mal_object_set(object, key, value);
        return true;
    }
    if (http_incoming_singleton_header(name)) return true;

    const char *separator = mal_string_equals_ascii_ci(name, "cookie")
        ? "; " : ", ";
    MalString *previous = mal_value_to_string(existing.desc.value);
    MalString *next = mal_value_to_string(value);
    usize previous_length = mal_string_length(previous);
    usize value_length = mal_string_length(next);
    if (value_length > SIZE_MAX - 2
        || previous_length > SIZE_MAX - value_length - 2) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize joined_length = previous_length + 2 + value_length;
    char *joined = malloc(joined_length == 0 ? 1 : joined_length);
    if (joined == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    const c16 *previous_units = mal_string_code_units(previous);
    const c16 *value_units = mal_string_code_units(next);
    for (usize i = 0; i < previous_length; i++) joined[i] = (char) previous_units[i];
    memcpy(joined + previous_length, separator, 2);
    for (usize i = 0; i < value_length; i++) {
        joined[previous_length + 2 + i] = (char) value_units[i];
    }
    *scratch = http_ascii_value(vm, joined, joined_length);
    free(joined);
    mal_object_set(object, key, *scratch);
    return true;
}

static bool http_request_headers(
    MalVm *vm, MalNodeHttpRequestState *state,
    MalValue *headers_out, MalValue *raw_headers_out) {
    if (state->header_count > MAL_HTTP_CODEC_FIELDS_MAX) return false;
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue canonical_names[MAL_HTTP_CODEC_FIELDS_MAX];
    for (usize i = 0; i < state->header_count; i++) {
        canonical_names[i] = mal_value_new_undefined();
    }
    MalRootSpan canonical_root;
    mal_gc_root(&canonical_root, canonical_names, (i32) state->header_count);
    roots[0] = mal_value_from_object(
        mal_object_new_reserved(&vm->heap, nullptr, (u8) (state->header_count < MAL_SHAPE_ORDINARY_SLOTS
            ? state->header_count : MAL_SHAPE_ORDINARY_SLOTS)));
    roots[1] = mal_value_from_array_object(
        mal_intrinsic_new_dense_array(vm, (u32) (state->header_count * 2)));
    MalArrayObject *raw = mal_value_to_array_object(roots[1]);
    for (usize i = 0; i < state->header_count; i++) {
        MalNodeHttpCopiedHeader *header = &state->headers[i];
        usize canonical = i;
        for (usize j = 0; j < i; j++) {
            MalNodeHttpCopiedHeader *candidate = &state->headers[j];
            if (http_header_names_equal_ci(
                    header->name, header->name_len,
                    candidate->name, candidate->name_len)) {
                canonical = j;
                break;
            }
        }
        http_incoming_header_names(
            vm, header->name, header->name_len,
            canonical == i ? &roots[2] : nullptr, &roots[5]);
        if (canonical != i) roots[2] = canonical_names[canonical];
        canonical_names[i] = roots[2];
        roots[3] = http_ascii_value(vm, header->value, header->value_len);
        if (!http_incoming_header_add(
                vm, roots[0], roots[2], roots[3], &roots[4])) {
            mal_gc_unroot(&canonical_root);
            mal_gc_unroot(&root);
            return false;
        }
        roots[4] = roots[5];
        mal_array_object_store(
            raw,
            mal_key_index((i32) (i * 2)),
            roots[4]);
        mal_array_object_store(
            raw,
            mal_key_index((i32) (i * 2 + 1)),
            roots[3]);
    }
    *headers_out = roots[0];
    *raw_headers_out = roots[1];
    mal_gc_unroot(&canonical_root);
    mal_gc_unroot(&root);
    return true;
}

static void http_request_fail(MalNodeHttpRequestState *state, const char *message) {
    if (state->response_in_flight) {
        if (!state->ended) mal_http_conn_abort(state->conn);
        return;
    }
    if (!state->ended && state->conn != nullptr) {
        state->response_in_flight = true;
        state->head_committed = true;
        mal_http_conn_on_response_complete(
            state->conn, http_response_complete, state);
        mal_http_conn_respond(
            state->conn, 500, "Internal Server Error", nullptr, 0,
            message, strlen(message));
        state->ended = true;
    } else if (!state->ended && state->conn == nullptr) {
        http_request_queue_completion(state);
    }
}

static void http_request_dispatch(MalVm *vm, MalNodeHttpRequestState *state) {
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    state->pending = false;
    MalValue request_values[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan request_values_root;
    mal_gc_root(&request_values_root, request_values, countof(request_values));
    state->request = http_new_incoming_message(vm);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    state->response = http_new_server_response(vm);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    if (!http_response_index_insert(state) || !http_request_index_insert(state)) {
        mal_vm_throw_allocation_error(vm);
        goto fail;
    }

    MalValue roots[] = {
        state->request, state->response, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    http_incoming_message_dispatch_shapes(vm);
    if (!http_request_headers(vm, state, &roots[2], &roots[3])) {
        mal_vm_throw_allocation_error(vm);
        mal_gc_unroot(&root);
        goto fail;
    }
    roots[4] = http_server_socket_facade(vm, state->conn);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        goto fail;
    }
    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[6] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));

    request_values[0] = http_method_value(vm, state->method, state->method_len);
    request_values[1] = http_ascii_value(vm, state->target, state->target_len);
    request_values[2] = roots[2];
    request_values[3] = roots[3];
    request_values[4] = mal_value_from_string(mal_intrinsic_ascii(
        vm, (const byte *) (state->minor_version == 0 ? "1.0" : "1.1")));
    request_values[5] = mal_value_from_i32(1);
    request_values[6] = mal_value_from_i32(state->minor_version);
    request_values[7] = mal_value_new_boolean(
        state->request_transport_complete && state->request_end_success);
    request_values[8] = mal_value_new_boolean(false);
    request_values[9] = mal_value_new_boolean(false);
    request_values[10] = roots[5];
    request_values[11] = roots[6];
    request_values[12] = roots[4];
    request_values[13] = roots[4];

    if (mal_object_try_append_shaped_values(
            mal_value_to_object(roots[0]),
            &vm->node_http_incoming_message_dispatch_append_plan,
            request_values, (u32) countof(request_values))) {
        MAL_PERF_COUNT(http_incoming_message_shape_append_batches);
        MAL_PERF_ADD(http_incoming_message_shape_append_slots,
                     countof(request_values));
        MAL_PERF_ADD(http_incoming_message_slot_growths_avoided,
                     countof(request_values) - 1);
    } else {
        MAL_PERF_COUNT(http_incoming_message_shape_append_fallbacks);
        http_define_own(vm, roots[0], "method", request_values[0]);
        http_define_own(vm, roots[0], "url", request_values[1]);
        http_define_own(vm, roots[0], "headers", request_values[2]);
        http_define_own(vm, roots[0], "rawHeaders", request_values[3]);
        http_define_own(vm, roots[0], "httpVersion", request_values[4]);
        http_define_own(vm, roots[0], "httpVersionMajor", request_values[5]);
        http_define_own(vm, roots[0], "httpVersionMinor", request_values[6]);
        http_define_own(vm, roots[0], "complete", request_values[7]);
        http_define_own(vm, roots[0], "aborted", request_values[8]);
        http_define_own(vm, roots[0], "upgrade", request_values[9]);
        http_define_own(vm, roots[0], "trailers", request_values[10]);
        http_define_own(vm, roots[0], "rawTrailers", request_values[11]);
        http_define_own(vm, roots[0], "socket", request_values[12]);
        http_define_own(vm, roots[0], "connection", request_values[13]);
    }

    // Preserve construction and any unusual constructor layout. Only the exact
    // canonical source shape can append both dispatch fields with one slot growth.
    http_server_response_shapes(vm);
    MalValue response_values[] = {roots[4], roots[4]};
    if (mal_object_try_append_shaped_values(
            mal_value_to_object(roots[1]),
            &vm->node_http_server_response_dispatch_append_plan,
            response_values, (u32) countof(response_values))) {
        MAL_PERF_COUNT(http_response_shape_append_batches);
        MAL_PERF_ADD(http_response_shape_append_slots, countof(response_values));
        MAL_PERF_ADD(http_response_slot_growths_avoided,
                     countof(response_values) - 1);
    } else {
        MAL_PERF_COUNT(http_response_shape_append_fallbacks);
        http_define_own(vm, roots[1], "socket", roots[4]);
        http_define_own(vm, roots[1], "connection", roots[4]);
    }

    MalValue emit_args[] = {
        mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "request")),
        roots[0], roots[1],
    };
    if (!http_call_method(vm, state->server_receiver, "emit", emit_args, 3)) {
        mal_gc_unroot(&root);
        goto fail;
    }
    mal_gc_unroot(&root);
    mal_gc_unroot(&request_values_root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    return;

fail:
    mal_gc_unroot(&request_values_root);
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    http_request_fail(state, "request handler error");
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
}

static MalValue http_client_error(MalVm *vm, const char *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                       (const byte *) (message == nullptr ? "HTTP request failed" : message));
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    return error;
}

static MalValue http_client_coded_error(MalVm *vm, const char *message, const char *code) {
    MalValue roots[] = {http_client_error(vm, message), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) code));
    http_define(vm, roots[0], "code", roots[1]);
    mal_gc_unroot(&root);
    return roots[0];
}

/* Node's error for a failed exchange: a peer that hangs up before any response gives
 * "socket hang up" with ECONNRESET, a failed socket call gives libuv's
 * "connect ECONNREFUSED 127.0.0.1:80" or "read ECONNRESET" with errno, code and
 * syscall, a failed lookup gives "getaddrinfo ENOTFOUND host", and a deadline gives
 * ETIMEDOUT. */
static MalValue http_client_failure_error(
    MalVm *vm, const MalNodeHttpClientState *state, bool hung_up,
    const MalHttpClientResult *result) {
    MalHttpClientFailure failure = result == nullptr
        ? MAL_HTTP_CLIENT_FAILURE_OTHER : result->failure;
    if (hung_up) return http_client_coded_error(vm, "socket hang up", "ECONNRESET");
    if (failure == MAL_HTTP_CLIENT_FAILURE_TIMEOUT) {
        return http_client_coded_error(vm, result->error, "ETIMEDOUT");
    }
    if (failure != MAL_HTTP_CLIENT_FAILURE_SOCKET
        && failure != MAL_HTTP_CLIENT_FAILURE_CONNECT
        && failure != MAL_HTTP_CLIENT_FAILURE_RESOLUTION) {
        return http_client_error(vm, result == nullptr ? nullptr : result->error);
    }
    const char *code;
    const char *syscall = result->syscall;
    int error_number = -result->error_number;
    char message[512];
    if (failure == MAL_HTTP_CLIENT_FAILURE_RESOLUTION) {
        mal_node_dns_error_code(
            result->resolution.kind == MAL_DNS_ERROR_SYSTEM
                ? EAI_SYSTEM : result->resolution.resolver_code,
            result->resolution.system_errno, &code, &error_number);
        syscall = "getaddrinfo";
        snprintf(message, sizeof message, "%s %s %s", syscall, code, state->host);
    } else {
        code = mal_posix_fs_errno_name(result->error_number);
        if (failure == MAL_HTTP_CLIENT_FAILURE_CONNECT) {
            snprintf(message, sizeof message, "%s %s %s:%u", syscall, code,
                     result->address, (unsigned) result->port);
        } else {
            snprintf(message, sizeof message, "%s %s", syscall, code);
        }
    }
    MalValue roots[] = {http_client_error(vm, message), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    http_define(vm, roots[0], "errno", mal_value_from_i32(error_number));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) code));
    http_define(vm, roots[0], "code", roots[1]);
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) syscall));
    http_define(vm, roots[0], "syscall", roots[1]);
    if (failure == MAL_HTTP_CLIENT_FAILURE_CONNECT) {
        roots[1] = http_ascii_value(vm, result->address, strlen(result->address));
        http_define(vm, roots[0], "address", roots[1]);
        http_define(vm, roots[0], "port", mal_value_from_i32(result->port));
    } else if (failure == MAL_HTTP_CLIENT_FAILURE_RESOLUTION) {
        roots[1] = mal_value_from_string(mal_string_from_utf8(
            &vm->heap, (const byte *) state->host, strlen(state->host)));
        http_define(vm, roots[0], "hostname", roots[1]);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static bool http_client_response_headers(
    MalVm *vm, const MalHttpCodecHead *head,
    MalValue *headers_out, MalValue *raw_headers_out) {
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue canonical_names[MAL_HTTP_CODEC_FIELDS_MAX];
    for (usize i = 0; i < head->field_count; i++) {
        canonical_names[i] = mal_value_new_undefined();
    }
    MalRootSpan canonical_root;
    mal_gc_root(&canonical_root, canonical_names, (i32) head->field_count);
    roots[0] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    roots[1] = mal_value_from_array_object(
        mal_intrinsic_new_dense_array(vm, (u32) (head->field_count * 2)));
    MalArrayObject *raw = mal_value_to_array_object(roots[1]);
    for (usize i = 0; i < head->field_count; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        const char *name = (const char *) mal_http_codec_field_name(head, field);
        const char *value = (const char *) mal_http_codec_field_value(head, field);
        usize canonical = i;
        for (usize j = 0; j < i; j++) {
            const MalHttpCodecField *candidate = &head->fields[j];
            if (http_header_names_equal_ci(
                    name, field->name_length,
                    (const char *) mal_http_codec_field_name(head, candidate),
                    candidate->name_length)) {
                canonical = j;
                break;
            }
        }
        http_incoming_header_names(
            vm, name, field->name_length,
            canonical == i ? &roots[2] : nullptr, &roots[5]);
        if (canonical != i) roots[2] = canonical_names[canonical];
        canonical_names[i] = roots[2];
        roots[3] = http_ascii_value(vm, value, field->value_length);
        if (!http_incoming_header_add(
                vm, roots[0], roots[2], roots[3], &roots[4])) {
            mal_gc_unroot(&canonical_root);
            mal_gc_unroot(&root);
            return false;
        }
        roots[4] = roots[5];
        mal_array_object_store(
            raw,
            mal_key_index((i32) (i * 2)),
            roots[4]);
        mal_array_object_store(
            raw,
            mal_key_index((i32) (i * 2 + 1)),
            roots[3]);
    }
    *headers_out = roots[0];
    *raw_headers_out = roots[1];
    mal_gc_unroot(&canonical_root);
    mal_gc_unroot(&root);
    return true;
}

static void http_client_dispatch_write(
    MalVm *vm, MalNodeHttpClientState *state,
    const MalHttpClientProgress *progress) {
    MalNodeHttpResponseWrite *write = state->write_head;
    if (write == nullptr || !state->write_in_flight
        || write->token != progress->token
        || state->active_write_bytes != progress->length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Invalid HTTP upload completion");
        return;
    }
    write->offset += state->active_write_bytes;
    state->queued_write_bytes -= state->active_write_bytes;
    state->active_write_bytes = 0;
    state->write_in_flight = false;
    MalValue callback = mal_value_new_undefined();
    MalAsyncContext *callback_context = nullptr;
    if (write->offset == write->length) {
        state->write_head = write->next;
        if (state->write_head == nullptr) state->write_tail = nullptr;
        callback = write->callback;
        callback_context = write->async_context;
        free(write->bytes);
        free(write);
    }
    MalRootSpan root;
    mal_gc_root(&root, &callback, 1);
    if (!mal_value_is_undefined(callback)) {
        MalAsyncContextScope scope;
        mal_async_context_scope_enter(vm, &scope, callback_context);
        mal_vm_call_value(vm, callback, mal_value_new_undefined(), nullptr, 0);
        mal_async_context_scope_exit(vm, &scope);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW && progress->end_stream) {
        state->upload_complete = true;
        http_define(
            vm, state->request, "writableFinished", mal_value_new_boolean(true));
        http_define(vm, state->request, "writable", mal_value_new_boolean(false));
        http_emit(vm, state->request, "finish");
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && state->backpressured && !state->upload_complete
        && state->queued_write_bytes <= HTTP_RESPONSE_WRITE_LOW_WATER) {
        state->backpressured = false;
        http_emit(vm, state->request, "drain");
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        (void) http_client_pump(vm, state);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && state->response_complete && !state->upload_complete
        && !state->write_in_flight && !state->cancelled) {
        (void) mal_http_client_response_complete_ack(
            mal_host(vm), state->operation);
    }
    mal_gc_unroot(&root);
}

static void http_client_dispatch_head(
    MalVm *vm, MalNodeHttpClientState *state, const MalHttpCodecHead *head) {
    if (head == nullptr || state->response_head_seen) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Invalid HTTP response head");
        return;
    }
    MalCompletion completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR],
        nullptr, 0);
    if (completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {
        completion.value, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!http_client_response_headers(vm, head, &roots[1], &roots[2])) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[4] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[5] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    http_define_own(vm, roots[3], "encrypted", mal_value_new_boolean(false));
    http_define_own(vm, roots[3], "readable", mal_value_new_boolean(true));
    http_define_own(vm, roots[3], "writable", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "statusCode", mal_value_from_i32(head->status_code));
    http_define_own(
        vm, roots[0], "statusMessage",
        http_ascii_value(
            vm, (const char *) mal_http_codec_head_status(head),
            head->status_length));
    http_define_own(vm, roots[0], "headers", roots[1]);
    http_define_own(vm, roots[0], "rawHeaders", roots[2]);
    char version[32];
    int version_length = snprintf(
        version, sizeof(version), "%d.%d", head->major_version,
        head->minor_version);
    if (version_length < 0 || (usize) version_length >= sizeof(version)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Invalid HTTP response version");
        goto done;
    }
    http_define_own(
        vm, roots[0], "httpVersion",
        http_ascii_value(vm, version, (usize) version_length));
    http_define_own(
        vm, roots[0], "httpVersionMajor", mal_value_from_i32(head->major_version));
    http_define_own(
        vm, roots[0], "httpVersionMinor", mal_value_from_i32(head->minor_version));
    http_define_own(vm, roots[0], "complete", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "aborted", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "upgrade", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "trailers", roots[4]);
    http_define_own(vm, roots[0], "rawTrailers", roots[5]);
    http_define_own(vm, roots[0], "socket", roots[3]);
    http_define_own(vm, roots[0], "connection", roots[3]);
    state->response = roots[0];
    state->response_head_seen = true;
    MalValue emit_args[] = {
        mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "response")),
        roots[0],
    };
    (void) http_call_method(vm, state->request, "emit", emit_args, 2);
done:
    mal_gc_unroot(&root);
}

static void http_client_dispatch_progress(
    MalVm *vm, MalNodeHttpClientState *state, MalHttpClientProgress *progress) {
    if (progress == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Invalid HTTP client progress");
        return;
    }
    if (state->cancelled) return;
    if (progress->kind == MAL_HTTP_CLIENT_PROGRESS_WRITE_COMPLETE) {
        http_client_dispatch_write(vm, state, progress);
        return;
    }
    if (progress->kind == MAL_HTTP_CLIENT_PROGRESS_RESPONSE_HEAD) {
        http_client_dispatch_head(vm, state, progress->head);
        return;
    }
    if (progress->kind == MAL_HTTP_CLIENT_PROGRESS_RESPONSE_BODY) {
        if (!state->response_head_seen || state->response_complete
            || state->response_destroyed) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                               "Invalid HTTP response body progress");
            return;
        }
        byte *bytes = progress->bytes;
        progress->bytes = nullptr;
        MalValue chunk = mal_node_buffer_from_owned_bytes(
            vm, bytes, progress->length);
        MalRootSpan root;
        mal_gc_root(&root, &chunk, 1);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            (void) http_call_method(vm, state->response, "push", &chunk, 1);
        }
        mal_gc_unroot(&root);
        return;
    }
    if (progress->kind == MAL_HTTP_CLIENT_PROGRESS_RESPONSE_COMPLETE) {
        if (!state->response_head_seen || state->response_complete) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                               "Invalid HTTP response completion");
            return;
        }
        state->response_complete = true;
        http_define(vm, state->response, "complete", mal_value_new_boolean(true));
        MalValue end = mal_value_new_null();
        (void) http_call_method(vm, state->response, "push", &end, 1);
        if (!state->upload_complete && !state->write_in_flight
            && !state->cancelled) {
            (void) mal_http_client_response_complete_ack(
                mal_host(vm), state->operation);
        }
        return;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                       "Unknown HTTP client progress");
}

// Calls each pending upload callback once with `error`.
static void http_client_fail_writes(
    MalVm *vm, MalNodeHttpClientState *state, MalValue error) {
    if (mal_value_is_nil(error) || vm->completion.kind == MAL_COMPLETION_THROW) return;
    usize callback_count = 0;
    for (MalNodeHttpResponseWrite *write = state->write_head;
         write != nullptr; write = write->next) {
        if (!mal_value_is_undefined(write->callback)) callback_count++;
    }
    MalValue *callbacks = callback_count == 0 || callback_count > INT32_MAX
        ? nullptr : malloc(callback_count * sizeof(*callbacks));
    MalAsyncContext **callback_contexts =
        callbacks == nullptr ? nullptr
                             : malloc(callback_count * sizeof(*callback_contexts));
    if (callbacks != nullptr && callback_contexts != nullptr) {
        usize callback_index = 0;
        for (MalNodeHttpResponseWrite *write = state->write_head;
             write != nullptr; write = write->next) {
            if (mal_value_is_undefined(write->callback)) continue;
            callbacks[callback_index++] = write->callback;
            callback_contexts[callback_index - 1] = write->async_context;
            write->callback = mal_value_new_undefined();
        }
        MalRootSpan callbacks_root;
        mal_gc_root(&callbacks_root, callbacks, (i32) callback_count);
        MalRootSpan error_root;
        mal_gc_root(&error_root, &error, 1);
        for (usize i = 0; i < callback_count; i++) {
            MalAsyncContextScope scope;
            mal_async_context_scope_enter(vm, &scope, callback_contexts[i]);
            mal_vm_call_value(vm, callbacks[i], mal_value_new_undefined(), &error, 1);
            mal_async_context_scope_exit(vm, &scope);
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        }
        mal_gc_unroot(&error_root);
        mal_gc_unroot(&callbacks_root);
    }
    free(callback_contexts);
    free(callbacks);
}

// Node's IncomingMessage reports a destroy error only to 'error' listeners it already has.
static void http_client_close_response(
    MalVm *vm, MalNodeHttpClientState *state, MalValue error) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    if (!mal_value_is_nil(error)
        && mal_node_events_listener_count(vm, state->response, "error") > 0) {
        http_emit_error(vm, state->response, error);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        http_emit(vm, state->response, "close");
    }
}

static void http_client_dispatch_terminal(
    MalVm *vm, MalNodeHttpClientState *state, MalHostTask *task,
    const MalHttpClientResult *result) {
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    bool success = !state->cancelled && task->result == MAL_HOST_TERMINAL_OK
        && state->upload_complete && state->response_complete;
    MalHttpClientFailure failure = result == nullptr
        ? MAL_HTTP_CLIENT_FAILURE_OTHER : result->failure;
    bool hung_up = failure == MAL_HTTP_CLIENT_FAILURE_PEER_CLOSED
        || (task->result == MAL_HOST_TERMINAL_CANCELLED && state->ended);
    bool response_cut = !success && state->response_head_seen && !state->response_complete;
    bool before_connection = failure == MAL_HTTP_CLIENT_FAILURE_CONNECT
        || failure == MAL_HTTP_CLIENT_FAILURE_RESOLUTION;
    // [0] is the request's error and [1] the response's.
    MalValue errors[] = {state->destroy_error, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, errors, countof(errors));
    if (state->response_destroyed) {
        errors[1] = errors[0];
    } else if (!success) {
        // A hang-up that cuts a response short is the response's failure alone.
        if (mal_value_is_nil(errors[0]) && !(response_cut && hung_up)) {
            errors[0] = http_client_failure_error(vm, state, hung_up, result);
        }
        if (response_cut) errors[1] = http_client_coded_error(vm, "aborted", "ECONNRESET");
    }
    // Node's contract for a socket deadline: 'timeout' first, then the error the
    // deadline caused, then 'close'. This runs once per request, so a listener that
    // destroys the request from 'timeout' cannot produce a second terminal pass.
    if (!success && failure == MAL_HTTP_CLIENT_FAILURE_TIMEOUT
        && vm->completion.kind != MAL_COMPLETION_THROW) {
        http_emit(vm, state->request, "timeout");
    }
    if (!success && !before_connection) {
        http_client_fail_writes(
            vm, state, mal_value_is_nil(errors[0]) ? errors[1] : errors[0]);
    }
    if (state->aborted && vm->completion.kind != MAL_COMPLETION_THROW) {
        http_emit(vm, state->request, "abort");
    }
    if (!mal_value_is_nil(errors[0]) && vm->completion.kind != MAL_COMPLETION_THROW) {
        http_emit_error(vm, state->request, errors[0]);
    }
    if (response_cut && !state->response_destroyed
        && vm->completion.kind != MAL_COMPLETION_THROW) {
        http_define(vm, state->response, "aborted", mal_value_new_boolean(true));
        http_define(vm, state->response, "destroyed", mal_value_new_boolean(true));
        http_define(vm, state->response, "readable", mal_value_new_boolean(false));
        http_emit(vm, state->response, "aborted");
    }
    // res.destroy() closes the response before the request; a response the connection
    // cut short closes after it, as Node's socket close handler orders them.
    if (state->response_destroyed) http_client_close_response(vm, state, errors[1]);
    http_define(vm, state->request, "destroyed", mal_value_new_boolean(true));
    http_define(vm, state->request, "writable", mal_value_new_boolean(false));
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        http_emit(vm, state->request, "close");
    }
    if (response_cut && !state->response_destroyed) {
        http_client_close_response(vm, state, errors[1]);
    }
    if (before_connection && vm->completion.kind != MAL_COMPLETION_THROW) {
        // Node fails writes queued on a socket that never connected after it closes.
        errors[1] = http_client_coded_error(
            vm, "Socket closed before the connection was established",
            "ERR_SOCKET_CLOSED_BEFORE_CONNECTION");
        http_client_fail_writes(vm, state, errors[1]);
        // end()'s callback waits for 'finish', which a request that never connected
        // cannot reach; Node fails it with the writes.
        if (!mal_value_is_undefined(state->end_callback)
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            MalAsyncContextScope scope;
            mal_async_context_scope_enter(vm, &scope, state->end_context);
            mal_vm_call_value(vm, state->end_callback, mal_value_new_undefined(), &errors[1], 1);
            mal_async_context_scope_exit(vm, &scope);
        }
    }
    mal_gc_unroot(&root);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
    }
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
}

static void http_client_dispatch_terminating(
    MalVm *vm, MalNodeHttpClientState *state, MalHostTask *task,
    const MalHttpClientResult *result) {
    state->next = http_clients_terminating;
    http_clients_terminating = state;
    http_client_dispatch_terminal(vm, state, task, result);
    http_clients_terminating = state->next;
    http_client_free(state);
}

static bool http_client_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) return false;
    MalNodeHttpClientState **pending_link = &http_clients;
    while (*pending_link != nullptr) {
        MalNodeHttpClientState *state = *pending_link;
        if (state->vm != vm || !state->terminal_pending) {
            pending_link = &state->next;
            continue;
        }
        MalAsyncContextScope async_scope;
        mal_async_context_scope_enter(
            vm, &async_scope, state->async_context);
        *pending_link = state->next;
        MalHostTask task = {
            .kind = MAL_HOST_TASK_TERMINAL,
            .result = MAL_HOST_TERMINAL_CANCELLED,
        };
        http_client_dispatch_terminating(vm, state, &task, nullptr);
        mal_async_context_scope_exit(vm, &async_scope);
        return true;
    }
    if (mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask task;
    if (!mal_host_peek_task(&host->tasks, &task)) return false;
    MalNodeHttpClientState **link = &http_clients;
    while (*link != nullptr
           && ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    if (*link == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    MalNodeHttpClientState *state = *link;
    MalValue roots[] = {
        state->request, state->response, state->end_callback,
        state->destroy_error, state->response_destroy_error,
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope async_scope;
    mal_async_context_scope_enter(vm, &async_scope, state->async_context);
    void *data = mal_host_task_take_data(&host->tasks, &task);
    if (task.kind == MAL_HOST_TASK_PROGRESS) {
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_realm_switch(vm, state->realm);
#endif
        http_client_dispatch_progress(vm, state, data);
        if (vm->completion.kind == MAL_COMPLETION_THROW && !state->cancelled) {
            http_client_cancel(vm, state, false, vm->completion.value);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            vm->completion = (MalCompletion) {
                .kind = MAL_COMPLETION_NORMAL,
                .value = mal_value_new_undefined(),
            };
        }
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
        mal_http_client_progress_free(data);
    } else {
        *link = state->next;
        http_client_dispatch_terminating(vm, state, &task, data);
        mal_http_client_result_free(data);
    }
    mal_async_context_scope_exit(vm, &async_scope);
    mal_host_task_release(&host->tasks, &task);
    mal_gc_unroot(&root);
    return true;
}

static bool http_server_drain_tls(MalVm *vm, MalNodeHttpServerState *state);
static void http_server_free_tls_errors(MalNodeHttpServerState *server);

bool mal_node_http_drain(MalVm *vm) {
    MAL_PERF_COUNT(http_drain_calls);
    if (mal_http_client_drain_dns(mal_host(vm))) return true;
    if (http_client_drain(vm)) return true;
    MalNodeHttpServerState **link = &http_servers;
    while (*link != nullptr) {
        MalNodeHttpServerState *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        if (state->listening_pending) {
            state->listening_pending = false;
            MalAsyncContextScope scope;
            mal_async_context_scope_enter(vm, &scope, state->async_context);
            http_emit(vm, state->receiver, "listening");
            mal_async_context_scope_exit(vm, &scope);
            return true;
        }
        if (http_server_drain_tls(vm, state)) return true;
        if (state->close_ready) {
            MAL_PERF_COUNT(http_close_scans);
            if (mal_host(vm)->pending_http_completions > 0) {
                link = &state->next;
                continue;
            }
            MalValue receiver = state->receiver;
            MalAsyncContext *async_context = state->async_context;
            MalRootSpan root;
            mal_gc_root(&root, &receiver, 1);
            *link = state->next;
            http_server_free_tls_errors(state);
            free(state);
            MalAsyncContextScope scope;
            mal_async_context_scope_enter(vm, &scope, async_context);
            http_emit(vm, receiver, "close");
            mal_async_context_scope_exit(vm, &scope);
            mal_gc_unroot(&root);
            return true;
        }
        link = &state->next;
    }
    MalHost *host = mal_host(vm);
    MalNodeHttpRequestState *request = host->ready_http_requests;
    if (request != nullptr) {
        host->ready_http_requests = request->ready_next;
        if (host->ready_http_requests == nullptr) {
            host->ready_http_requests_tail = nullptr;
        }
        MalNodeHttpRequestReadyKind kind = request->ready_kind;
        request->ready_kind = HTTP_REQUEST_READY_NONE;
        request->ready_next = nullptr;
        MalAsyncContextScope async_scope;
        mal_async_context_scope_enter(
            vm, &async_scope, request->async_context);
        if (kind == HTTP_REQUEST_READY_DISPATCH) {
            MAL_PERF_COUNT(http_dispatch_dequeues);
            if (request->finish_pending) {
                (void) http_request_enqueue_ready(
                    request, HTTP_REQUEST_READY_COMPLETION);
            } else {
                http_request_dispatch(vm, request);
                if (vm->completion.kind != MAL_COMPLETION_THROW) {
                    http_request_schedule_write(request);
                    http_request_schedule_response(request);
                    http_request_schedule_read(request);
                }
            }
        } else if (kind == HTTP_REQUEST_READY_READ) {
#if MAL_REALMS
            MalRealm *saved_realm = vm->current_realm;
            mal_realm_switch(vm, request->realm);
#endif
            http_request_dispatch_read(vm, request);
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
            http_request_schedule_write(request);
            http_request_schedule_response(request);
            http_request_schedule_read(request);
        } else if (kind == HTTP_REQUEST_READY_WRITE) {
            request->write_ready_pending = false;
#if MAL_REALMS
            MalRealm *saved_realm = vm->current_realm;
            mal_realm_switch(vm, request->realm);
#endif
            http_response_dispatch_write(vm, request);
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
            http_request_schedule_write(request);
            http_request_schedule_response(request);
            http_request_schedule_read(request);
            if (request->finish_pending
                && request->ready_kind == HTTP_REQUEST_READY_NONE) {
                (void) http_request_enqueue_ready(
                    request, HTTP_REQUEST_READY_COMPLETION);
            }
        } else if (kind == HTTP_REQUEST_READY_RESPONSE) {
#if MAL_REALMS
            MalRealm *saved_realm = vm->current_realm;
            mal_realm_switch(vm, request->realm);
#endif
            http_response_dispatch_terminal(vm, request);
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
            http_request_schedule_write(request);
            http_request_schedule_read(request);
        } else if (kind == HTTP_REQUEST_READY_COMPLETION) {
            request->finish_pending = false;
            host->pending_http_completions--;
            MAL_PERF_COUNT(http_completion_dequeues);
            http_request_remove(request);
        }
        mal_async_context_scope_exit(vm, &async_scope);
        return true;
    }
    return false;
}

/*
 * The transport resource policy, exposed under Node's property names. Before
 * listen() these are ordinary writable properties on the server; listen() latches
 * them into the transport and swaps them for accessors so a later assignment
 * retunes the running server instead of being silently ignored.
 *
 * Zero means "the engine default", matching MalHttpServerLimits: these bounds can
 * be retuned but never switched off, so Node's "0 disables the timeout" reading is
 * deliberately not carried over.
 */
typedef enum MalNodeHttpLimit {
    HTTP_LIMIT_HEADERS_TIMEOUT,
    HTTP_LIMIT_REQUEST_TIMEOUT,
    HTTP_LIMIT_KEEP_ALIVE_TIMEOUT,
    HTTP_LIMIT_MAX_CONNECTIONS,
} MalNodeHttpLimit;

static const char *const http_limit_names[] = {
    "headersTimeout", "requestTimeout", "keepAliveTimeout", "maxConnections",
};
static const u32 http_limit_defaults[] = {60000, 300000, 5000, 0};

static u32 *http_limit_field(
    MalNodeHttpServerState *state, MalNodeHttpLimit limit) {
    switch (limit) {
        case HTTP_LIMIT_HEADERS_TIMEOUT: return &state->headers_timeout_ms;
        case HTTP_LIMIT_REQUEST_TIMEOUT: return &state->request_timeout_ms;
        case HTTP_LIMIT_KEEP_ALIVE_TIMEOUT: return &state->keep_alive_timeout_ms;
        default: return &state->max_connections;
    }
}

static bool http_server_limit_value(MalVm *vm, MalValue value, u32 *out) {
    f64 number = mal_ops_is_number(value) ? mal_ops_number_as_f64(value) : (f64) NAN;
    if (!isfinite(number) || floor(number) != number || number < 0
        || number > 2147483647.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "HTTP server limits must be integers from 0 through "
                           "2147483647");
        return false;
    }
    *out = (u32) number;
    return true;
}

static bool http_server_push_limits(MalNodeHttpServerState *state) {
    MalHttpServerLimits limits = {
        .headers_timeout_ms = state->headers_timeout_ms,
        .request_timeout_ms = state->request_timeout_ms,
        .keep_alive_timeout_ms = state->keep_alive_timeout_ms,
        .max_connections = state->max_connections,
    };
    return mal_http_server_configure_limits(state->native, &limits);
}

static MalValue http_server_limit_get(
    MalVm *vm, MalValue receiver, MalNodeHttpLimit limit) {
    (void) vm;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state == nullptr) return mal_value_new_undefined();
    return mal_value_from_f64((f64) *http_limit_field(state, limit));
}

static MalValue http_server_limit_set(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalNodeHttpLimit limit) {
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state == nullptr || state->native == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Server is not running");
        return mal_value_new_undefined();
    }
    u32 parsed;
    if (argc < 1 || !http_server_limit_value(vm, args[0], &parsed)) {
        return mal_value_new_undefined();
    }
    u32 *field = http_limit_field(state, limit);
    u32 previous = *field;
    *field = parsed;
    if (!http_server_push_limits(state)) {
        *field = previous;
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to configure the HTTP server limit");
    }
    return mal_value_new_undefined();
}

#define HTTP_SERVER_LIMIT_ACCESSORS(suffix, limit)                            \
    static MalValue http_server_get_##suffix(                                 \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,         \
        MalValue new_target, MalValue callee) {                               \
        (void) args;                                                          \
        (void) argc;                                                          \
        (void) new_target;                                                    \
        (void) callee;                                                        \
        return http_server_limit_get(vm, receiver, limit);                    \
    }                                                                         \
    static MalValue http_server_set_##suffix(                                 \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,         \
        MalValue new_target, MalValue callee) {                               \
        (void) new_target;                                                    \
        (void) callee;                                                        \
        return http_server_limit_set(vm, receiver, args, argc, limit);        \
    }

HTTP_SERVER_LIMIT_ACCESSORS(headers_timeout, HTTP_LIMIT_HEADERS_TIMEOUT)
HTTP_SERVER_LIMIT_ACCESSORS(request_timeout, HTTP_LIMIT_REQUEST_TIMEOUT)
HTTP_SERVER_LIMIT_ACCESSORS(keep_alive_timeout, HTTP_LIMIT_KEEP_ALIVE_TIMEOUT)
HTTP_SERVER_LIMIT_ACCESSORS(max_connections, HTTP_LIMIT_MAX_CONNECTIONS)
#undef HTTP_SERVER_LIMIT_ACCESSORS

static void http_server_install_limit_accessors(MalVm *vm, MalValue receiver) {
    static const MalNativeFunctionCallback getters[] = {
        http_server_get_headers_timeout, http_server_get_request_timeout,
        http_server_get_keep_alive_timeout, http_server_get_max_connections,
    };
    static const MalNativeFunctionCallback setters[] = {
        http_server_set_headers_timeout, http_server_set_request_timeout,
        http_server_set_keep_alive_timeout, http_server_set_max_connections,
    };
    for (usize i = 0; i < countof(http_limit_names); i++) {
        mal_intrinsic_define_accessor_n(
            vm, mal_value_to_object(receiver),
            mal_intrinsic_string_key(vm, (const byte *) http_limit_names[i]),
            (const byte *) http_limit_names[i], 0, getters[i],
            (const byte *) http_limit_names[i], 1, setters[i],
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
}

/* Read the limits the application configured (constructor options or plain
 * assignment) into the state that backs the accessors installed afterwards. */
static bool http_server_collect_limits(
    MalVm *vm, MalValue receiver, MalNodeHttpServerState *state) {
    for (usize i = 0; i < countof(http_limit_names); i++) {
        MalValue value;
        if (!mal_vm_get_property(
                vm, receiver,
                mal_intrinsic_string_key(vm, (const byte *) http_limit_names[i]),
                &value)) {
            return false;
        }
        u32 parsed = http_limit_defaults[i];
        if (!mal_value_is_undefined(value)
            && !http_server_limit_value(vm, value, &parsed)) {
            return false;
        }
        *http_limit_field(state, (MalNodeHttpLimit) i) = parsed;
    }
    return true;
}

static bool http_ipv4_host(MalValue value, char out[16]) {
    if (!mal_value_is_string(value)) return false;
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    if (length == 0 || length >= 16) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] > 0x7f) return false;
        out[i] = (char) units[i];
    }
    out[length] = '\0';
    return true;
}

/* The connection's socket state, attached now so a close before dispatch unqueues it. */
static MalNodeHttpSocketState *http_socket_state_for(MalNodeHttpServerState *server, MalHttpConn *conn) {
    MalNodeHttpSocketState *state = mal_http_conn_context(conn);
    if (state != nullptr) return state;
    state = malloc(sizeof(*state));
    if (state == nullptr) return nullptr;
    *state = (MalNodeHttpSocketState) {
        .vm = server->vm, .receiver = mal_value_new_undefined(), .conn = conn, .next = http_sockets,
    };
    if (!mal_http_conn_attach_context(conn, state, http_socket_release)) {
        free(state);
        return nullptr;
    }
    if (http_sockets != nullptr) http_sockets->previous = state;
    http_sockets = state;
    return state;
}

static void http_server_tls_event(void *data, MalHttpConn *conn, int error) {
    MalNodeHttpServerState *server = data;
    if (error != 0) {
        MalNodeHttpTlsError *entry = malloc(sizeof(*entry));
        if (entry == nullptr) return;
        *entry = (MalNodeHttpTlsError) {.error = error};
        if (error == EPROTO) mal_http_conn_tls_failure(conn, entry->failure, sizeof(entry->failure));
        if (server->tls_errors_tail == nullptr) server->tls_errors = entry;
        else server->tls_errors_tail->next = entry;
        server->tls_errors_tail = entry;
        return;
    }
    MalNodeHttpSocketState *state = http_socket_state_for(server, conn);
    if (state == nullptr || state->secure_server != nullptr) return;
    state->secure_server = server;
    if (server->secure_tail == nullptr) server->secure_head = state;
    else server->secure_tail->secure_next = state;
    server->secure_tail = state;
}

static void http_server_tls_hello(void *data, MalHttpConn *conn, const byte *name, usize length) {
    MalNodeHttpServerState *server = data;
    MalNodeHttpSocketState *state = http_socket_state_for(server, conn);
    if (state == nullptr || state->hello_server != nullptr) {
        (void) mal_http_conn_tls_select(conn, nullptr);
        return;
    }
    if (name != nullptr) {
        state->hello_name = malloc(length + 1);
        if (state->hello_name == nullptr) {
            (void) mal_http_conn_tls_select(conn, nullptr);
            return;
        }
        memcpy(state->hello_name, name, length);
        state->hello_name_length = length;
    }
    state->hello_pending = true;
    state->hello_server = server;
    if (server->hello_tail == nullptr) server->hello_head = state;
    else server->hello_tail->hello_next = state;
    server->hello_tail = state;
}

void mal_node_http_server_enable_sni(MalValue server) {
    MalNodeHttpServerState *state = http_server_state(server);
    if (state != nullptr && state->native != nullptr) mal_http_server_set_tls_hello(state->native, http_server_tls_hello);
}

static MalNodeHttpSocketState *http_socket_for_receiver(MalValue receiver) {
    for (MalNodeHttpSocketState *state = http_sockets; state != nullptr; state = state->next) {
        if (state->receiver == receiver) return state;
    }
    return nullptr;
}

static void http_sni_fail(
    MalVm *vm, MalNodeHttpSocketState *state, MalValue socket, MalValue server, MalValue error) {
    state->hello_pending = false;
    MalValue emitted[] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "tlsClientError")), error, socket};
    MalRootSpan root;
    mal_gc_root(&root, emitted, countof(emitted));
    // The error is reported here, so the close that follows must not report a hang-up too.
    mal_http_conn_tls_mark_reported(state->conn);
    (void) http_call_method(vm, server, "emit", emitted, 3);
    mal_http_conn_abort(state->conn);
    mal_gc_unroot(&root);
}

/* Node's loadSNI callback: an error ends the handshake, a context replaces the default. */
static MalValue http_sni_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue socket = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue server_value = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    MalNodeHttpSocketState *state = http_socket_for_receiver(socket);
    if (state == nullptr || state->conn == nullptr || !state->hello_pending) return mal_value_new_undefined();
    state->hello_pending = false;
    MalValue roots[] = {socket, server_value, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_truthy(roots[2])) {
        http_sni_fail(vm, state, roots[0], roots[1], roots[2]);
    } else {
        MalTlsServerConfig *config = mal_value_is_object(roots[3])
            ? mal_node_net_context_config(vm, roots[1], roots[3]) : nullptr;
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            (void) mal_http_conn_tls_select(state->conn, config);
        }
        mal_tls_server_config_free(&config);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool http_server_drain_hello(MalVm *vm, MalNodeHttpServerState *server) {
    MalNodeHttpSocketState *state = server->hello_head;
    if (state == nullptr) return false;
    http_socket_unqueue_hello(state);
    MalValue roots[] = {server->receiver, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, server->async_context);
    MalHttpConn *conn = state->conn;
    if (state->hello_name == nullptr
        || !mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "_malSNICallback"), &roots[1])) {
        state->hello_pending = false;
        (void) mal_http_conn_tls_select(conn, nullptr);
    } else if (mal_value_is_callable(roots[1])) {
        roots[2] = http_server_socket_facade(vm, conn);
        roots[3] = mal_value_from_string(mal_string_from_utf8(&vm->heap, (const byte *) state->hello_name,
            state->hello_name_length));
        MalValue slots[] = {roots[2], roots[0]};
        roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) ""), 2, http_sni_callback, slots, 2));
        MalValue call_args[] = {roots[3], roots[4]};
        MalCompletion called = mal_vm_call_value(vm, roots[1], roots[0], call_args, 2);
        // Node catches an SNICallback that throws and fails the connection with that error;
        // dropping it would leave the handshake waiting forever.
        if (called.kind == MAL_COMPLETION_THROW) {
            roots[3] = called.value;
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
            MalNodeHttpSocketState *socket = http_socket_for_receiver(roots[2]);
            if (socket != nullptr && socket->conn != nullptr) http_sni_fail(vm, socket, roots[2], roots[0], roots[3]);
        }
    } else {
        state->hello_pending = false;
        roots[2] = mal_node_net_sni_match(vm, roots[0], (const byte *) state->hello_name, state->hello_name_length);
        MalTlsServerConfig *config = mal_value_is_object(roots[2])
            ? mal_node_net_context_config(vm, roots[0], roots[2]) : nullptr;
        if (vm->completion.kind != MAL_COMPLETION_THROW) (void) mal_http_conn_tls_select(conn, config);
        mal_tls_server_config_free(&config);
    }
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
    return true;
}

static void http_server_free_tls_errors(MalNodeHttpServerState *server) {
    while (server->tls_errors != nullptr) {
        MalNodeHttpTlsError *next = server->tls_errors->next;
        free(server->tls_errors);
        server->tls_errors = next;
    }
    server->tls_errors_tail = nullptr;
}

static MalValue http_tls_client_error(MalVm *vm, int error, const char *failure) {
    if (error == ECONNRESET) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "socket hang up", "ECONNRESET");
    } else if (failure[0] != '\0') {
        char code[64];
        usize length = (usize) snprintf(code, sizeof(code), "ERR_SSL_%s", failure);
        for (usize i = 8; i < length && i < sizeof(code); i++) {
            char c = code[i];
            code[i] = c == ' ' ? '_' : c >= 'a' && c <= 'z' ? (char) (c - 32) : c;
        }
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, failure, code);
    } else {
        // Without a known cause, every protocol failure shares one code.
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "TLS handshake failed",
            "ERR_SSL_SSL_HANDSHAKE_FAILURE");
    }
    MalValue value = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return value;
}

/* Node's https.Server is a tls.Server, so its handshake outcomes reach JavaScript first. */
static bool http_server_drain_tls(MalVm *vm, MalNodeHttpServerState *state) {
    if (http_server_drain_hello(vm, state)) return true;
    if (state->secure_head == nullptr && state->tls_errors == nullptr) return false;
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, state->async_context);
    if (state->secure_head != nullptr) {
        MalNodeHttpSocketState *socket = state->secure_head;
        http_socket_unqueue_secure(socket);
        roots[1] = http_server_socket_facade(vm, socket->conn);
        roots[0] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "secureConnection"));
    } else {
        MalNodeHttpTlsError *entry = state->tls_errors;
        state->tls_errors = entry->next;
        if (state->tls_errors == nullptr) state->tls_errors_tail = nullptr;
        int error = entry->error;
        char failure[sizeof(entry->failure)];
        memcpy(failure, entry->failure, sizeof(failure));
        free(entry);
        roots[1] = http_tls_client_error(vm, error, failure);
        if (vm->completion.kind != MAL_COMPLETION_THROW) roots[2] = http_server_socket_facade(vm, nullptr);
        roots[0] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "tlsClientError"));
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        (void) http_call_method(vm, state->receiver, "emit", roots,
            mal_value_is_undefined(roots[2]) ? 2 : 3);
    }
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
    return true;
}

bool mal_node_http_server_replace_tls(MalValue server, MalTlsServerConfig *config) {
    MalNodeHttpServerState *state = http_server_state(server);
    return state != nullptr && state->native != nullptr
        && mal_http_server_replace_tls(state->native, config);
}

bool mal_node_http_server_set_tls(MalValue server, MalTlsServerConfig *config) {
    MalNodeHttpServerState *state = http_server_state(server);
    return state != nullptr && state->native != nullptr
        && mal_http_server_set_tls(state->native, config, http_server_tls_event, state);
}

static MalValue http_server_listen(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(receiver) || argc < 1 || !mal_ops_is_number(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The port argument must be a number");
        return mal_value_new_undefined();
    }
    f64 number = mal_ops_number_as_f64(args[0]);
    if (!isfinite(number) || number < 0 || number > 65535 || floor(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The port argument must be between 0 and 65535");
        return mal_value_new_undefined();
    }
    if (http_server_state(receiver) != nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Listen method has been called more than once");
        return mal_value_new_undefined();
    }

    char host[16] = "0.0.0.0";
    MalValue callback = mal_value_new_undefined();
    if (argc > 1 && mal_value_is_string(args[1])) {
        if (!http_ipv4_host(args[1], host)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The host argument must be a numeric IPv4 address");
            return mal_value_new_undefined();
        }
        if (argc > 2) callback = args[2];
    } else if (argc > 1) {
        callback = args[1];
    }
    if (!mal_value_is_undefined(callback) && !mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The callback argument must be a function");
        return mal_value_new_undefined();
    }

    MalNodeHttpServerState *state = calloc(1, sizeof(MalNodeHttpServerState));
    if (state == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to allocate server state");
        return mal_value_new_undefined();
    }
    state->vm = vm;
    state->receiver = receiver;
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    if (!http_server_collect_limits(vm, receiver, state)) {
        free(state);
        return mal_value_new_undefined();
    }
    MalHttpServer *native = mal_http_server_start_stream_handler(
        vm, host, (u16) number, http_queue_request, state);
    if (native == nullptr) {
        free(state);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to listen on the requested address");
        return mal_value_new_undefined();
    }
    state->native = native;
    state->port = mal_http_server_port(native);
    memcpy(state->host, host, sizeof(state->host));
    state->listening_pending = true;
    state->next = http_servers;
    http_servers = state;
    // In force before the reactor can accept: this call precedes the first yield.
    if (!http_server_push_limits(state)) {
        mal_http_server_close(native, http_native_close_complete, state);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to configure the HTTP server limits");
        return mal_value_new_undefined();
    }
    http_server_install_limit_accessors(vm, receiver);

    if (!mal_value_is_undefined(callback)
        && !http_once(vm, receiver, "listening", callback)) {
        mal_http_server_close(native, http_native_close_complete, state);
        return mal_value_new_undefined();
    }
    return receiver;
}

static MalValue http_server_address(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state == nullptr || state->native == nullptr || state->closing) {
        return mal_value_new_null();
    }
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *object = mal_value_to_object(roots[0]);
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(
        vm, (const byte *) state->host));
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(
        vm, (const byte *) "IPv4"));
    mal_intrinsic_define_data(vm, object, (const byte *) "address", roots[1], HTTP_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "family", roots[2], HTTP_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "port",
                              mal_value_from_i32((i32) state->port), HTTP_VISIBLE);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_server_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state == nullptr || state->native == nullptr || state->closing) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Server is not running");
        return mal_value_new_undefined();
    }
    if (argc > 0 && !mal_value_is_undefined(args[0])) {
        if (!mal_value_is_callable(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The callback argument must be a function");
            return mal_value_new_undefined();
        }
        MalValue bound = mal_async_context_bind_callback(
            vm, args[0], mal_async_context_capture(vm));
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !http_once(vm, receiver, "close", bound)) {
            return mal_value_new_undefined();
        }
    }
    state->closing = true;
    mal_http_server_close(state->native, http_native_close_complete, state);
    return receiver;
}

static MalValue http_server_close_all_connections(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state != nullptr && state->native != nullptr) {
        mal_http_server_close_connections(state->native, false);
    }
    return mal_value_new_undefined();
}

static MalValue http_server_close_idle_connections(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state != nullptr && state->native != nullptr) {
        mal_http_server_close_connections(state->native, true);
    }
    return mal_value_new_undefined();
}

static MalValue http_construct(
    MalVm *vm, MalValue receiver, MalValue new_target, MalValue callee,
    MalIntrinsic parent_slot) {
    MalValue roots[] = {
        receiver, new_target, callee, vm->intrinsics[parent_slot],
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    if (mal_value_is_undefined(roots[1]) && mal_value_is_object(roots[0])) {
        mal_vm_call_value(vm, roots[3], roots[0], nullptr, 0);
        MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
            ? mal_value_new_undefined() : roots[0];
        mal_gc_unroot(&root);
        return result;
    }

    MalValue target = mal_value_is_undefined(roots[1]) ? roots[2] : roots[1];
    roots[4] = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(roots[4])
        ? mal_value_to_object(roots[4])
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    roots[0] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    mal_vm_call_value(vm, roots[3], roots[0], nullptr, 0);
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_incoming_message_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    return http_construct(vm, receiver, new_target, callee,
                          MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR);
}

static MalValue http_client_request_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    MalValue result = http_construct(vm, receiver, new_target, callee,
                                     MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR);
    if (mal_value_is_object(result)) {
        http_define_own(vm, result, "finished", mal_value_new_boolean(false));
        http_define_own(vm, result, "writable", mal_value_new_boolean(true));
        http_define_own(vm, result, "writableEnded", mal_value_new_boolean(false));
        http_define_own(vm, result, "writableFinished", mal_value_new_boolean(false));
        http_define_own(vm, result, "destroyed", mal_value_new_boolean(false));
        http_define_own(vm, result, "aborted", mal_value_new_boolean(false));
        http_define_own(vm, result, "reusedSocket", mal_value_new_boolean(false));
    }
    return result;
}

static MalValue http_server_response_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    MalValue result = http_construct(vm, receiver, new_target, callee,
                                     MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR);
    if (mal_value_is_object(result)) {
        http_server_response_shapes(vm);
        MalValue values[] = {
            mal_value_from_i32(200), mal_value_new_undefined(),
            mal_value_new_boolean(false), mal_value_new_null(),
            mal_value_new_boolean(false), mal_value_new_boolean(false),
            mal_value_new_boolean(false),
        };
        if (mal_object_try_append_shaped_values(
                mal_value_to_object(result),
                &vm->node_http_server_response_constructor_append_plan,
                values, (u32) countof(values))) {
            MAL_PERF_COUNT(http_response_constructor_shape_append_batches);
            MAL_PERF_ADD(http_response_constructor_shape_append_slots,
                         countof(values));
            MAL_PERF_ADD(http_response_constructor_slot_growths_avoided,
                         countof(values) - 1);
        } else {
            MAL_PERF_COUNT(http_response_constructor_shape_append_fallbacks);
            http_define_own(vm, result, "statusCode", values[0]);
            http_define_own(vm, result, "statusMessage", values[1]);
            http_define_own(vm, result, "headersSent", values[2]);
            http_define_own(vm, result, "_header", values[3]);
            http_define_own(vm, result, "finished", values[4]);
            http_define_own(vm, result, "writableEnded", values[5]);
            http_define_own(vm, result, "writableFinished", values[6]);
        }
    }
    return result;
}

static MalValue http_server_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue listener = mal_value_new_undefined();
    MalValue options = mal_value_new_undefined();
    if (argc > 0 && mal_value_is_callable(args[0])) {
        listener = args[0];
    } else {
        if (argc > 0 && !mal_value_is_undefined(args[0])
            && !mal_value_is_null(args[0]) && !mal_value_is_object(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The options argument must be an object");
            return mal_value_new_undefined();
        }
        if (argc > 0 && mal_value_is_object(args[0])) options = args[0];
        if (argc > 1) listener = args[1];
    }
    u32 limits[countof(http_limit_names)];
    for (usize i = 0; i < countof(http_limit_names); i++) {
        MalValue value = mal_value_new_undefined();
        limits[i] = http_limit_defaults[i];
        if (mal_value_is_object(options)
            && !mal_vm_get_property(
                vm, options,
                mal_intrinsic_string_key(vm, (const byte *) http_limit_names[i]),
                &value)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(value)
            && !http_server_limit_value(vm, value, &limits[i])) {
            return mal_value_new_undefined();
        }
    }
    if (!mal_value_is_undefined(listener) && !mal_value_is_callable(listener)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The listener argument must be a function");
        return mal_value_new_undefined();
    }

    MalValue roots[] = {
        new_target, callee, listener, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue target = mal_value_is_undefined(roots[0]) ? roots[1] : roots[0];
    roots[3] = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(roots[3])
        ? mal_value_to_object(roots[3])
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    roots[4] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    mal_vm_call_value(vm,
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR],
        roots[4], nullptr, 0);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        for (usize i = 0; i < countof(http_limit_names); i++) {
            http_define_own(vm, roots[4], http_limit_names[i],
                            mal_value_from_f64((f64) limits[i]));
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && !mal_value_is_undefined(roots[2])) {
        roots[5] = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "request"));
        MalPropertyLookup on = mal_object_get_own(
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]),
            mal_intrinsic_string_key(vm, (const byte *) "on"));
        MalValue on_args[] = {roots[5], roots[2]};
        mal_vm_call_value(vm, on.desc.value, roots[4], on_args, 2);
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : roots[4];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_create_server(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalCompletion completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR], args, argc);
    return completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : completion.value;
}

static bool http_client_option(
    MalVm *vm, MalValue options, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    return !mal_value_is_object(options)
        || mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) name), out);
}

static bool http_client_replace_string(
    MalVm *vm, MalValue value, char **target, usize *length) {
    char *replacement;
    usize replacement_len;
    if (!http_client_ascii_string(vm, value, &replacement, &replacement_len)) {
        return false;
    }
    free(*target);
    *target = replacement;
    *length = replacement_len;
    return true;
}

static bool http_client_set_port(MalVm *vm, MalValue value, u16 *port) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || floor(number) != number || number < 0 || number > 65535) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "HTTP port must be an integer from 0 through 65535");
        return false;
    }
    *port = (u16) number;
    return true;
}

static bool http_client_validate_endpoint(
    MalVm *vm, const char *protocol, const char *host, u16 port,
    const char *path, usize path_len, bool secure) {
    if (strcmp(protocol, secure ? "https:" : "http:") != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "HTTP request protocol does not match the module");
        return false;
    }
    if (host[0] == '\0') {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "HTTP hostname must not be empty");
        return false;
    }
    (void) port;
    for (const char *cursor = host; *cursor != '\0'; cursor++) {
        unsigned char ch = (unsigned char)*cursor;
        if (ch <= 0x20 || ch >= 0x7f || ch == '/' || ch == '@' || ch == '\\') {
            mal_vm_throw_error(vm,MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,"HTTP hostname contains invalid characters");
            return false;
        }
    }
    for (usize i = 0; i < path_len; i++) {
        unsigned char ch = (unsigned char) path[i];
        if (ch <= 0x20 || ch == 0x7f) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "HTTP path contains invalid characters");
            return false;
        }
    }
    return true;
}

static MalValue http_request_common(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee, bool secure) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "http.request requires a URL or options object");
        return mal_value_new_undefined();
    }
    bool url_object = mal_value_is_url_object(args[0]);
    bool options_only = mal_value_is_object(args[0]) && !url_object;
    MalValue options = options_only ? args[0]
        : (argc > 1 && mal_value_is_object(args[1]) ? args[1]
                                                    : mal_value_new_undefined());
    if (secure && !mal_node_https_validate_options(vm, options, false,
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0))) return mal_value_new_undefined();
    MalValue callback = options_only
        ? (argc > 1 ? args[1] : mal_value_new_undefined())
        : (argc > 2 ? args[2]
                    : (argc > 1 && mal_value_is_callable(args[1])
                           ? args[1] : mal_value_new_undefined()));
    if (!mal_value_is_undefined(callback) && !mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The response callback must be a function");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        options, callback, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNodeHttpClientState *state = calloc(1, sizeof(MalNodeHttpClientState));
    if (state == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto fail;
    }
    state->vm = vm;
    state->async_context = mal_async_context_capture(vm);
    state->request = mal_value_new_undefined();
    state->response = mal_value_new_undefined();
    state->end_callback = mal_value_new_undefined();
    state->destroy_error = mal_value_new_undefined();
    state->response_destroy_error = mal_value_new_undefined();
    state->next_write_token = 1;
    state->keep_alive = true;
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    char *protocol = nullptr;
    usize protocol_len = 0;
    usize host_len = 0;
    if (options_only) {
        protocol = http_copy_bytes(secure ? "https:" : "http:", secure ? 6 : 5);
        state->host = http_copy_bytes("localhost", 9);
        state->path = http_copy_bytes("/", 1);
        state->port = secure ? 443 : 80;
        state->path_len = 1;
        host_len = 9;
        protocol_len = secure ? 6 : 5;
        if (protocol == nullptr || state->host == nullptr || state->path == nullptr) {
            mal_vm_throw_allocation_error(vm);
            goto fail_endpoint;
        }
    } else if (!http_client_parse_url(
                   vm, args[0], &protocol, &state->host, &state->port,
                   &state->path, &state->path_len)) {
        goto fail_endpoint;
    } else {
        protocol_len = strlen(protocol);
        host_len = strlen(state->host);
    }
    if (!http_client_option(vm, roots[0], "protocol", &roots[2])) {
        goto fail_endpoint;
    }
    if (!mal_value_is_undefined(roots[2])
        && !http_client_replace_string(
            vm, roots[2], &protocol, &protocol_len)) {
        goto fail_endpoint;
    }
    if (!http_client_option(vm, roots[0], "hostname", &roots[3])) {
        goto fail_endpoint;
    }
    if (!mal_value_is_undefined(roots[3])) {
        if (!http_client_replace_string(vm, roots[3], &state->host, &host_len)) {
            goto fail_endpoint;
        }
    } else if (options_only) {
        if (!http_client_option(vm, roots[0], "host", &roots[4])) {
            goto fail_endpoint;
        }
        if (!mal_value_is_undefined(roots[4])
            && !http_client_replace_string(
                vm, roots[4], &state->host, &host_len)) {
            goto fail_endpoint;
        }
    }
    state->secure = strcmp(protocol, "https:") == 0;
    if (options_only) state->port = state->secure ? 443 : 80;
    if (!http_client_option(vm, roots[0], "port", &roots[4])) goto fail_endpoint;
    if (!mal_value_is_undefined(roots[4])
        && !http_client_set_port(vm, roots[4], &state->port)) {
        goto fail_endpoint;
    }
    if (state->secure) {
        if (!http_client_option(vm, roots[0], "ca", &roots[4])) goto fail_endpoint;
        if (!mal_value_is_undefined(roots[4])
            && !http_client_replace_string(vm, roots[4], &state->ca, &state->ca_len)) {
            goto fail_endpoint;
        }
        if (!http_client_option(vm, roots[0], "cert", &roots[4])) goto fail_endpoint;
        if (!mal_value_is_undefined(roots[4])
            && !http_client_replace_string(vm, roots[4], &state->cert, &state->cert_len)) {
            goto fail_endpoint;
        }
        if (!http_client_option(vm, roots[0], "key", &roots[4])) goto fail_endpoint;
        if (!mal_value_is_undefined(roots[4])
            && !http_client_replace_string(vm, roots[4], &state->key, &state->key_len)) {
            goto fail_endpoint;
        }
    }
    if (!http_client_option(vm, roots[0], "path", &roots[5])) goto fail_endpoint;
    if (!mal_value_is_undefined(roots[5])) {
        if (!http_client_replace_string(
                vm, roots[5], &state->path, &state->path_len)) {
            goto fail_endpoint;
        }
        if (state->path_len == 0) {
            free(state->path);
            state->path = http_copy_bytes("/", 1);
            state->path_len = 1;
            if (state->path == nullptr) {
                mal_vm_throw_allocation_error(vm);
                goto fail_endpoint;
            }
        }
    }
    if (!http_client_validate_endpoint(
            vm, protocol, state->host, state->port,
            state->path, state->path_len, secure)) {
        goto fail_endpoint;
    }
    free(protocol);
    protocol = nullptr;
    if (!http_client_option(vm, roots[0], "method", &roots[2])) goto fail_state;
    if (mal_value_is_undefined(roots[2])) {
        state->method = http_copy_bytes("GET", 3);
        state->method_len = 3;
    } else if (!http_client_ascii_string(
                   vm, roots[2], &state->method, &state->method_len)) {
        goto fail_state;
    }
    if (state->method == nullptr || state->method_len == 0) {
        if (state->method == nullptr) mal_vm_throw_allocation_error(vm);
        else mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                                "HTTP method must not be empty");
        goto fail_state;
    }
    for (usize i = 0; i < state->method_len; i++) {
        char ch = state->method[i];
        if (ch >= 'a' && ch <= 'z') state->method[i] = (char) (ch - 0x20);
        else if (ch <= 0x20 || ch >= 0x7f) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Invalid HTTP method");
            goto fail_state;
        }
    }
    if (!http_client_option(vm, roots[0], "timeout", &roots[6])) goto fail_state;
    if (!mal_value_is_undefined(roots[6])
        && !http_client_timeout_ms(vm, roots[6], &state->timeout_ms)) {
        goto fail_state;
    }
    if (!http_client_option(vm, roots[0], "agent", &roots[6])) goto fail_state;
    // An agent keeps connections only when it pools them; `agent: false` is a new,
    // non-pooling Agent, and no agent means the keep-alive globalAgent.
    if (!mal_value_is_nil(roots[6])) {
        MalValue keep_alive = mal_value_new_undefined();
        if (mal_value_is_object(roots[6])
            && !mal_vm_get_static(vm, roots[6], (const byte *) "keepAlive", &keep_alive)) {
            goto fail_state;
        }
        state->keep_alive = mal_value_is_truthy(keep_alive);
    }
    if (!http_client_option(vm, roots[0], "headers", &roots[3])
        || !http_client_serialize_headers(
            vm, roots[3], &state->headers, &state->headers_len,
            &state->has_content_length, &state->content_length, &state->keep_alive)) {
        goto fail_state;
    }
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_MODULE];
    MalPropertyLookup constructor = mal_object_get_own(
        mal_value_to_object(module),
        mal_intrinsic_string_key(vm, (const byte *) "ClientRequest"));
    if (!constructor.present) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ClientRequest is not installed");
        goto fail_state;
    }
    MalCompletion request = mal_vm_construct_value(
        vm, constructor.desc.value, nullptr, 0);
    if (request.kind == MAL_COMPLETION_THROW) goto fail_state;
    roots[4] = request.value;
    state->request = roots[4];
    http_define_own(vm, roots[4], "method",
                http_ascii_value(vm, state->method, state->method_len));
    http_define_own(vm, roots[4], "path",
                http_ascii_value(vm, state->path, state->path_len));
    state->next = http_clients;
    http_clients = state;
    if (!mal_value_is_undefined(roots[1])
        && !http_once(vm, roots[4], "response", roots[1])) {
        http_clients = state->next;
        goto fail_state;
    }
    MalValue result = roots[4];
    mal_gc_unroot(&root);
    return result;

fail_endpoint:
    free(protocol);
fail_state:
    http_client_free(state);
fail:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue http_request(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    return http_request_common(vm, receiver, args, argc, new_target, callee, false);
}

MalValue mal_node_https_request(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    return http_request_common(vm, receiver, args, argc, new_target, callee, true);
}

static MalValue http_get(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    MalValue request = http_request(
        vm, receiver, args, argc, new_target, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &request, 1);
    bool ended = http_call_method(vm, request, "end", nullptr, 0);
    MalValue result = ended ? request : mal_value_new_undefined();
    mal_gc_unroot(&root);
    return result;
}

MalValue mal_node_https_get(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    MalValue request = mal_node_https_request(vm, receiver, args, argc, new_target, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &request, 1);
    bool ended = http_call_method(vm, request, "end", nullptr, 0);
    MalValue result = ended ? request : mal_value_new_undefined();
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_constructor(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue prototype) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype",
                              prototype, MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype),
                              (const byte *) "constructor", value, HTTP_METHOD);
    return value;
}

// `options[name] || fallback`, as Node's Agent constructor reads each option.
static bool http_agent_option(
    MalVm *vm, MalValue options, const char *name, MalValue fallback, MalValue *out) {
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) name), out)) {
        return false;
    }
    if (!mal_value_is_truthy(*out)) *out = fallback;
    return true;
}

/* Node's Agent records its options as these properties. The transport keeps one idle
 * connection pool of its own, so only keepAlive changes how requests behave. */
static MalValue http_agent_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap, prototype)),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        callee,
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue options = argc > 0 ? args[0] : mal_value_new_undefined();
    bool ok = mal_vm_call_value(
            vm, vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR], roots[0],
            nullptr, 0).kind != MAL_COMPLETION_THROW;
    if (ok) {
        roots[1] = mal_value_is_nil(options)
            ? mal_value_from_object(mal_intrinsic_new_object(vm))
            : mal_vm_op_copy_data_properties(vm, options, nullptr, 0);
        ok = vm->completion.kind != MAL_COMPLETION_THROW;
    }
    if (ok) {
        mal_object_set_prototype(mal_value_to_object(roots[1]), nullptr);
        http_define_own(vm, roots[0], "options", roots[1]);
        ok = http_agent_option(vm, roots[1], "defaultPort", mal_value_from_i32(80), &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "defaultPort", roots[2]);
        ok = http_agent_option(vm, roots[1], "protocol", mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "http:")), &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "protocol", roots[2]);
        ok = mal_vm_get_static(vm, roots[1], (const byte *) "noDelay", &roots[2]);
    }
    if (ok) {
        if (mal_value_is_undefined(roots[2])) {
            http_define(vm, roots[1], "noDelay", mal_value_new_boolean(true));
        }
        http_define(vm, roots[1], "path", mal_value_new_null());
        static const char *pools[] = {"requests", "sockets", "freeSockets"};
        for (usize i = 0; i < countof(pools); i++) {
            roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
            http_define_own(vm, roots[0], pools[i], roots[2]);
        }
        ok = http_agent_option(
            vm, roots[1], "keepAliveMsecs", mal_value_from_i32(1000), &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "keepAliveMsecs", roots[2]);
        ok = http_agent_option(
            vm, roots[1], "keepAlive", mal_value_new_boolean(false), &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "keepAlive", roots[2]);
        ok = mal_vm_get_static(vm, roots[4], (const byte *) "defaultMaxSockets", &roots[3])
            && http_agent_option(vm, roots[1], "maxSockets", roots[3], &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "maxSockets", roots[2]);
        ok = http_agent_option(
            vm, roots[1], "maxFreeSockets", mal_value_from_i32(256), &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "maxFreeSockets", roots[2]);
        ok = http_agent_option(vm, roots[1], "scheduling", mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "lifo")), &roots[2]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "scheduling", roots[2]);
        ok = mal_vm_get_static(vm, roots[1], (const byte *) "maxTotalSockets", &roots[3]);
    }
    if (ok) {
        http_define_own(vm, roots[0], "maxTotalSockets", roots[3]);
        http_define_own(vm, roots[0], "totalSocketCount", mal_value_from_i32(0));
        MalValue buffer = mal_value_new_undefined();
        ok = mal_vm_get_static(
            vm, roots[1], (const byte *) "agentKeepAliveTimeoutBuffer", &buffer);
        bool usable = ok && mal_ops_is_number(buffer)
            && isfinite(mal_ops_number_as_f64(buffer)) && mal_ops_number_as_f64(buffer) >= 0;
        http_define_own(vm, roots[0], "agentKeepAliveTimeoutBuffer",
                        usable ? buffer : mal_value_from_i32(1000));
    }
    if (ok && !(mal_value_is_string(roots[2])
                && (mal_string_equals_ascii(mal_value_to_string(roots[2]), "fifo")
                    || mal_string_equals_ascii(mal_value_to_string(roots[2]), "lifo")))) {
        http_throw_invalid_arg_value(
            vm, "The argument 'scheduling' must be one of: 'fifo', 'lifo'.", roots[2]);
        ok = false;
    }
    if (ok && mal_value_is_undefined(roots[3])) {
        http_define_own(vm, roots[0], "maxTotalSockets", mal_value_from_f64(INFINITY));
    } else if (ok && !mal_ops_is_number(roots[3])) {
        mal_node_throw_invalid_arg_type(vm, "maxTotalSockets", "of type number", roots[3]);
        ok = false;
    } else if (ok && !(mal_ops_number_as_f64(roots[3]) >= 1)) {
        mal_node_throw_out_of_range(vm, "maxTotalSockets", ">= 1", roots[3]);
        ok = false;
    }
    MalValue result = ok ? roots[0] : mal_value_new_undefined();
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_agent_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    mal_http_client_close_idle(mal_host(vm));
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return receiver;
}

static MalValue http_methods(MalVm *vm) {
    static const char *methods[] = {
        "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD",
        "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL",
        "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH",
        "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE",
        "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE",
    };
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, countof(methods));
    MalValue value = mal_value_from_array_object(array);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    for (u32 i = 0; i < countof(methods); i++) {
        MalKey key = mal_key_index(i);
        MalValue method = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) methods[i]));
        mal_array_object_store(array, key, method);
    }
    mal_gc_unroot(&root);
    return value;
}

static MalValue http_status_codes(MalVm *vm) {
    MalValue value = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalObject *object = mal_value_to_object(value);
    for (usize i = 0; i < countof(http_statuses); i++) {
        MalValue reason = mal_value_from_string(mal_intrinsic_ascii(
            vm, (const byte *) http_statuses[i].reason));
        mal_object_set(object, mal_key_index(http_statuses[i].code), reason);
    }
    mal_gc_unroot(&root);
    return value;
}

static void http_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    mal_node_module_publish(vm, "node:http", slots, count, module);
}

/* The parser pool is per connection here, so only Node's validation is observable. */
static MalValue http_set_max_idle_parsers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    f64 max;
    mal_node_validate_integer(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "max", 1,
        9007199254740991.0, &max);
    return mal_value_new_undefined();
}

void mal_host_install_node_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (!mal_vm_register_runtime_cleanup(vm, http_cleanup)) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_MODULE];
    if (!mal_value_is_undefined(cached)) {
        http_install_exports(vm, slots, count, cached);
        return;
    }

    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return;
    }
    MalValue roots[19] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE])));
    // [7] holds OutgoingMessage.prototype until createServer claims the slot.
    roots[7] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE])));
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[7])));
    roots[9] = http_constructor(vm, "OutgoingMessage", 1, http_outgoing_message_constructor, roots[7]);
    mal_object_set_prototype(mal_value_to_object(roots[9]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "OutgoingMessage", roots[9],
        HTTP_VISIBLE);
    http_outgoing_prototype_shape = mal_value_to_object(roots[7])->shape;
    http_outgoing_prototype_properties = http_object_property_count(mal_value_to_object(roots[7]));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[1]), (const byte *) "_read", 1,
        http_incoming_read);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[1]), (const byte *) "destroy", 1,
        http_incoming_destroy);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "setHeader", 2,
        http_response_set_header);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "getHeader", 1,
        http_response_get_header);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "hasHeader", 1,
        http_response_has_header);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "removeHeader", 1,
        http_response_remove_header);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "getHeaders", 0,
        http_response_get_headers);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "getHeaderNames", 0,
        http_response_get_header_names);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "writeHead", 3,
        http_response_write_head);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "_implicitHeader", 0,
        http_response_implicit_header);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "write", 3,
        http_response_write);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[2]), (const byte *) "end", 3,
        http_response_end);
    roots[3] = http_constructor(vm, "IncomingMessage", 1,
                                http_incoming_message_constructor, roots[1]);
    roots[4] = http_constructor(vm, "ServerResponse", 2,
                                http_server_response_constructor, roots[2]);
    mal_object_set_prototype(mal_value_to_object(roots[3]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR]));
    roots[5] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "listen", 3,
        http_server_listen);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "address", 0,
        http_server_address);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "close", 1,
        http_server_close);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "closeAllConnections", 0,
        http_server_close_all_connections);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "closeIdleConnections", 0,
        http_server_close_idle_connections);
    roots[6] = http_constructor(vm, "Server", 2,
                                http_server_constructor, roots[5]);
    mal_object_set_prototype(mal_value_to_object(roots[6]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR]));
    roots[7] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "createServer"), 2,
            http_create_server));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "createServer", roots[7], HTTP_VISIBLE);
    roots[8] = http_methods(vm);
    roots[9] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_object_get_prototype(mal_value_to_object(roots[2]))));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[9]), (const byte *) "write", 3,
        http_client_write);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[9]), (const byte *) "end", 3,
        http_client_end);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[9]), (const byte *) "destroy", 1,
        http_client_destroy);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[9]), (const byte *) "abort", 0,
        http_client_abort);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[9]), (const byte *) "setTimeout", 2,
        http_client_set_timeout);
    roots[10] = http_constructor(vm, "ClientRequest", 3,
                                  http_client_request_constructor, roots[9]);
    mal_object_set_prototype(mal_value_to_object(roots[10]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR]));
    roots[11] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "request"), 3,
            http_request));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "request", roots[11], HTTP_VISIBLE);
    roots[12] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "get"), 3,
            http_get));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "get", roots[12], HTTP_VISIBLE);
    roots[13] = http_status_codes(vm);
    roots[14] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "validateHeaderName"), 1,
            http_validate_header_name));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[0]), (const byte *) "validateHeaderName",
        roots[14], HTTP_VISIBLE);
    roots[15] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "validateHeaderValue"), 2,
            http_validate_header_value));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[0]), (const byte *) "validateHeaderValue",
        roots[15], HTTP_VISIBLE);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "isValidHeaderName", 1,
        http_is_valid_header_name);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "isValidHeaderValue", 2,
        http_is_valid_header_value);
    roots[16] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[16]), (const byte *) "destroy", 0,
        http_agent_destroy);
    roots[17] = http_constructor(
        vm, "Agent", 1, http_agent_constructor, roots[16]);
    mal_object_set_prototype(mal_value_to_object(roots[17]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[17]),
        (const byte *) "defaultMaxSockets", mal_value_from_f64(INFINITY), HTTP_VISIBLE);
    // Node's globalAgent: new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 }).
    roots[18] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[18]), (const byte *) "keepAlive",
        mal_value_new_boolean(true), HTTP_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[18]), (const byte *) "scheduling",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "lifo")), HTTP_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[18]), (const byte *) "timeout",
        mal_value_from_i32(5000), HTTP_VISIBLE);
    roots[18] = http_agent_constructor(vm, mal_value_new_undefined(), &roots[18], 1,
                                       roots[17], roots[17]);

    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "setMaxIdleHTTPParsers", 1,
        http_set_max_idle_parsers);
    mal_web_websocket_install(vm, mal_value_to_object(roots[0]));
    // Node's default --max-http-header-size.
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "maxHeaderSize",
        mal_value_from_i32(16384), HTTP_VISIBLE);
    static const char *names[] = {
        "METHODS", "STATUS_CODES", "IncomingMessage", "ServerResponse", "Server",
        "ClientRequest", "Agent", "globalAgent",
    };
    MalValue values[] = {
        roots[8], roots[13], roots[3], roots[4], roots[6], roots[10], roots[17],
        roots[18],
    };
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                                  (const byte *) names[i], values[i], HTTP_VISIBLE);
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR] = roots[3];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_PROTOTYPE] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_CONSTRUCTOR] = roots[4];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_PROTOTYPE] = roots[2];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR] = roots[6];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_PROTOTYPE] = roots[5];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_MODULE] = roots[0];
    vm->node_http_object_prototype_shape = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])->shape;
    vm->node_http_event_emitter_prototype_shape = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])->shape;
    vm->node_http_stream_prototype_shape = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE])->shape;
    vm->node_http_readable_prototype_shape = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE])->shape;
    vm->node_http_incoming_message_prototype_shape =
        mal_value_to_object(roots[1])->shape;
    vm->node_http_server_response_prototype_shape =
        mal_value_to_object(roots[2])->shape;
    vm->node_http_object_prototype_properties = http_object_property_count(
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->node_http_event_emitter_prototype_properties = http_object_property_count(
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]));
    vm->node_http_stream_prototype_properties = http_object_property_count(
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE]));
    vm->node_http_readable_prototype_properties = http_object_property_count(
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE]));
    vm->node_http_incoming_message_prototype_properties =
        http_object_property_count(mal_value_to_object(roots[1]));
    vm->node_http_server_response_prototype_properties =
        http_object_property_count(mal_value_to_object(roots[2]));
    if (!http_roots_installed) {
        mal_gc_register_root_source(http_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_node_http_drain, false);
        http_roots_installed = true;
    }
    http_install_exports(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
