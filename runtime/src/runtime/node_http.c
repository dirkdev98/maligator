#include "node_http.h"

#if MAL_NODE

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "array_buffer_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "web_host_timer.h"
#include "host.h"
#include "http_client.h"
#include "intrinsics.h"
#include "node_stream.h"
#include "node_buffer.h"
#include "net.h"
#include "object.h"
#include "object_ops.h"
#include "perf_stats.h"
#include "server.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value_ops.h"
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
    MalHttpServer *native;
    u16 port;
    char host[16];
    bool listening_pending;
    bool closing;
    bool close_ready;
#if MAL_REALMS
    MalRealm *realm;
#endif
    struct MalNodeHttpServerState *next;
} MalNodeHttpServerState;

typedef struct MalNodeHttpCopiedHeader {
    char *name;
    char *lower_name;
    usize name_len;
    char *value;
    usize value_len;
} MalNodeHttpCopiedHeader;

typedef struct MalNodeHttpResponseHeader {
    char *name;
    usize name_len;
    MalValue value;
} MalNodeHttpResponseHeader;

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
    MalNodeHttpResponseHeader response_headers[MAL_HTTP_MAX_HEADERS];
    usize response_header_count;
    MalNodeHttpResponseWrite *write_head;
    MalNodeHttpResponseWrite *write_tail;
    usize queued_write_bytes;
    usize active_write_bytes;
    u64 next_write_token;
    u64 ready_write_token;
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
    MalNodeHttpCopiedHeader headers[];
} MalNodeHttpRequestState;

static_assert(offsetof(MalNodeHttpRequestState, headers) == sizeof(MalNodeHttpRequestState),
              "request header descriptors must immediately follow request state");
static_assert(offsetof(MalNodeHttpRequestState, headers) % alignof(MalNodeHttpCopiedHeader) == 0,
              "request header descriptors must be aligned");

typedef struct MalNodeHttpClientState {
    MalVm *vm;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalValue request;
    MalHostHandle operation;
    char *host;
    u16 port;
    char *method;
    usize method_len;
    char *path;
    usize path_len;
    char *headers;
    usize headers_len;
    byte *body;
    usize body_len;
    usize body_capacity;
    MalValue destroy_error;
    bool ended;
    bool cancelled;
    bool aborted;
    bool terminal_pending;
    struct MalNodeHttpClientState *next;
} MalNodeHttpClientState;

static MalNodeHttpServerState *http_servers;
static MalNodeHttpRequestState *http_requests;
static MalNodeHttpRequestState *http_requests_tail;
static MalNodeHttpRequestState **http_response_index;
static usize http_response_index_capacity;
static usize http_response_index_count;
static MalNodeHttpRequestState **http_request_index;
static usize http_request_index_capacity;
static usize http_request_index_count;
static MalNodeHttpClientState *http_clients;
static bool http_roots_installed;
static void http_response_complete(void *data, bool success);
static void http_queue_request_body(void *data, byte *owned_bytes, usize length);
static void http_queue_request_end(void *data, bool success);
static MalValue http_client_error(MalVm *vm, const char *message);

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
    char **cursor, const char *bytes, usize length, bool lowercase) {
    char *copy = *cursor;
    if (lowercase) {
        for (usize i = 0; i < length; i++) {
            char ch = bytes[i];
            copy[i] = ch >= 'A' && ch <= 'Z' ? (char) (ch + 0x20) : ch;
        }
    } else {
        memcpy(copy, bytes, length);
    }
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
    if (state == nullptr || state->conn == nullptr
        || state->request_transport_complete) {
        return mal_value_new_undefined();
    }
    state->request_read_started = true;
    usize credit = 16 * 1024;
    if (argc > 0 && mal_ops_is_number(args[0])) {
        f64 number = mal_ops_number_as_f64(args[0]);
        if (isfinite(number) && number > 0) {
            if (number > 256 * 1024) number = 256 * 1024;
            credit = (usize) floor(number);
        }
    }
    (void) mal_http_conn_request_read_credit(state->conn, credit);
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
            || !http_request_snapshot_add_string(&snapshot_size, field->name_length)
            || !http_request_snapshot_add_string(&snapshot_size, field->value_length)) {
            goto fail;
        }
    }

    MalNodeHttpRequestState *state = calloc(1, snapshot_size);
    if (state == nullptr) goto fail;
    MAL_PERF_COUNT(http_request_state_allocations);
    state->vm = server->vm;
    state->server_receiver = server->receiver;
#if MAL_REALMS
    state->realm = server->realm;
#endif
    state->conn = conn;
    state->request = mal_value_new_undefined();
    state->response = mal_value_new_undefined();
    state->end_callback = mal_value_new_undefined();
    state->request_destroy_error = mal_value_new_undefined();
    state->pending = true;
    state->next_write_token = 1;
    state->method_len = head->method_length;
    state->target_len = head->target_length;
    state->minor_version = head->minor_version;
    state->header_count = head->field_count;
    char *cursor = (char *) &state->headers[head->field_count];
    state->method = http_request_snapshot_copy(
        &cursor, (const char *) mal_http_codec_head_method(head),
        head->method_length, false);
    state->target = http_request_snapshot_copy(
        &cursor, (const char *) mal_http_codec_head_target(head),
        head->target_length, false);
    for (usize i = 0; i < head->field_count; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        const char *name = (const char *) mal_http_codec_field_name(head, field);
        const char *value = (const char *) mal_http_codec_field_value(head, field);
        state->headers[i].name_len = field->name_length;
        state->headers[i].value_len = field->value_length;
        state->headers[i].name = http_request_snapshot_copy(
            &cursor, name, field->name_length, false);
        state->headers[i].lower_name = http_request_snapshot_copy(
            &cursor, name, field->name_length, true);
        state->headers[i].value = http_request_snapshot_copy(
            &cursor, value, field->value_length, false);
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
    bool found = mal_vm_get_property(
        vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) name), &roots[1]);
    if (found) {
        mal_vm_call_value(vm, roots[1], roots[0], argc > 0 ? roots + 2 : nullptr, argc);
    }
    bool ok = found && vm->completion.kind != MAL_COMPLETION_THROW;
    mal_gc_unroot(&root);
    return ok;
}

static bool http_emit(MalVm *vm, MalValue receiver, const char *event) {
    MalValue name = mal_value_from_string(
        mal_intrinsic_ascii(vm, (const byte *) event));
    MalRootSpan root;
    mal_gc_root(&root, &name, 1);
    bool ok = http_call_method(vm, receiver, "emit", &name, 1);
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

static MalValue http_server_socket_facade(MalVm *vm) {
    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]);
    MalValue socket = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &socket, 1);
    mal_vm_call_value(vm,
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR],
        socket, nullptr, 0);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        http_define_own(vm, socket, "encrypted", mal_value_new_boolean(false));
        http_define_own(vm, socket, "readable", mal_value_new_boolean(true));
        http_define_own(vm, socket, "writable", mal_value_new_boolean(true));
    }
    mal_gc_unroot(&root);
    return socket;
}

static void http_incoming_message_dispatch_shapes(MalVm *vm) {
    if (vm->node_http_incoming_message_source_shape != nullptr) return;

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
    MalShape *shape = mal_shape_empty();
    for (usize i = 0; i < countof(source_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) source_names[i]),
            HTTP_VISIBLE);
    }
    vm->node_http_incoming_message_source_shape = shape;
    for (usize i = 0; i < countof(dispatch_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) dispatch_names[i]),
            HTTP_VISIBLE);
    }
    vm->node_http_incoming_message_final_shape = shape;
}

static void http_server_response_shapes(MalVm *vm) {
    if (vm->node_http_server_response_parent_shape != nullptr) return;

    static const char *parent_names[] = {
        "_events", "_eventsCount", "_maxListeners", "destroyed", "_malStreamKind",
    };
    static const char *constructor_names[] = {
        "statusCode", "statusMessage", "headersSent", "finished", "writableEnded",
        "writableFinished",
    };
    static const char *dispatch_names[] = {"socket", "connection"};
    static_assert(countof(parent_names) + countof(constructor_names)
                      + countof(dispatch_names) <= MAL_SHAPE_MAX_INLINE_SLOTS,
                   "ServerResponse dispatch shape exceeds inline slots");
    MalShape *shape = mal_shape_empty();
    for (usize i = 0; i < countof(parent_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) parent_names[i]),
            HTTP_VISIBLE);
    }
    vm->node_http_server_response_parent_shape = shape;
    for (usize i = 0; i < countof(constructor_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) constructor_names[i]),
            HTTP_VISIBLE);
    }
    vm->node_http_server_response_constructor_shape = shape;
    for (usize i = 0; i < countof(dispatch_names); ++i) {
        shape = mal_shape_add_property(
            shape, mal_intrinsic_string_key(vm, (const byte *) dispatch_names[i]),
            HTTP_VISIBLE);
    }
    vm->node_http_server_response_dispatch_shape = shape;
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
        bool valid = unit > 0x20 && unit < 0x7f && unit != '(' && unit != ')'
            && unit != '<' && unit != '>' && unit != '@' && unit != ','
            && unit != ';' && unit != ':' && unit != '\\' && unit != '"'
            && unit != '/' && unit != '[' && unit != ']' && unit != '?'
            && unit != '=' && unit != '{' && unit != '}';
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
        bool valid = unit > 0x20 && unit < 0x7f && unit != '(' && unit != ')'
            && unit != '<' && unit != '>' && unit != '@' && unit != ','
            && unit != ';' && unit != ':' && unit != '\\' && unit != '"'
            && unit != '/' && unit != '[' && unit != ']' && unit != '?'
            && unit != '=' && unit != '{' && unit != '}';
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
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        c16 unit = units[i];
        if (unit != '\t' && (unit < 0x20 || unit == 0x7f || unit > 0xff)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Invalid character in HTTP header value");
            return false;
        }
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
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit != '\t' && (unit < 0x20 || unit == 0x7f || unit > 0xff)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Invalid character in HTTP header value");
            return false;
        }
    }
    if (length == SIZE_MAX) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    byte *bytes = malloc(length + 1);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (usize i = 0; i < length; i++) bytes[i] = (byte) units[i];
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

static MalValue http_response_set_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr || state->ending || state->ended
        || state->response_in_flight || state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ServerResponse is not writable");
        return mal_value_new_undefined();
    }
    if (argc < 2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "setHeader requires a name and value");
        return mal_value_new_undefined();
    }
    MalNodeHttpResponseNameView name;
    if (!http_response_name_view(vm, args[0], &name)) {
        return mal_value_new_undefined();
    }
    if (!http_header_value_valid(vm, args[1])) {
        return mal_value_new_undefined();
    }
    if (state->ending || state->ended || state->response_in_flight
        || state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ServerResponse is not writable");
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_view_index(state, &name);
    if (index < 0) {
        if (state->response_header_count == MAL_HTTP_MAX_HEADERS) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Too many response headers");
            return mal_value_new_undefined();
        }
        char *stored_name = http_response_name_materialize(vm, &name);
        if (stored_name == nullptr) return mal_value_new_undefined();
        index = (i64) state->response_header_count++;
        state->response_headers[index].name = stored_name;
        state->response_headers[index].name_len = name.length;
        MAL_PERF_COUNT(http_response_header_insertions);
    } else {
        MAL_PERF_COUNT(http_response_header_replacements);
        MAL_PERF_COUNT(http_response_header_allocation_free_lookups);
    }
    state->response_headers[index].value = args[1];
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
    if (state == nullptr || state->ending || state->ended || argc < 1) {
        return mal_value_new_undefined();
    }
    if (state->response_in_flight || state->committing_headers) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ServerResponse is not writable");
        return mal_value_new_undefined();
    }
    MalNodeHttpResponseNameView name;
    if (!http_response_name_view(vm, args[0], &name)) {
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_view_index(state, &name);
    MAL_PERF_COUNT(http_response_header_allocation_free_lookups);
    if (index >= 0) {
        free(state->response_headers[index].name);
        for (usize i = (usize) index + 1; i < state->response_header_count; i++) {
            state->response_headers[i - 1] = state->response_headers[i];
        }
        state->response_header_count--;
    }
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
            mal_object_set(mal_value_to_object(object), mal_key_from_value(name),
                           state->response_headers[i].value);
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
            memcpy(owned, array->buffer->data + array->byte_offset, length);
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
    if (!http_response_start(vm, state, receiver, -1, true)) {
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

static bool http_block_append(
    char **block, usize *length, usize *capacity,
    const char *bytes, usize count) {
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
    memcpy(*block + *length, bytes, count);
    *length = required;
    return true;
}

static bool http_serialize_header_line(
    MalVm *vm, char **block, usize *length, usize *capacity,
    const char *name, usize name_length, MalValue value) {
    byte *bytes;
    usize value_length;
    if (!http_header_value_bytes(vm, value, &bytes, &value_length)) return false;
    bool appended = http_block_append(block, length, capacity, name, name_length)
        && http_block_append(block, length, capacity, ": ", 2)
        && http_block_append(
            block, length, capacity, (const char *) bytes, value_length)
        && http_block_append(block, length, capacity, "\r\n", 2);
    free(bytes);
    if (!appended) mal_vm_throw_allocation_error(vm);
    return appended;
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

static void http_client_free(MalNodeHttpClientState *state) {
    free(state->host);
    free(state->method);
    free(state->path);
    free(state->headers);
    free(state->body);
    free(state);
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
        if (units[i] > 0x7f) {
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
    u16 port = 80;
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
invalid_url:
    free(url);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "HTTP request URL must be an absolute URL");
    return false;
}

static bool http_client_serialize_headers(
    MalVm *vm, MalValue headers_value, char **out, usize *out_length) {
    *out = nullptr;
    *out_length = 0;
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
        bool managed = (name_len == 4 && memcmp(name, "host", 4) == 0)
            || (name_len == 14 && memcmp(name, "content-length", 14) == 0)
            || (name_len == 10 && memcmp(name, "connection", 10) == 0)
            || (name_len == 17 && memcmp(name, "transfer-encoding", 17) == 0);
        if (!http_header_value_valid(vm, roots[3])) {
            free(name);
            ok = false;
            break;
        }
        if (managed) {
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

static bool http_client_append(
    MalVm *vm, MalNodeHttpClientState *state, MalValue chunk) {
    const byte *bytes;
    usize length;
    byte *owned = nullptr;
    if (mal_value_is_string(chunk)) {
        MalString *string = mal_value_to_string(chunk);
        owned = mal_string_to_utf8(string, &length);
        if (owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        bytes = owned;
    } else if (mal_value_is_typed_array_object(chunk)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(chunk);
        if (mal_typed_array_object_is_out_of_bounds(array)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Request chunk is out of bounds");
            return false;
        }
        length = mal_typed_array_object_byte_length(array);
        bytes = array->buffer->data + array->byte_offset;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Request chunk must be a string or Buffer");
        return false;
    }
    if (length > SIZE_MAX - state->body_len) {
        free(owned);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize required = state->body_len + length;
    if (required > state->body_capacity) {
        usize capacity = state->body_capacity == 0 ? 256 : state->body_capacity;
        while (capacity < required && capacity <= SIZE_MAX / 2) capacity *= 2;
        if (capacity < required) capacity = required;
        byte *grown = realloc(state->body, capacity);
        if (grown == nullptr) {
            free(owned);
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        state->body = grown;
        state->body_capacity = capacity;
    }
    if (length > 0) memcpy(state->body + state->body_len, bytes, length);
    state->body_len = required;
    free(owned);
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
    if (state == nullptr || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_boolean(false);
    }
    if (argc < 1 || !http_client_append(vm, state, args[0])) {
        return mal_value_new_boolean(false);
    }
    if (argc > 1 && mal_value_is_callable(args[argc - 1])) {
        mal_vm_call_value(vm, args[argc - 1], mal_value_new_undefined(), nullptr, 0);
    }
    return mal_value_new_boolean(true);
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

static bool http_client_start_request(MalVm *vm, MalNodeHttpClientState *state) {
    char framing[192];
    int framing_len = snprintf(
        framing, sizeof(framing),
        "Host: %s:%u\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
        state->host, (unsigned) state->port, state->body_len);
    usize request_len = state->method_len + 1 + state->path_len + 11
        + state->headers_len + (usize) framing_len + state->body_len;
    byte *request = malloc(request_len);
    if (request == nullptr || framing_len < 0) {
        free(request);
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
    HTTP_CLIENT_COPY(framing, (usize) framing_len);
    HTTP_CLIENT_COPY(state->body, state->body_len);
#undef HTTP_CLIENT_COPY
    const char *connect_host = strcmp(state->host, "localhost") == 0
        ? "127.0.0.1" : state->host;
    if (!mal_http_client_start(
            mal_host(vm), connect_host, state->port, request, request_len,
            state->method_len == 4 && memcmp(state->method, "HEAD", 4) == 0,
            &state->operation)) {
        free(request);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start HTTP request");
        return false;
    }
    return true;
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
    if (state == nullptr || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_undefined();
    }
    bool sole_callback = argc == 1 && mal_value_is_callable(args[0]);
    if (argc > 0 && !sole_callback && !mal_value_is_undefined(args[0])
        && !http_client_append(vm, state, args[0])) {
        return mal_value_new_undefined();
    }
    if (!http_client_start_request(vm, state)) return mal_value_new_undefined();
    state->ended = true;
    http_define(vm, receiver, "finished", mal_value_new_boolean(true));
    http_define(vm, receiver, "writableEnded", mal_value_new_boolean(true));
    http_define(vm, receiver, "writableFinished", mal_value_new_boolean(true));
    http_define(vm, receiver, "writable", mal_value_new_boolean(false));
    if (argc > 0 && mal_value_is_callable(args[argc - 1])) {
        mal_vm_call_value(
            vm, args[argc - 1], mal_value_new_undefined(), nullptr, 0);
    }
    http_emit(vm, receiver, "finish");
    return receiver;
}

static void http_response_write_ready(void *data, u64 token) {
    MalNodeHttpRequestState *state = data;
    state->ready_write_token = token;
    (void) http_request_enqueue_ready(state, HTTP_REQUEST_READY_WRITE);
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
    if (!mal_value_is_undefined(status_message_value)) {
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
    bool started = mal_http_conn_response_start(
        state->conn, (int) status_number, reason,
        headers == nullptr ? "" : headers, headers_length,
        declared_content_length,
        state->suppress_response_body ? 0 : declared_content_length,
        chunked);
    free(status_message);
    free(headers);
    if (!started) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start HTTP response");
        return false;
    }
    state->response_in_flight = true;
    http_define(vm, receiver, "headersSent", mal_value_new_boolean(true));
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
    if (write->offset == write->length) {
        state->write_head = write->next;
        if (state->write_head == nullptr) state->write_tail = nullptr;
        callback = write->callback;
        free(write->bytes);
        free(write);
    }
    MalRootSpan root;
    mal_gc_root(&root, &callback, 1);
    if (!mal_value_is_undefined(callback)) {
        mal_vm_call_value(vm, callback, mal_value_new_undefined(), nullptr, 0);
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
                mal_vm_call_value(
                    vm, roots[1], mal_value_new_undefined(), roots, 1);
            }
        }
        roots[1] = request->end_callback;
        if (vm->completion.kind != MAL_COMPLETION_THROW
            && !mal_value_is_undefined(roots[1])) {
            mal_vm_call_value(
                vm, roots[1], request->response, roots, 1);
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
    if (!http_response_start(
            vm, state, receiver, fresh_response ? (i64) length : -1,
            !fresh_response)) {
        http_response_rollback_enqueue(state, previous_tail);
        state->ending = false;
        return mal_value_new_undefined();
    }
    state->end_callback = argc > 0 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    if (!mal_value_is_undefined(state->end_callback)
        && !http_once(vm, receiver, "finish", state->end_callback)) {
        mal_http_conn_abort(state->conn);
        state->ending = false;
        return mal_value_new_undefined();
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

static void http_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalNodeHttpServerState *state = http_servers; state != nullptr;
         state = state->next) {
        if (state->vm == vm) mal_gc_mark_value(state->receiver);
    }
    for (MalNodeHttpRequestState *state = http_requests; state != nullptr;
         state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->server_receiver);
        mal_gc_mark_value(state->request);
        mal_gc_mark_value(state->response);
        mal_gc_mark_value(state->end_callback);
        mal_gc_mark_value(state->request_destroy_error);
        for (usize i = 0; i < state->response_header_count; i++) {
            mal_gc_mark_value(state->response_headers[i].value);
        }
        for (MalNodeHttpResponseWrite *write = state->write_head;
             write != nullptr; write = write->next) {
            mal_gc_mark_value(write->callback);
        }
    }
    for (MalNodeHttpClientState *state = http_clients; state != nullptr;
         state = state->next) {
        if (state->vm == vm) {
            mal_gc_mark_value(state->request);
            mal_gc_mark_value(state->destroy_error);
        }
    }
}

static bool http_incoming_singleton_header(const char *name, usize length) {
    static const char *singletons[] = {
        "age", "authorization", "content-length", "content-type", "etag",
        "expires", "from", "host", "if-modified-since", "if-unmodified-since",
        "last-modified", "location", "max-forwards", "proxy-authorization",
        "referer", "retry-after", "server", "user-agent",
    };
    for (usize i = 0; i < countof(singletons); i++) {
        if (strlen(singletons[i]) == length
            && memcmp(singletons[i], name, length) == 0) {
            return true;
        }
    }
    return false;
}

static bool http_incoming_header_add(
    MalVm *vm, MalValue headers, MalValue lower_name,
    const char *lower_bytes, usize name_length, MalValue value,
    MalValue *scratch) {
    MalObject *object = mal_value_to_object(headers);
    MalKey key = mal_key_from_value(lower_name);
    MalPropertyLookup existing = mal_object_get_own(object, key);
    bool set_cookie = name_length == 10
        && memcmp(lower_bytes, "set-cookie", 10) == 0;
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
    if (http_incoming_singleton_header(lower_bytes, name_length)) return true;

    const char *separator = name_length == 6
            && memcmp(lower_bytes, "cookie", 6) == 0
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
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    roots[1] = mal_value_from_array_object(
        mal_intrinsic_new_dense_array(vm, (u32) (state->header_count * 2)));
    MalArrayObject *raw = mal_value_to_array_object(roots[1]);
    for (usize i = 0; i < state->header_count; i++) {
        MalNodeHttpCopiedHeader *header = &state->headers[i];
        roots[2] = http_ascii_value(vm, header->lower_name, header->name_len);
        roots[3] = http_ascii_value(vm, header->value, header->value_len);
        if (!http_incoming_header_add(
                vm, roots[0], roots[2], header->lower_name, header->name_len,
                roots[3], &roots[4])) {
            mal_gc_unroot(&root);
            return false;
        }
        roots[4] = http_ascii_value(vm, header->name, header->name_len);
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
    MalCompletion request_completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR],
        nullptr, 0);
    if (request_completion.kind == MAL_COMPLETION_THROW) goto fail;
    state->request = request_completion.value;
    MalCompletion response_completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_CONSTRUCTOR],
        nullptr, 0);
    if (response_completion.kind == MAL_COMPLETION_THROW) goto fail;
    state->response = response_completion.value;
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
    roots[4] = http_server_socket_facade(vm);
    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[6] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));

    request_values[0] = http_ascii_value(vm, state->method, state->method_len);
    request_values[1] = http_ascii_value(vm, state->target, state->target_len);
    request_values[2] = roots[2];
    request_values[3] = roots[3];
    request_values[4] = http_ascii_value(
        vm, state->minor_version == 0 ? "1.0" : "1.1", 3);
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
            vm->node_http_incoming_message_source_shape,
            vm->node_http_incoming_message_final_shape,
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
            vm->node_http_server_response_constructor_shape,
            vm->node_http_server_response_dispatch_shape,
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

static bool http_client_response_headers(
    MalVm *vm, const MalHttpClientResult *result,
    MalValue *headers_out, MalValue *raw_headers_out) {
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)),
        mal_value_from_array_object(
            mal_intrinsic_new_dense_array(vm, (u32) (result->header_count * 2))),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *raw = mal_value_to_array_object(roots[1]);
    for (usize i = 0; i < result->header_count; i++) {
        const MalHttpClientHeader *header = &result->headers[i];
        char *lower = malloc(header->name_len == 0 ? 1 : header->name_len);
        if (lower == nullptr) {
            mal_gc_unroot(&root);
            return false;
        }
        for (usize j = 0; j < header->name_len; j++) {
            char ch = header->name[j];
            lower[j] = ch >= 'A' && ch <= 'Z' ? (char) (ch + 0x20) : ch;
        }
        roots[2] = http_ascii_value(vm, lower, header->name_len);
        roots[3] = http_ascii_value(vm, header->value, header->value_len);
        if (!http_incoming_header_add(
                vm, roots[0], roots[2], lower, header->name_len, roots[3],
                &roots[4])) {
            free(lower);
            mal_gc_unroot(&root);
            return false;
        }
        free(lower);
        roots[4] = http_ascii_value(vm, header->name, header->name_len);
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
    mal_gc_unroot(&root);
    return true;
}

static void http_client_dispatch(
    MalVm *vm, MalNodeHttpClientState *state, MalHostTask *task) {
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    MalHttpClientResult *result = task->data;
    if (state->cancelled) {
        if (state->aborted) http_emit(vm, state->request, "abort");
        MalValue error = state->destroy_error;
        MalRootSpan error_root;
        bool error_rooted = false;
        if (vm->completion.kind != MAL_COMPLETION_THROW
            && mal_value_is_nil(error) && state->ended) {
            error = http_client_error(vm, "socket hang up");
            mal_gc_root(&error_root, &error, 1);
            error_rooted = true;
            http_define(vm, error, "code",
                mal_value_from_string(
                    mal_intrinsic_ascii(vm, (const byte *) "ECONNRESET")));
        }
        if (vm->completion.kind != MAL_COMPLETION_THROW
            && !mal_value_is_nil(error)) {
            http_call_method(vm, state->request, "emit", (MalValue[]) {
                mal_value_from_string(
                    mal_intrinsic_ascii(vm, (const byte *) "error")),
                error,
            }, 2);
        }
        if (error_rooted) mal_gc_unroot(&error_root);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            http_emit(vm, state->request, "close");
        }
        goto done;
    }
    if (task->result != MAL_HOST_TERMINAL_OK || result == nullptr) {
        MalValue error = http_client_error(
            vm, result == nullptr ? nullptr : result->error);
        MalRootSpan root;
        mal_gc_root(&root, &error, 1);
        http_call_method(vm, state->request, "emit", (MalValue[]) {
            mal_value_from_string(
                mal_intrinsic_ascii(vm, (const byte *) "error")),
            error,
        }, 2);
        mal_gc_unroot(&root);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            http_define(
                vm, state->request, "destroyed", mal_value_new_boolean(true));
            http_define(vm, state->request, "writable", mal_value_new_boolean(false));
            http_emit(vm, state->request, "close");
        }
        goto done;
    }
    MalCompletion response_completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR],
        nullptr, 0);
    if (response_completion.kind == MAL_COMPLETION_THROW) goto done;
    MalValue roots[] = {
        response_completion.value, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!http_client_response_headers(vm, result, &roots[1], &roots[2])) {
        mal_vm_throw_allocation_error(vm);
        mal_gc_unroot(&root);
        goto done;
    }
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    http_define_own(vm, roots[3], "encrypted", mal_value_new_boolean(false));
    http_define_own(vm, roots[3], "readable", mal_value_new_boolean(true));
    http_define_own(vm, roots[3], "writable", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "statusCode", mal_value_from_i32(result->status));
    http_define_own(vm, roots[0], "statusMessage",
        http_ascii_value(
            vm, result->status_message, result->status_message_len));
    http_define_own(vm, roots[0], "headers", roots[1]);
    http_define_own(vm, roots[0], "rawHeaders", roots[2]);
    http_define_own(vm, roots[0], "httpVersion",
                http_ascii_value(vm, result->minor_version == 0 ? "1.0" : "1.1", 3));
    http_define_own(vm, roots[0], "httpVersionMajor", mal_value_from_i32(1));
    http_define_own(vm, roots[0], "httpVersionMinor",
                mal_value_from_i32(result->minor_version));
    http_define_own(vm, roots[0], "complete", mal_value_new_boolean(true));
    http_define_own(vm, roots[0], "aborted", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "socket", roots[3]);
    http_define_own(vm, roots[0], "connection", roots[3]);
    MalValue emit_args[] = {
        mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "response")),
        roots[0],
    };
    if (http_call_method(vm, state->request, "emit", emit_args, 2)) {
        if (result->body_len > 0) {
            byte *body = result->body;
            result->body = nullptr;
            roots[3] = mal_node_buffer_from_owned_bytes(vm, body, result->body_len);
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                http_call_method(vm, roots[0], "push", &roots[3], 1);
            }
        }
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            roots[3] = mal_value_new_null();
            http_call_method(vm, roots[0], "push", &roots[3], 1);
        }
    }
    mal_gc_unroot(&root);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        http_define(vm, state->request, "destroyed", mal_value_new_boolean(true));
        http_define(vm, state->request, "writable", mal_value_new_boolean(false));
        http_emit(vm, state->request, "close");
    }

done:
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
        MalValue roots[] = {state->request, state->destroy_error};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        *pending_link = state->next;
        MalHostTask task = {
            .kind = MAL_HOST_TASK_TERMINAL,
            .result = MAL_HOST_TERMINAL_CANCELLED,
        };
        http_client_dispatch(vm, state, &task);
        http_client_free(state);
        mal_gc_unroot(&root);
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
    if (*link == nullptr || task.kind != MAL_HOST_TASK_TERMINAL
        || !mal_host_next_task(&host->tasks, &task)) return false;
    MalNodeHttpClientState *state = *link;
    MalValue roots[] = {state->request, state->destroy_error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    *link = state->next;
    http_client_dispatch(vm, state, &task);
    http_client_free(state);
    mal_host_task_release(&host->tasks, &task);
    mal_gc_unroot(&root);
    return true;
}

bool mal_node_http_drain(MalVm *vm) {
    MAL_PERF_COUNT(http_drain_calls);
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
            http_emit(vm, state->receiver, "listening");
            return true;
        }
        if (state->close_ready) {
            MAL_PERF_COUNT(http_close_scans);
            if (mal_host(vm)->pending_http_completions > 0) {
                link = &state->next;
                continue;
            }
            MalValue receiver = state->receiver;
            MalRootSpan root;
            mal_gc_root(&root, &receiver, 1);
            *link = state->next;
            free(state);
            http_emit(vm, receiver, "close");
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
        if (kind == HTTP_REQUEST_READY_DISPATCH) {
            MAL_PERF_COUNT(http_dispatch_dequeues);
            if (request->finish_pending) {
                (void) http_request_enqueue_ready(
                    request, HTTP_REQUEST_READY_COMPLETION);
            } else {
                http_request_dispatch(vm, request);
                if (vm->completion.kind != MAL_COMPLETION_THROW) {
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
            http_request_schedule_response(request);
            http_request_schedule_read(request);
        } else if (kind == HTTP_REQUEST_READY_WRITE) {
#if MAL_REALMS
            MalRealm *saved_realm = vm->current_realm;
            mal_realm_switch(vm, request->realm);
#endif
            http_response_dispatch_write(vm, request);
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
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
            http_request_schedule_read(request);
        } else if (kind == HTTP_REQUEST_READY_COMPLETION) {
            request->finish_pending = false;
            host->pending_http_completions--;
            MAL_PERF_COUNT(http_completion_dequeues);
            http_request_remove(request);
        }
        return true;
    }
    return false;
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
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
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
        if (!http_once(vm, receiver, "close", args[0])) {
            return mal_value_new_undefined();
        }
    }
    state->closing = true;
    mal_http_server_close(state->native, http_native_close_complete, state);
    return receiver;
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
            mal_value_new_boolean(false), mal_value_new_boolean(false),
            mal_value_new_boolean(false), mal_value_new_boolean(false),
        };
        if (mal_object_try_append_shaped_values(
                mal_value_to_object(result),
                vm->node_http_server_response_parent_shape,
                vm->node_http_server_response_constructor_shape,
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
            http_define_own(vm, result, "finished", values[3]);
            http_define_own(vm, result, "writableEnded", values[4]);
            http_define_own(vm, result, "writableFinished", values[5]);
        }
    }
    return result;
}

static MalValue http_server_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue listener = mal_value_new_undefined();
    if (argc > 0 && mal_value_is_callable(args[0])) {
        listener = args[0];
    } else {
        if (argc > 0 && !mal_value_is_undefined(args[0])
            && !mal_value_is_null(args[0]) && !mal_value_is_object(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The options argument must be an object");
            return mal_value_new_undefined();
        }
        if (argc > 1) listener = args[1];
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
    const char *path, usize path_len) {
    if (strcmp(protocol, "http:") != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Only the http: protocol is supported");
        return false;
    }
    if (host[0] == '\0') {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "HTTP hostname must not be empty");
        return false;
    }
    if (strcmp(host, "localhost") != 0) {
        struct sockaddr_storage address;
        socklen_t address_len;
        if (!mal_net_parse_ip(host, port, &address, &address_len)
            || address.ss_family != AF_INET) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "HTTP hostname must be localhost or a numeric IPv4 address");
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

static MalValue http_request(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
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
    state->destroy_error = mal_value_new_undefined();
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    char *protocol = nullptr;
    usize protocol_len = 0;
    usize host_len = 0;
    if (options_only) {
        protocol = http_copy_bytes("http:", 5);
        state->host = http_copy_bytes("localhost", 9);
        state->path = http_copy_bytes("/", 1);
        state->port = 80;
        state->path_len = 1;
        host_len = 9;
        protocol_len = 5;
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
    if (!http_client_option(vm, roots[0], "port", &roots[4])) goto fail_endpoint;
    if (!mal_value_is_undefined(roots[4])
        && !http_client_set_port(vm, roots[4], &state->port)) {
        goto fail_endpoint;
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
            state->path, state->path_len)) {
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
    if (!http_client_option(vm, roots[0], "headers", &roots[3])
        || !http_client_serialize_headers(
            vm, roots[3], &state->headers, &state->headers_len)) {
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
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
            continue;
        }
        MalPropertyLookup lookup = mal_object_get_own(
            mal_value_to_object(module),
            mal_intrinsic_string_key(vm, (const byte *) slots[i].name));
        if (lookup.present) vm->globals[slots[i].slot] = lookup.desc.value;
    }
}

void mal_host_install_node_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_MODULE];
    if (!mal_value_is_undefined(cached)) {
        http_install_exports(vm, slots, count, cached);
        return;
    }

    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return;
    }
    MalValue roots[16] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE])));
    roots[2] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE])));
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
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE])));
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

    static const char *names[] = {
        "METHODS", "STATUS_CODES", "IncomingMessage", "ServerResponse", "Server",
        "ClientRequest",
    };
    MalValue values[] = {
        roots[8], roots[13], roots[3], roots[4], roots[6], roots[10],
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
    if (!http_roots_installed) {
        mal_gc_register_root_source(http_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_node_http_drain);
        http_roots_installed = true;
    }
    http_install_exports(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
