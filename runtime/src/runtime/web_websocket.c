/* WHATWG WebSocket client (RFC 6455) over the host TCP/TLS connections, on the reactor. */
#include "web_websocket.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "async_context.h"
#include "base64.h"
#include "builtin_data_view.h"
#include "entropy.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "host.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "tcp.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_events_object.h"
#include "web_host_timer.h"

enum { WS_CONNECTING = 0, WS_OPEN = 1, WS_CLOSING = 2, WS_CLOSED = 3 };

typedef struct MalWebSocket {
    MalVm *vm;
    MalValue receiver;
    MalAsyncContext *async_context;
    MalHostHandle operation;
    bool secure;
    char *server_name;
    char *request;
    usize request_length;
    char accept[29];
    char *protocols;
    bool handshake_done;
    byte *input;
    usize input_length;
    usize input_capacity;
    byte *message;
    usize message_length;
    u8 message_opcode;
    bool close_sent;
    bool close_received;
    u16 close_code;
    byte reason[123];
    usize reason_length;
    bool failed;
    struct MalWebSocket *next;
} MalWebSocket;

static MAL_ISOLATE_LOCAL MalWebSocket *ws_list;
static MAL_ISOLATE_LOCAL MalValue ws_slots_symbol;
static MAL_ISOLATE_LOCAL MalValue ws_message_event_prototype;
static MAL_ISOLATE_LOCAL MalValue ws_close_event_prototype;
static MAL_ISOLATE_LOCAL bool ws_roots_installed;

static void ws_scan_roots(MalVm *vm, void *data) {
    (void) data;
    mal_gc_mark_value(ws_slots_symbol);
    mal_gc_mark_value(ws_message_event_prototype);
    mal_gc_mark_value(ws_close_event_prototype);
    for (MalWebSocket *ws = ws_list; ws != nullptr; ws = ws->next) {
        if (ws->vm != vm) continue;
        mal_gc_mark_value(ws->receiver);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) ws->async_context));
    }
}

/* SHA-1 (FIPS 180-4) for Sec-WebSocket-Accept only. */
static void ws_sha1(const byte *data, usize length, byte out[20]) {
    u32 h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
    usize total = ((length + 8) / 64 + 1) * 64;
    byte *buffer = calloc(1, total);
    if (buffer == nullptr) { memset(out, 0, 20); return; }
    memcpy(buffer, data, length);
    buffer[length] = 0x80;
    u64 bits = (u64) length * 8;
    for (int i = 0; i < 8; i++) buffer[total - 1 - i] = (byte) (bits >> (8 * i));
    for (usize chunk = 0; chunk < total; chunk += 64) {
        u32 w[80];
        for (int i = 0; i < 16; i++) {
            const u8 *p = (const u8 *) buffer + chunk + i * 4;
            w[i] = (u32) p[0] << 24 | (u32) p[1] << 16 | (u32) p[2] << 8 | p[3];
        }
        for (int i = 16; i < 80; i++) {
            u32 v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = v << 1 | v >> 31;
        }
        u32 a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; i++) {
            u32 f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999u; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1u; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6u; }
            u32 t = (a << 5 | a >> 27) + f + e + k + w[i];
            e = d; d = c; c = b << 30 | b >> 2; b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    free(buffer);
    for (int i = 0; i < 5; i++) {
        out[i * 4] = (byte) (h[i] >> 24);
        out[i * 4 + 1] = (byte) (h[i] >> 16);
        out[i * 4 + 2] = (byte) (h[i] >> 8);
        out[i * 4 + 3] = (byte) h[i];
    }
}

static MalWebSocket *ws_find(MalValue receiver) {
    for (MalWebSocket *ws = ws_list; ws != nullptr; ws = ws->next) {
        if (ws->receiver == receiver) return ws;
    }
    return nullptr;
}

static MalValue ws_slots(MalValue receiver) {
    if (!mal_value_is_object(receiver) || !mal_value_is_symbol(ws_slots_symbol)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(receiver),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = ws_slots_symbol});
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static MalValue ws_slot(MalVm *vm, MalValue receiver, const char *name) {
    MalValue slots = ws_slots(receiver);
    if (!mal_value_is_object(slots)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(slots), mal_intrinsic_string_key(vm, (const byte *) name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void ws_set_slot(MalVm *vm, MalValue receiver, const char *name, MalValue value) {
    MalValue slots = ws_slots(receiver);
    if (mal_value_is_object(slots)) {
        mal_object_set(mal_value_to_object(slots), mal_intrinsic_string_key(vm, (const byte *) name), value);
    }
}

static MalValue ws_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text)));
}

static void ws_define(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

static MalValue ws_event(MalVm *vm, const char *type, MalValue prototype) {
    MalValue name = ws_ascii(vm, type);
    MalRootSpan root;
    mal_gc_root(&root, &name, 1);
    MalCompletion made = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_EVENT_CONSTRUCTOR], &name, 1);
    mal_gc_unroot(&root);
    if (made.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    if (mal_value_is_object(prototype)) {
        mal_object_set_prototype(mal_value_to_object(made.value), mal_value_to_object(prototype));
    }
    return made.value;
}

static void ws_dispatch(MalVm *vm, MalValue target, MalValue event) {
    if (!mal_value_is_object(event)) return;
    MalValue roots[] = {target, event, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "dispatchEvent"), &roots[2])) {
        (void) mal_vm_call_value(vm, roots[2], roots[0], &roots[1], 1);
    }
    mal_gc_unroot(&root);
}

static void ws_free(MalWebSocket *ws) {
    MalWebSocket **link = &ws_list;
    while (*link != nullptr && *link != ws) link = &(*link)->next;
    if (*link == ws) *link = ws->next;
    free(ws->server_name);
    free(ws->request);
    free(ws->protocols);
    free(ws->input);
    free(ws->message);
    free(ws);
}

static void ws_write_frame(MalWebSocket *ws, u8 opcode, const byte *payload, usize length, bool counted) {
    usize header = 2 + (length < 126 ? 0 : length <= 0xffff ? 2 : 8) + 4;
    byte *frame = malloc(header + length);
    if (frame == nullptr) return;
    usize at = 0;
    frame[at++] = (byte) (0x80 | opcode);
    if (length < 126) {
        frame[at++] = (byte) (0x80 | length);
    } else if (length <= 0xffff) {
        frame[at++] = 0x80 | 126;
        frame[at++] = (byte) (length >> 8);
        frame[at++] = (byte) length;
    } else {
        frame[at++] = 0x80 | 127;
        for (int i = 7; i >= 0; i--) frame[at++] = (byte) ((u64) length >> (8 * i));
    }
    byte mask[4];
    (void) mal_host_entropy(mask, sizeof mask);
    memcpy(frame + at, mask, 4);
    at += 4;
    for (usize i = 0; i < length; i++) frame[at + i] = payload[i] ^ mask[i & 3];
    // The write token carries the payload length that bufferedAmount gives back on completion.
    if (!mal_tcp_write_owned(mal_host(ws->vm), ws->operation, frame, header + length, counted ? (u64) length + 1 : 0)) {
        free(frame);
    }
}

static void ws_buffered_add(MalVm *vm, MalValue receiver, f64 amount) {
    MalValue current = ws_slot(vm, receiver, "bufferedAmount");
    f64 value = mal_ops_is_number(current) ? mal_ops_number_as_f64(current) : 0;
    ws_set_slot(vm, receiver, "bufferedAmount", mal_value_from_f64(value + amount));
}

static void ws_send_close(MalWebSocket *ws, u16 code, const byte *reason, usize reason_length) {
    if (ws->close_sent) return;
    byte payload[125];
    usize length = 0;
    if (code != 0) {
        payload[0] = (byte) (code >> 8);
        payload[1] = (byte) code;
        memcpy(payload + 2, reason, reason_length);
        length = 2 + reason_length;
    }
    ws->close_sent = true;
    ws_write_frame(ws, 0x8, payload, length, false);
}

/* Fires close (after error when the connection failed) and releases the state. */
static void ws_finish(MalVm *vm, MalWebSocket *ws) {
    MalValue roots[] = {ws->receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool clean = ws->close_sent && ws->close_received && !ws->failed;
    u16 code = clean ? ws->close_code : 1006;
    MalValue reason = clean ? mal_value_from_string(mal_string_from_utf8(&vm->heap, ws->reason, ws->reason_length))
                            : ws_ascii(vm, "");
    bool failed = ws->failed;
    MalAsyncContext *context = ws->async_context;
    ws_free(ws);
    ws_set_slot(vm, roots[0], "readyState", mal_value_from_i32(WS_CLOSED));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    if (failed) ws_dispatch(vm, roots[0], ws_event(vm, "error", mal_value_new_undefined()));
    roots[1] = ws_event(vm, "close", ws_close_event_prototype);
    if (mal_value_is_object(roots[1])) {
        ws_define(vm, roots[1], "wasClean", mal_value_new_boolean(clean));
        ws_define(vm, roots[1], "code", mal_value_from_i32(code));
        ws_define(vm, roots[1], "reason", reason);
        ws_dispatch(vm, roots[0], roots[1]);
    }
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
}

/* The connection's terminal task, which cancellation queues, fires the events. */
static void ws_fail(MalVm *vm, MalWebSocket *ws, u16 code) {
    if (code != 0 && ws->handshake_done) ws_send_close(ws, code, nullptr, 0);
    ws->failed = true;
    ws_set_slot(vm, ws->receiver, "readyState", mal_value_from_i32(WS_CLOSING));
    if (ws->operation != 0) (void) mal_tcp_cancel(mal_host(vm), ws->operation);
}

static MalValue ws_header_value(const char *head, const char *name, char *out, usize capacity) {
    usize name_length = strlen(name);
    for (const char *line = strstr(head, "\r\n"); line != nullptr; line = strstr(line + 2, "\r\n")) {
        const char *start = line + 2;
        if (strncasecmp(start, name, name_length) == 0 && start[name_length] == ':') {
            const char *value = start + name_length + 1;
            while (*value == ' ' || *value == '\t') value++;
            const char *end = strstr(value, "\r\n");
            usize length = end == nullptr ? strlen(value) : (usize) (end - value);
            while (length > 0 && (value[length - 1] == ' ' || value[length - 1] == '\t')) length--;
            if (length >= capacity) length = capacity - 1;
            memcpy(out, value, length);
            out[length] = '\0';
            return mal_value_new_boolean(true);
        }
    }
    out[0] = '\0';
    return mal_value_new_boolean(false);
}

static bool ws_token_listed(const char *list, const char *token) {
    usize length = strlen(token);
    for (const char *at = list; at != nullptr && *at != '\0';) {
        while (*at == ' ' || *at == ',') at++;
        const char *end = strchr(at, ',');
        usize part = end == nullptr ? strlen(at) : (usize) (end - at);
        while (part > 0 && at[part - 1] == ' ') part--;
        if (part == length && strncasecmp(at, token, length) == 0) return true;
        at = end;
    }
    return false;
}

static bool ws_handshake(MalVm *vm, MalWebSocket *ws) {
    byte *end = nullptr;
    for (usize i = 0; i + 3 < ws->input_length; i++) {
        if (memcmp(ws->input + i, "\r\n\r\n", 4) == 0) { end = ws->input + i + 4; break; }
    }
    if (end == nullptr) return true;
    usize head_length = (usize) (end - ws->input);
    char *head = malloc(head_length + 1);
    if (head == nullptr) { ws_fail(vm, ws, 0); return false; }
    memcpy(head, ws->input, head_length);
    head[head_length] = '\0';
    char value[256];
    bool ok = strncmp(head, "HTTP/1.1 101", 12) == 0;
    ok = ok && mal_value_to_boolean(ws_header_value(head, "Upgrade", value, sizeof value)) && strcasecmp(value, "websocket") == 0;
    ok = ok && mal_value_to_boolean(ws_header_value(head, "Connection", value, sizeof value)) && ws_token_listed(value, "upgrade");
    ok = ok && mal_value_to_boolean(ws_header_value(head, "Sec-WebSocket-Accept", value, sizeof value))
        && strcmp(value, ws->accept) == 0;
    // No extension was offered, so any accepted one fails the connection.
    ok = ok && !mal_value_to_boolean(ws_header_value(head, "Sec-WebSocket-Extensions", value, sizeof value));
    char protocol[256];
    bool has_protocol = mal_value_to_boolean(ws_header_value(head, "Sec-WebSocket-Protocol", protocol, sizeof protocol));
    if (ok && has_protocol) ok = ws->protocols != nullptr && ws_token_listed(ws->protocols, protocol);
    free(head);
    if (!ok) { ws_fail(vm, ws, 0); return false; }
    memmove(ws->input, end, ws->input_length - head_length);
    ws->input_length -= head_length;
    ws->handshake_done = true;
    MalValue receiver = ws->receiver;
    MalRootSpan root;
    mal_gc_root(&root, &receiver, 1);
    ws_set_slot(vm, receiver, "readyState", mal_value_from_i32(WS_OPEN));
    ws_set_slot(vm, receiver, "protocol", has_protocol ? ws_ascii(vm, protocol) : ws_ascii(vm, ""));
    ws_dispatch(vm, receiver, ws_event(vm, "open", mal_value_new_undefined()));
    bool alive = ws_find(receiver) == ws;
    mal_gc_unroot(&root);
    return alive;
}

static void ws_deliver(MalVm *vm, MalWebSocket *ws, u8 opcode, byte *payload, usize length) {
    // WHATWG: a message that arrives once closing has started is dropped.
    MalValue ready = ws_slot(vm, ws->receiver, "readyState");
    if (!mal_ops_is_number(ready) || mal_ops_number_as_f64(ready) != WS_OPEN) return;
    MalValue roots[] = {ws->receiver, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (opcode == 0x1) {
        bool had_error = false;
        MalUtf8DecodeStatus status;
        MalString *text = mal_string_from_utf8_report(&vm->heap, payload, length, &had_error, &status);
        if (text == nullptr || had_error) {
            mal_gc_unroot(&root);
            ws_fail(vm, ws, 1007);
            return;
        }
        roots[1] = mal_value_from_string(text);
    } else {
        byte *copy = malloc(length > 0 ? length : 1);
        if (copy == nullptr) { mal_gc_unroot(&root); return; }
        if (length > 0) memcpy(copy, payload, length);
        roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), copy, (u32) length, true));
        MalValue type = ws_slot(vm, roots[0], "binaryType");
        if (!(mal_value_is_string(type) && mal_string_equals_ascii(mal_value_to_string(type), "arraybuffer"))) {
            roots[2] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
            (void) mal_array_object_set(mal_value_to_array_object(roots[2]), mal_key_index(0), roots[1]);
            MalCompletion blob = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_BLOB_CONSTRUCTOR], &roots[2], 1);
            if (blob.kind != MAL_COMPLETION_THROW) roots[1] = blob.value;
        }
    }
    roots[3] = ws_event(vm, "message", ws_message_event_prototype);
    if (mal_value_is_object(roots[3])) {
        ws_define(vm, roots[3], "data", roots[1]);
        MalValue origin = ws_slot(vm, roots[0], "origin");
        ws_define(vm, roots[3], "origin", origin);
        ws_define(vm, roots[3], "lastEventId", ws_ascii(vm, ""));
        ws_dispatch(vm, roots[0], roots[3]);
    }
    mal_gc_unroot(&root);
}

/* Parses complete frames; false once the state is gone. */
static bool ws_frames(MalVm *vm, MalWebSocket *ws) {
    while (ws->input_length >= 2) {
        const u8 *in = (const u8 *) ws->input;
        bool fin = in[0] & 0x80;
        u8 opcode = in[0] & 0x0f;
        if ((in[0] & 0x70) != 0 || (in[1] & 0x80) != 0) { ws_fail(vm, ws, 1002); return false; }
        u64 length = in[1] & 0x7f;
        usize at = 2;
        if (length == 126) {
            if (ws->input_length < 4) return true;
            length = (u64) in[2] << 8 | in[3];
            at = 4;
        } else if (length == 127) {
            if (ws->input_length < 10) return true;
            length = 0;
            for (int i = 0; i < 8; i++) length = length << 8 | in[2 + i];
            at = 10;
        }
        if (length > ws->input_length - at) return true;
        byte *payload = ws->input + at;
        const u8 *bytes = in + at;
        usize size = (usize) length;
        bool control = opcode >= 0x8;
        if (control && (!fin || size > 125)) { ws_fail(vm, ws, 1002); return false; }
        bool alive = true;
        if (opcode == 0x8) {
            ws->close_received = true;
            ws->close_code = size >= 2 ? (u16) (bytes[0] << 8 | bytes[1]) : 1005;
            ws->reason_length = size > 2 ? size - 2 : 0;
            memcpy(ws->reason, payload + 2, ws->reason_length);
            ws_set_slot(vm, ws->receiver, "readyState", mal_value_from_i32(WS_CLOSING));
            // Like undici, the echoed close carries the code but not the reason.
            if (!ws->close_sent) ws_send_close(ws, size >= 2 ? ws->close_code : 0, nullptr, 0);
            (void) mal_tcp_shutdown_write(mal_host(vm), ws->operation);
        } else if (opcode == 0x9) {
            if (!ws->close_sent) ws_write_frame(ws, 0xA, payload, size, false);
        } else if (opcode == 0xA) {
        } else if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
            if ((opcode == 0 && ws->message_opcode == 0) || (opcode != 0 && ws->message_opcode != 0)) {
                ws_fail(vm, ws, 1002);
                return false;
            }
            if (opcode != 0) ws->message_opcode = opcode;
            if (fin && ws->message_length == 0) {
                u8 kind = ws->message_opcode;
                ws->message_opcode = 0;
                byte *copy = malloc(size > 0 ? size : 1);
                if (copy != nullptr && size > 0) memcpy(copy, payload, size);
                usize consumed = at + size;
                memmove(ws->input, ws->input + consumed, ws->input_length - consumed);
                ws->input_length -= consumed;
                MalValue receiver = ws->receiver;
                MalRootSpan root;
                mal_gc_root(&root, &receiver, 1);
                if (copy != nullptr && !ws->close_received) ws_deliver(vm, ws, kind, copy, size);
                free(copy);
                alive = ws_find(receiver) == ws;
                mal_gc_unroot(&root);
                if (!alive) return false;
                continue;
            }
            byte *grown = realloc(ws->message, ws->message_length + size + 1);
            if (grown == nullptr) { ws_fail(vm, ws, 1009); return false; }
            ws->message = grown;
            memcpy(ws->message + ws->message_length, payload, size);
            ws->message_length += size;
            if (fin) {
                u8 kind = ws->message_opcode;
                byte *message = ws->message;
                usize message_length = ws->message_length;
                ws->message = nullptr;
                ws->message_length = 0;
                ws->message_opcode = 0;
                usize consumed = at + size;
                memmove(ws->input, ws->input + consumed, ws->input_length - consumed);
                ws->input_length -= consumed;
                MalValue receiver = ws->receiver;
                MalRootSpan root;
                mal_gc_root(&root, &receiver, 1);
                if (!ws->close_received) ws_deliver(vm, ws, kind, message, message_length);
                free(message);
                alive = ws_find(receiver) == ws;
                mal_gc_unroot(&root);
                if (!alive) return false;
                continue;
            }
        } else {
            ws_fail(vm, ws, 1002);
            return false;
        }
        usize consumed = at + size;
        memmove(ws->input, ws->input + consumed, ws->input_length - consumed);
        ws->input_length -= consumed;
    }
    return true;
}

static void ws_on_data(MalVm *vm, MalWebSocket *ws, const byte *bytes, usize length) {
    if (ws->input_length + length > ws->input_capacity) {
        usize capacity = (ws->input_length + length) * 2;
        byte *grown = realloc(ws->input, capacity);
        if (grown == nullptr) { ws_fail(vm, ws, 1009); return; }
        ws->input = grown;
        ws->input_capacity = capacity;
    }
    memcpy(ws->input + ws->input_length, bytes, length);
    ws->input_length += length;
    if (!ws->handshake_done && !ws_handshake(vm, ws)) return;
    if (ws->handshake_done) (void) ws_frames(vm, ws);
}

static void ws_send_request(MalWebSocket *ws) {
    byte *copy = malloc(ws->request_length);
    if (copy == nullptr) return;
    memcpy(copy, ws->request, ws->request_length);
    if (!mal_tcp_write_owned(mal_host(ws->vm), ws->operation, copy, ws->request_length, 0)) free(copy);
}

static bool mal_web_websocket_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr || ws_list == nullptr || mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask task;
    if (!mal_host_peek_task(&host->tasks, &task)) return false;
    MalWebSocket *ws = ws_list;
    while (ws != nullptr && (ws->vm != vm || ws->operation != task.operation)) ws = ws->next;
    if (ws == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, ws->async_context);
    if (task.kind == MAL_HOST_TASK_PROGRESS) {
        MalTcpProgress *progress = data;
        if (progress->kind == MAL_TCP_CONNECTED) {
            (void) mal_tcp_read_resume(host, ws->operation);
            if (ws->secure) {
                if (!mal_tcp_start_tls(host, ws->operation, (const byte *) ws->server_name, strlen(ws->server_name),
                        nullptr, 0, nullptr, 0, nullptr, false)) {
                    ws_fail(vm, ws, 0);
                }
            } else {
                ws_send_request(ws);
            }
        } else if (progress->kind == MAL_TCP_SECURE_CONNECTED) {
            ws_send_request(ws);
        } else if (progress->kind == MAL_TCP_DATA) {
            ws_on_data(vm, ws, progress->bytes, progress->length);
        } else if (progress->kind == MAL_TCP_WRITE_COMPLETE && progress->write_token > 0) {
            ws_buffered_add(vm, ws->receiver, -(f64) (progress->write_token - 1));
        }
        mal_tcp_progress_free(progress);
    } else {
        ws->operation = 0;
        if (!ws->close_received) ws->failed = true;
        ws_finish(vm, ws);
        if (data != nullptr) mal_tcp_terminal_free(data);
    }
    mal_async_context_scope_exit(vm, &scope);
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static bool ws_valid_protocol(const byte *text, usize length) {
    if (length == 0) return false;
    for (usize i = 0; i < length; i++) {
        byte c = text[i];
        if (c <= 0x20 || c >= 0x7f || strchr("()<>@,;:\\\"/[]?={}", c) != nullptr) return false;
    }
    return true;
}

static MalValue ws_syntax_error(MalVm *vm, const char *message) {
    mal_dom_exception_throw(vm, (const byte *) message, (const byte *) "SyntaxError");
    return mal_value_new_undefined();
}

static MalValue ws_url_part(MalVm *vm, MalValue url, const char *name, char **out) {
    MalValue value = mal_value_new_undefined();
    *out = nullptr;
    if (!mal_vm_get_property(vm, url, mal_intrinsic_string_key(vm, (const byte *) name), &value) || !mal_value_is_string(value)) {
        return mal_value_new_boolean(false);
    }
    usize length = 0;
    *out = (char *) mal_string_to_utf8(mal_value_to_string(value), &length);
    return mal_value_new_boolean(*out != nullptr);
}

static MalValue mal_web_websocket_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Class constructor WebSocket cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    char *protocol = nullptr, *hostname = nullptr, *port = nullptr, *pathname = nullptr, *search = nullptr, *hash = nullptr,
         *href = nullptr, *protocols = nullptr;
    MalString *text = mal_value_is_string(roots[0]) ? mal_value_to_string(roots[0]) : mal_ops_to_string(&vm->heap, roots[0]);
    if (text == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[0] = mal_value_from_string(text);
    MalCompletion parsed = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR], &roots[0], 1);
    if (parsed.kind == MAL_COMPLETION_THROW) {
        // undici reports String(error), i.e. "TypeError: Invalid URL".
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        MalValue name = mal_value_new_undefined(), message = mal_value_new_undefined();
        MalValue error_roots[] = {error, name, message};
        MalRootSpan error_root;
        mal_gc_root(&error_root, error_roots, countof(error_roots));
        (void) mal_vm_get_property(vm, error_roots[0], mal_intrinsic_string_key(vm, (const byte *) "name"), &error_roots[1]);
        (void) mal_vm_get_property(vm, error_roots[0], mal_intrinsic_string_key(vm, (const byte *) "message"), &error_roots[2]);
        usize name_length = 0, message_length = 0;
        byte *name_text = mal_value_is_string(error_roots[1]) ? mal_string_to_utf8(mal_value_to_string(error_roots[1]), &name_length) : nullptr;
        byte *message_text = mal_value_is_string(error_roots[2]) ? mal_string_to_utf8(mal_value_to_string(error_roots[2]), &message_length) : nullptr;
        char text[256];
        snprintf(text, sizeof text, "%s: %s", name_text ? (const char *) name_text : "Error",
            message_text ? (const char *) message_text : "Invalid URL");
        free(name_text);
        free(message_text);
        mal_gc_unroot(&error_root);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        ws_syntax_error(vm, text);
        goto done;
    }
    roots[2] = parsed.value;
    (void) ws_url_part(vm, roots[2], "protocol", &protocol);
    bool secure = protocol != nullptr && (strcmp(protocol, "wss:") == 0 || strcmp(protocol, "https:") == 0);
    if (protocol == nullptr || !(secure || strcmp(protocol, "ws:") == 0 || strcmp(protocol, "http:") == 0)) {
        ws_syntax_error(vm, "expected a ws: or wss: url");
        goto done;
    }
    if (strcmp(protocol, "http:") == 0 || strcmp(protocol, "https:") == 0) {
        roots[3] = ws_ascii(vm, secure ? "wss:" : "ws:");
        (void) mal_vm_set_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "protocol"), roots[3], roots[2]);
    }
    (void) ws_url_part(vm, roots[2], "hash", &hash);
    MalValue href_value = mal_value_new_undefined();
    (void) mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "href"), &href_value);
    roots[3] = href_value;
    if (hash != nullptr && hash[0] != '\0') {
        ws_syntax_error(vm, "hash");
        goto done;
    }
    if (mal_value_is_string(roots[3])) {
        MalString *full = mal_value_to_string(roots[3]);
        usize count = mal_string_length(full);
        const c16 *units = mal_string_code_units(full);
        for (usize i = 0; i < count; i++) {
            if (units[i] == '#') { ws_syntax_error(vm, "hash"); goto done; }
        }
    }
    // Protocols: a string or a sequence of unique tokens (compared case-sensitively, as undici does).
    usize protocols_length = 0;
    if (!mal_value_is_undefined(roots[1])) {
        roots[4] = roots[1];
        if (!mal_value_is_array_object(roots[4])) {
            roots[5] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
            (void) mal_array_object_set(mal_value_to_array_object(roots[5]), mal_key_index(0), roots[4]);
            roots[4] = roots[5];
        }
        MalArrayObject *list = mal_value_to_array_object(roots[4]);
        u32 count = mal_array_object_length(list);
        for (u32 i = 0; i < count; i++) {
            MalValue item = mal_value_new_undefined();
            (void) mal_vm_get_property(vm, roots[4], mal_key_index(i), &item);
            MalString *name = mal_value_is_string(item) ? mal_value_to_string(item) : mal_ops_to_string(&vm->heap, item);
            if (name == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            usize length = 0;
            byte *utf8 = mal_string_to_utf8(name, &length);
            bool valid = utf8 != nullptr && ws_valid_protocol(utf8, length);
            if (valid && protocols != nullptr) {
                for (const char *at = protocols; at != nullptr;) {
                    const char *end = strstr(at, ", ");
                    usize part = end == nullptr ? strlen(at) : (usize) (end - at);
                    if (part == length && memcmp(at, utf8, length) == 0) valid = false;
                    at = end == nullptr ? nullptr : end + 2;
                }
            }
            if (!valid) {
                free(utf8);
                ws_syntax_error(vm, "Invalid Sec-WebSocket-Protocol value");
                goto done;
            }
            char *grown = realloc(protocols, protocols_length + length + 3);
            if (grown == nullptr) { free(utf8); mal_vm_throw_allocation_error(vm); goto done; }
            protocols = grown;
            if (protocols_length > 0) { memcpy(protocols + protocols_length, ", ", 2); protocols_length += 2; }
            memcpy(protocols + protocols_length, utf8, length);
            protocols_length += length;
            protocols[protocols_length] = '\0';
            free(utf8);
        }
    }
    (void) ws_url_part(vm, roots[2], "hostname", &hostname);
    (void) ws_url_part(vm, roots[2], "port", &port);
    (void) ws_url_part(vm, roots[2], "pathname", &pathname);
    (void) ws_url_part(vm, roots[2], "search", &search);
    (void) ws_url_part(vm, roots[2], "href", &href);
    MalValue prototype = mal_vm_function_prototype(vm, new_target);
    roots[3] = mal_value_from_object((MalObject *) mal_event_target_object_new(&vm->heap,
        mal_value_to_object(mal_value_is_object(prototype) ? prototype : vm->intrinsics[MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE])));
    roots[4] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_object_set(mal_value_to_object(roots[3]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = ws_slots_symbol}, roots[4]);
    ws_set_slot(vm, roots[3], "url", ws_ascii(vm, href == nullptr ? "" : href));
    ws_set_slot(vm, roots[3], "readyState", mal_value_from_i32(WS_CONNECTING));
    ws_set_slot(vm, roots[3], "bufferedAmount", mal_value_from_i32(0));
    ws_set_slot(vm, roots[3], "protocol", ws_ascii(vm, ""));
    ws_set_slot(vm, roots[3], "extensions", ws_ascii(vm, ""));
    ws_set_slot(vm, roots[3], "binaryType", ws_ascii(vm, "blob"));
    MalWebSocket *ws = calloc(1, sizeof(*ws));
    if (ws == nullptr) { mal_vm_throw_allocation_error(vm); goto done; }
    ws->vm = vm;
    ws->receiver = roots[3];
    ws->async_context = mal_async_context_capture(vm);
    ws->secure = secure;
    ws->protocols = protocols;
    protocols = nullptr;
    const char *host = hostname == nullptr ? "" : hostname;
    usize host_length = strlen(host);
    // URL hostnames keep IPv6 brackets; the socket wants the bare address.
    char numeric[64];
    if (host_length >= 2 && host[0] == '[' && host_length - 2 < sizeof numeric) {
        memcpy(numeric, host + 1, host_length - 2);
        numeric[host_length - 2] = '\0';
    } else {
        snprintf(numeric, sizeof numeric, "%s", strcmp(host, "localhost") == 0 ? "127.0.0.1" : host);
    }
    ws->server_name = strdup(host);
    byte nonce[16];
    char key[25];
    (void) mal_host_entropy(nonce, sizeof nonce);
    usize key_length = mal_base64_encode(nonce, sizeof nonce, MAL_BASE64_ALPHABET_STANDARD, true, (byte *) key);
    key[key_length] = '\0';
    char concatenated[64];
    snprintf(concatenated, sizeof concatenated, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    byte digest[20];
    ws_sha1((const byte *) concatenated, strlen(concatenated), digest);
    usize accept_length = mal_base64_encode(digest, sizeof digest, MAL_BASE64_ALPHABET_STANDARD, true, (byte *) ws->accept);
    ws->accept[accept_length] = '\0';
    bool default_port = port == nullptr || port[0] == '\0';
    usize capacity = 512 + strlen(pathname ? pathname : "") + strlen(search ? search : "") + host_length
        + (ws->protocols ? strlen(ws->protocols) : 0);
    ws->request = malloc(capacity);
    if (ws->request != nullptr) {
        int written = snprintf(ws->request, capacity,
            "GET %s%s HTTP/1.1\r\nHost: %s%s%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n%s%s%s\r\n",
            pathname && pathname[0] ? pathname : "/", search ? search : "", host, default_port ? "" : ":",
            default_port ? "" : port, key, ws->protocols ? "Sec-WebSocket-Protocol: " : "",
            ws->protocols ? ws->protocols : "", ws->protocols ? "\r\n" : "");
        ws->request_length = written > 0 ? (usize) written : 0;
    }
    ws->next = ws_list;
    ws_list = ws;
    u16 port_number = default_port ? (secure ? 443 : 80) : (u16) strtoul(port, nullptr, 10);
    if (ws->request == nullptr || !mal_tcp_connect_start(mal_host(vm), numeric, port_number, &ws->operation)) {
        // Node reports even an immediate failure asynchronously, so it goes through the task queue.
        ws->failed = true;
        MalHostTasks *tasks = &mal_host(vm)->tasks;
        if (!mal_host_operation_start(tasks, &ws->operation)
            || !mal_host_operation_complete(tasks, ws->operation, MAL_HOST_TERMINAL_ERROR, nullptr, nullptr)) {
            ws->operation = 0;
        }
    }
    result = roots[3];
done:
    free(protocol); free(hostname); free(port); free(pathname); free(search); free(hash); free(href); free(protocols);
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_web_websocket_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target;
    MalValue name = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue slots = ws_slots(receiver);
    if (!mal_value_is_object(slots)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
        return mal_value_new_undefined();
    }
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(slots), mal_key_from_value(name));
    return lookup.present ? lookup.desc.value : mal_value_new_null();
}

static MalValue mal_web_websocket_binary_type_set(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    if (!mal_value_is_object(ws_slots(receiver))) return mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    // WebIDL enum assignment: unknown values are ignored.
    if (mal_value_is_string(value) && (mal_string_equals_ascii(mal_value_to_string(value), "blob")
            || mal_string_equals_ascii(mal_value_to_string(value), "arraybuffer"))) {
        ws_set_slot(vm, receiver, "binaryType", value);
    }
    return mal_value_new_undefined();
}

static MalValue mal_web_websocket_handler_trampoline(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalValue name = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue target = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    (void) receiver;
    MalValue slots = ws_slots(target);
    if (!mal_value_is_object(slots)) return mal_value_new_undefined();
    MalPropertyLookup handler = mal_object_get_own(mal_value_to_object(slots), mal_key_from_value(name));
    if (handler.present && mal_value_is_callable(handler.desc.value)) {
        return mal_vm_call_value(vm, handler.desc.value, target, args, argc).value;
    }
    return mal_value_new_undefined();
}

static MalValue mal_web_websocket_handler_set(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalValue name = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue type = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    MalValue slots = ws_slots(receiver);
    if (!mal_value_is_object(slots)) return mal_value_new_undefined();
    MalValue roots[] = {receiver, name, type, argc > 0 && mal_value_is_callable(args[0]) ? args[0] : mal_value_new_null(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool registered = mal_object_get_own(mal_value_to_object(slots), mal_key_from_value(roots[1])).present;
    mal_object_set(mal_value_to_object(slots), mal_key_from_value(roots[1]), roots[3]);
    if (!registered) {
        MalValue trampoline_slots[] = {roots[1], roots[0]};
        roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) ""), 1, mal_web_websocket_handler_trampoline, trampoline_slots, 2));
        if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "addEventListener"), &roots[5])) {
            MalValue listen_args[] = {roots[2], roots[4]};
            (void) mal_vm_call_value(vm, roots[5], roots[0], listen_args, 2);
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool ws_payload(MalVm *vm, MalValue data, byte **out, usize *length, u8 *opcode) {
    *out = nullptr;
    *length = 0;
    if (mal_value_is_heap_type(data, MAL_HEAP_BLOB_OBJECT)) {
        // A Blob's bytes are immutable and live in the object itself.
        typedef struct { MalObject object; MalObjectStorage storage; byte *bytes; usize length; } BlobView;
        BlobView *blob = (BlobView *) mal_value_to_heap(data);
        *out = malloc(blob->length > 0 ? blob->length : 1);
        if (*out == nullptr) return false;
        if (blob->length > 0) memcpy(*out, blob->bytes, blob->length);
        *length = blob->length;
        *opcode = 0x2;
        return true;
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(data, &span) == MAL_BUFFER_SOURCE_SPAN_OK) {
        *out = malloc(span.length > 0 ? span.length : 1);
        if (*out == nullptr) return false;
        if (span.length > 0) mal_buffer_source_span_read(&span, 0, *out, span.length);
        *length = span.length;
        *opcode = 0x2;
        return true;
    }
    MalString *text = mal_value_is_string(data) ? mal_value_to_string(data) : mal_ops_to_string(&vm->heap, data);
    if (text == nullptr) return false;
    *out = mal_string_to_utf8(text, length);
    *opcode = 0x1;
    return *out != nullptr;
}

static MalValue mal_web_websocket_send(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    MalValue slots = ws_slots(receiver);
    if (!mal_value_is_object(slots)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
        return mal_value_new_undefined();
    }
    MalValue state = ws_slot(vm, receiver, "readyState");
    i32 ready = mal_ops_is_number(state) ? (i32) mal_ops_number_as_f64(state) : WS_CLOSED;
    if (ready == WS_CONNECTING) {
        mal_dom_exception_throw(vm, (const byte *) "Sent before connected.", (const byte *) "InvalidStateError");
        return mal_value_new_undefined();
    }
    byte *payload;
    usize length;
    u8 opcode;
    if (!ws_payload(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &payload, &length, &opcode)) {
        return mal_value_new_undefined();
    }
    MalWebSocket *ws = ws_find(receiver);
    // Per the spec, data sent after closing starts still counts toward bufferedAmount.
    ws_buffered_add(vm, receiver, (f64) length);
    if (ready == WS_OPEN && ws != nullptr && !ws->close_sent) ws_write_frame(ws, opcode, payload, length, true);
    free(payload);
    return mal_value_new_undefined();
}

static MalValue mal_web_websocket_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    if (!mal_value_is_object(ws_slots(receiver))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
        return mal_value_new_undefined();
    }
    u16 code = 0;
    if (argc > 0 && !mal_value_is_undefined(args[0])) {
        f64 number = mal_ops_is_number(args[0]) ? mal_ops_number_as_f64(args[0]) : 0;
        if (!(number == 1000 || (number >= 3000 && number <= 4999))) {
            mal_dom_exception_throw(vm, (const byte *) "invalid code", (const byte *) "InvalidAccessError");
            return mal_value_new_undefined();
        }
        code = (u16) number;
    }
    byte *reason = nullptr;
    usize reason_length = 0;
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        MalString *text = mal_value_is_string(args[1]) ? mal_value_to_string(args[1]) : mal_ops_to_string(&vm->heap, args[1]);
        if (text == nullptr) return mal_value_new_undefined();
        reason = mal_string_to_utf8(text, &reason_length);
        if (reason_length > 123) {
            char message[96];
            snprintf(message, sizeof message, "Reason must be less than 123 bytes; received %zu", reason_length);
            free(reason);
            mal_dom_exception_throw(vm, (const byte *) message, (const byte *) "SyntaxError");
            return mal_value_new_undefined();
        }
    }
    MalWebSocket *ws = ws_find(receiver);
    MalValue state = ws_slot(vm, receiver, "readyState");
    i32 ready = mal_ops_is_number(state) ? (i32) mal_ops_number_as_f64(state) : WS_CLOSED;
    if (ws != nullptr && ready == WS_CONNECTING) {
        // Failing a connection that has not opened: Node then reports close 1006.
        ws_fail(vm, ws, 0);
    } else if (ws != nullptr && ready == WS_OPEN) {
        ws_set_slot(vm, receiver, "readyState", mal_value_from_i32(WS_CLOSING));
        ws_send_close(ws, code, reason, reason_length);
    }
    free(reason);
    return mal_value_new_undefined();
}

/* MessageEvent/CloseEvent: Events whose init fields become own properties. */
static MalValue mal_web_websocket_event_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue kind = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Class constructor cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalCompletion made = mal_vm_construct_value_with_target(
        vm, vm->intrinsics[MAL_INTRINSIC_EVENT_CONSTRUCTOR], args, argc > 2 ? 2 : argc, new_target);
    if (made.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalValue roots[] = {made.value, argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool close = mal_value_is_string(kind) && mal_string_equals_ascii(mal_value_to_string(kind), "close");
    static const char *const message_fields[] = {"data", "origin", "lastEventId", "source", "ports"};
    static const char *const close_fields[] = {"wasClean", "code", "reason"};
    const char *const *fields = close ? close_fields : message_fields;
    usize count = close ? countof(close_fields) : countof(message_fields);
    for (usize i = 0; i < count; i++) {
        roots[2] = mal_value_new_undefined();
        if (mal_value_is_object(roots[1])) {
            (void) mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) fields[i]), &roots[2]);
        }
        if (mal_value_is_undefined(roots[2])) {
            roots[2] = close ? (i == 0 ? mal_value_new_boolean(false) : i == 1 ? mal_value_from_i32(0) : ws_ascii(vm, ""))
                : i == 0 ? mal_value_new_null() : i < 3 ? ws_ascii(vm, "") : i == 3 ? mal_value_new_null()
                : mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
        } else if (close && i == 0) {
            roots[2] = mal_value_new_boolean(mal_value_is_truthy(roots[2]));
        }
        ws_define(vm, roots[0], fields[i], roots[2]);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue ws_event_class(MalVm *vm, const char *name, const char *kind) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_PROTOTYPE]))), ws_ascii(vm, kind), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_CONSTRUCTOR]), mal_intrinsic_ascii(vm, (const byte *) name), 1,
        mal_web_websocket_event_constructor, &roots[1], 1);
    mal_native_function_object_set_constructor(constructor);
    roots[2] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "constructor", roots[2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[2];
}

void mal_web_websocket_install(MalVm *vm, MalObject *module) {
    // Embedders may install node:http before the web event classes exist; WebSocket needs them.
    static const MalIntrinsic required[] = {
        MAL_INTRINSIC_EVENT_CONSTRUCTOR, MAL_INTRINSIC_EVENT_PROTOTYPE,
        MAL_INTRINSIC_EVENT_TARGET_CONSTRUCTOR, MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE,
        MAL_INTRINSIC_URL_CONSTRUCTOR, MAL_INTRINSIC_BLOB_CONSTRUCTOR,
    };
    for (usize i = 0; i < countof(required); i++) {
        if (!mal_value_is_object(vm->intrinsics[required[i]])) return;
    }
    if (!ws_roots_installed) {
        ws_slots_symbol = mal_value_new_undefined();
        ws_message_event_prototype = mal_value_new_undefined();
        ws_close_event_prototype = mal_value_new_undefined();
        mal_gc_register_root_source(ws_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_web_websocket_drain, false);
        ws_roots_installed = true;
    }
    if (!mal_value_is_symbol(ws_slots_symbol)) ws_slots_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE]))), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype = mal_value_to_object(roots[0]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_TARGET_CONSTRUCTOR]),
        mal_intrinsic_ascii(vm, (const byte *) "WebSocket"), 1, mal_web_websocket_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "close", 0, mal_web_websocket_close);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "send", 1, mal_web_websocket_send);
    static const char *const getters[] = {"readyState", "bufferedAmount", "url", "extensions", "protocol"};
    for (usize i = 0; i < countof(getters); i++) {
        roots[2] = ws_ascii(vm, getters[i]);
        char getter_name[48];
        snprintf(getter_name, sizeof getter_name, "get %s", getters[i]);
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) getter_name), 0, mal_web_websocket_getter, &roots[2], 1));
        MalPropertyDesc desc = mal_intrinsic_accessor_desc(roots[3], mal_value_new_undefined(),
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(prototype, mal_key_from_value(roots[2]), &desc);
    }
    static const char *const handlers[] = {"onopen", "onerror", "onclose", "onmessage"};
    for (usize i = 0; i < countof(handlers); i++) {
        roots[2] = ws_ascii(vm, handlers[i]);
        roots[3] = ws_ascii(vm, handlers[i] + 2);
        char getter_name[48];
        snprintf(getter_name, sizeof getter_name, "get %s", handlers[i]);
        roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) getter_name), 0, mal_web_websocket_getter, &roots[2], 1));
        snprintf(getter_name, sizeof getter_name, "set %s", handlers[i]);
        roots[5] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) getter_name), 1, mal_web_websocket_handler_set, &roots[2], 2));
        MalPropertyDesc desc = mal_intrinsic_accessor_desc(roots[4], roots[5], MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(prototype, mal_key_from_value(roots[2]), &desc);
    }
    roots[2] = ws_ascii(vm, "binaryType");
    roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "get binaryType"), 0, mal_web_websocket_getter, &roots[2], 1));
    roots[5] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "set binaryType"), 1, mal_web_websocket_binary_type_set, &roots[2], 1));
    MalPropertyDesc binary = mal_intrinsic_accessor_desc(roots[4], roots[5], MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_key_from_value(roots[2]), &binary);
    static const char *const states[] = {"CONNECTING", "OPEN", "CLOSING", "CLOSED"};
    for (usize i = 0; i < countof(states); i++) {
        mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) states[i], mal_value_from_i32((i32) i),
            MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, prototype, (const byte *) states[i], mal_value_from_i32((i32) i), MAL_PROPERTY_ENUMERABLE);
    }
    roots[2] = ws_event_class(vm, "MessageEvent", "message");
    ws_message_event_prototype = mal_vm_function_prototype(vm, roots[2]);
    roots[3] = ws_event_class(vm, "CloseEvent", "close");
    ws_close_event_prototype = mal_vm_function_prototype(vm, roots[3]);
    MalPropertyFlags visible = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    static const char *const names[] = {"WebSocket", "MessageEvent", "CloseEvent"};
    MalValue values[] = {roots[1], roots[2], roots[3]};
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, module, (const byte *) names[i], values[i], visible);
        if (mal_value_is_object(global)) {
            mal_intrinsic_define_data(vm, mal_value_to_object(global), (const byte *) names[i], values[i],
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
