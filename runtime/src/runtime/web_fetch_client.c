#include "web_surface.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "array_buffer_object.h"
#include "ascii.h"
#include "base64.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "http_client.h"
#include "intrinsics.h"
#include "mal_url.h"
#include "mal_zlib.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "vm_ops.h"
#include "web_events_object.h"
#include "web_fetch.h"
#include "web_headers_object.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_request_object.h"

/*
 * fetch() over the host HTTP/1.1 client. One FetchClient follows a request from
 * its first attempt through redirects to the end of the response body. The
 * response body is a ReadableStream whose pulls grant the client read credit, so
 * a slow consumer stops the socket instead of buffering the whole body.
 *
 * As a server runtime, fetch follows Deno and undici where the browser model has
 * no counterpart: no CORS enforcement, cookie jar, HTTP cache or referrer; forbidden
 * request headers are sent except the ones that frame the message; and a manual
 * redirect resolves with the actual 3xx response.
 */

#define FETCH_SEGMENT (64 * 1024)
#define FETCH_CREDIT (64 * 1024)
#define FETCH_MAX_REDIRECTS 20

typedef enum FetchRedirect { FETCH_FOLLOW, FETCH_ERROR, FETCH_MANUAL } FetchRedirect;

typedef struct FetchClient {
    MalVm *vm;
    u64 id;
    MalHostHandle operation;
    struct FetchClient *next;
    // Traced by fetch_scan_roots.
    MalValue promise;
    MalValue request;
    MalValue signal;
    MalValue abort;
    MalValue controller;
    MalValue reader;
    void *url;
    char *method;
    byte *body;
    usize body_len;
    usize body_offset;
    bool has_body;
    bool stream_body;
    FetchRedirect redirect;
    u32 redirects;
    bool drop_body_headers;
    bool drop_credentials;
    MalZlibStream *decoder;
    u64 next_token;
    bool head_seen;
    bool response_complete;
    bool upload_complete;
    bool write_in_flight;
    bool aborted;
    bool body_closed;
} FetchClient;

static MAL_ISOLATE_LOCAL FetchClient *fetch_clients;
static MAL_ISOLATE_LOCAL u64 fetch_next_id;

// Operations whose client moved on (a followed redirect); their tasks still arrive.
typedef struct FetchOrphan {
    MalVm *vm;
    MalHostHandle operation;
    struct FetchOrphan *next;
} FetchOrphan;
static MAL_ISOLATE_LOCAL FetchOrphan *fetch_orphans;

static void fetch_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (FetchClient *client = fetch_clients; client != nullptr; client = client->next) {
        if (client->vm != vm) continue;
        mal_gc_mark_value(client->promise);
        mal_gc_mark_value(client->request);
        mal_gc_mark_value(client->signal);
        mal_gc_mark_value(client->abort);
        mal_gc_mark_value(client->controller);
        mal_gc_mark_value(client->reader);
    }
}

static FetchClient *fetch_find(MalVm *vm, u64 id) {
    for (FetchClient *client = fetch_clients; client != nullptr; client = client->next)
        if (client->vm == vm && client->id == id) return client;
    return nullptr;
}

static FetchClient *fetch_slot_client(MalVm *vm, MalValue callee) {
    MalValue slot = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    return fetch_find(vm, (u64) mal_value_to_f64(slot));
}

static MalValue fetch_native(MalVm *vm, FetchClient *client, const char *name, i32 length,
    MalNativeFunctionCallback callback) {
    MalValue slot = mal_value_from_f64((f64) client->id);
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, &slot, 1));
}

static MalValue fetch_string(MalVm *vm, const char *bytes, usize length) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, bytes, length));
}

static MalValue fetch_take_exception(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return error;
}

// TypeError(message) with its `cause`, as undici reports network failures.
static MalValue fetch_type_error(MalVm *vm, const char *message, MalValue cause) {
    MalRootSpan root;
    mal_gc_root(&root, &cause, 1);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
    MalValue error = fetch_take_exception(vm);
    if (!mal_value_is_undefined(cause) && mal_value_is_object(error)) {
        mal_intrinsic_define_data(vm, mal_value_to_object(error), (const byte *) "cause", cause,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return error;
}

static MalValue fetch_cause(MalVm *vm, const char *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
    return fetch_take_exception(vm);
}

static MalValue fetch_failure(MalVm *vm, const char *reason) {
    return fetch_type_error(vm, "fetch failed", fetch_cause(vm, reason));
}

static void fetch_call_method(MalVm *vm, MalValue receiver, const char *name, MalValue *args, i32 argc) {
    MalValue roots[2] = {receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_vm_get_property(vm, receiver, mal_intrinsic_string_key(vm, (const byte *) name), &roots[1])
        && mal_value_is_callable(roots[1])) {
        (void) mal_vm_call_value(vm, roots[1], receiver, args, argc);
    }
    mal_gc_unroot(&root);
}

static MalValue fetch_uint8_array(MalVm *vm, const byte *bytes, usize length) {
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) length, (u32) length, false, false);
    if (length > 0 && buffer->data == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (length > 0) memcpy(buffer->data, bytes, length);
    MalValue buffer_value = mal_value_from_array_buffer_object(buffer);
    MalRootSpan root;
    mal_gc_root(&root, &buffer_value, 1);
    MalValue array = mal_value_from_typed_array_object(mal_typed_array_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, (u32) length, false));
    mal_gc_unroot(&root);
    return array;
}

static void fetch_unlink(FetchClient *client) {
    FetchClient **link = &fetch_clients;
    while (*link != nullptr && *link != client) link = &(*link)->next;
    if (*link == client) *link = client->next;
}

static void fetch_free(MalVm *vm, FetchClient *client) {
    if (!mal_value_is_undefined(client->abort) && mal_value_is_object(client->signal))
        mal_abort_signal_remove_algorithm(client->signal, client->abort);
    fetch_unlink(client);
    (void) vm;
    mal_url_free(client->url);
    mal_zlib_free(&client->decoder);
    free(client->method);
    free(client->body);
    free(client);
}

static void fetch_orphan(MalVm *vm, MalHostHandle operation) {
    if (operation == 0) return;
    (void) mal_http_client_cancel(mal_host(vm), operation);
    FetchOrphan *orphan = calloc(1, sizeof(FetchOrphan));
    if (orphan == nullptr) return;
    orphan->vm = vm;
    orphan->operation = operation;
    orphan->next = fetch_orphans;
    fetch_orphans = orphan;
}

// Drops a client whose request can make no more progress; its operation's tasks
// are consumed as an orphan's.
static void fetch_abandon(MalVm *vm, FetchClient *client) {
    fetch_orphan(vm, client->operation);
    client->operation = 0;
    fetch_free(vm, client);
}

static void fetch_settle(MalVm *vm, FetchClient *client, bool reject, MalValue value) {
    if (!mal_value_is_promise_object(client->promise)) return;
    MalPromiseObject *promise = mal_value_to_promise_object(client->promise);
    client->promise = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    if (reject) mal_promise_reject(vm, promise, value);
    else mal_promise_fulfill(vm, promise, value);
    mal_gc_unroot(&root);
}

// Ends the fetch with `error`: the promise rejects, or an open body errors.
static void fetch_fail(MalVm *vm, FetchClient *client, MalValue error) {
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    if (!client->head_seen) {
        fetch_settle(vm, client, true, error);
    } else if (!client->body_closed && mal_value_is_object(client->controller)) {
        client->body_closed = true;
        fetch_call_method(vm, client->controller, "error", &error, 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) (void) fetch_take_exception(vm);
    }
    if (mal_value_is_object(client->reader)) {
        MalValue reader = client->reader;
        client->reader = mal_value_new_undefined();
        (void) mal_readable_stream_default_reader_cancel(vm, reader, error);
        if (vm->completion.kind == MAL_COMPLETION_THROW) (void) fetch_take_exception(vm);
    }
    mal_gc_unroot(&root);
}

/* ---------------------------------------------------------------------------
 * URLs and the request head.
 * --------------------------------------------------------------------------- */

typedef struct FetchBytes {
    byte *data;
    usize length;
    usize capacity;
    bool failed;
} FetchBytes;

static void bytes_append(FetchBytes *out, const void *data, usize length) {
    if (out->failed || length == 0) return;
    if (out->length + length > out->capacity) {
        usize capacity = out->capacity == 0 ? 512 : out->capacity;
        while (capacity < out->length + length) capacity *= 2;
        byte *grown = realloc(out->data, capacity);
        if (grown == nullptr) {
            out->failed = true;
            return;
        }
        out->data = grown;
        out->capacity = capacity;
    }
    memcpy(out->data + out->length, data, length);
    out->length += length;
}

static void bytes_append_cstr(FetchBytes *out, const char *text) {
    bytes_append(out, text, strlen(text));
}

// Appends a ByteString (header names and values hold code units below 0x100).
static void bytes_append_string(FetchBytes *out, MalString *string) {
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length && !out->failed; i++) {
        byte unit = (byte) units[i];
        bytes_append(out, &unit, 1);
    }
}

// A URL component as a NUL-terminated heap string.
static char *url_component(void *url, i32 (*read)(void *, uint8_t *, int32_t)) {
    i32 length = read(url, nullptr, 0);
    if (length < 0) return nullptr;
    char *text = malloc((usize) length + 1);
    if (text == nullptr) return nullptr;
    read(url, (uint8_t *) text, length);
    text[length] = '\0';
    return text;
}

static void *url_parse_value(MalVm *vm, MalValue value, void *base) {
    MalString *text;
    if (!mal_vm_to_string(vm, value, &text)) return nullptr;
    char *base_href = base == nullptr ? nullptr : url_component(base, mal_url_href);
    usize base_length = base_href == nullptr ? 0 : strlen(base_href);
    u16 *base_units = base_length == 0 ? nullptr : malloc(base_length * sizeof(u16));
    for (usize i = 0; base_units != nullptr && i < base_length; i++) base_units[i] = (u8) base_href[i];
    void *url = mal_url_parse(mal_string_code_units(text), mal_string_length(text), base_units,
        base_length, base_units != nullptr);
    free(base_units);
    free(base_href);
    return url;
}

// The URL a Response reports: the href without its fragment.
static MalValue url_response_value(MalVm *vm, void *url) {
    char *href = url_component(url, mal_url_href);
    if (href == nullptr) return fetch_string(vm, "", 0);
    char *hash = strchr(href, '#');
    usize length = hash == nullptr ? strlen(href) : (usize) (hash - href);
    MalValue value = mal_value_from_string(mal_string_from_utf8(&vm->heap, (const byte *) href, length));
    free(href);
    return value;
}

static bool header_excluded(FetchClient *client, MalString *name) {
    static const char *const framing[] = {
        "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade",
    };
    static const char *const body_headers[] = {
        "content-encoding", "content-language", "content-location", "content-type",
    };
    static const char *const credentials[] = {"authorization", "cookie", "proxy-authorization"};
    usize length = mal_string_length(name);
    const c16 *units = mal_string_code_units(name);
    char lower[32];
    if (length >= sizeof lower) return false;
    for (usize i = 0; i < length; i++) lower[i] = (char) units[i];
    lower[length] = '\0';
    for (usize i = 0; i < countof(framing); i++)
        if (strcmp(lower, framing[i]) == 0) return true;
    for (usize i = 0; client->drop_body_headers && i < countof(body_headers); i++)
        if (strcmp(lower, body_headers[i]) == 0) return true;
    for (usize i = 0; client->drop_credentials && i < countof(credentials); i++)
        if (strcmp(lower, credentials[i]) == 0) return true;
    return false;
}

static bool headers_have(MalHeadersObject *headers, const char *name) {
    usize length = strlen(name);
    for (i32 i = 0; i < headers->count; i++) {
        MalString *entry = headers->entries[i].name;
        if (mal_string_length(entry) != length) continue;
        const c16 *units = mal_string_code_units(entry);
        bool same = true;
        for (usize j = 0; same && j < length; j++) same = units[j] == (c16) name[j];
        if (same) return true;
    }
    return false;
}

static bool fetch_request_head(MalVm *vm, FetchClient *client, FetchBytes *head) {
    MalValue headers_value = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &headers_value, 1);
    bool ok = mal_vm_get_property(vm, client->request,
        mal_intrinsic_string_key(vm, (const byte *) "headers"), &headers_value);
    if (ok && !mal_value_is_headers_object(headers_value)) ok = false;
    char *path = url_component(client->url, mal_url_pathname);
    char *search = url_component(client->url, mal_url_search);
    char *host = url_component(client->url, mal_url_host);
    if (ok && path != nullptr && search != nullptr && host != nullptr) {
        bytes_append_cstr(head, client->method);
        bytes_append_cstr(head, " ");
        bytes_append_cstr(head, path[0] == '\0' ? "/" : path);
        bytes_append_cstr(head, search);
        bytes_append_cstr(head, " HTTP/1.1\r\nhost: ");
        bytes_append_cstr(head, host);
        bytes_append_cstr(head, "\r\n");
        MalHeadersObject *headers = mal_value_to_headers_object(headers_value);
        for (i32 i = 0; i < headers->count; i++) {
            if (header_excluded(client, headers->entries[i].name)) continue;
            bytes_append_string(head, headers->entries[i].name);
            bytes_append_cstr(head, ": ");
            bytes_append_string(head, headers->entries[i].value);
            bytes_append_cstr(head, "\r\n");
        }
        if (!headers_have(headers, "accept")) bytes_append_cstr(head, "accept: */*\r\n");
        if (!headers_have(headers, "accept-encoding"))
            bytes_append_cstr(head, "accept-encoding: gzip, deflate, br\r\n");
        if (!headers_have(headers, "user-agent")) bytes_append_cstr(head, "user-agent: Maligator\r\n");
    } else {
        ok = false;
    }
    free(path);
    free(search);
    free(host);
    mal_gc_unroot(&root);
    return ok && !head->failed;
}

/* ---------------------------------------------------------------------------
 * Upload.
 * --------------------------------------------------------------------------- */

static bool fetch_write(MalVm *vm, FetchClient *client, const byte *bytes, usize length, bool end) {
    byte *owned = malloc(length == 0 ? 1 : length);
    if (owned == nullptr) return false;
    if (length > 0) memcpy(owned, bytes, length);
    MalHttpClientWriteResult result = mal_http_client_write_owned(
        mal_host(vm), client->operation, owned, length, ++client->next_token, end);
    if (result != MAL_HTTP_CLIENT_WRITE_ACCEPTED) {
        free(owned);
        return false;
    }
    client->write_in_flight = true;
    if (end) client->upload_complete = true;
    return true;
}

static void fetch_read_upload(MalVm *vm, FetchClient *client);

static void fetch_pump_buffered(MalVm *vm, FetchClient *client) {
    if (client->write_in_flight || client->upload_complete) return;
    usize remaining = client->body_len - client->body_offset;
    usize segment = remaining > FETCH_SEGMENT ? FETCH_SEGMENT : remaining;
    bool end = segment == remaining;
    if (!fetch_write(vm, client, client->body + client->body_offset, segment, end)) {
        fetch_fail(vm, client, fetch_failure(vm, "the request body could not be sent"));
        fetch_abandon(vm, client);
        return;
    }
    client->body_offset += segment;
}

static MalValue fetch_upload_fulfilled(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    FetchClient *client = fetch_slot_client(vm, callee);
    if (client == nullptr || client->operation == 0 || client->aborted || !mal_value_is_object(client->reader))
        return mal_value_new_undefined();
    MalValue result = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue roots[3] = {result, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // Undefined while the upload goes on; otherwise the error that ends the request.
    MalValue *failure = &roots[2];
    if (mal_vm_get_property(vm, result, mal_intrinsic_string_key(vm, (const byte *) "done"), &roots[1])
        && mal_value_is_boolean(roots[1]) && mal_value_to_boolean(roots[1])) {
        client->reader = mal_value_new_undefined();
        if (!fetch_write(vm, client, nullptr, 0, true))
            *failure = fetch_failure(vm, "the request body could not be sent");
    } else if (mal_vm_get_property(vm, result, mal_intrinsic_string_key(vm, (const byte *) "value"), &roots[1])) {
        MalBufferSourceSpan span;
        byte *bytes = nullptr;
        usize length = 0;
        if (vm->host_node && mal_value_is_string(roots[1])) {
            // Node's fetch sends a string chunk as its UTF-8 bytes.
            bytes = mal_string_to_utf8(mal_value_to_string(roots[1]), &length);
        } else if (mal_value_is_typed_array_object(roots[1])
            && mal_buffer_source_span(roots[1], &span) == MAL_BUFFER_SOURCE_SPAN_OK) {
            length = span.length;
            bytes = malloc(length == 0 ? 1 : length);
            if (bytes != nullptr) mal_buffer_source_span_read(&span, 0, bytes, length);
        } else {
            *failure = fetch_type_error(vm, "fetch request body chunks must be Uint8Array",
                mal_value_new_undefined());
        }
        if (mal_value_is_undefined(*failure) && (bytes == nullptr || !fetch_write(vm, client, bytes, length, false)))
            *failure = fetch_failure(vm, "the request body could not be sent");
        free(bytes);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) *failure = fetch_take_exception(vm);
    if (!mal_value_is_undefined(*failure)) {
        // The server is still reading the body, so the request must end too.
        fetch_fail(vm, client, *failure);
        fetch_abandon(vm, client);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue fetch_upload_rejected(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    FetchClient *client = fetch_slot_client(vm, callee);
    if (client == nullptr || client->aborted || !mal_value_is_object(client->reader))
        return mal_value_new_undefined();
    client->reader = mal_value_new_undefined();
    fetch_fail(vm, client, argc > 0 ? args[0] : mal_value_new_undefined());
    fetch_abandon(vm, client);
    return mal_value_new_undefined();
}

static void fetch_read_upload(MalVm *vm, FetchClient *client) {
    if (!mal_value_is_object(client->reader) || client->write_in_flight) return;
    MalValue roots[3] = {mal_readable_stream_default_reader_read(vm, client->reader),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[1] = fetch_native(vm, client, "", 1, fetch_upload_fulfilled);
        roots[2] = fetch_native(vm, client, "", 1, fetch_upload_rejected);
        fetch_call_method(vm, roots[0], "then", &roots[1], 2);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) fetch_fail(vm, client, fetch_take_exception(vm));
    mal_gc_unroot(&root);
}

static void fetch_upload_next(MalVm *vm, FetchClient *client) {
    if (client->stream_body) fetch_read_upload(vm, client);
    else fetch_pump_buffered(vm, client);
}

/* ---------------------------------------------------------------------------
 * Starting a request.
 * --------------------------------------------------------------------------- */

static bool fetch_start(MalVm *vm, FetchClient *client) {
    char *protocol = url_component(client->url, mal_url_protocol);
    char *hostname = url_component(client->url, mal_url_hostname);
    char *port_text = url_component(client->url, mal_url_port);
    bool secure = protocol != nullptr && strcmp(protocol, "https:") == 0;
    bool ok = false;
    FetchBytes head = {0};
    if (protocol == nullptr || hostname == nullptr || port_text == nullptr) {
        fetch_fail(vm, client, fetch_failure(vm, "out of memory"));
        goto done;
    }
    // A bracketed IPv6 literal connects without its brackets.
    usize host_length = strlen(hostname);
    if (host_length >= 2 && hostname[0] == '[' && hostname[host_length - 1] == ']') {
        memmove(hostname, hostname + 1, host_length - 2);
        hostname[host_length - 2] = '\0';
    }
    u16 port = port_text[0] == '\0' ? (secure ? 443 : 80) : (u16) atoi(port_text);
    if (!fetch_request_head(vm, client, &head)) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) fetch_fail(vm, client, fetch_take_exception(vm));
        else fetch_fail(vm, client, fetch_failure(vm, "the request head could not be built"));
        goto done;
    }
    i64 content_length = client->stream_body ? -1 : client->has_body ? (i64) client->body_len : 0;
    bool reused;
    client->upload_complete = false;
    client->write_in_flight = false;
    client->body_offset = 0;
    if (!mal_http_client_start(mal_host(vm), hostname, port, secure, nullptr, 0, nullptr, true,
            head.data, head.length, content_length, strcmp(client->method, "HEAD") == 0, 0, 0,
            &client->operation, &reused)) {
        client->operation = 0;
        fetch_fail(vm, client, fetch_failure(vm, "the request could not be started"));
        goto done;
    }
    head.data = nullptr;
    ok = true;
done:
    free(head.data);
    free(protocol);
    free(hostname);
    free(port_text);
    return ok;
}

/* ---------------------------------------------------------------------------
 * The response.
 * --------------------------------------------------------------------------- */

static void fetch_grant(MalVm *vm, FetchClient *client) {
    if (client->operation != 0 && !client->response_complete && !client->body_closed)
        (void) mal_http_client_read_credit(mal_host(vm), client->operation, FETCH_CREDIT);
}

static MalValue fetch_body_start(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    FetchClient *client = fetch_slot_client(vm, callee);
    if (client != nullptr && argc > 0) client->controller = args[0];
    return mal_value_new_undefined();
}

static MalValue fetch_body_pull(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    FetchClient *client = fetch_slot_client(vm, callee);
    if (client != nullptr) fetch_grant(vm, client);
    return mal_value_new_undefined();
}

static MalValue fetch_body_cancel(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    FetchClient *client = fetch_slot_client(vm, callee);
    if (client != nullptr && !client->body_closed) {
        client->body_closed = true;
        if (client->operation != 0 && !client->response_complete)
            (void) mal_http_client_cancel(mal_host(vm), client->operation);
    }
    return mal_value_new_undefined();
}

static void fetch_enqueue(MalVm *vm, FetchClient *client, const byte *bytes, usize length) {
    if (length == 0 || client->body_closed || !mal_value_is_object(client->controller)) return;
    MalValue chunk = fetch_uint8_array(vm, bytes, length);
    MalRootSpan root;
    mal_gc_root(&root, &chunk, 1);
    if (vm->completion.kind != MAL_COMPLETION_THROW)
        fetch_call_method(vm, client->controller, "enqueue", &chunk, 1);
    mal_gc_unroot(&root);
}

// Decodes `length` bytes, or finishes the decoder when `bytes` is null.
static bool fetch_decode(MalVm *vm, FetchClient *client, const byte *bytes, usize length) {
    byte output[FETCH_SEGMENT];
    usize offset = 0;
    for (;;) {
        usize consumed = 0, produced = 0;
        i32 status = mal_zlib_pump(client->decoder, bytes == nullptr ? nullptr : bytes + offset,
            bytes == nullptr ? 0 : length - offset, output, sizeof output, 0, &consumed, &produced);
        offset += consumed;
        fetch_enqueue(vm, client, output, produced);
        if (status < 0) return false;
        if (status == MAL_ZLIB_STATUS_NEED_OUTPUT) continue;
        // Bytes after a complete stream are ignored, as browsers do.
        if (status == MAL_ZLIB_STATUS_STREAM_END) return true;
        if (bytes != nullptr) {
            if (offset < length && consumed > 0) continue;
            return true;
        }
        return mal_zlib_finish(client->decoder) == MAL_ZLIB_STATUS_STREAM_END;
    }
}

static bool field_named(const MalHttpCodecHead *head, const MalHttpCodecField *field, const char *name) {
    usize length = strlen(name);
    if (field->name_length != length) return false;
    const byte *bytes = mal_http_codec_field_name(head, field);
    for (usize i = 0; i < length; i++)
        if (mal_ascii_to_lower(bytes[i]) != (byte) name[i]) return false;
    return true;
}

static const MalHttpCodecField *head_field(const MalHttpCodecHead *head, const char *name) {
    for (usize i = 0; i < head->field_count; i++)
        if (field_named(head, &head->fields[i], name)) return &head->fields[i];
    return nullptr;
}

static bool value_is(const MalHttpCodecHead *head, const MalHttpCodecField *field, const char *value) {
    usize length = strlen(value);
    const byte *bytes = mal_http_codec_field_value(head, field);
    usize start = 0, end = field->value_length;
    while (start < end && (bytes[start] == ' ' || bytes[start] == '\t')) start++;
    while (end > start && (bytes[end - 1] == ' ' || bytes[end - 1] == '\t')) end--;
    if (end - start != length) return false;
    for (usize i = 0; i < length; i++)
        if (mal_ascii_to_lower(bytes[start + i]) != (byte) value[i]) return false;
    return true;
}

static bool fetch_follow(MalVm *vm, FetchClient *client, const MalHttpCodecHead *head,
    const MalHttpCodecField *location) {
    if (client->redirect == FETCH_ERROR) {
        fetch_fail(vm, client, fetch_failure(vm, "unexpected redirect"));
        fetch_abandon(vm, client);
        return true;
    }
    if (++client->redirects > FETCH_MAX_REDIRECTS) {
        fetch_fail(vm, client, fetch_failure(vm, "redirect count exceeded"));
        fetch_abandon(vm, client);
        return true;
    }
    MalValue target = mal_value_from_string(mal_string_from_utf8(&vm->heap,
        mal_http_codec_field_value(head, location), location->value_length));
    void *next = url_parse_value(vm, target, client->url);
    char *protocol = next == nullptr ? nullptr : url_component(next, mal_url_protocol);
    if (protocol == nullptr || (strcmp(protocol, "http:") != 0 && strcmp(protocol, "https:") != 0)) {
        free(protocol);
        mal_url_free(next);
        fetch_fail(vm, client, fetch_failure(vm, "the redirect location is not an HTTP(S) URL"));
        fetch_abandon(vm, client);
        return true;
    }
    free(protocol);
    int status = head->status_code;
    bool to_get = status == 303 && strcmp(client->method, "HEAD") != 0;
    if ((status == 301 || status == 302) && strcmp(client->method, "POST") == 0) to_get = true;
    if (!to_get && client->stream_body) {
        mal_url_free(next);
        fetch_fail(vm, client, fetch_failure(vm, "a streamed request body cannot follow a redirect"));
        fetch_abandon(vm, client);
        return true;
    }
    char *origin = url_component(client->url, mal_url_origin);
    char *next_origin = url_component(next, mal_url_origin);
    if (origin == nullptr || next_origin == nullptr || strcmp(origin, next_origin) != 0)
        client->drop_credentials = true;
    free(origin);
    free(next_origin);
    if (to_get) {
        if (mal_value_is_object(client->reader)) {
            MalValue reader = client->reader;
            client->reader = mal_value_new_undefined();
            mal_readable_stream_default_reader_release(vm, reader);
        }
        client->stream_body = false;
        char *get = strdup("GET");
        if (get != nullptr) {
            free(client->method);
            client->method = get;
        }
        free(client->body);
        client->body = nullptr;
        client->body_len = 0;
        client->has_body = false;
        client->drop_body_headers = true;
    }
    mal_url_free(client->url);
    client->url = next;
    fetch_orphan(vm, client->operation);
    client->operation = 0;
    if (fetch_start(vm, client)) fetch_upload_next(vm, client);
    else fetch_free(vm, client);
    return true;
}

static void fetch_head(MalVm *vm, FetchClient *client, const MalHttpCodecHead *head) {
    int status = head->status_code;
    const MalHttpCodecField *location = head_field(head, "location");
    if ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308)
        && location != nullptr && client->redirect != FETCH_MANUAL) {
        (void) fetch_follow(vm, client, head, location);
        return;
    }
    client->head_seen = true;
    MalValue roots[5] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalHeadersObject *headers = mal_headers_create(vm);
    roots[0] = mal_value_from_headers_object(headers);
    for (usize i = 0; i < head->field_count && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        mal_headers_append_bytes(vm, headers, (const char *) mal_http_codec_field_name(head, field),
            field->name_length, (const char *) mal_http_codec_field_value(head, field), field->value_length);
    }
    roots[1] = mal_value_from_string(mal_string_new_latin1_copy(
        &vm->heap, mal_http_codec_head_status(head), head->status_length));
    roots[3] = url_response_value(vm, client->url);
    bool null_body = strcmp(client->method, "HEAD") == 0 || status == 101 || status == 103
        || status == 204 || status == 205 || status == 304;
    if (!null_body && vm->completion.kind != MAL_COMPLETION_THROW) {
        const MalHttpCodecField *encoding = head_field(head, "content-encoding");
        u32 format = 0;
        if (encoding != nullptr) {
            if (value_is(head, encoding, "gzip") || value_is(head, encoding, "x-gzip"))
                format = MAL_ZLIB_FORMAT_GZIP;
            else if (value_is(head, encoding, "deflate")) format = MAL_ZLIB_FORMAT_UNZIP;
            else if (value_is(head, encoding, "br")) format = MAL_ZLIB_FORMAT_BROTLI;
        }
        if (format != 0) (void) mal_zlib_create(format, &client->decoder);
        MalObject *streams = mal_web_streams_ensure(vm);
        if (streams != nullptr) {
            MalObject *source = mal_intrinsic_new_object(vm);
            roots[2] = mal_value_from_object(source);
            static const struct {
                const char *name;
                MalNativeFunctionCallback callback;
            } methods[] = {
                {"start", fetch_body_start}, {"pull", fetch_body_pull}, {"cancel", fetch_body_cancel},
            };
            for (usize i = 0; i < countof(methods); i++) {
                roots[4] = fetch_native(vm, client, methods[i].name, 1, methods[i].callback);
                mal_intrinsic_define_data(vm, source, (const byte *) methods[i].name, roots[4],
                    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
            }
            MalObject *strategy = mal_intrinsic_new_object(vm);
            roots[4] = mal_value_from_object(strategy);
            mal_intrinsic_define_data(vm, strategy, (const byte *) "highWaterMark", mal_value_from_i32(0),
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
            MalValue arguments[2] = {roots[2], roots[4]};
            MalCompletion made = mal_vm_construct_value(
                vm, mal_web_group_export(vm, streams, "ReadableStream"), arguments, 2);
            if (made.kind == MAL_COMPLETION_THROW) vm->completion = made;
            else roots[2] = made.value;
        }
    } else {
        client->body_closed = true;
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        client->head_seen = false;
        fetch_fail(vm, client, fetch_take_exception(vm));
        mal_gc_unroot(&root);
        return;
    }
    MalValue response = mal_fetch_response_new(vm, status, roots[1], headers,
        null_body ? mal_value_new_undefined() : roots[2], roots[3], client->redirects > 0);
    fetch_settle(vm, client, false, response);
    // A small body completes without a read, so a program that never reads it can
    // still let its event loop end.
    fetch_grant(vm, client);
    mal_gc_unroot(&root);
}

static void fetch_progress(MalVm *vm, FetchClient *client, MalHttpClientProgress *progress) {
    if (progress == nullptr || client->aborted) return;
    switch (progress->kind) {
        case MAL_HTTP_CLIENT_PROGRESS_WRITE_COMPLETE:
            client->write_in_flight = false;
            if (!client->upload_complete) fetch_upload_next(vm, client);
            else if (client->response_complete)
                (void) mal_http_client_response_complete_ack(mal_host(vm), client->operation);
            return;
        case MAL_HTTP_CLIENT_PROGRESS_RESPONSE_HEAD:
            fetch_head(vm, client, progress->head);
            return;
        case MAL_HTTP_CLIENT_PROGRESS_RESPONSE_BODY:
            if (client->decoder != nullptr) {
                if (!fetch_decode(vm, client, progress->bytes, progress->length))
                    fetch_fail(vm, client, fetch_type_error(vm, "terminated",
                        fetch_cause(vm, "the response body failed to decompress")));
            } else {
                fetch_enqueue(vm, client, progress->bytes, progress->length);
            }
            return;
        case MAL_HTTP_CLIENT_PROGRESS_RESPONSE_COMPLETE:
            client->response_complete = true;
            if (client->decoder != nullptr && !client->body_closed && !fetch_decode(vm, client, nullptr, 0)) {
                fetch_fail(vm, client, fetch_type_error(vm, "terminated",
                    fetch_cause(vm, "the response body failed to decompress")));
            } else if (!client->body_closed && mal_value_is_object(client->controller)) {
                client->body_closed = true;
                fetch_call_method(vm, client->controller, "close", nullptr, 0);
            }
            if (!client->upload_complete || client->write_in_flight) {
                if (!client->write_in_flight)
                    (void) mal_http_client_response_complete_ack(mal_host(vm), client->operation);
            }
            return;
    }
}

static void fetch_terminal(MalVm *vm, FetchClient *client, const MalHostTask *task, MalHttpClientResult *result) {
    client->operation = 0;
    if (!client->aborted && task->result != MAL_HOST_TERMINAL_OK) {
        const char *reason = result != nullptr && result->error != nullptr ? result->error
            : task->result == MAL_HOST_TERMINAL_CANCELLED ? "the request was cancelled" : "network error";
        if (!client->head_seen) fetch_fail(vm, client, fetch_failure(vm, reason));
        else fetch_fail(vm, client, fetch_type_error(vm, "terminated", fetch_cause(vm, reason)));
    } else if (!client->aborted && !client->head_seen) {
        fetch_fail(vm, client, fetch_failure(vm, "the connection closed before a response"));
    }
    fetch_free(vm, client);
}

static bool fetch_drain(MalVm *vm) {
    if (fetch_clients == nullptr && fetch_orphans == nullptr) return false;
    MalHost *host = mal_host(vm);
    if (mal_http_client_drain_dns(host)) return true;
    if (mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask task;
    if (!mal_host_peek_task(&host->tasks, &task)) return false;
    for (FetchOrphan **link = &fetch_orphans; *link != nullptr; link = &(*link)->next) {
        FetchOrphan *orphan = *link;
        if (orphan->vm != vm || orphan->operation != task.operation) continue;
        if (!mal_host_next_task(&host->tasks, &task)) return false;
        void *data = mal_host_task_take_data(&host->tasks, &task);
        if (task.kind == MAL_HOST_TASK_PROGRESS) {
            mal_http_client_progress_free(data);
        } else {
            mal_http_client_result_free(data);
            *link = orphan->next;
            free(orphan);
        }
        mal_host_task_release(&host->tasks, &task);
        return true;
    }
    FetchClient *client = fetch_clients;
    while (client != nullptr && (client->vm != vm || client->operation == 0 || client->operation != task.operation))
        client = client->next;
    if (client == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
    if (task.kind == MAL_HOST_TASK_PROGRESS) {
        fetch_progress(vm, client, data);
        mal_http_client_progress_free(data);
    } else {
        fetch_terminal(vm, client, &task, data);
        mal_http_client_result_free(data);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) (void) fetch_take_exception(vm);
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static MalValue fetch_abort(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    FetchClient *client = fetch_slot_client(vm, callee);
    if (client == nullptr || client->aborted) return mal_value_new_undefined();
    MalValue reason = mal_abort_signal_reason(client->signal);
    fetch_fail(vm, client, reason);
    client->aborted = true;
    if (client->operation != 0) {
        (void) mal_http_client_cancel(mal_host(vm), client->operation);
    } else {
        fetch_free(vm, client);
    }
    return mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * data: URLs.
 * --------------------------------------------------------------------------- */

static i32 hex_value(byte c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// The fetch standard's data: URL processor: percent-decoded bytes, base64 when the
// media type ends in ";base64", and text/plain;charset=US-ASCII by default.
static MalValue fetch_data_url(MalVm *vm, void *url, MalValue *error) {
    char *href = url_component(url, mal_url_href);
    if (href == nullptr) {
        *error = fetch_failure(vm, "out of memory");
        return mal_value_new_undefined();
    }
    char *hash = strchr(href, '#');
    if (hash != nullptr) *hash = '\0';
    char *comma = strchr(href + 5, ',');
    if (comma == nullptr) {
        free(href);
        *error = fetch_failure(vm, "invalid data: URL");
        return mal_value_new_undefined();
    }
    *comma = '\0';
    char *mime = href + 5;
    while (*mime == ' ' || *mime == '\t') mime++;
    usize mime_length = strlen(mime);
    while (mime_length > 0 && (mime[mime_length - 1] == ' ' || mime[mime_length - 1] == '\t')) mime[--mime_length] = '\0';
    bool base64 = false;
    if (mime_length >= 7) {
        char *suffix = mime + mime_length - 7;
        if (suffix[0] == ';' && strncasecmp(suffix + 1, "base64", 6) == 0) {
            base64 = true;
            *suffix = '\0';
            mime_length -= 7;
            while (mime_length > 0 && (mime[mime_length - 1] == ' ' || mime[mime_length - 1] == '\t')) mime[--mime_length] = '\0';
        }
    }
    const char *data = comma + 1;
    usize data_length = strlen(data);
    byte *bytes = malloc(data_length + 1);
    usize length = 0;
    for (usize i = 0; bytes != nullptr && i < data_length; i++) {
        i32 high, low;
        if (data[i] == '%' && i + 2 < data_length + 0 + 1 && (high = hex_value((byte) data[i + 1])) >= 0
            && (low = hex_value((byte) data[i + 2])) >= 0) {
            bytes[length++] = (byte) (high * 16 + low);
            i += 2;
        } else {
            bytes[length++] = (byte) data[i];
        }
    }
    if (bytes != nullptr && base64) {
        usize out = 0;
        u32 accumulator = 0;
        i32 bits = 0;
        usize significant = 0;
        bool invalid = false;
        for (usize i = 0; i < length && !invalid; i++) {
            if (mal_base64_is_ascii_whitespace(bytes[i])) continue;
            if (bytes[i] == '=') break;
            i32 digit = mal_base64_decode_digit(bytes[i], MAL_BASE64_ALPHABET_STANDARD);
            if (digit < 0) {
                invalid = true;
                break;
            }
            significant++;
            accumulator = (accumulator << 6) | (u32) digit;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                bytes[out++] = (byte) (accumulator >> bits);
            }
        }
        if (invalid || significant % 4 == 1) {
            free(bytes);
            free(href);
            *error = fetch_failure(vm, "invalid base64 in data: URL");
            return mal_value_new_undefined();
        }
        length = out;
    }
    if (bytes == nullptr) {
        free(href);
        *error = fetch_failure(vm, "out of memory");
        return mal_value_new_undefined();
    }
    MalValue roots[4] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalHeadersObject *headers = mal_headers_create(vm);
    roots[0] = mal_value_from_headers_object(headers);
    const char *type = mime_length == 0 || mime[0] == ';' ? "text/plain;charset=US-ASCII" : mime;
    char *typed = nullptr;
    if (mime_length > 0 && mime[0] == ';') {
        typed = malloc(strlen(mime) + 11);
        if (typed != nullptr) {
            snprintf(typed, strlen(mime) + 11, "text/plain%s", mime);
            type = typed;
        }
    }
    mal_headers_append_bytes(vm, headers, "content-type", 12, type, strlen(type));
    free(typed);
    roots[1] = mal_readable_stream_from_bytes(vm, bytes, length);
    free(bytes);
    free(href);
    roots[2] = fetch_string(vm, "OK", 2);
    roots[3] = url_response_value(vm, url);
    MalValue response = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : mal_fetch_response_new(vm, 200, roots[2], headers, roots[1], roots[3], false);
    mal_gc_unroot(&root);
    return response;
}

/* ---------------------------------------------------------------------------
 * fetch(input, init).
 * --------------------------------------------------------------------------- */

static MalValue fetch_new_promise(MalVm *vm) {
    return mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
}

static MalValue fetch_rejected(MalVm *vm, MalValue reason) {
    MalValue roots[2] = {reason, fetch_new_promise(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_promise_reject(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue fetch_function(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalObject *fetch_group = mal_web_fetch_ensure(vm);
    if (fetch_group == nullptr) return fetch_rejected(vm, fetch_take_exception(vm));
    MalValue roots[4] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue arguments[2] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalCompletion made = mal_vm_construct_value(
        vm, mal_web_group_export(vm, fetch_group, "Request"), arguments, argc > 1 ? 2 : 1);
    MalValue result;
    if (made.kind == MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        result = fetch_rejected(vm, made.value);
        goto done;
    }
    roots[0] = made.value;
    MalRequestObject *request = mal_value_to_request_object(roots[0]);
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "signal"), &roots[1])
        || !mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "url"), &roots[2])) {
        result = fetch_rejected(vm, fetch_take_exception(vm));
        goto done;
    }
    if (mal_value_is_object(roots[1]) && mal_abort_signal_is_aborted(roots[1])) {
        result = fetch_rejected(vm, mal_abort_signal_reason(roots[1]));
        goto done;
    }
    if (!mal_value_is_undefined(request->body_stream)
        && (mal_readable_stream_is_disturbed(request->body_stream)
            || mal_readable_stream_is_locked(request->body_stream))) {
        result = fetch_rejected(vm, fetch_type_error(vm,
            "fetch cannot send a request body that was already read", mal_value_new_undefined()));
        goto done;
    }
    MalString *integrity;
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "integrity"), &roots[3])
        || !mal_vm_to_string(vm, roots[3], &integrity)) {
        result = fetch_rejected(vm, fetch_take_exception(vm));
        goto done;
    }
    if (mal_string_length(integrity) > 0) {
        result = fetch_rejected(vm, fetch_type_error(vm,
            "fetch does not verify integrity metadata yet", mal_value_new_undefined()));
        goto done;
    }
    void *url = url_parse_value(vm, roots[2], nullptr);
    char *protocol = url == nullptr ? nullptr : url_component(url, mal_url_protocol);
    if (protocol != nullptr && strcmp(protocol, "data:") == 0) {
        free(protocol);
        MalValue error = mal_value_new_undefined();
        roots[3] = fetch_data_url(vm, url, &error);
        mal_url_free(url);
        if (vm->completion.kind == MAL_COMPLETION_THROW) error = fetch_take_exception(vm);
        if (!mal_value_is_undefined(error)) {
            result = fetch_rejected(vm, error);
        } else {
            MalValue promise = fetch_new_promise(vm);
            mal_promise_fulfill(vm, mal_value_to_promise_object(promise), roots[3]);
            result = promise;
        }
        goto done;
    }
    if (protocol == nullptr || (strcmp(protocol, "http:") != 0 && strcmp(protocol, "https:") != 0)) {
        free(protocol);
        mal_url_free(url);
        result = fetch_rejected(vm, fetch_failure(vm, "unknown scheme"));
        goto done;
    }
    free(protocol);
    FetchClient *client = calloc(1, sizeof(FetchClient));
    MalString *method_string = nullptr;
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "method"), &roots[3])
        || !mal_vm_to_string(vm, roots[3], &method_string)) {
        free(client);
        mal_url_free(url);
        result = fetch_rejected(vm, fetch_take_exception(vm));
        goto done;
    }
    if (client != nullptr && method_string != nullptr) {
        usize length = mal_string_length(method_string);
        client->method = malloc(length + 1);
        const c16 *units = mal_string_code_units(method_string);
        for (usize i = 0; client->method != nullptr && i < length; i++) client->method[i] = (char) units[i];
        if (client->method != nullptr) client->method[length] = '\0';
    }
    if (client == nullptr || client->method == nullptr) {
        if (client != nullptr) free(client);
        mal_url_free(url);
        mal_vm_throw_allocation_error(vm);
        result = fetch_rejected(vm, fetch_take_exception(vm));
        goto done;
    }
    client->vm = vm;
    client->id = ++fetch_next_id;
    client->url = url;
    client->promise = fetch_new_promise(vm);
    client->request = roots[0];
    client->signal = roots[1];
    client->abort = mal_value_new_undefined();
    client->controller = mal_value_new_undefined();
    client->reader = mal_value_new_undefined();
    if (request->body != nullptr) {
        client->body = malloc(request->body_len == 0 ? 1 : request->body_len);
        if (client->body != nullptr) memcpy(client->body, request->body, request->body_len);
        client->body_len = request->body_len;
        client->has_body = true;
    } else if (!mal_value_is_undefined(request->body_stream)) {
        client->stream_body = true;
        client->reader = mal_readable_stream_acquire_default_reader(vm, request->body_stream);
    }
    MalString *redirect = nullptr;
    if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "redirect"), &roots[3]))
        (void) mal_vm_to_string(vm, roots[3], &redirect);
    if (vm->completion.kind == MAL_COMPLETION_THROW) (void) fetch_take_exception(vm);
    client->redirect = FETCH_FOLLOW;
    if (redirect != nullptr && mal_string_length(redirect) > 0) {
        c16 first = mal_string_code_units(redirect)[0];
        client->redirect = first == 'e' ? FETCH_ERROR : first == 'm' ? FETCH_MANUAL : FETCH_FOLLOW;
    }
    client->next = fetch_clients;
    fetch_clients = client;
    result = client->promise;
    if (mal_value_is_object(client->signal)) {
        client->abort = fetch_native(vm, client, "", 0, fetch_abort);
        mal_abort_signal_add_algorithm(client->signal, client->abort);
    }
    // On failure the promise already carries the error.
    if (fetch_start(vm, client)) fetch_upload_next(vm, client);
    else fetch_free(vm, client);
done:
    mal_gc_unroot(&root);
    return result;
}

static void fetch_cleanup(MalVm *vm) {
    FetchClient **link = &fetch_clients;
    while (*link != nullptr) {
        FetchClient *client = *link;
        if (client->vm != vm) {
            link = &client->next;
            continue;
        }
        *link = client->next;
        if (client->operation != 0) (void) mal_http_client_cancel(mal_host(vm), client->operation);
        mal_url_free(client->url);
        mal_zlib_free(&client->decoder);
        free(client->method);
        free(client->body);
        free(client);
    }
    FetchOrphan **orphan_link = &fetch_orphans;
    while (*orphan_link != nullptr) {
        FetchOrphan *orphan = *orphan_link;
        if (orphan->vm != vm) {
            orphan_link = &orphan->next;
            continue;
        }
        *orphan_link = orphan->next;
        free(orphan);
    }
}

static bool web_fetch_client_build(MalVm *vm, MalObject *exports) {
    if (mal_web_fetch_ensure(vm) == nullptr || mal_web_streams_ensure(vm) == nullptr) return false;
    if (!mal_vm_register_runtime_cleanup(vm, fetch_cleanup)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    mal_gc_register_root_source(fetch_scan_roots, nullptr);
    mal_host_register_macrotask_drain(fetch_drain, false);
    mal_intrinsic_define_method_n(vm, exports, (const byte *) "fetch", 1, fetch_function);
    return true;
}

MAL_WEB_GROUP_DEFINE(fetch_client, MAL_WEB_GROUP_FETCH_CLIENT, web_fetch_client_build)

void mal_host_install_maligator_internal_fetch(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    MalObject *client = mal_web_fetch_client_ensure(vm);
    if (client == nullptr) return;
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "fetch") == 0)
            vm->globals[slots[i].slot] = mal_web_group_export(vm, client, "fetch");
    }
}
