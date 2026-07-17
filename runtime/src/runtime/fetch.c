#include "fetch.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "headers_object.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "request_object.h"
#include "response_object.h"
#include "server.h" // host: mal_http_handler, mal_http_conn_respond, MalHttpRequest
#include "text_encoding.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h" // mal_vm_get_property

static const char *mal_fetch_reason(int status) {
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
        default: return "OK";
    }
}

/* Extract the byte range of a BufferSource (TypedArray or ArrayBuffer); returns
 * false for anything else. */
static bool mal_fetch_buffer_source(MalValue v, const byte **out, usize *out_len) {
    if (mal_value_is_typed_array_object(v)) {
        MalTypedArrayObject *ta = mal_value_to_typed_array_object(v);
        if (ta->buffer == nullptr || ta->buffer->detached) {
            *out = nullptr;
            *out_len = 0;
            return true;
        }
        *out = (const byte *) ta->buffer->data + ta->byte_offset;
        *out_len = mal_typed_array_object_byte_length(ta);
        return true;
    }
    if (mal_value_is_array_buffer_object(v)) {
        MalArrayBufferObject *ab = mal_value_to_array_buffer_object(v);
        *out = (const byte *) ab->data;
        *out_len = ab->detached ? 0 : ab->byte_length;
        return true;
    }
    return false;
}

/* Fresh ArrayBuffer holding a copy of bytes. */
static MalValue mal_fetch_new_array_buffer(MalVm *vm, const byte *data, usize len) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *ab =
        mal_array_buffer_object_new(&vm->heap, proto, (u32) len, (u32) len, false, false);
    if (len > 0) {
        memcpy(ab->data, data, len);
    }
    return mal_value_from_array_buffer_object(ab);
}

/* Fresh Uint8Array over a copy of bytes (buffer rooted across the view alloc). */
static MalValue mal_fetch_new_uint8array(MalVm *vm, const byte *data, usize len) {
    MalObject *ab_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *ab =
        mal_array_buffer_object_new(&vm->heap, ab_proto, (u32) len, (u32) len, false, false);
    if (len > 0) {
        memcpy(ab->data, data, len);
    }
    MalValue buf = mal_value_from_array_buffer_object(ab);
    MalRootSpan rs;
    mal_gc_root(&rs, &buf, 1);
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]);
    MalValue view = mal_value_from_typed_array_object(
        mal_typed_array_object_new(&vm->heap, proto, ab, MAL_TA_UINT8, 0, (u32) len, false));
    mal_gc_unroot(&rs);
    return view;
}

/* Case-insensitive header-name match (defined below; used by Response.json). */
static bool mal_fetch_name_is(const MalString *name, const char *ascii);

/* Resolve a value to a native Promise, returning the promise (or undefined on
 * failure). mal_promise_resolve_value roots its argument internally. */
static MalValue mal_fetch_resolve(MalVm *vm, MalValue value) {
    MalValue promise;
    return mal_promise_resolve_value(vm, value, &promise) ? promise : mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * Response object.
 * --------------------------------------------------------------------------- */

MalResponseObject *mal_response_object_new(
    MalHeap *heap, MalObject *prototype, i32 status, byte *body, usize body_len) {
    MalResponseObject *r = mal_heap_alloc(heap, sizeof(MalResponseObject), MAL_HEAP_RESPONSE_OBJECT);
    mal_object_init(heap, &r->object, MAL_HEAP_RESPONSE_OBJECT, prototype);
    r->status = status;
    r->headers = mal_value_new_undefined();
    r->body = body;
    r->body_len = body_len;
    return r;
}

static void mal_response_finalize(MalHeapHeader *cell) {
    MalResponseObject *r = (MalResponseObject *) cell;
    if (r->body != nullptr) {
        free(r->body);
        r->body = nullptr;
    }
}

static void mal_response_trace(MalHeapHeader *cell) {
    mal_gc_mark_value(((MalResponseObject *) cell)->headers);
}

static MalValue mal_response_constructor(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    i32 status = 200;
    MalValue init_headers = mal_value_new_undefined();
    if (arg_count >= 2 && mal_value_is_object(args[1])) {
        MalValue s;
        if (mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "status"), &s)
            && mal_ops_is_number(s)) {
            status = (i32) mal_ops_to_number(s);
        }
        MalValue hv;
        if (mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "headers"), &hv)) {
            init_headers = hv;
        }
    }

    byte *body = nullptr;
    usize body_len = 0;
    const byte *src_bytes;
    usize src_len;
    if (arg_count >= 1 && mal_value_is_string(args[0])) {
        MalString *str = mal_value_to_string(args[0]);
        body = mal_utf8_encode(mal_string_code_units(str), mal_string_length(str), &body_len);
    } else if (arg_count >= 1 && mal_fetch_buffer_source(args[0], &src_bytes, &src_len)) {
        // A BufferSource (ArrayBuffer / TypedArray) body: copy the raw bytes.
        body = malloc(src_len == 0 ? 1 : src_len);
        if (src_len > 0) {
            memcpy(body, src_bytes, src_len);
        }
        body_len = src_len;
    }

    MalValue roots[2] = {init_headers, mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]);
    MalResponseObject *r = mal_response_object_new(&vm->heap, proto, status, body, body_len);
    roots[1] = mal_value_from_response_object(r);
    r->headers = mal_value_from_headers_object(mal_headers_from_init(vm, roots[0]));
    MalValue result = roots[1];
    mal_gc_unroot(&rs);
    return result;
}

/* --- Response read side (a received/constructed Response is read via these). --- */

static MalResponseObject *mal_response_this(MalValue self) {
    return mal_value_is_response_object(self) ? mal_value_to_response_object(self) : nullptr;
}

/* Decode a Response's body bytes to a string (empty when there is no body). */
static MalValue mal_response_body_string(MalVm *vm, MalResponseObject *r) {
    if (r == nullptr || r->body == nullptr || r->body_len == 0) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    usize count;
    c16 *units = mal_utf8_decode((const byte *) r->body, r->body_len, &count);
    MalValue s = mal_value_from_string(mal_string_new_copy(&vm->heap, units, count));
    free(units);
    return s;
}

static MalValue mal_response_method_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_fetch_resolve(vm, mal_response_body_string(vm, mal_response_this(self)));
}

static MalValue mal_response_method_array_buffer(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    const byte *bytes = (r != nullptr && r->body != nullptr) ? (const byte *) r->body : (const byte *) "";
    usize len = (r != nullptr && r->body != nullptr) ? r->body_len : 0;
    return mal_fetch_resolve(vm, mal_fetch_new_array_buffer(vm, bytes, len));
}

static MalValue mal_response_method_bytes(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    const byte *bytes = (r != nullptr && r->body != nullptr) ? (const byte *) r->body : (const byte *) "";
    usize len = (r != nullptr && r->body != nullptr) ? r->body_len : 0;
    return mal_fetch_resolve(vm, mal_fetch_new_uint8array(vm, bytes, len));
}

static MalValue mal_response_method_json(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalValue text = mal_response_body_string(vm, mal_response_this(self));
    MalValue parsed = mal_value_new_undefined();
    MalValue json_ns = vm->intrinsics[MAL_INTRINSIC_JSON];
    MalValue parse_fn;
    if (mal_vm_get_property(vm, json_ns, mal_intrinsic_string_key(vm, (const byte *) "parse"), &parse_fn)
        && mal_value_is_callable(parse_fn)) {
        MalCompletion c = mal_vm_call_value(vm, parse_fn, json_ns, &text, 1);
        if (c.kind == MAL_COMPLETION_THROW) {
            vm->completion =
                (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        } else {
            parsed = c.value;
        }
    }
    return mal_fetch_resolve(vm, parsed);
}

static MalValue mal_response_get_status(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    return mal_value_from_f64((f64) (r != nullptr ? r->status : 0));
}

static MalValue mal_response_get_ok(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    return mal_value_new_boolean(r != nullptr && r->status >= 200 && r->status <= 299);
}

static MalValue mal_response_get_status_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    const char *reason = mal_fetch_reason(r != nullptr ? r->status : 200);
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, reason, strlen(reason)));
}

static MalValue mal_response_get_headers(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    if (r == nullptr || !mal_value_is_headers_object(r->headers)) {
        return mal_value_new_undefined();
    }
    return r->headers;
}

/* Define a getter-only accessor on a prototype. */
static void mal_fetch_define_getter(
    MalVm *vm, MalObject *proto, const byte *name, MalNativeFunctionCallback getter) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(
            mal_native_function_object_new(&vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), getter)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(proto, mal_intrinsic_string_key(vm, name), &desc);
}

/* Read an optional { status, headers } init into out-params. */
static void mal_response_read_init(MalVm *vm, const MalValue *args, i32 argc, i32 *status,
    MalValue *init_headers) {
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue s;
        if (mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "status"), &s)
            && mal_ops_is_number(s)) {
            *status = (i32) mal_ops_to_number(s);
        }
        MalValue hv;
        if (mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "headers"), &hv)) {
            *init_headers = hv;
        }
    }
}

/* Response.json(data, init?): a JSON Response (Content-Type defaults to
 * application/json unless the init headers already set it). */
static MalValue mal_response_static_json(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue data = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue json_ns = vm->intrinsics[MAL_INTRINSIC_JSON];
    MalValue stringify;
    if (!mal_vm_get_property(vm, json_ns, mal_intrinsic_string_key(vm, (const byte *) "stringify"), &stringify)
        || !mal_value_is_callable(stringify)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "JSON.stringify unavailable");
        return mal_value_new_undefined();
    }
    MalCompletion c = mal_vm_call_value(vm, stringify, json_ns, &data, 1);
    if (c.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_string(c.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response.json: data could not be serialized");
        return mal_value_new_undefined();
    }
    MalValue json = c.value;
    MalRootSpan jrs;
    mal_gc_root(&jrs, &json, 1);
    MalString *jstr = mal_value_to_string(json);
    usize body_len;
    byte *body = mal_utf8_encode(mal_string_code_units(jstr), mal_string_length(jstr), &body_len);

    i32 status = 200;
    MalValue init_headers = mal_value_new_undefined();
    mal_response_read_init(vm, args, argc, &status, &init_headers);

    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]);
    MalResponseObject *r = mal_response_object_new(&vm->heap, proto, status, body, body_len);
    MalValue rval = mal_value_from_response_object(r);
    MalRootSpan rrs;
    mal_gc_root(&rrs, &rval, 1);
    MalHeadersObject *h = mal_headers_from_init(vm, init_headers);
    r->headers = mal_value_from_headers_object(h); // reachable + traced via r now
    bool has_ct = false;
    for (i32 i = 0; i < h->count; i++) {
        if (mal_fetch_name_is(h->entries[i].name, "content-type")) {
            has_ct = true;
            break;
        }
    }
    if (!has_ct) {
        mal_headers_append_bytes(vm, h, "content-type", 12, "application/json", 16);
    }
    mal_gc_unroot(&rrs);
    mal_gc_unroot(&jrs);
    return rval;
}

/* Response.redirect(url, status = 302): an empty-body Response with a Location. */
static MalValue mal_response_static_redirect(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalString *url;
    if (argc < 1 || !mal_vm_to_string(vm, args[0], &url)) {
        if (argc < 1) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "redirect requires a url");
        }
        return mal_value_new_undefined();
    }
    i32 status = 302;
    if (argc >= 2 && mal_ops_is_number(args[1])) {
        status = (i32) mal_ops_to_number(args[1]);
    }
    MalValue url_val = mal_value_from_string(url);
    MalRootSpan urs;
    mal_gc_root(&urs, &url_val, 1);
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]);
    MalResponseObject *r = mal_response_object_new(&vm->heap, proto, status, nullptr, 0);
    MalValue rval = mal_value_from_response_object(r);
    MalRootSpan rrs;
    mal_gc_root(&rrs, &rval, 1);
    MalHeadersObject *h = mal_headers_create(vm);
    r->headers = mal_value_from_headers_object(h);
    MalString *url_string = mal_value_to_string(url_val);
    usize url_len;
    byte *url_bytes = mal_utf8_encode(
        mal_string_code_units(url_string), mal_string_length(url_string), &url_len);
    mal_headers_append_bytes(vm, h, "location", 8, (const char *) url_bytes, url_len);
    free(url_bytes);
    mal_gc_unroot(&rrs);
    mal_gc_unroot(&urs);
    return rval;
}

/* Response.error(): a network-error Response (status 0). */
static MalValue mal_response_static_error(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]);
    MalResponseObject *r = mal_response_object_new(&vm->heap, proto, 0, nullptr, 0);
    MalValue rval = mal_value_from_response_object(r);
    MalRootSpan rrs;
    mal_gc_root(&rrs, &rval, 1);
    r->headers = mal_value_from_headers_object(mal_headers_create(vm));
    mal_gc_unroot(&rrs);
    return rval;
}

/* ---------------------------------------------------------------------------
 * Request object (built by the server from a parsed request).
 * --------------------------------------------------------------------------- */

MalRequestObject *mal_request_object_new(MalHeap *heap, MalObject *prototype) {
    MalRequestObject *r = mal_heap_alloc(heap, sizeof(MalRequestObject), MAL_HEAP_REQUEST_OBJECT);
    mal_object_init(heap, &r->object, MAL_HEAP_REQUEST_OBJECT, prototype);
    r->body = nullptr;
    r->body_len = 0;
    return r;
}

static void mal_request_finalize(MalHeapHeader *cell) {
    MalRequestObject *r = (MalRequestObject *) cell;
    if (r->body != nullptr) {
        free(r->body);
        r->body = nullptr;
    }
}

/* Decode a Request's body bytes to a string (empty when there is no body). */
static MalValue mal_request_body_string(MalVm *vm, MalRequestObject *r) {
    if (r == nullptr || r->body == nullptr || r->body_len == 0) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    usize count;
    c16 *units = mal_utf8_decode(r->body, r->body_len, &count);
    MalValue s = mal_value_from_string(mal_string_new_copy(&vm->heap, units, count));
    free(units);
    return s;
}

static MalValue mal_request_method_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalRequestObject *r =
        mal_value_is_request_object(self) ? mal_value_to_request_object(self) : nullptr;
    return mal_fetch_resolve(vm, mal_request_body_string(vm, r));
}

/* arrayBuffer(): Promise<ArrayBuffer> of the raw body bytes. */
static MalValue mal_request_method_array_buffer(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalRequestObject *r =
        mal_value_is_request_object(self) ? mal_value_to_request_object(self) : nullptr;
    const byte *bytes = (r != nullptr && r->body != nullptr) ? r->body : (const byte *) "";
    usize len = (r != nullptr && r->body != nullptr) ? r->body_len : 0;
    return mal_fetch_resolve(vm, mal_fetch_new_array_buffer(vm, bytes, len));
}

/* bytes(): Promise<Uint8Array> of the raw body bytes. */
static MalValue mal_request_method_bytes(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalRequestObject *r =
        mal_value_is_request_object(self) ? mal_value_to_request_object(self) : nullptr;
    const byte *bytes = (r != nullptr && r->body != nullptr) ? r->body : (const byte *) "";
    usize len = (r != nullptr && r->body != nullptr) ? r->body_len : 0;
    return mal_fetch_resolve(vm, mal_fetch_new_uint8array(vm, bytes, len));
}

static MalValue mal_request_method_json(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalRequestObject *r =
        mal_value_is_request_object(self) ? mal_value_to_request_object(self) : nullptr;
    MalValue text = mal_request_body_string(vm, r);

    MalValue parsed = mal_value_new_undefined();
    MalValue json_ns = vm->intrinsics[MAL_INTRINSIC_JSON];
    MalValue parse_fn;
    if (mal_vm_get_property(vm, json_ns, mal_intrinsic_string_key(vm, (const byte *) "parse"), &parse_fn)
        && mal_value_is_callable(parse_fn)) {
        MalCompletion c = mal_vm_call_value(vm, parse_fn, json_ns, &text, 1);
        if (c.kind == MAL_COMPLETION_THROW) {
            // v1: a parse error yields undefined (proper promise rejection later).
            vm->completion =
                (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        } else {
            parsed = c.value;
        }
    }
    return mal_fetch_resolve(vm, parsed);
}

/* `new Request(input, init?)`: input is a URL string or another Request (copied);
 * init overrides method / headers / body. method/url/headers are own properties,
 * the body is stored as raw bytes (like a server-built Request). */
static MalValue mal_request_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE]);
    if (mal_value_is_object(nt)) {
        MalValue p = mal_vm_function_prototype(vm, nt);
        if (mal_value_is_object(p)) {
            proto = mal_value_to_object(p);
        }
    }
    MalRequestObject *r = mal_request_object_new(&vm->heap, proto);
    // Root the instance + the transient method/url/headers/body values across the
    // allocations below (ToString, Headers construction).
    MalValue slots[5];
    slots[0] = mal_value_from_request_object(r);
    slots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "GET", 3)); // method
    slots[2] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));    // url
    slots[3] = mal_value_new_undefined();                                        // headers init
    slots[4] = mal_value_new_undefined();                                        // body value
    MalRootSpan rs;
    mal_gc_root(&rs, slots, 5);

    if (argc >= 1 && mal_value_is_request_object(args[0])) {
        MalRequestObject *src = mal_value_to_request_object(args[0]);
        MalValue v;
        if (mal_vm_get_property(vm, args[0], mal_intrinsic_string_key(vm, (const byte *) "method"), &v)) {
            slots[1] = v;
        }
        if (mal_vm_get_property(vm, args[0], mal_intrinsic_string_key(vm, (const byte *) "url"), &v)) {
            slots[2] = v;
        }
        if (mal_vm_get_property(vm, args[0], mal_intrinsic_string_key(vm, (const byte *) "headers"), &v)) {
            slots[3] = v;
        }
        if (src->body != nullptr && src->body_len > 0) {
            r->body = malloc(src->body_len);
            memcpy(r->body, src->body, src->body_len);
            r->body_len = src->body_len;
        }
    } else if (argc >= 1 && !mal_value_is_undefined(args[0])) {
        MalString *u;
        if (mal_vm_to_string(vm, args[0], &u)) {
            slots[2] = mal_value_from_string(u);
        }
    }

    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue v;
        if (mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "method"), &v)
            && !mal_value_is_undefined(v)) {
            MalString *m;
            if (mal_vm_to_string(vm, v, &m)) {
                slots[1] = mal_value_from_string(m);
            }
        }
        if (mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "headers"), &v)
            && !mal_value_is_undefined(v)) {
            slots[3] = v;
        }
        if (mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "body"), &v)
            && !mal_value_is_undefined(v)) {
            slots[4] = v;
        }
    }

    // A body from init (string or BufferSource) replaces any copied body.
    if (mal_value_is_string(slots[4])) {
        MalString *bs = mal_value_to_string(slots[4]);
        free(r->body);
        r->body = mal_utf8_encode(mal_string_code_units(bs), mal_string_length(bs), &r->body_len);
    } else {
        const byte *sb;
        usize sl;
        if (mal_fetch_buffer_source(slots[4], &sb, &sl)) {
            free(r->body);
            r->body = malloc(sl == 0 ? 1 : sl);
            if (sl > 0) {
                memcpy(r->body, sb, sl);
            }
            r->body_len = sl;
        }
    }

    mal_object_set(&r->object, mal_intrinsic_string_key(vm, (const byte *) "method"), slots[1]);
    mal_object_set(&r->object, mal_intrinsic_string_key(vm, (const byte *) "url"), slots[2]);
    MalHeadersObject *h = mal_headers_from_init(vm, slots[3]);
    mal_object_set(&r->object, mal_intrinsic_string_key(vm, (const byte *) "headers"),
        mal_value_from_headers_object(h));

    mal_gc_unroot(&rs);
    return slots[0];
}

static MalValue mal_fetch_make_request(
    MalVm *vm, const MalHttpRequest *req, const char *body, usize body_len) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE]);
    MalRequestObject *r = mal_request_object_new(&vm->heap, proto);
    if (body_len > 0) {
        r->body = malloc(body_len);
        memcpy(r->body, body, body_len);
        r->body_len = body_len;
    }

    MalString *method = mal_string_new_ascii(&vm->heap, req->method, req->method_len);
    mal_object_set(&r->object, mal_intrinsic_string_key(vm, (const byte *) "method"),
        mal_value_from_string(method));

    // url = "http://" + Host + request-target (spec wants an absolute URL string).
    const char *host_hdr;
    usize host_len;
    if (!mal_http_header(req, "host", &host_hdr, &host_len)) {
        host_hdr = "localhost";
        host_len = 9;
    }
    char urlbuf[2048];
    int un = snprintf(urlbuf, sizeof(urlbuf), "http://%.*s%.*s", (int) host_len, host_hdr,
        (int) req->target_len, req->target);
    MalString *url = mal_string_new_ascii(&vm->heap, urlbuf, un > 0 ? (usize) un : 0);
    mal_object_set(&r->object, mal_intrinsic_string_key(vm, (const byte *) "url"),
        mal_value_from_string(url));

    // request.headers (a Headers instance built from the parsed headers).
    MalHeadersObject *headers = mal_headers_create(vm);
    for (usize i = 0; i < req->header_count; i++) {
        mal_headers_append_bytes(vm, headers, req->headers[i].name, req->headers[i].name_len,
            req->headers[i].value, req->headers[i].value_len);
    }
    mal_object_set(&r->object, mal_intrinsic_string_key(vm, (const byte *) "headers"),
        mal_value_from_headers_object(headers));

    return mal_value_from_request_object(r);
}

/* ---------------------------------------------------------------------------
 * The handler hook + Mal.serve.
 * --------------------------------------------------------------------------- */

/* The connection is a host C struct (not a GC cell) that stays alive across the
 * async gap — nothing closes it while a response is pending — so we can carry the
 * pointer through a native reaction's slot boxed as an f64 (48-bit pointers are
 * exact in a double). */
static MalValue mal_fetch_box_conn(MalHttpConn *conn) {
    return mal_value_from_f64((f64) (uptr) conn);
}

static MalHttpConn *mal_fetch_unbox_conn(MalValue value) {
    return (MalHttpConn *) (uptr) mal_value_to_f64(value);
}

/* Case-insensitive match of a header name (UTF-16) against a lowercase ASCII literal. */
static bool mal_fetch_name_is(const MalString *name, const char *ascii) {
    usize len = mal_string_length(name);
    usize alen = strlen(ascii);
    if (len != alen) {
        return false;
    }
    const c16 *u = mal_string_code_units(name);
    for (usize i = 0; i < len; i++) {
        c16 x = u[i];
        if (x >= 'A' && x <= 'Z') {
            x = (c16) (x + 32);
        }
        if (x != (c16) (unsigned char) ascii[i]) {
            return false;
        }
    }
    return true;
}

/* Serialize a Response's Headers into an HTTP header block ("Name: Value\r\n" per
 * line), skipping host-managed framing headers and ensuring a Content-Type. Returns
 * malloc'd bytes + len (caller frees), or null (=> host default) when there is no
 * Headers object. */
static char *mal_fetch_serialize_headers(MalResponseObject *r, usize *out_len) {
    static const char default_ct[] = "Content-Type: text/plain; charset=utf-8\r\n";
    if (!mal_value_is_headers_object(r->headers)) {
        *out_len = 0;
        return nullptr;
    }
    MalHeadersObject *h = mal_value_to_headers_object(r->headers);

    bool has_ct = false;
    usize size = 0;
    for (i32 i = 0; i < h->count; i++) {
        const MalString *n = h->entries[i].name;
        if (mal_fetch_name_is(n, "content-length") || mal_fetch_name_is(n, "connection")
            || mal_fetch_name_is(n, "transfer-encoding")) {
            continue;
        }
        if (mal_fetch_name_is(n, "content-type")) {
            has_ct = true;
        }
        size += mal_string_length(n) + 2 + mal_string_length(h->entries[i].value) + 2;
    }
    if (!has_ct) {
        size += strlen(default_ct);
    }

    char *buf = malloc(size == 0 ? 1 : size);
    usize o = 0;
    if (!has_ct) {
        memcpy(buf, default_ct, strlen(default_ct));
        o += strlen(default_ct);
    }
    for (i32 i = 0; i < h->count; i++) {
        const MalString *n = h->entries[i].name;
        if (mal_fetch_name_is(n, "content-length") || mal_fetch_name_is(n, "connection")
            || mal_fetch_name_is(n, "transfer-encoding")) {
            continue;
        }
        const c16 *nu = mal_string_code_units(n);
        usize nl = mal_string_length(n);
        for (usize k = 0; k < nl; k++) {
            buf[o++] = (char) nu[k];
        }
        buf[o++] = ':';
        buf[o++] = ' ';
        const MalString *v = h->entries[i].value;
        const c16 *vu = mal_string_code_units(v);
        usize vl = mal_string_length(v);
        for (usize k = 0; k < vl; k++) {
            buf[o++] = (char) vu[k];
        }
        buf[o++] = '\r';
        buf[o++] = '\n';
    }
    *out_len = o;
    return buf;
}

/* Serialize a settled handler result (a Response, or a 500 if it isn't one). */
static void mal_fetch_respond_with(MalHttpConn *conn, MalValue result) {
    if (!mal_value_is_response_object(result)) {
        mal_http_conn_respond(conn, 500, "Internal Server Error", nullptr, 0,
            "handler must return a Response", 30);
        return;
    }
    MalResponseObject *r = mal_value_to_response_object(result);
    usize hlen = 0;
    char *block = mal_fetch_serialize_headers(r, &hlen);
    mal_http_conn_respond(conn, r->status, mal_fetch_reason(r->status), block, hlen,
        r->body != nullptr ? r->body : "", r->body_len);
    free(block);
}

static MalValue mal_fetch_on_fulfilled(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt,
    MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) nt;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalHttpConn *conn = mal_fetch_unbox_conn(mal_native_function_object_get_slot(self, 0));
    mal_fetch_respond_with(conn, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue mal_fetch_on_rejected(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt,
    MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) nt;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalHttpConn *conn = mal_fetch_unbox_conn(mal_native_function_object_get_slot(self, 0));
    mal_http_conn_respond(conn, 500, "Internal Server Error", nullptr, 0, "handler rejected", 16);
    return mal_value_new_undefined();
}

static void mal_fetch_request_hook(
    MalVm *vm, MalHttpConn *conn, const MalHttpRequest *req, const char *body, usize body_len) {
    MalValue handler = vm->intrinsics[MAL_INTRINSIC_FETCH_HANDLER];
    if (!mal_value_is_callable(handler)) {
        mal_http_conn_respond(conn, 500, "Internal Server Error", nullptr, 0, "no handler", 10);
        return;
    }

    MalValue request = mal_fetch_make_request(vm, req, body, body_len);
    MalCompletion c = mal_vm_call_value(vm, handler, mal_value_new_undefined(), &request, 1);
    if (c.kind == MAL_COMPLETION_THROW) {
        // Swallow the handler's synchronous throw so it doesn't leak into the loop.
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_http_conn_respond(conn, 500, "Internal Server Error", nullptr, 0, "handler error", 13);
        return;
    }

    // Normalize the result to a promise and respond when it settles — covers a
    // sync Response and an async Promise<Response> through one path.
    MalValue promise;
    if (!mal_promise_resolve_value(vm, c.value, &promise)) {
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_http_conn_respond(conn, 500, "Internal Server Error", nullptr, 0, "handler error", 13);
        return;
    }

    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalString *name = mal_intrinsic_ascii(vm, (const byte *) "");
    MalValue conn_slot = mal_fetch_box_conn(conn);
    MalNativeFunctionObject *on_fulfilled = mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, name, mal_fetch_on_fulfilled, &conn_slot, 1);
    MalNativeFunctionObject *on_rejected = mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, name, mal_fetch_on_rejected, &conn_slot, 1);
    mal_promise_perform_then(vm, promise,
        mal_value_from_native_function_object(on_fulfilled),
        mal_value_from_native_function_object(on_rejected),
        mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue mal_serve(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_undefined(); // The required TypeError remains unsupported.
    }
    MalValue opts = args[0];

    MalValue fetch_val;
    if (!mal_vm_get_property(vm, opts, mal_intrinsic_string_key(vm, (const byte *) "fetch"), &fetch_val)
        || !mal_value_is_callable(fetch_val)) {
        return mal_value_new_undefined(); // The required TypeError remains unsupported.
    }

    u16 port = 0;
    MalValue pv;
    if (mal_vm_get_property(vm, opts, mal_intrinsic_string_key(vm, (const byte *) "port"), &pv)
        && mal_ops_is_number(pv)) {
        port = (u16) mal_ops_to_number(pv);
    }

    char host[64] = "0.0.0.0";
    MalValue hv;
    if (mal_vm_get_property(vm, opts, mal_intrinsic_string_key(vm, (const byte *) "hostname"), &hv)
        && mal_value_is_string(hv)) {
        MalString *hs = mal_value_to_string(hv);
        usize hl = mal_string_length(hs);
        if (hl < sizeof(host)) {
            const c16 *u = mal_string_code_units(hs);
            for (usize i = 0; i < hl; i++) {
                host[i] = (byte) u[i]; // ASCII hostname
            }
            host[hl] = '\0';
        }
    }

    // Store the handler in a rooted intrinsic slot and install the transport hook.
    vm->intrinsics[MAL_INTRINSIC_FETCH_HANDLER] = fetch_val;
    mal_http_handler = mal_fetch_request_hook;

    MalHttpServer *server = mal_http_server_start(vm, host, port);
    if (server == nullptr) {
        return mal_value_new_undefined(); // The required exception remains unsupported.
    }

    MalObject *handle = mal_intrinsic_new_object(vm);
    mal_object_set(handle, mal_intrinsic_string_key(vm, (const byte *) "port"),
        mal_value_from_f64((f64) mal_http_server_port(server)));
    return mal_value_from_object(handle);
}

/* ---------------------------------------------------------------------------
 * Installation (host entry only).
 * --------------------------------------------------------------------------- */

void mal_fetch_install(MalVm *vm, MalObject *global_this) {
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    // Response constructor + prototype.
    MalObject *resp_proto = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *resp_ctor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "Response"), 2,
        mal_response_constructor);
    mal_native_function_object_set_constructor(resp_ctor);
    vm->intrinsics[MAL_INTRINSIC_RESPONSE_CONSTRUCTOR] =
        mal_value_from_native_function_object(resp_ctor);
    vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE] = mal_value_from_object(resp_proto);
    mal_intrinsic_define_data(vm, (MalObject *) resp_ctor, (const byte *) "prototype",
        vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, resp_proto, (const byte *) "constructor",
        vm->intrinsics[MAL_INTRINSIC_RESPONSE_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "Response",
        vm->intrinsics[MAL_INTRINSIC_RESPONSE_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    // Response read side + getters.
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "text", 0, mal_response_method_text);
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "json", 0, mal_response_method_json);
    mal_intrinsic_define_method_n(
        vm, resp_proto, (const byte *) "arrayBuffer", 0, mal_response_method_array_buffer);
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "bytes", 0, mal_response_method_bytes);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "status", mal_response_get_status);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "ok", mal_response_get_ok);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "statusText", mal_response_get_status_text);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "headers", mal_response_get_headers);
    // Static Response.json / redirect / error.
    mal_intrinsic_define_method_n(
        vm, (MalObject *) resp_ctor, (const byte *) "json", 1, mal_response_static_json);
    mal_intrinsic_define_method_n(
        vm, (MalObject *) resp_ctor, (const byte *) "redirect", 1, mal_response_static_redirect);
    mal_intrinsic_define_method_n(
        vm, (MalObject *) resp_ctor, (const byte *) "error", 0, mal_response_static_error);

    // Request constructor + prototype (also built by the server via make_request).
    MalObject *req_proto = mal_object_new(&vm->heap, object_prototype);
    vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE] = mal_value_from_object(req_proto);
    MalNativeFunctionObject *req_ctor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "Request"), 1,
        mal_request_constructor);
    mal_native_function_object_set_constructor(req_ctor);
    // The constructor is rooted via globalThis.Request + req_proto.constructor (no
    // dedicated intrinsic slot), keeping this addition free of engine changes.
    mal_intrinsic_define_data(vm, (MalObject *) req_ctor, (const byte *) "prototype",
        vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, req_proto, (const byte *) "constructor",
        mal_value_from_native_function_object(req_ctor),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "Request",
        mal_value_from_native_function_object(req_ctor),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "text", 0, mal_request_method_text);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "json", 0, mal_request_method_json);
    mal_intrinsic_define_method_n(
        vm, req_proto, (const byte *) "arrayBuffer", 0, mal_request_method_array_buffer);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "bytes", 0, mal_request_method_bytes);

    // Headers (constructor + prototype; registers its own GC tracer/finalizer).
    mal_headers_install(vm, global_this);

    // Mal namespace + Mal.serve.
    MalObject *mal_ns = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_method_n(vm, mal_ns, (const byte *) "serve", 1, mal_serve);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "Mal",
        mal_value_from_object(mal_ns), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // GC hooks for the fetch objects: the Response carries a Headers MalValue (trace)
    // and owns its body buffer (finalize); Request owns an (optional) body buffer.
    mal_gc_register_tracer(MAL_HEAP_RESPONSE_OBJECT, mal_response_trace);
    mal_gc_register_finalizer(MAL_HEAP_RESPONSE_OBJECT, mal_response_finalize);
    mal_gc_register_finalizer(MAL_HEAP_REQUEST_OBJECT, mal_request_finalize);
}
