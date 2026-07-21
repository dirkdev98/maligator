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
#include "server.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm_ops.h"

#define HTTP_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define HTTP_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

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
    usize name_len;
    char *value;
    usize value_len;
} MalNodeHttpCopiedHeader;

typedef struct MalNodeHttpResponseHeader {
    char *name;
    usize name_len;
    MalValue value;
} MalNodeHttpResponseHeader;

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
    MalNodeHttpCopiedHeader headers[MAL_HTTP_MAX_HEADERS];
    usize header_count;
    byte *body;
    usize body_len;
    MalValue request;
    MalValue response;
    MalNodeHttpResponseHeader response_headers[MAL_HTTP_MAX_HEADERS];
    usize response_header_count;
    byte *response_body;
    usize response_body_len;
    usize response_body_capacity;
    bool pending;
    bool finish_pending;
    bool response_in_flight;
    bool ending;
    bool ended;
    struct MalNodeHttpRequestState *next;
} MalNodeHttpRequestState;

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
static MalNodeHttpClientState *http_clients;
static bool http_roots_installed;

static char *http_copy_bytes(const char *bytes, usize length) {
    char *copy = malloc(length + 1);
    if (copy == nullptr) return nullptr;
    memcpy(copy, bytes, length);
    copy[length] = '\0';
    return copy;
}

static void http_request_free(MalNodeHttpRequestState *request) {
    free(request->method);
    free(request->target);
    for (usize i = 0; i < request->header_count; i++) {
        free(request->headers[i].name);
        free(request->headers[i].value);
    }
    for (usize i = 0; i < request->response_header_count; i++) {
        free(request->response_headers[i].name);
    }
    free(request->body);
    free(request->response_body);
    free(request);
}

static void http_request_remove(MalNodeHttpRequestState **link) {
    MalNodeHttpRequestState *request = *link;
    *link = request->next;
    if (http_requests_tail == request) {
        http_requests_tail = nullptr;
        for (MalNodeHttpRequestState *cursor = http_requests; cursor != nullptr;
             cursor = cursor->next) {
            http_requests_tail = cursor;
        }
    }
    http_request_free(request);
}

static MalNodeHttpRequestState *http_response_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    MalObject *object = mal_value_to_object(receiver);
    for (MalNodeHttpRequestState *state = http_requests; state != nullptr;
         state = state->next) {
        if (!mal_value_is_undefined(state->response)
            && mal_value_to_object(state->response) == object) {
            return state;
        }
    }
    return nullptr;
}

static void http_queue_request(
    void *data,
    MalVm *vm,
    MalHttpConn *conn,
    const MalHttpRequest *req,
    const char *body,
    usize body_len) {
    (void) vm;
    MalNodeHttpServerState *server = data;
    MalNodeHttpRequestState *state = calloc(1, sizeof(MalNodeHttpRequestState));
    if (state == nullptr) goto fail;
    state->vm = server->vm;
    state->server_receiver = server->receiver;
#if MAL_REALMS
    state->realm = server->realm;
#endif
    state->conn = conn;
    state->request = mal_value_new_undefined();
    state->response = mal_value_new_undefined();
    state->pending = true;
    state->method_len = req->method_len;
    state->target_len = req->target_len;
    state->minor_version = req->minor_version;
    state->header_count = req->header_count;
    state->body_len = body_len;
    state->method = http_copy_bytes(req->method, req->method_len);
    state->target = http_copy_bytes(req->target, req->target_len);
    if (state->method == nullptr || state->target == nullptr) goto fail_state;
    for (usize i = 0; i < req->header_count; i++) {
        state->headers[i].name_len = req->headers[i].name_len;
        state->headers[i].value_len = req->headers[i].value_len;
        state->headers[i].name = http_copy_bytes(
            req->headers[i].name, req->headers[i].name_len);
        state->headers[i].value = http_copy_bytes(
            req->headers[i].value, req->headers[i].value_len);
        if (state->headers[i].name == nullptr
            || state->headers[i].value == nullptr) {
            goto fail_state;
        }
    }
    if (body_len > 0) {
        state->body = malloc(body_len);
        if (state->body == nullptr) goto fail_state;
        memcpy(state->body, body, body_len);
    }
    if (http_requests_tail == nullptr) {
        http_requests = state;
    } else {
        http_requests_tail->next = state;
    }
    http_requests_tail = state;
    return;

fail_state:
    http_request_free(state);
fail:
    mal_http_conn_respond(
        conn, 500, "Internal Server Error", nullptr, 0,
        "request allocation failed", 25);
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

static bool http_response_name(
    MalVm *vm, MalValue value, char **out, usize *out_length) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
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

static i64 http_response_header_index(
    const MalNodeHttpRequestState *state, const char *name, usize length) {
    for (usize i = 0; i < state->response_header_count; i++) {
        if (state->response_headers[i].name_len == length
            && memcmp(state->response_headers[i].name, name, length) == 0) {
            return (i64) i;
        }
    }
    return -1;
}

static MalValue http_response_set_header(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr || state->ending || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "ServerResponse is not writable");
        return mal_value_new_undefined();
    }
    if (argc < 2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "setHeader requires a name and value");
        return mal_value_new_undefined();
    }
    char *name;
    usize length;
    if (!http_response_name(vm, args[0], &name, &length)) {
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_index(state, name, length);
    if (index < 0) {
        if (state->response_header_count == MAL_HTTP_MAX_HEADERS) {
            free(name);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Too many response headers");
            return mal_value_new_undefined();
        }
        index = (i64) state->response_header_count++;
        state->response_headers[index].name = name;
        state->response_headers[index].name_len = length;
    } else {
        free(name);
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
    char *name;
    usize length;
    if (!http_response_name(vm, args[0], &name, &length)) {
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_index(state, name, length);
    free(name);
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
    char *name;
    usize length;
    if (!http_response_name(vm, args[0], &name, &length)) {
        return mal_value_new_undefined();
    }
    i64 index = http_response_header_index(state, name, length);
    free(name);
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

static bool http_response_append(
    MalVm *vm, MalNodeHttpRequestState *state, MalValue chunk) {
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
                               "Response chunk is out of bounds");
            return false;
        }
        length = mal_typed_array_object_byte_length(array);
        bytes = array->buffer->data + array->byte_offset;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Response chunk must be a string or Buffer");
        return false;
    }
    if (length > SIZE_MAX - state->response_body_len) {
        free(owned);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize required = state->response_body_len + length;
    if (required > state->response_body_capacity) {
        usize capacity = state->response_body_capacity == 0
            ? 256 : state->response_body_capacity;
        while (capacity < required) {
            if (capacity > SIZE_MAX / 2) {
                capacity = required;
                break;
            }
            capacity *= 2;
        }
        byte *grown = realloc(state->response_body, capacity);
        if (grown == nullptr) {
            free(owned);
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        state->response_body = grown;
        state->response_body_capacity = capacity;
    }
    if (length > 0) {
        memcpy(state->response_body + state->response_body_len, bytes, length);
    }
    state->response_body_len = required;
    free(owned);
    return true;
}

static MalValue http_response_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr || state->ending || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "write after end");
        return mal_value_new_undefined();
    }
    if (argc < 1 || !http_response_append(vm, state, args[0])) {
        return mal_value_new_undefined();
    }
    http_define(vm, receiver, "headersSent", mal_value_new_boolean(true));
    if (argc > 1 && mal_value_is_callable(args[argc - 1])) {
        if (!http_once(vm, receiver, "finish", args[argc - 1])) {
            return mal_value_new_undefined();
        }
    }
    return mal_value_new_boolean(true);
}

static const char *http_status_reason(int status) {
    switch (status) {
        case 200: return "OK";
        case 201: return "Created";
        case 202: return "Accepted";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 500: return "Internal Server Error";
        case 501: return "Not Implemented";
        case 503: return "Service Unavailable";
        default: return "Unknown";
    }
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
        MalString *string;
        if (!mal_vm_to_string(vm, header->value, &string)) {
            free(block);
            return false;
        }
        usize value_length;
        byte *value = mal_string_to_utf8(string, &value_length);
        if (value == nullptr) {
            free(block);
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        bool valid = true;
        for (usize j = 0; j < value_length; j++) {
            if (value[j] == '\r' || value[j] == '\n') valid = false;
        }
        bool appended = valid
            && http_block_append(&block, &length, &capacity,
                                 header->name, header->name_len)
            && http_block_append(&block, &length, &capacity, ": ", 2)
            && http_block_append(&block, &length, &capacity,
                                 (const char *) value, value_length)
            && http_block_append(&block, &length, &capacity, "\r\n", 2);
        free(value);
        if (!appended) {
            free(block);
            if (valid) {
                mal_vm_throw_allocation_error(vm);
            } else {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                                   "Invalid HTTP header value");
            }
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
        if (managed) {
            free(name);
            continue;
        }
        MalString *value_string;
        if (!mal_vm_to_string(vm, roots[3], &value_string)) {
            free(name);
            ok = false;
            break;
        }
        usize value_len;
        byte *value = mal_string_to_utf8(value_string, &value_len);
        bool valid = value != nullptr;
        for (usize j = 0; valid && j < value_len; j++) {
            if (value[j] == '\r' || value[j] == '\n') valid = false;
        }
        ok = valid
            && http_block_append(&block, &length, &capacity, name, name_len)
            && http_block_append(&block, &length, &capacity, ": ", 2)
            && http_block_append(&block, &length, &capacity,
                                 (const char *) value, value_len)
            && http_block_append(&block, &length, &capacity, "\r\n", 2);
        free(value);
        free(name);
        if (!ok) {
            if (valid) mal_vm_throw_allocation_error(vm);
            else mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                                    "Invalid HTTP header value");
            break;
        }
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

static void http_response_complete(void *data) {
    MalNodeHttpRequestState *state = data;
    state->response_in_flight = false;
    state->finish_pending = true;
}

static MalValue http_response_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpRequestState *state = http_response_state(receiver);
    if (state == nullptr || state->ending || state->ended) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_undefined();
    }
    state->ending = true;
    bool sole_callback = argc == 1 && mal_value_is_callable(args[0]);
    if (argc > 0 && !sole_callback && !mal_value_is_undefined(args[0])
        && !http_response_append(vm, state, args[0])) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    MalValue status_value;
    if (!mal_vm_get_property(
            vm, receiver, mal_intrinsic_string_key(vm, (const byte *) "statusCode"),
            &status_value)) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    f64 status_number;
    if (!mal_vm_to_number(vm, status_value, &status_number)
        || !isfinite(status_number) || floor(status_number) != status_number
        || status_number < 100 || status_number > 999) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Invalid status code");
        }
        state->ending = false;
        return mal_value_new_undefined();
    }
    if (argc > 0 && mal_value_is_callable(args[argc - 1])
        && !http_once(vm, receiver, "finish", args[argc - 1])) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    char *headers;
    usize headers_length;
    if (!http_response_serialize_headers(vm, state, &headers, &headers_length)) {
        state->ending = false;
        return mal_value_new_undefined();
    }
    bool suppress_body = (status_number >= 100 && status_number < 200)
        || status_number == 204 || status_number == 304
        || (state->method_len == 4 && memcmp(state->method, "HEAD", 4) == 0);
    bool head = state->method_len == 4 && memcmp(state->method, "HEAD", 4) == 0;
    i64 declared_content_length = suppress_body && !head
        ? -1 : (i64) state->response_body_len;
    state->ended = true;
    state->ending = false;
    state->response_in_flight = true;
    http_define(vm, receiver, "headersSent", mal_value_new_boolean(true));
    http_define(vm, receiver, "finished", mal_value_new_boolean(true));
    http_define(vm, receiver, "writableEnded", mal_value_new_boolean(true));
    i64 connection_header = http_response_header_index(state, "connection", 10);
    if (connection_header >= 0
        && http_string_equal_ci(
            state->response_headers[connection_header].value, "close")) {
        mal_http_conn_close_after_response(state->conn);
    }
    mal_http_conn_on_response_complete(
        state->conn, http_response_complete, state);
    mal_http_conn_respond_framed(
        state->conn, (int) status_number, http_status_reason((int) status_number),
        headers == nullptr ? "" : headers, headers_length,
        (const char *) state->response_body,
        suppress_body ? 0 : state->response_body_len, declared_content_length);
    state->conn = nullptr;
    free(headers);
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
        for (usize i = 0; i < state->response_header_count; i++) {
            mal_gc_mark_value(state->response_headers[i].value);
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
        free(lower);
        roots[3] = http_ascii_value(vm, header->value, header->value_len);
        mal_object_set(mal_value_to_object(roots[0]), mal_key_from_value(roots[2]), roots[3]);
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
    if (state->response_in_flight) return;
    if (!state->ended && state->conn != nullptr) {
        state->response_in_flight = true;
        mal_http_conn_on_response_complete(
            state->conn, http_response_complete, state);
        mal_http_conn_respond(
            state->conn, 500, "Internal Server Error", nullptr, 0,
            message, strlen(message));
        state->conn = nullptr;
        state->ended = true;
    } else if (!state->ended && state->conn == nullptr) {
        state->finish_pending = true;
    }
}

static void http_request_dispatch(MalVm *vm, MalNodeHttpRequestState *state) {
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    state->pending = false;
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

    MalValue roots[] = {
        state->request, state->response, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!http_request_headers(vm, state, &roots[2], &roots[3])) {
        mal_vm_throw_allocation_error(vm);
        mal_gc_unroot(&root);
        goto fail;
    }
    roots[4] = mal_value_from_object(mal_intrinsic_new_object(vm));
    http_define_own(vm, roots[4], "encrypted", mal_value_new_boolean(false));
    http_define_own(vm, roots[4], "readable", mal_value_new_boolean(true));
    http_define_own(vm, roots[4], "writable", mal_value_new_boolean(true));
    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[6] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));

    http_define_own(vm, roots[0], "method",
                http_ascii_value(vm, state->method, state->method_len));
    http_define_own(vm, roots[0], "url",
                http_ascii_value(vm, state->target, state->target_len));
    http_define_own(vm, roots[0], "headers", roots[2]);
    http_define_own(vm, roots[0], "rawHeaders", roots[3]);
    http_define_own(vm, roots[0], "httpVersion",
                http_ascii_value(vm, state->minor_version == 0 ? "1.0" : "1.1", 3));
    http_define_own(vm, roots[0], "httpVersionMajor", mal_value_from_i32(1));
    http_define_own(vm, roots[0], "httpVersionMinor",
                mal_value_from_i32(state->minor_version));
    http_define_own(vm, roots[0], "complete", mal_value_new_boolean(true));
    http_define_own(vm, roots[0], "aborted", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "upgrade", mal_value_new_boolean(false));
    http_define_own(vm, roots[0], "trailers", roots[5]);
    http_define_own(vm, roots[0], "rawTrailers", roots[6]);
    http_define_own(vm, roots[0], "socket", roots[4]);
    http_define_own(vm, roots[0], "connection", roots[4]);

    // ServerResponse's constructor already installed its six default state
    // fields. Dispatch only adds the connection-specific fields; redefining all
    // defaults here made every request repeat six shape searches and writes.
    http_define_own(vm, roots[1], "socket", roots[4]);
    http_define_own(vm, roots[1], "connection", roots[4]);

    MalValue emit_args[] = {
        mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "request")),
        roots[0], roots[1],
    };
    if (!http_call_method(vm, state->server_receiver, "emit", emit_args, 3)) {
        mal_gc_unroot(&root);
        goto fail;
    }
    if (state->body_len > 0) {
        byte *body = state->body;
        state->body = nullptr;
        roots[5] = mal_node_buffer_from_owned_bytes(vm, body, state->body_len);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !http_call_method(vm, roots[0], "push", &roots[5], 1)) {
            mal_gc_unroot(&root);
            goto fail;
        }
    }
    roots[5] = mal_value_new_null();
    if (!http_call_method(vm, roots[0], "push", &roots[5], 1)) {
        mal_gc_unroot(&root);
        goto fail;
    }
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    return;

fail:
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
        bool set_cookie = header->name_len == 10
            && memcmp(lower, "set-cookie", 10) == 0;
        free(lower);
        if (set_cookie) {
            MalPropertyLookup existing = mal_object_get_own(
                mal_value_to_object(roots[0]), mal_key_from_value(roots[2]));
            if (!existing.present || !mal_value_is_array_object(existing.desc.value)) {
                roots[4] = mal_value_from_array_object(
                    mal_intrinsic_new_dense_array(vm, 0));
                mal_object_set(mal_value_to_object(roots[0]),
                               mal_key_from_value(roots[2]), roots[4]);
            } else {
                roots[4] = existing.desc.value;
            }
            MalArrayObject *cookies = mal_value_to_array_object(roots[4]);
            mal_array_object_store(
                cookies,
                mal_key_index((i32) mal_array_object_length(cookies)),
                roots[3]);
        } else {
            mal_object_set(mal_value_to_object(roots[0]),
                           mal_key_from_value(roots[2]), roots[3]);
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
    http_define_own(vm, roots[0], "statusMessage", mal_value_new_undefined());
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
            bool response_ready = false;
            for (MalNodeHttpRequestState *request = http_requests;
                 request != nullptr; request = request->next) {
                if (request->vm == vm && request->finish_pending) {
                    response_ready = true;
                    break;
                }
            }
            if (response_ready) {
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
    MalNodeHttpRequestState **request_link = &http_requests;
    while (*request_link != nullptr) {
        MalNodeHttpRequestState *request = *request_link;
        if (request->vm != vm) {
            request_link = &request->next;
            continue;
        }
        if (request->pending) {
            http_request_dispatch(vm, request);
            return true;
        }
        if (request->finish_pending) {
            request->finish_pending = false;
#if MAL_REALMS
            MalRealm *saved_realm = vm->current_realm;
            mal_realm_switch(vm, request->realm);
#endif
            if (!mal_value_is_undefined(request->response)) {
                http_define(
                    vm, request->response, "writableFinished",
                    mal_value_new_boolean(true));
                http_emit(vm, request->response, "finish");
            }
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
            http_request_remove(request_link);
            return true;
        }
        request_link = &request->next;
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
    MalHttpServer *native = mal_http_server_start_handler(
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
        http_define_own(vm, result, "statusCode", mal_value_from_i32(200));
        http_define_own(vm, result, "statusMessage", mal_value_new_undefined());
        http_define_own(vm, result, "headersSent", mal_value_new_boolean(false));
        http_define_own(vm, result, "finished", mal_value_new_boolean(false));
        http_define_own(vm, result, "writableEnded", mal_value_new_boolean(false));
        http_define_own(vm, result, "writableFinished", mal_value_new_boolean(false));
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
    MalValue roots[13] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
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
    roots[2] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE])));
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

    static const char *names[] = {
        "METHODS", "IncomingMessage", "ServerResponse", "Server", "ClientRequest",
    };
    MalValue values[] = {roots[8], roots[3], roots[4], roots[6], roots[10]};
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
