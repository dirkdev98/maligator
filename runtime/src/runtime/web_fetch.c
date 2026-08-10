#include "web_fetch.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_buffer_object.h"
#include "builtin_data_view.h"
#include "builtin_iterator.h"
#include "builtin_json.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "web_headers_object.h"
#include "web_blob_object.h"
#include "web_form_data_object.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "mal_url.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "property_store.h"
#include "web_readable_stream_object.h"
#include "web_request_object.h"
#include "web_response_object.h"
#include "web_url_object.h"
#include "server.h" // host: mal_http_server_start_stream_handler, mal_http_conn_respond
#include "utf8.h"
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

static bool mal_fetch_string_ascii_equal_ci(const MalString *string, const char *ascii) {
    return mal_string_equals_ascii_ci(string, ascii);
}

static byte *mal_fetch_utf8_encode(MalVm *vm, const MalString *string, usize *length) {
    byte *bytes = mal_string_to_utf8(string, length);
    if (bytes == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "UTF-8 allocation failed");
    }
    return bytes;
}

typedef enum MalFetchBufferSourceResult {
    MAL_FETCH_NOT_BUFFER_SOURCE,
    MAL_FETCH_BUFFER_SOURCE_OK,
    MAL_FETCH_BUFFER_SOURCE_ERROR,
} MalFetchBufferSourceResult;

/* Extract a validated BufferSource span. Detached and out-of-bounds views are
 * errors rather than empty bodies. */
static MalFetchBufferSourceResult mal_fetch_buffer_source(
    MalVm *vm, MalValue v, const byte **out, usize *out_len) {
    MalBufferSourceSpan span;
    MalBufferSourceSpanStatus status = mal_buffer_source_span(v, &span);
    if (status == MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE) {
        return MAL_FETCH_NOT_BUFFER_SOURCE;
    }
    if (status != MAL_BUFFER_SOURCE_SPAN_OK) {
        if (mal_value_is_array_buffer_object(v)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "BodyInit contains a detached ArrayBuffer");
        } else {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "BodyInit contains a detached or out-of-bounds view");
        }
        return MAL_FETCH_BUFFER_SOURCE_ERROR;
    }
    *out = span.data;
    *out_len = span.length;
    return MAL_FETCH_BUFFER_SOURCE_OK;
}

static bool mal_fetch_name_is(const MalString *name, const char *ascii);

static bool mal_fetch_headers_have(MalHeadersObject *headers, const char *name) {
    for (i32 i = 0; i < headers->count; i++) {
        if (mal_fetch_name_is(headers->entries[i].name, name)) return true;
    }
    return false;
}

static void mal_fetch_default_content_type(
    MalVm *vm, MalHeadersObject *headers, const char *value) {
    if (value != nullptr && !mal_fetch_headers_have(headers, "content-type")) {
        mal_headers_append_bytes(vm, headers, "content-type", 12, value, strlen(value));
    }
}

static bool mal_fetch_reason_phrase(MalVm *vm, MalValue value, MalValue *out) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit > 0xFF) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Response statusText is not a ByteString");
            return false;
        }
        if ((unit < 0x20 && unit != '\t') || unit == 0x7F) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Response statusText is not a valid reason phrase");
            return false;
        }
    }
    *out = mal_value_from_string(string);
    return true;
}

/* Web IDL unsigned short conversion: ToNumber, truncate, then modulo 2^16. */
static bool mal_fetch_to_uint16(MalVm *vm, MalValue value, u16 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number == 0) {
        *out = 0;
        return true;
    }
    f64 wrapped = fmod(trunc(number), 65536.0);
    if (wrapped < 0) wrapped += 65536.0;
    *out = (u16) wrapped;
    return true;
}

/* Fresh ArrayBuffer holding a copy of bytes. */
static MalValue mal_fetch_new_array_buffer(MalVm *vm, const byte *data, usize len) {
    if (len > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Body is too large for an ArrayBuffer");
        return mal_value_new_undefined();
    }
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *ab =
        mal_array_buffer_object_new(&vm->heap, proto, (u32) len, (u32) len, false, false);
    if (len > 0 && ab->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ArrayBuffer allocation failed");
        return mal_value_new_undefined();
    }
    if (len > 0) {
        memcpy(ab->data, data, len);
    }
    return mal_value_from_array_buffer_object(ab);
}

/* Fresh Uint8Array over a copy of bytes (buffer rooted across the view alloc). */
static MalValue mal_fetch_new_uint8array(MalVm *vm, const byte *data, usize len) {
    if (len > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Body is too large for a Uint8Array");
        return mal_value_new_undefined();
    }
    MalObject *ab_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *ab =
        mal_array_buffer_object_new(&vm->heap, ab_proto, (u32) len, (u32) len, false, false);
    if (len > 0 && ab->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Uint8Array allocation failed");
        return mal_value_new_undefined();
    }
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

/* Resolve a value to a native Promise, returning the promise (or undefined on
 * failure). mal_promise_resolve_value roots its argument internally. */
static MalValue mal_fetch_resolve(MalVm *vm, MalValue value) {
    MalValue promise;
    return mal_promise_resolve_value(vm, value, &promise) ? promise : mal_value_new_undefined();
}

static MalValue mal_fetch_reject(MalVm *vm, MalValue reason) {
    MalValue roots[2] = {reason, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    mal_promise_reject(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    MalValue result = roots[1];
    mal_gc_unroot(&span);
    return result;
}

static MalValue mal_fetch_reject_type_error(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Body is unusable: stream is locked or disturbed");
    MalValue error = vm->completion.value;
    vm->completion =
        (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return mal_fetch_reject(vm, error);
}

static MalValue mal_fetch_reject_completion(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion =
        (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return mal_fetch_reject(vm, error);
}

static bool mal_fetch_is_blob(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_BLOB_OBJECT);
}

static MalBlobObject *mal_fetch_to_blob(MalValue value) {
    return (MalBlobObject *) mal_value_to_heap(value);
}

static MalValue mal_fetch_from_blob(MalBlobObject *blob) {
    return mal_value_from_heap((MalHeapHeader *) blob);
}

static MalBlobObject *mal_blob_object_new(MalHeap *heap, MalObject *prototype,
    byte *bytes, usize length, char *type, usize type_length) {
    MalBlobObject *blob =
        mal_heap_alloc(heap, sizeof(MalBlobObject), MAL_HEAP_BLOB_OBJECT);
    mal_object_init(heap, &blob->object, MAL_HEAP_BLOB_OBJECT, prototype);
    blob->bytes = bytes;
    blob->length = length;
    blob->type = type;
    blob->type_length = type_length;
    return blob;
}

static void mal_blob_finalize(MalHeapHeader *cell) {
    MalBlobObject *blob = (MalBlobObject *) cell;
    free(blob->bytes);
    free(blob->type);
    blob->bytes = nullptr;
    blob->type = nullptr;
    blob->length = 0;
    blob->type_length = 0;
}

static bool mal_blob_append_bytes(
    MalVm *vm, byte **buffer, usize *length, usize *capacity,
    const byte *bytes, usize byte_length) {
    if (byte_length > SIZE_MAX - *length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Blob exceeds the supported size");
        return false;
    }
    usize required = *length + byte_length;
    if (required > *capacity) {
        usize next = *capacity == 0 ? 64 : *capacity;
        while (next < required) {
            if (next > SIZE_MAX / 2) {
                next = required;
                break;
            }
            next *= 2;
        }
        byte *grown = realloc(*buffer, next);
        if (grown == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *buffer = grown;
        *capacity = next;
    }
    if (byte_length > 0) memcpy(*buffer + *length, bytes, byte_length);
    *length = required;
    return true;
}

static bool mal_blob_normalize_type(
    MalVm *vm, MalValue options, char **type_out, usize *length_out) {
    *type_out = malloc(1);
    if (*type_out == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    (*type_out)[0] = '\0';
    *length_out = 0;
    if (!mal_value_is_object(options)) return true;

    MalValue value;
    if (!mal_vm_get_property(vm, options,
            mal_intrinsic_string_key(vm, (const byte *) "type"), &value)) {
        free(*type_out);
        *type_out = nullptr;
        return false;
    }
    if (mal_value_is_undefined(value)) return true;
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) {
        free(*type_out);
        *type_out = nullptr;
        return false;
    }
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] < 0x20 || units[i] > 0x7E) return true;
    }
    char *type = realloc(*type_out, length + 1);
    if (type == nullptr) {
        free(*type_out);
        *type_out = nullptr;
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        type[i] = (char) (unit >= 'A' && unit <= 'Z' ? unit + ('a' - 'A') : unit);
    }
    type[length] = '\0';
    *type_out = type;
    *length_out = length;
    return true;
}

static bool mal_fetch_is_form_data(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FORM_DATA_OBJECT);
}

static MalFormDataObject *mal_fetch_to_form_data(MalValue value) {
    return (MalFormDataObject *) mal_value_to_heap(value);
}

static MalValue mal_fetch_from_form_data(MalFormDataObject *form_data) {
    return mal_value_from_heap((MalHeapHeader *) form_data);
}

static MalFormDataObject *mal_form_data_new(MalHeap *heap, MalObject *prototype) {
    MalFormDataObject *form_data =
        mal_heap_alloc(heap, sizeof(MalFormDataObject), MAL_HEAP_FORM_DATA_OBJECT);
    mal_object_init(heap, &form_data->object, MAL_HEAP_FORM_DATA_OBJECT, prototype);
    form_data->entries = nullptr;
    form_data->count = 0;
    form_data->capacity = 0;
    return form_data;
}

static void mal_form_data_finalize(MalHeapHeader *cell) {
    MalFormDataObject *form_data = (MalFormDataObject *) cell;
    free(form_data->entries);
    form_data->entries = nullptr;
    form_data->count = 0;
    form_data->capacity = 0;
}

static void mal_form_data_trace(MalHeapHeader *cell) {
    MalFormDataObject *form_data = (MalFormDataObject *) cell;
    for (i32 i = 0; i < form_data->count; i++) {
        MalFormDataEntry *entry = &form_data->entries[i];
        mal_gc_mark_value(mal_value_from_string(entry->name));
        mal_gc_mark_value(entry->value);
        if (entry->filename != nullptr) {
            mal_gc_mark_value(mal_value_from_string(entry->filename));
        }
    }
}

static bool mal_form_data_append_entry(MalVm *vm, MalFormDataObject *form_data,
    MalString *name, MalValue value, MalString *filename) {
    if (form_data->count == form_data->capacity) {
        i32 next = form_data->capacity == 0 ? 8 : form_data->capacity * 2;
        MalFormDataEntry *grown = realloc(
            form_data->entries, sizeof(MalFormDataEntry) * (usize) next);
        if (grown == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        form_data->entries = grown;
        form_data->capacity = next;
    }
    MalFormDataEntry *entry = &form_data->entries[form_data->count++];
    entry->name = name;
    entry->value = value;
    entry->filename = filename;
    mal_gc_card(&form_data->object.header, mal_value_from_string(name));
    mal_gc_card(&form_data->object.header, value);
    if (filename != nullptr) {
        mal_gc_card(&form_data->object.header, mal_value_from_string(filename));
    }
    return true;
}

static const char *MAL_FORM_DATA_BOUNDARY = "----maligator-formdata-boundary";
static const char *MAL_FORM_DATA_CONTENT_TYPE =
    "multipart/form-data; boundary=----maligator-formdata-boundary";

static bool mal_form_data_append_string(MalVm *vm, byte **buffer, usize *length,
    usize *capacity, MalString *string) {
    usize encoded_length;
    byte *encoded = mal_fetch_utf8_encode(vm, string, &encoded_length);
    if (encoded == nullptr) return false;
    bool ok = mal_blob_append_bytes(
        vm, buffer, length, capacity, encoded, encoded_length);
    free(encoded);
    return ok;
}

static bool mal_form_data_append_quoted(MalVm *vm, byte **buffer, usize *length,
    usize *capacity, MalString *string) {
    usize encoded_length;
    byte *encoded = mal_fetch_utf8_encode(vm, string, &encoded_length);
    if (encoded == nullptr) return false;
    bool ok = true;
    for (usize i = 0; i < encoded_length; i++) {
        const char *replacement = encoded[i] == '\r' ? "%0D"
            : encoded[i] == '\n' ? "%0A" : encoded[i] == '"' ? "%22" : nullptr;
        if (replacement != nullptr) {
            if (!mal_blob_append_bytes(vm, buffer, length, capacity,
                    (const byte *) replacement, 3)) {
                ok = false;
                break;
            }
            continue;
        }
        if (!mal_blob_append_bytes(
                vm, buffer, length, capacity, &encoded[i], 1)) {
            ok = false;
            break;
        }
    }
    free(encoded);
    return ok;
}

static byte *mal_form_data_serialize(
    MalVm *vm, MalFormDataObject *form_data, usize *length_out) {
    byte *buffer = nullptr;
    usize length = 0;
    usize capacity = 0;
    if (form_data->count == 0) {
        buffer = malloc(1);
        if (buffer == nullptr) mal_vm_throw_allocation_error(vm);
        *length_out = 0;
        return buffer;
    }
    for (i32 i = 0; i < form_data->count; i++) {
        MalFormDataEntry *entry = &form_data->entries[i];
        if (!mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                (const byte *) "--", 2)
            || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                (const byte *) MAL_FORM_DATA_BOUNDARY, strlen(MAL_FORM_DATA_BOUNDARY))
            || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                (const byte *) "\r\nContent-Disposition: form-data; name=\"",
                strlen("\r\nContent-Disposition: form-data; name=\""))
            || !mal_form_data_append_quoted(
                vm, &buffer, &length, &capacity, entry->name)
            || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                (const byte *) "\"", 1)) {
            goto serialize_error;
        }
        if (mal_fetch_is_blob(entry->value)) {
            MalBlobObject *blob = mal_fetch_to_blob(entry->value);
            if (!mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                    (const byte *) "; filename=\"", strlen("; filename=\""))
                || !mal_form_data_append_quoted(
                    vm, &buffer, &length, &capacity, entry->filename)
                || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                    (const byte *) "\"\r\nContent-Type: ",
                    strlen("\"\r\nContent-Type: "))
                || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                    (const byte *) (blob->type_length > 0
                        ? blob->type : "application/octet-stream"),
                    blob->type_length > 0 ? blob->type_length : 24)
                || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                    (const byte *) "\r\n\r\n", 4)
                || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                    blob->bytes, blob->length)) {
                goto serialize_error;
            }
        } else if (!mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                (const byte *) "\r\n\r\n", 4)
            || !mal_form_data_append_string(vm, &buffer, &length, &capacity,
                mal_value_to_string(entry->value))) {
            goto serialize_error;
        }
        if (!mal_blob_append_bytes(vm, &buffer, &length, &capacity,
                (const byte *) "\r\n", 2)) goto serialize_error;
    }
    if (!mal_blob_append_bytes(vm, &buffer, &length, &capacity,
            (const byte *) "--", 2)
        || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
            (const byte *) MAL_FORM_DATA_BOUNDARY, strlen(MAL_FORM_DATA_BOUNDARY))
        || !mal_blob_append_bytes(vm, &buffer, &length, &capacity,
            (const byte *) "--\r\n", 4)) {
        goto serialize_error;
    }
    *length_out = length;
    return buffer;

serialize_error:
    free(buffer);
    return nullptr;
}

static void mal_form_data_release_entry(const MalFormDataEntry *entry) {
    mal_gc_write_barrier(mal_value_from_string(entry->name));
    mal_gc_write_barrier(entry->value);
    if (entry->filename != nullptr) {
        mal_gc_write_barrier(mal_value_from_string(entry->filename));
    }
}

static MalFormDataObject *mal_form_data_this(MalVm *vm, MalValue self) {
    if (mal_fetch_is_form_data(self)) return mal_fetch_to_form_data(self);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "FormData method called on incompatible receiver");
    return nullptr;
}

static bool mal_form_data_convert_entry(MalVm *vm, const MalValue *args, i32 argc,
    MalValue roots[3], MalString **filename_out) {
    if (argc < 2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FormData entry requires a name and value");
        return false;
    }
    MalString *name;
    if (!mal_vm_to_string(vm, args[0], &name)) return false;
    roots[0] = mal_value_from_string(name);
    *filename_out = nullptr;
    if (mal_fetch_is_blob(args[1])) {
        roots[1] = args[1];
        MalString *filename;
        if (argc >= 3) {
            if (!mal_vm_to_string(vm, args[2], &filename)) return false;
        } else {
            filename = mal_string_new_ascii(&vm->heap, "blob", 4);
        }
        roots[2] = mal_value_from_string(filename);
        *filename_out = filename;
        return true;
    }
    MalString *value;
    if (!mal_vm_to_string(vm, args[1], &value)) return false;
    roots[1] = mal_value_from_string(value);
    return true;
}

static MalValue mal_form_data_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) callee;
    if (!mal_value_is_object(nt)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FormData constructor requires new");
        return mal_value_new_undefined();
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, nt, MAL_INTRINSIC_FORM_DATA_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    return mal_fetch_from_form_data(mal_form_data_new(&vm->heap, prototype));
}

static MalValue mal_form_data_append(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    if (form_data == nullptr) return mal_value_new_undefined();
    MalValue roots[3] = {
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalString *filename;
    bool converted = mal_form_data_convert_entry(vm, args, argc, roots, &filename);
    if (converted) {
        (void) mal_form_data_append_entry(vm, form_data,
            mal_value_to_string(roots[0]), roots[1], filename);
    }
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static bool mal_form_data_name(MalVm *vm, const MalValue *args, i32 argc, MalString **out) {
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FormData operation requires a name");
        return false;
    }
    return mal_vm_to_string(vm, args[0], out);
}

static MalValue mal_form_data_delete(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    MalString *name;
    if (form_data == nullptr || !mal_form_data_name(vm, args, argc, &name)) {
        return mal_value_new_undefined();
    }
    i32 write = 0;
    for (i32 read = 0; read < form_data->count; read++) {
        MalFormDataEntry entry = form_data->entries[read];
        if (mal_string_equals(entry.name, name)) {
            mal_form_data_release_entry(&entry);
        } else {
            if (write != read) form_data->entries[write] = entry;
            write++;
        }
    }
    form_data->count = write;
    return mal_value_new_undefined();
}

static MalValue mal_form_data_get(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    MalString *name;
    if (form_data == nullptr || !mal_form_data_name(vm, args, argc, &name)) {
        return mal_value_new_undefined();
    }
    for (i32 i = 0; i < form_data->count; i++) {
        if (mal_string_equals(form_data->entries[i].name, name)) {
            return form_data->entries[i].value;
        }
    }
    return mal_value_new_null();
}

static MalValue mal_form_data_get_all(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    MalString *name;
    if (form_data == nullptr || !mal_form_data_name(vm, args, argc, &name)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *values = mal_intrinsic_new_array(vm, 0);
    u32 index = 0;
    for (i32 i = 0; i < form_data->count; i++) {
        if (mal_string_equals(form_data->entries[i].name, name)) {
            mal_array_object_store(values, mal_key_index(index++), form_data->entries[i].value);
        }
    }
    return mal_value_from_array_object(values);
}

static MalValue mal_form_data_has(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    MalValue value = mal_form_data_get(vm, self, args, argc, nt, callee);
    return vm->completion.kind == MAL_COMPLETION_NORMAL
        ? mal_value_new_boolean(!mal_value_is_null(value)) : mal_value_new_undefined();
}

static MalValue mal_form_data_set(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    if (form_data == nullptr) return mal_value_new_undefined();
    MalValue roots[3] = {
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalString *filename;
    if (!mal_form_data_convert_entry(vm, args, argc, roots, &filename)) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(roots[0]);
    i32 first = -1;
    i32 write = 0;
    for (i32 read = 0; read < form_data->count; read++) {
        MalFormDataEntry entry = form_data->entries[read];
        if (mal_string_equals(entry.name, name)) {
            if (first < 0) {
                first = write++;
                mal_form_data_release_entry(&entry);
            } else {
                mal_form_data_release_entry(&entry);
            }
        } else {
            if (write != read) form_data->entries[write] = entry;
            write++;
        }
    }
    form_data->count = write;
    if (first < 0) {
        (void) mal_form_data_append_entry(vm, form_data, name, roots[1], filename);
    } else {
        form_data->entries[first] = (MalFormDataEntry) {
            .name = name, .value = roots[1], .filename = filename};
        mal_gc_card(&form_data->object.header, roots[0]);
        mal_gc_card(&form_data->object.header, roots[1]);
        if (filename != nullptr) mal_gc_card(&form_data->object.header, roots[2]);
    }
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

typedef struct MalFetchBody {
    MalObject *owner;
    byte *bytes;
    usize length;
    MalValue *stream;
} MalFetchBody;

static bool mal_fetch_body_from_value(MalValue value, MalFetchBody *body) {
    if (mal_value_is_response_object(value)) {
        MalResponseObject *response = mal_value_to_response_object(value);
        *body = (MalFetchBody) {
            .owner = &response->object,
            .bytes = response->body,
            .length = response->body_len,
            .stream = &response->body_stream,
        };
        return true;
    }
    if (mal_value_is_request_object(value)) {
        MalRequestObject *request = mal_value_to_request_object(value);
        *body = (MalFetchBody) {
            .owner = &request->object,
            .bytes = request->body,
            .length = request->body_len,
            .stream = &request->body_stream,
        };
        return true;
    }
    return false;
}

static MalValue mal_fetch_body_stream(MalVm *vm, MalValue owner, MalFetchBody *body) {
    if (!mal_value_is_undefined(*body->stream)) return *body->stream;
    if (body->bytes == nullptr) return mal_value_new_null();
    {
        MalRootSpan span;
        mal_gc_root(&span, &owner, 1);
        MalValue stream =
            mal_readable_stream_from_bytes(vm, body->bytes, body->length);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            mal_gc_unroot(&span);
            return mal_value_new_undefined();
        }
        *body->stream = stream;
        mal_gc_card(&body->owner->header, stream);
        mal_gc_unroot(&span);
    }
    return *body->stream;
}

static bool mal_fetch_body_begin(MalVm *vm, MalValue owner, MalFetchBody *body) {
    if (body->bytes == nullptr && mal_value_is_undefined(*body->stream)) return true;
    MalValue stream = mal_fetch_body_stream(vm, owner, body);
    return mal_readable_stream_consume(vm, stream);
}

/* ---------------------------------------------------------------------------
 * Response object.
 * --------------------------------------------------------------------------- */

MalResponseObject *mal_response_object_new(
    MalHeap *heap, MalObject *prototype, i32 status, byte *body, usize body_len) {
    MalResponseObject *r = mal_heap_alloc(heap, sizeof(MalResponseObject), MAL_HEAP_RESPONSE_OBJECT);
    mal_object_init(heap, &r->object, MAL_HEAP_RESPONSE_OBJECT, prototype);
    r->status = status;
    r->status_text = mal_value_new_undefined();
    r->headers = mal_value_new_undefined();
    r->server_headers = mal_value_new_undefined();
    r->body = body;
    r->body_len = body_len;
    r->body_stream = mal_value_new_undefined();
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
    MalResponseObject *response = (MalResponseObject *) cell;
    mal_gc_mark_value(response->status_text);
    mal_gc_mark_value(response->headers);
    mal_gc_mark_value(response->server_headers);
    mal_gc_mark_value(response->body_stream);
}

static bool mal_fetch_response_headers(MalVm *vm, MalValue init,
    MalValue *visible_out, MalValue *server_out) {
    MalValue roots[3] = {mal_value_new_undefined(), init, mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 3);
    MalHeadersObject *raw = mal_headers_from_init(vm, roots[1]);
    roots[0] = mal_value_from_headers_object(raw);
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
        mal_gc_unroot(&rs);
        return false;
    }
    MalHeadersObject *visible = mal_headers_create(vm);
    visible->guard = MAL_HEADERS_GUARD_RESPONSE;
    roots[2] = mal_value_from_headers_object(visible);
    MalHeadersObject *server = mal_headers_create(vm);
    *server_out = mal_value_from_headers_object(server);
    MalRootSpan server_span;
    mal_gc_root(&server_span, server_out, 1);
    for (i32 i = 0; i < raw->count; i++) {
        MalHeaderEntry *entry = &raw->entries[i];
        MalHeadersObject *target = mal_fetch_name_is(entry->name, "set-cookie")
                || mal_fetch_name_is(entry->name, "set-cookie2")
            ? server : visible;
        if (!mal_headers_append_entry(target, entry->name, entry->value)) {
            mal_vm_throw_allocation_error(vm);
            mal_gc_unroot(&server_span);
            mal_gc_unroot(&rs);
            return false;
        }
    }
    *visible_out = roots[2];
    mal_gc_unroot(&server_span);
    mal_gc_unroot(&rs);
    return true;
}

static MalValue mal_response_constructor(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) callee;

    i32 status = 200;
    MalValue roots[5] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0)),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 5);
    byte *body = nullptr;
    MalResponseObject *response = nullptr;
    const char *content_type = nullptr;
    if (arg_count >= 2 && mal_value_is_object(args[1])) {
        MalValue s;
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "status"), &s)) {
            goto response_error;
        }
        if (!mal_value_is_undefined(s)) {
            u16 converted;
            if (!mal_fetch_to_uint16(vm, s, &converted)) goto response_error;
            status = converted;
        }
        MalValue status_text;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "statusText"), &status_text)) {
            goto response_error;
        }
        if (!mal_value_is_undefined(status_text)
            && !mal_fetch_reason_phrase(vm, status_text, &roots[2])) {
            goto response_error;
        }
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "headers"), &roots[0])) {
            goto response_error;
        }
    }
    if (status < 200 || status > 599) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Response status must be between 200 and 599");
        goto response_error;
    }

    usize body_len = 0;
    const byte *src_bytes;
    usize src_len;
    bool has_body = arg_count >= 1 && !mal_value_is_nil(args[0]);
    if (arg_count >= 1 && mal_value_is_readable_stream_object(args[0])) {
        if (mal_readable_stream_is_locked(args[0])
            || mal_readable_stream_is_disturbed(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "ReadableStream BodyInit is locked or disturbed");
            goto response_error;
        }
        roots[4] = args[0];
    } else if (arg_count >= 1 && mal_fetch_is_form_data(args[0])) {
        body = mal_form_data_serialize(
            vm, mal_fetch_to_form_data(args[0]), &body_len);
        if (body == nullptr) goto response_error;
        content_type = MAL_FORM_DATA_CONTENT_TYPE;
    } else if (arg_count >= 1 && mal_fetch_is_blob(args[0])) {
        MalBlobObject *blob = mal_fetch_to_blob(args[0]);
        body = malloc(blob->length == 0 ? 1 : blob->length);
        if (body == nullptr) {
            mal_vm_throw_allocation_error(vm);
            goto response_error;
        }
        if (blob->length > 0) memcpy(body, blob->bytes, blob->length);
        body_len = blob->length;
        content_type = blob->type_length > 0 ? blob->type : nullptr;
    } else if (arg_count >= 1 && mal_value_is_string(args[0])) {
        MalString *str = mal_value_to_string(args[0]);
        body = mal_fetch_utf8_encode(vm, str, &body_len);
        if (body == nullptr) goto response_error;
        content_type = "text/plain;charset=UTF-8";
    } else if (arg_count >= 1) {
        MalFetchBufferSourceResult buffer_result =
            mal_fetch_buffer_source(vm, args[0], &src_bytes, &src_len);
        if (buffer_result == MAL_FETCH_BUFFER_SOURCE_ERROR) goto response_error;
        if (buffer_result == MAL_FETCH_BUFFER_SOURCE_OK) {
        // A BufferSource (ArrayBuffer / TypedArray) body: copy the raw bytes.
            body = malloc(src_len == 0 ? 1 : src_len);
            if (body == nullptr) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Response body allocation failed");
                goto response_error;
            }
            if (src_len > 0) {
                memcpy(body, src_bytes, src_len);
            }
            body_len = src_len;
        } else if (!mal_value_is_nil(args[0])) {
            bool is_search_params = mal_value_is_url_search_params_object(args[0]);
            MalString *str;
            if (!mal_vm_to_string(vm, args[0], &str)) {
                goto response_error;
            }
            body = mal_fetch_utf8_encode(vm, str, &body_len);
            if (body == nullptr) goto response_error;
            content_type = is_search_params
                ? "application/x-www-form-urlencoded;charset=UTF-8"
                : "text/plain;charset=UTF-8";
        }
    }
    if (has_body && (status == 204 || status == 205 || status == 304)) {
        free(body);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response status cannot have a body");
        body = nullptr;
        goto response_error;
    }

    MalObject *proto;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_RESPONSE_PROTOTYPE, &proto)) {
        goto response_error;
    }
    response = mal_response_object_new(&vm->heap, proto, status, body, body_len);
    roots[1] = mal_value_from_response_object(response);
    if (!mal_value_is_undefined(roots[4])) {
        response->body_stream = roots[4];
        mal_gc_card(&response->object.header, roots[4]);
    }
    if (!mal_fetch_response_headers(vm, roots[0], &response->headers, &roots[3])) {
        goto response_error;
    }
    response->server_headers = roots[3];
    response->status_text = roots[2];
    mal_fetch_default_content_type(
        vm, mal_value_to_headers_object(response->headers), content_type);
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) goto response_error;
    MalValue result = roots[1];
    mal_gc_unroot(&rs);
    return result;

response_error:
    if (response == nullptr) free(body);
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

/* --- Response read side (a received/constructed Response is read via these). --- */

static MalResponseObject *mal_response_this(MalValue self) {
    return mal_value_is_response_object(self) ? mal_value_to_response_object(self) : nullptr;
}

static MalValue mal_fetch_body_string_impl(
    MalVm *vm, const MalFetchBody *body, bool strip_bom) {
    if (body->bytes == nullptr || body->length == 0) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    usize count;
    c16 *units = mal_utf8_decode(body->bytes, body->length, &count);
    if (units == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Body text allocation failed");
        return mal_value_new_undefined();
    }
    usize offset = strip_bom && count > 0 && units[0] == 0xFEFF ? 1 : 0;
    if (count - offset > MAL_STRING_MAX_CODE_UNITS) {
        free(units);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Body text exceeds the string length limit");
        return mal_value_new_undefined();
    }
    MalValue s = mal_value_from_string(
        mal_string_new_copy(&vm->heap, units + offset, count - offset));
    free(units);
    return s;
}

static MalValue mal_fetch_body_string(MalVm *vm, const MalFetchBody *body) {
    return mal_fetch_body_string_impl(vm, body, true);
}

static MalValue mal_blob_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) callee;
    if (!mal_value_is_object(nt)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Blob constructor requires new");
        return mal_value_new_undefined();
    }

    byte *bytes = nullptr;
    usize length = 0;
    usize capacity = 0;
    if (argc >= 1 && !mal_value_is_undefined(args[0])) {
        MalIteratorRecord record;
        if (!mal_vm_get_iterator(vm, args[0], &record)) goto blob_error;
        MalValue part = mal_value_new_undefined();
        MalRootSpan iterator_span, part_span;
        mal_gc_root(&iterator_span, &record.iterator, 2);
        mal_gc_root(&part_span, &part, 1);
        bool ok = false;
        while (true) {
            bool done;
            if (!mal_vm_iterator_step(vm, &record, &part, &done)) break;
            if (done) {
                ok = true;
                break;
            }
            if (mal_fetch_is_blob(part)) {
                MalBlobObject *source = mal_fetch_to_blob(part);
                if (!mal_blob_append_bytes(vm, &bytes, &length, &capacity,
                        source->bytes, source->length)) break;
                continue;
            }
            const byte *source_bytes;
            usize source_length;
            MalFetchBufferSourceResult source_result =
                mal_fetch_buffer_source(vm, part, &source_bytes, &source_length);
            if (source_result == MAL_FETCH_BUFFER_SOURCE_ERROR) break;
            if (source_result == MAL_FETCH_BUFFER_SOURCE_OK) {
                if (!mal_blob_append_bytes(vm, &bytes, &length, &capacity,
                        source_bytes, source_length)) break;
                continue;
            }
            MalString *string;
            if (!mal_vm_to_string(vm, part, &string)) break;
            usize encoded_length;
            byte *encoded = mal_fetch_utf8_encode(vm, string, &encoded_length);
            if (encoded == nullptr) break;
            bool appended = mal_blob_append_bytes(
                vm, &bytes, &length, &capacity, encoded, encoded_length);
            free(encoded);
            if (!appended) break;
        }
        mal_gc_unroot(&part_span);
        mal_gc_unroot(&iterator_span);
        if (!ok) goto blob_error;
    }

    char *type = nullptr;
    usize type_length = 0;
    if (!mal_blob_normalize_type(vm,
            argc >= 2 ? args[1] : mal_value_new_undefined(),
            &type, &type_length)) {
        goto blob_error;
    }
    if (bytes == nullptr) {
        bytes = malloc(1);
        if (bytes == nullptr) {
            free(type);
            mal_vm_throw_allocation_error(vm);
            goto blob_error;
        }
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, nt, MAL_INTRINSIC_BLOB_PROTOTYPE, &prototype)) {
        free(type);
        goto blob_error;
    }
    return mal_fetch_from_blob(mal_blob_object_new(
        &vm->heap, prototype, bytes, length, type, type_length));

blob_error:
    free(bytes);
    return mal_value_new_undefined();
}

static MalBlobObject *mal_blob_this(MalVm *vm, MalValue self) {
    if (mal_fetch_is_blob(self)) return mal_fetch_to_blob(self);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Blob method called on incompatible receiver");
    return nullptr;
}

static MalValue mal_blob_get_size(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalBlobObject *blob = mal_blob_this(vm, self);
    return blob != nullptr
        ? mal_value_from_f64((f64) blob->length) : mal_value_new_undefined();
}

static MalValue mal_blob_get_type(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalBlobObject *blob = mal_blob_this(vm, self);
    return blob != nullptr
        ? mal_value_from_string(mal_string_new_ascii(
            &vm->heap, blob->type, blob->type_length))
        : mal_value_new_undefined();
}

static MalValue mal_blob_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalBlobObject *blob = mal_blob_this(vm, self);
    if (blob == nullptr) return mal_fetch_reject_completion(vm);
    MalFetchBody body = {.bytes = blob->bytes, .length = blob->length};
    MalValue text = mal_fetch_body_string(vm, &body);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm) : mal_fetch_resolve(vm, text);
}

static MalValue mal_blob_array_buffer(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalBlobObject *blob = mal_blob_this(vm, self);
    if (blob == nullptr) return mal_fetch_reject_completion(vm);
    MalValue result = mal_fetch_new_array_buffer(vm, blob->bytes, blob->length);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm) : mal_fetch_resolve(vm, result);
}

static MalValue mal_blob_bytes(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalBlobObject *blob = mal_blob_this(vm, self);
    if (blob == nullptr) return mal_fetch_reject_completion(vm);
    MalValue result = mal_fetch_new_uint8array(vm, blob->bytes, blob->length);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm) : mal_fetch_resolve(vm, result);
}

static MalValue mal_blob_stream(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalBlobObject *blob = mal_blob_this(vm, self);
    if (blob == nullptr) return mal_value_new_undefined();
    return mal_readable_stream_from_bytes(vm, blob->bytes, blob->length);
}

static void mal_form_data_iterator_trace(MalHeapHeader *cell) {
    MalFormDataIteratorObject *iterator = (MalFormDataIteratorObject *) cell;
    mal_gc_mark_value(mal_fetch_from_form_data(iterator->form_data));
}

static MalValue mal_form_data_make_iterator(MalVm *vm, MalFormDataObject *form_data,
    MalFormDataIteratorKind kind) {
    MalFormDataIteratorObject *iterator = mal_heap_alloc(&vm->heap,
        sizeof(MalFormDataIteratorObject), MAL_HEAP_FORM_DATA_ITERATOR_OBJECT);
    mal_object_init(&vm->heap, &iterator->object,
        MAL_HEAP_FORM_DATA_ITERATOR_OBJECT,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_FORM_DATA_ITERATOR_PROTOTYPE]));
    iterator->form_data = form_data;
    iterator->index = 0;
    iterator->kind = kind;
    mal_gc_card(&iterator->object.header, mal_fetch_from_form_data(form_data));
    return mal_value_from_heap((MalHeapHeader *) iterator);
}

static MalValue mal_form_data_iterator_next(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    if (!mal_value_is_heap_type(self, MAL_HEAP_FORM_DATA_ITERATOR_OBJECT)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Receiver is not a FormData iterator");
        return mal_value_new_undefined();
    }
    MalFormDataIteratorObject *iterator =
        (MalFormDataIteratorObject *) mal_value_to_heap(self);
    MalFormDataObject *form_data = iterator->form_data;
    if (iterator->index >= (u64) form_data->count) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    MalFormDataEntry *entry = &form_data->entries[iterator->index++];
    MalValue value;
    if (iterator->kind == MAL_FORM_DATA_ITERATOR_KEYS) {
        value = mal_value_from_string(entry->name);
    } else if (iterator->kind == MAL_FORM_DATA_ITERATOR_VALUES) {
        value = entry->value;
    } else {
        value = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
        MalRootSpan span;
        mal_gc_root(&span, &value, 1);
        MalArrayObject *pair = mal_value_to_array_object(value);
        mal_array_object_store(pair, mal_key_index(0), mal_value_from_string(entry->name));
        mal_array_object_store(pair, mal_key_index(1), entry->value);
        mal_gc_unroot(&span);
    }
    MalRootSpan span;
    mal_gc_root(&span, &value, 1);
    MalValue result = mal_vm_create_iter_result(vm, value, false);
    mal_gc_unroot(&span);
    return result;
}

static MalValue mal_form_data_entries(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    return form_data != nullptr
        ? mal_form_data_make_iterator(vm, form_data, MAL_FORM_DATA_ITERATOR_ENTRIES)
        : mal_value_new_undefined();
}

static MalValue mal_form_data_keys(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    return form_data != nullptr
        ? mal_form_data_make_iterator(vm, form_data, MAL_FORM_DATA_ITERATOR_KEYS)
        : mal_value_new_undefined();
}

static MalValue mal_form_data_values(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    return form_data != nullptr
        ? mal_form_data_make_iterator(vm, form_data, MAL_FORM_DATA_ITERATOR_VALUES)
        : mal_value_new_undefined();
}

static MalValue mal_form_data_for_each(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalFormDataObject *form_data = mal_form_data_this(vm, self);
    if (form_data == nullptr) return mal_value_new_undefined();
    if (argc < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FormData forEach callback is not callable");
        return mal_value_new_undefined();
    }
    MalValue callback = args[0];
    MalValue this_arg = argc >= 2 ? args[1] : mal_value_new_undefined();
    for (i32 i = 0; i < form_data->count; i++) {
        MalValue call_args[3] = {
            form_data->entries[i].value,
            mal_value_from_string(form_data->entries[i].name),
            self,
        };
        MalCompletion completion =
            mal_vm_call_value(vm, callback, this_arg, call_args, 3);
        if (completion.kind != MAL_COMPLETION_NORMAL) return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

typedef enum MalFetchBodyConsumeKind {
    MAL_FETCH_BODY_CONSUME_TEXT,
    MAL_FETCH_BODY_CONSUME_JSON,
    MAL_FETCH_BODY_CONSUME_ARRAY_BUFFER,
    MAL_FETCH_BODY_CONSUME_BYTES,
    MAL_FETCH_BODY_CONSUME_BLOB,
    MAL_FETCH_BODY_CONSUME_FORM_DATA,
} MalFetchBodyConsumeKind;

static bool mal_fetch_body_is_stream_only(const MalFetchBody *body) {
    return body->bytes == nullptr && !mal_value_is_undefined(*body->stream);
}

static MalValue mal_fetch_body_collect_stream(
    MalVm *vm, MalValue self, MalFetchBody *body, MalFetchBodyConsumeKind kind);

static MalValue mal_fetch_body_method_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        return mal_fetch_reject_type_error(vm);
    }
    if (mal_fetch_body_is_stream_only(&body)) {
        return mal_fetch_body_collect_stream(
            vm, self, &body, MAL_FETCH_BODY_CONSUME_TEXT);
    }
    if (!mal_fetch_body_begin(vm, self, &body)) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_fetch_reject_completion(vm);
        }
        return mal_fetch_reject_type_error(vm);
    }
    MalValue text = mal_fetch_body_string(vm, &body);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm)
        : mal_fetch_resolve(vm, text);
}

static MalValue mal_fetch_body_method_array_buffer(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        return mal_fetch_reject_type_error(vm);
    }
    if (mal_fetch_body_is_stream_only(&body)) {
        return mal_fetch_body_collect_stream(
            vm, self, &body, MAL_FETCH_BODY_CONSUME_ARRAY_BUFFER);
    }
    if (!mal_fetch_body_begin(vm, self, &body)) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_fetch_reject_completion(vm);
        }
        return mal_fetch_reject_type_error(vm);
    }
    const byte *bytes = body.bytes != nullptr ? body.bytes : (const byte *) "";
    MalValue array_buffer = mal_fetch_new_array_buffer(vm, bytes, body.length);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm)
        : mal_fetch_resolve(vm, array_buffer);
}

static MalValue mal_fetch_body_method_bytes(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        return mal_fetch_reject_type_error(vm);
    }
    if (mal_fetch_body_is_stream_only(&body)) {
        return mal_fetch_body_collect_stream(
            vm, self, &body, MAL_FETCH_BODY_CONSUME_BYTES);
    }
    if (!mal_fetch_body_begin(vm, self, &body)) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_fetch_reject_completion(vm);
        }
        return mal_fetch_reject_type_error(vm);
    }
    const byte *bytes = body.bytes != nullptr ? body.bytes : (const byte *) "";
    MalValue byte_array = mal_fetch_new_uint8array(vm, bytes, body.length);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm)
        : mal_fetch_resolve(vm, byte_array);
}

static MalValue mal_fetch_body_method_json(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        return mal_fetch_reject_type_error(vm);
    }
    if (mal_fetch_body_is_stream_only(&body)) {
        return mal_fetch_body_collect_stream(
            vm, self, &body, MAL_FETCH_BODY_CONSUME_JSON);
    }
    if (!mal_fetch_body_begin(vm, self, &body)) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_fetch_reject_completion(vm);
        }
        return mal_fetch_reject_type_error(vm);
    }

    MalValue roots[2] = {
        mal_fetch_body_string(vm, &body),
        mal_value_new_undefined(),
    };
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_fetch_reject_completion(vm);
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_builtin_json_parse_intrinsic(vm, roots[0]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        MalValue result = mal_fetch_reject(vm, error);
        mal_gc_unroot(&span);
        return result;
    }
    MalValue result = mal_fetch_resolve(vm, roots[1]);
    mal_gc_unroot(&span);
    return result;
}

static MalString *mal_fetch_body_content_type(MalVm *vm, MalValue self) {
    MalValue headers = mal_value_is_response_object(self)
        ? mal_value_to_response_object(self)->headers
        : mal_value_to_request_object(self)->headers;
    if (mal_value_is_headers_object(headers)) {
        MalHeadersObject *object = mal_value_to_headers_object(headers);
        for (i32 i = 0; i < object->count; i++) {
            if (mal_fetch_name_is(object->entries[i].name, "content-type")) {
                return object->entries[i].value;
            }
        }
    }
    return mal_string_new_ascii(&vm->heap, "", 0);
}

static bool mal_fetch_content_type_starts_with(
    MalString *content_type, const char *prefix) {
    usize prefix_length = strlen(prefix);
    if (mal_string_length(content_type) < prefix_length) return false;
    const c16 *units = mal_string_code_units(content_type);
    for (usize i = 0; i < prefix_length; i++) {
        c16 unit = units[i];
        if (unit >= 'A' && unit <= 'Z') unit += 'a' - 'A';
        if (unit != (c16) prefix[i]) return false;
    }
    return true;
}

static MalValue mal_fetch_form_data_type_error(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Body MIME type is not supported by formData()");
    return mal_fetch_reject_completion(vm);
}

static MalValue mal_fetch_form_data_value(MalVm *vm, MalFetchBody *body) {
    MalValue roots[3] = {
        mal_fetch_body_string_impl(vm, body, false),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalCompletion parsed = mal_vm_construct_value(vm,
        vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_CONSTRUCTOR], roots, 1);
    if (parsed.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    roots[1] = parsed.value;
    MalUrlSearchParamsObject *params = mal_value_to_url_search_params_object(roots[1]);
    MalFormDataObject *form_data = mal_form_data_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FORM_DATA_PROTOTYPE]));
    roots[2] = mal_fetch_from_form_data(form_data);
    for (i32 i = 0; i < params->count; i++) {
        if (!mal_form_data_append_entry(vm, form_data, params->pairs[i].name,
                mal_value_from_string(params->pairs[i].value), nullptr)) {
            mal_gc_unroot(&span);
            return mal_value_new_undefined();
        }
    }
    MalValue result = roots[2];
    mal_gc_unroot(&span);
    return result;
}

static MalValue mal_fetch_body_method_form_data(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        return mal_fetch_reject_type_error(vm);
    }
    if (mal_fetch_body_is_stream_only(&body)) {
        return mal_fetch_body_collect_stream(
            vm, self, &body, MAL_FETCH_BODY_CONSUME_FORM_DATA);
    }
    MalString *content_type = mal_fetch_body_content_type(vm, self);
    if (!mal_fetch_content_type_starts_with(
            content_type, "application/x-www-form-urlencoded")) {
        return mal_fetch_form_data_type_error(vm);
    }
    if (!mal_fetch_body_begin(vm, self, &body)) {
        return vm->completion.kind == MAL_COMPLETION_THROW
            ? mal_fetch_reject_completion(vm) : mal_fetch_reject_type_error(vm);
    }
    MalValue value = mal_fetch_form_data_value(vm, &body);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm) : mal_fetch_resolve(vm, value);
}

static MalValue mal_fetch_blob_value(MalVm *vm, MalValue self, MalFetchBody *body) {
    MalString *content_type = mal_fetch_body_content_type(vm, self);
    MalValue type_root = mal_value_from_string(content_type);
    MalRootSpan span;
    mal_gc_root(&span, &type_root, 1);
    usize type_length;
    char *type = (char *) mal_fetch_utf8_encode(vm, content_type, &type_length);
    if (type == nullptr) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    char *grown_type = realloc(type, type_length + 1);
    if (grown_type == nullptr) {
        free(type);
        mal_gc_unroot(&span);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    type = grown_type;
    type[type_length] = '\0';
    byte *bytes = malloc(body->length == 0 ? 1 : body->length);
    if (bytes == nullptr) {
        free(type);
        mal_gc_unroot(&span);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (body->length > 0) memcpy(bytes, body->bytes, body->length);
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_BLOB_PROTOTYPE]);
    MalValue result = mal_fetch_from_blob(mal_blob_object_new(
        &vm->heap, prototype, bytes, body->length, type, type_length));
    mal_gc_unroot(&span);
    return result;
}

static MalValue mal_fetch_body_method_blob(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        return mal_fetch_reject_type_error(vm);
    }
    if (mal_fetch_body_is_stream_only(&body)) {
        return mal_fetch_body_collect_stream(
            vm, self, &body, MAL_FETCH_BODY_CONSUME_BLOB);
    }
    if (!mal_fetch_body_begin(vm, self, &body)) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_fetch_reject_completion(vm);
        }
        return mal_fetch_reject_type_error(vm);
    }
    MalValue value = mal_fetch_blob_value(vm, self, &body);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_fetch_reject_completion(vm) : mal_fetch_resolve(vm, value);
}

enum {
    MAL_FETCH_COLLECT_READER,
    MAL_FETCH_COLLECT_CHUNKS,
    MAL_FETCH_COLLECT_TOTAL,
    MAL_FETCH_COLLECT_RESOLVE,
    MAL_FETCH_COLLECT_REJECT,
    MAL_FETCH_COLLECT_SELF,
    MAL_FETCH_COLLECT_KIND,
    MAL_FETCH_COLLECT_ON_REJECTED,
    MAL_FETCH_COLLECT_SLOT_COUNT,
};

static void mal_fetch_call_settler(MalVm *vm, MalValue settler, MalValue value) {
    MalCompletion completion = mal_vm_call_value(
        vm, settler, mal_value_new_undefined(), &value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
    }
}

static void mal_fetch_collect_reject_completion(
    MalVm *vm, MalNativeFunctionObject *function) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    mal_fetch_call_settler(vm,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_REJECT),
        error);
}

static MalValue mal_fetch_collect_conversion(
    MalVm *vm, MalValue self, MalFetchBody *body, MalFetchBodyConsumeKind kind) {
    switch (kind) {
        case MAL_FETCH_BODY_CONSUME_TEXT:
            return mal_fetch_body_string(vm, body);
        case MAL_FETCH_BODY_CONSUME_JSON: {
            MalValue text = mal_fetch_body_string(vm, body);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            MalRootSpan span;
            mal_gc_root(&span, &text, 1);
            MalValue result = mal_builtin_json_parse_intrinsic(vm, text);
            mal_gc_unroot(&span);
            return result;
        }
        case MAL_FETCH_BODY_CONSUME_ARRAY_BUFFER:
            return mal_fetch_new_array_buffer(vm, body->bytes, body->length);
        case MAL_FETCH_BODY_CONSUME_BYTES:
            return mal_fetch_new_uint8array(vm, body->bytes, body->length);
        case MAL_FETCH_BODY_CONSUME_BLOB:
            return mal_fetch_blob_value(vm, self, body);
        case MAL_FETCH_BODY_CONSUME_FORM_DATA: {
            MalString *content_type = mal_fetch_body_content_type(vm, self);
            if (!mal_fetch_content_type_starts_with(
                    content_type, "application/x-www-form-urlencoded")) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Body MIME type is not supported by formData()");
                return mal_value_new_undefined();
            }
            return mal_fetch_form_data_value(vm, body);
        }
    }
    return mal_value_new_undefined();
}

static MalValue mal_fetch_body_collect_rejected(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    mal_fetch_call_settler(vm,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_REJECT),
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue mal_fetch_body_collect_fulfilled(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue read_result = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue done;
    if (!mal_vm_get_property(vm, read_result,
            mal_intrinsic_string_key(vm, (const byte *) "done"), &done)) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }

    if (mal_value_is_truthy(done)) {
        MalValue chunks_value = mal_native_function_object_get_slot(
            function, MAL_FETCH_COLLECT_CHUNKS);
        MalArrayObject *chunks = mal_value_to_array_object(chunks_value);
        usize total = (usize) mal_value_to_f64(mal_native_function_object_get_slot(
            function, MAL_FETCH_COLLECT_TOTAL));
        byte *bytes = malloc(total == 0 ? 1 : total);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            mal_fetch_collect_reject_completion(vm, function);
            return mal_value_new_undefined();
        }
        usize offset = 0;
        for (u32 i = 0; i < mal_array_object_length(chunks); i++) {
            MalValue chunk;
            MalBufferSourceSpan chunk_span;
            if (!mal_array_object_dense_get(chunks, i, &chunk) ||
                mal_buffer_source_span(chunk, &chunk_span) != MAL_BUFFER_SOURCE_SPAN_OK) {
                free(bytes);
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Body stream chunk became unusable");
                mal_fetch_collect_reject_completion(vm, function);
                return mal_value_new_undefined();
            }
            if (chunk_span.length > 0) {
                memcpy(bytes + offset, chunk_span.data, chunk_span.length);
                offset += chunk_span.length;
            }
        }
        MalValue body_self = mal_native_function_object_get_slot(
            function, MAL_FETCH_COLLECT_SELF);
        MalFetchBody body = {
            .owner = mal_value_to_object(body_self),
            .bytes = bytes,
            .length = total,
            .stream = nullptr,
        };
        MalFetchBodyConsumeKind kind = (MalFetchBodyConsumeKind) mal_value_to_i32(
            mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_KIND));
        MalValue result = mal_fetch_collect_conversion(vm, body_self, &body, kind);
        free(bytes);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_fetch_collect_reject_completion(vm, function);
        } else {
            mal_fetch_call_settler(vm,
                mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_RESOLVE),
                result);
        }
        return mal_value_new_undefined();
    }

    MalValue chunk;
    if (!mal_vm_get_property(vm, read_result,
            mal_intrinsic_string_key(vm, (const byte *) "value"), &chunk)) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_typed_array_object(chunk) ||
        mal_value_to_typed_array_object(chunk)->kind != MAL_TA_UINT8) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream yielded a non-Uint8Array chunk");
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan chunk_span;
    if (mal_buffer_source_span(chunk, &chunk_span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream yielded an unusable Uint8Array chunk");
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    usize total = (usize) mal_value_to_f64(mal_native_function_object_get_slot(
        function, MAL_FETCH_COLLECT_TOTAL));
    if (chunk_span.length > UINT32_MAX - total) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Body stream exceeds the supported size");
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    MalValue copy = mal_fetch_new_uint8array(vm, chunk_span.data, chunk_span.length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    MalArrayObject *chunks = mal_value_to_array_object(
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_CHUNKS));
    if (!mal_array_object_store(chunks,
            mal_key_index(mal_array_object_length(chunks)), copy)) {
        mal_vm_throw_allocation_error(vm);
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(function, MAL_FETCH_COLLECT_TOTAL,
        mal_value_from_f64((f64) (total + chunk_span.length)));

    MalValue read_promise = mal_readable_stream_default_reader_read(vm,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_READER));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    mal_promise_perform_then(vm, read_promise, callee,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_ON_REJECTED),
        mal_value_new_undefined(), mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue mal_fetch_body_collect_stream(
    MalVm *vm, MalValue self, MalFetchBody *body, MalFetchBodyConsumeKind kind) {
    MalValue roots[8] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        self, *body->stream, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 8);
    if (!mal_promise_new_capability(vm,
            vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
            &roots[0], &roots[1], &roots[2])) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    roots[3] = mal_readable_stream_acquire_default_reader(vm, roots[5]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        mal_fetch_call_settler(vm, roots[2], error);
        MalValue promise = roots[0];
        mal_gc_unroot(&span);
        return promise;
    }
    roots[4] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue rejected_slots[MAL_FETCH_COLLECT_SLOT_COUNT] = {
        roots[3], roots[4], mal_value_from_f64(0), roots[1], roots[2],
        self, mal_value_from_i32((i32) kind), mal_value_new_undefined(),
    };
    roots[6] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, mal_fetch_body_collect_rejected,
            rejected_slots, MAL_FETCH_COLLECT_SLOT_COUNT));
    MalValue fulfilled_slots[MAL_FETCH_COLLECT_SLOT_COUNT] = {
        roots[3], roots[4], mal_value_from_f64(0), roots[1], roots[2],
        self, mal_value_from_i32((i32) kind), roots[6],
    };
    roots[7] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, mal_fetch_body_collect_fulfilled,
            fulfilled_slots, MAL_FETCH_COLLECT_SLOT_COUNT));
    MalValue read_promise = mal_readable_stream_default_reader_read(vm, roots[3]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        mal_fetch_call_settler(vm, roots[2], error);
    } else {
        mal_promise_perform_then(vm, read_promise, roots[7], roots[6],
            mal_value_new_undefined(), mal_value_new_undefined());
    }
    MalValue promise = roots[0];
    mal_gc_unroot(&span);
    return promise;
}

static MalValue mal_response_get_status(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    if (r == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) r->status);
}

static MalValue mal_response_get_ok(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    if (r == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(r->status >= 200 && r->status <= 299);
}

static MalValue mal_response_get_status_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    if (r == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_is_string(r->status_text)
        ? r->status_text
        : mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
}

static MalValue mal_response_get_type(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    if (r == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    const char *type = r->status == 0 ? "error" : "default";
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, type, strlen(type)));
}

static MalValue mal_response_get_url(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (mal_response_this(self) == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
}

static MalValue mal_response_get_redirected(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (mal_response_this(self) == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(false);
}

static MalValue mal_response_get_headers(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalResponseObject *r = mal_response_this(self);
    if (r == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_headers_object(r->headers)) {
        return mal_value_new_undefined();
    }
    return r->headers;
}

static MalValue mal_fetch_body_get_body(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_fetch_body_stream(vm, self, &body);
}

static MalValue mal_fetch_body_get_used(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalFetchBody body;
    if (!mal_fetch_body_from_value(self, &body)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(!mal_value_is_undefined(*body.stream) &&
        mal_readable_stream_is_disturbed(*body.stream));
}

static bool mal_fetch_body_has_brand(MalValue self, bool response) {
    return response ? mal_value_is_response_object(self) : mal_value_is_request_object(self);
}

static MalValue mal_fetch_body_method_for(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee,
    bool response, MalNativeFunctionCallback callback) {
    if (!mal_fetch_body_has_brand(self, response)) {
        return mal_fetch_reject_type_error(vm);
    }
    return callback(vm, self, args, argc, nt, callee);
}

static MalValue mal_fetch_body_getter_for(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee,
    bool response, MalNativeFunctionCallback callback) {
    if (!mal_fetch_body_has_brand(self, response)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return callback(vm, self, args, argc, nt, callee);
}

#define MAL_FETCH_BODY_METHOD_WRAPPER(prefix, response_brand, suffix, callback) \
    static MalValue prefix##_##suffix( \
        MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) { \
        return mal_fetch_body_method_for( \
            vm, self, args, argc, nt, callee, response_brand, callback); \
    }

#define MAL_FETCH_BODY_GETTER_WRAPPER(prefix, response_brand, suffix, callback) \
    static MalValue prefix##_##suffix( \
        MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) { \
        return mal_fetch_body_getter_for( \
            vm, self, args, argc, nt, callee, response_brand, callback); \
    }

MAL_FETCH_BODY_METHOD_WRAPPER(mal_response_body, true, text, mal_fetch_body_method_text)
MAL_FETCH_BODY_METHOD_WRAPPER(mal_response_body, true, json, mal_fetch_body_method_json)
MAL_FETCH_BODY_METHOD_WRAPPER(
    mal_response_body, true, array_buffer, mal_fetch_body_method_array_buffer)
MAL_FETCH_BODY_METHOD_WRAPPER(mal_response_body, true, bytes, mal_fetch_body_method_bytes)
MAL_FETCH_BODY_METHOD_WRAPPER(
    mal_response_body, true, blob, mal_fetch_body_method_blob)
MAL_FETCH_BODY_METHOD_WRAPPER(
    mal_response_body, true, form_data, mal_fetch_body_method_form_data)
MAL_FETCH_BODY_GETTER_WRAPPER(mal_response_body, true, get_body, mal_fetch_body_get_body)
MAL_FETCH_BODY_GETTER_WRAPPER(mal_response_body, true, get_used, mal_fetch_body_get_used)

MAL_FETCH_BODY_METHOD_WRAPPER(mal_request_body, false, text, mal_fetch_body_method_text)
MAL_FETCH_BODY_METHOD_WRAPPER(mal_request_body, false, json, mal_fetch_body_method_json)
MAL_FETCH_BODY_METHOD_WRAPPER(
    mal_request_body, false, array_buffer, mal_fetch_body_method_array_buffer)
MAL_FETCH_BODY_METHOD_WRAPPER(mal_request_body, false, bytes, mal_fetch_body_method_bytes)
MAL_FETCH_BODY_METHOD_WRAPPER(
    mal_request_body, false, blob, mal_fetch_body_method_blob)
MAL_FETCH_BODY_METHOD_WRAPPER(
    mal_request_body, false, form_data, mal_fetch_body_method_form_data)
MAL_FETCH_BODY_GETTER_WRAPPER(mal_request_body, false, get_body, mal_fetch_body_get_body)
MAL_FETCH_BODY_GETTER_WRAPPER(mal_request_body, false, get_used, mal_fetch_body_get_used)

#undef MAL_FETCH_BODY_METHOD_WRAPPER
#undef MAL_FETCH_BODY_GETTER_WRAPPER

/* Define a getter-only accessor on a prototype. */
static void mal_fetch_define_getter(
    MalVm *vm, MalObject *proto, const byte *name, MalNativeFunctionCallback getter) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(
            mal_native_function_object_new(&vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), getter)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(proto, mal_intrinsic_string_key(vm, name), &desc);
}

static MalValue mal_fetch_readonly_setter(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_undefined();
}

/* Maligator currently reports failed [[Set]] operations even for sloppy source.
 * A no-op Web IDL setter preserves readonly attribute behavior without turning a
 * harmless assignment into an exception. */
static void mal_fetch_define_readonly_getter(
    MalVm *vm, MalObject *proto, const byte *name, MalNativeFunctionCallback getter) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(
            mal_native_function_object_new(&vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), getter)),
        .setter = mal_value_from_native_function_object(
            mal_native_function_object_new(&vm->heap, fn_proto, mal_intrinsic_ascii(vm, name),
                mal_fetch_readonly_setter)),
    };
    mal_object_define_own(proto, mal_intrinsic_string_key(vm, name), &desc);
}

/* Read an optional { status, statusText, headers } init into out-params. */
static bool mal_response_read_init(MalVm *vm, const MalValue *args, i32 argc, i32 *status,
    MalValue *init_headers, MalValue *status_text) {
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue s;
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "status"), &s)) {
            return false;
        }
        if (!mal_value_is_undefined(s)) {
            u16 converted;
            if (!mal_fetch_to_uint16(vm, s, &converted)) return false;
            *status = converted;
            if (*status < 200 || *status > 599) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Response status must be between 200 and 599");
                return false;
            }
        }
        MalValue text;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "statusText"), &text)) {
            return false;
        }
        if (!mal_value_is_undefined(text)
            && !mal_fetch_reason_phrase(vm, text, status_text)) {
            return false;
        }
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "headers"), init_headers)) {
            return false;
        }
    }
    return true;
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
    MalValue roots[3] = {c.value, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 3);
    roots[2] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    MalString *jstr = mal_value_to_string(roots[0]);
    usize body_len;
    byte *body = mal_fetch_utf8_encode(vm, jstr, &body_len);
    if (body == nullptr) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }

    i32 status = 200;
    if (!mal_response_read_init(vm, args, argc, &status, &roots[1], &roots[2])) {
        free(body);
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    if (status == 204 || status == 205 || status == 304) {
        free(body);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Response status cannot have a body");
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }

    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]);
    MalResponseObject *r = mal_response_object_new(&vm->heap, proto, status, body, body_len);
    roots[0] = mal_value_from_response_object(r);
    r->status_text = roots[2];
    if (!mal_fetch_response_headers(vm, roots[1], &r->headers, &r->server_headers)) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalHeadersObject *h = mal_value_to_headers_object(r->headers);
    mal_fetch_default_content_type(vm, h, "application/json");
    MalValue result = roots[0];
    mal_gc_unroot(&rs);
    return result;
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
    void *url_handle = mal_url_parse(
        mal_string_code_units(url), mal_string_length(url), nullptr, 0, false);
    if (url_handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid URL");
        return mal_value_new_undefined();
    }
    i32 status = 302;
    if (argc >= 2 && !mal_value_is_undefined(args[1])) {
        u16 converted;
        if (!mal_fetch_to_uint16(vm, args[1], &converted)) {
            mal_url_free(url_handle);
            return mal_value_new_undefined();
        }
        status = converted;
    }
    if (status != 301 && status != 302 && status != 303 && status != 307 && status != 308) {
        mal_url_free(url_handle);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Invalid redirect status");
        return mal_value_new_undefined();
    }
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]);
    MalResponseObject *r = mal_response_object_new(&vm->heap, proto, status, nullptr, 0);
    MalValue rval = mal_value_from_response_object(r);
    MalRootSpan rrs;
    mal_gc_root(&rrs, &rval, 1);
    MalHeadersObject *h = mal_headers_create(vm);
    r->headers = mal_value_from_headers_object(h);
    MalHeadersObject *server_headers = mal_headers_create(vm);
    r->server_headers = mal_value_from_headers_object(server_headers);
    i32 url_len = mal_url_href(url_handle, nullptr, 0);
    byte *url_bytes = url_len > 0 ? malloc((usize) url_len) : nullptr;
    if (url_len > 0 && url_bytes == nullptr) {
        mal_url_free(url_handle);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Redirect URL allocation failed");
        mal_gc_unroot(&rrs);
        return mal_value_new_undefined();
    }
    if (url_len > 0) mal_url_href(url_handle, url_bytes, url_len);
    mal_headers_append_bytes(
        vm, h, "location", 8, (const char *) url_bytes, (usize) url_len);
    h->guard = MAL_HEADERS_GUARD_IMMUTABLE;
    free(url_bytes);
    mal_url_free(url_handle);
    mal_gc_unroot(&rrs);
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
    MalHeadersObject *h = mal_headers_create(vm);
    h->guard = MAL_HEADERS_GUARD_IMMUTABLE;
    r->headers = mal_value_from_headers_object(h);
    MalHeadersObject *server_headers = mal_headers_create(vm);
    r->server_headers = mal_value_from_headers_object(server_headers);
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
    r->body_stream = mal_value_new_undefined();
    r->method = mal_value_new_undefined();
    r->url = mal_value_new_undefined();
    r->headers = mal_value_new_undefined();
    r->referrer = mal_value_new_undefined();
    r->referrer_policy = mal_value_new_undefined();
    r->mode = mal_value_new_undefined();
    r->credentials = mal_value_new_undefined();
    r->cache = mal_value_new_undefined();
    r->redirect = mal_value_new_undefined();
    r->integrity = mal_value_new_undefined();
    return r;
}

static void mal_request_finalize(MalHeapHeader *cell) {
    MalRequestObject *r = (MalRequestObject *) cell;
    if (r->body != nullptr) {
        free(r->body);
        r->body = nullptr;
    }
}

static void mal_request_trace(MalHeapHeader *cell) {
    MalRequestObject *request = (MalRequestObject *) cell;
    mal_gc_mark_value(request->body_stream);
    mal_gc_mark_value(request->method);
    mal_gc_mark_value(request->url);
    mal_gc_mark_value(request->headers);
    mal_gc_mark_value(request->referrer);
    mal_gc_mark_value(request->referrer_policy);
    mal_gc_mark_value(request->mode);
    mal_gc_mark_value(request->credentials);
    mal_gc_mark_value(request->cache);
    mal_gc_mark_value(request->redirect);
    mal_gc_mark_value(request->integrity);
}

static bool mal_fetch_method_token_unit(c16 unit) {
    if ((unit >= '0' && unit <= '9') || (unit >= 'A' && unit <= 'Z')
        || (unit >= 'a' && unit <= 'z')) {
        return true;
    }
    switch (unit) {
        case '!':
        case '#':
        case '$':
        case '%':
        case '&':
        case '\'':
        case '*':
        case '+':
        case '-':
        case '.':
        case '^':
        case '_':
        case '`':
        case '|':
        case '~': return true;
        default: return false;
    }
}

static bool mal_fetch_normalize_method(MalVm *vm, MalString *method, MalValue *out) {
    usize length = mal_string_length(method);
    const c16 *units = mal_string_code_units(method);
    if (length == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Request method is not a valid HTTP token");
        return false;
    }
    for (usize i = 0; i < length; i++) {
        if (units[i] > 0xFF) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Request method is not a ByteString");
            return false;
        }
        if (!mal_fetch_method_token_unit(units[i])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Request method is not a valid HTTP token");
            return false;
        }
    }
    if (mal_fetch_string_ascii_equal_ci(method, "CONNECT")
        || mal_fetch_string_ascii_equal_ci(method, "TRACE")
        || mal_fetch_string_ascii_equal_ci(method, "TRACK")) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Request method is forbidden");
        return false;
    }
    static const char *normalized[] = {"DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"};
    for (usize i = 0; i < sizeof(normalized) / sizeof(normalized[0]); i++) {
        if (mal_fetch_string_ascii_equal_ci(method, normalized[i])) {
            *out = mal_value_from_string(mal_string_new_ascii(
                &vm->heap, normalized[i], strlen(normalized[i])));
            return true;
        }
    }
    *out = mal_value_from_string(method);
    return true;
}

static bool mal_fetch_request_url(MalVm *vm, MalString *url) {
    const c16 *units = mal_string_code_units(url);
    usize length = mal_string_length(url);
    bool absolute_authority = false;
    for (usize i = 0; i + 2 < length; i++) {
        if (units[i] == ':' && units[i + 1] == '/' && units[i + 2] == '/') {
            absolute_authority = true;
            break;
        }
    }
    // Maligator's server-main Request accepts application-relative targets because
    // it has no ambient document base. Absolute authority URLs still use the shared
    // WHATWG parser and must not contain credentials.
    if (!absolute_authority) return true;
    void *handle = mal_url_parse(units, length, nullptr, 0, false);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Request input is not a valid URL");
        return false;
    }
    bool credentials = mal_url_username(handle, nullptr, 0) > 0
        || mal_url_password(handle, nullptr, 0) > 0;
    mal_url_free(handle);
    if (credentials) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Request input URL cannot contain credentials");
        return false;
    }
    return true;
}

static bool mal_fetch_request_init_enum(MalVm *vm, MalValue init, const char *name,
    const char *const *values, usize value_count, i32 *selected, MalValue *out) {
    MalValue value;
    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_string_key(vm, (const byte *) name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) return true;
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    for (usize i = 0; i < value_count; i++) {
        if (mal_string_equals_ascii(string, values[i])) {
            *selected = (i32) i;
            *out = mal_value_from_string(string);
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "RequestInit member is not a valid enum value");
    return false;
}

enum {
    MAL_REQUEST_INIT_REFERRER,
    MAL_REQUEST_INIT_REFERRER_POLICY,
    MAL_REQUEST_INIT_MODE,
    MAL_REQUEST_INIT_CREDENTIALS,
    MAL_REQUEST_INIT_CACHE,
    MAL_REQUEST_INIT_REDIRECT,
    MAL_REQUEST_INIT_INTEGRITY,
};

static bool mal_fetch_validate_request_init(MalVm *vm, MalValue init,
    MalValue *fields, i32 *mode, i32 *cache, bool *duplex_present) {
    MalValue value;
    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_string_key(vm, (const byte *) "window"), &value)) {
        return false;
    }
    if (!mal_value_is_nil(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "RequestInit.window must be null");
        return false;
    }

    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_string_key(vm, (const byte *) "duplex"), &value)) {
        return false;
    }
    if (!mal_value_is_undefined(value)) {
        MalString *duplex;
        if (!mal_vm_to_string(vm, value, &duplex)) return false;
        if (!mal_string_equals_ascii(duplex, "half")) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "RequestInit.duplex must be half");
            return false;
        }
        *duplex_present = true;
    }

    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_string_key(vm, (const byte *) "referrer"), &value)) {
        return false;
    }
    if (!mal_value_is_undefined(value)) {
        MalString *referrer;
        if (!mal_vm_to_string(vm, value, &referrer)
            || !mal_fetch_request_url(vm, referrer)) {
            return false;
        }
        fields[MAL_REQUEST_INIT_REFERRER] = mal_value_from_string(referrer);
    }

    static const char *const referrer_policies[] = {"", "no-referrer",
        "no-referrer-when-downgrade", "origin", "origin-when-cross-origin",
        "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"};
    static const char *const modes[] = {"same-origin", "no-cors", "cors"};
    static const char *const credentials[] = {"omit", "same-origin", "include"};
    static const char *const caches[] = {
        "default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"};
    static const char *const redirects[] = {"follow", "error", "manual"};
    i32 selected = -1;
    if (!mal_fetch_request_init_enum(vm, init, "referrerPolicy", referrer_policies,
            sizeof(referrer_policies) / sizeof(referrer_policies[0]), &selected,
            &fields[MAL_REQUEST_INIT_REFERRER_POLICY])
        || !mal_fetch_request_init_enum(
            vm, init, "mode", modes, sizeof(modes) / sizeof(modes[0]), mode,
            &fields[MAL_REQUEST_INIT_MODE])
        || !mal_fetch_request_init_enum(vm, init, "credentials", credentials,
            sizeof(credentials) / sizeof(credentials[0]), &selected,
            &fields[MAL_REQUEST_INIT_CREDENTIALS])
        || !mal_fetch_request_init_enum(
            vm, init, "cache", caches, sizeof(caches) / sizeof(caches[0]), cache,
            &fields[MAL_REQUEST_INIT_CACHE])
        || !mal_fetch_request_init_enum(vm, init, "redirect", redirects,
            sizeof(redirects) / sizeof(redirects[0]), &selected,
            &fields[MAL_REQUEST_INIT_REDIRECT])) {
        return false;
    }

    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_string_key(vm, (const byte *) "integrity"), &value)) {
        return false;
    }
    if (!mal_value_is_undefined(value)) {
        MalString *integrity;
        if (!mal_vm_to_string(vm, value, &integrity)) return false;
        fields[MAL_REQUEST_INIT_INTEGRITY] = mal_value_from_string(integrity);
    }

    if (*cache == 5 && *mode != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "RequestInit.cache only-if-cached requires same-origin mode");
        return false;
    }
    return true;
}

/* `new Request(input, init?)`: input is a URL string or another Request (copied);
 * init overrides the Request internal slots and the body remains owned raw bytes. */
static MalValue mal_request_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (!mal_value_is_object(nt)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Request constructor requires new");
        return mal_value_new_undefined();
    }
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE]);
    MalValue p = mal_vm_function_prototype(vm, nt);
    if (mal_value_is_object(p)) {
        proto = mal_value_to_object(p);
    }
    MalRequestObject *r = mal_request_object_new(&vm->heap, proto);
    // Root the instance and every transient Request slot across conversion and
    // Headers/body allocation.
    MalValue slots[13];
    for (usize i = 0; i < sizeof(slots) / sizeof(slots[0]); i++) {
        slots[i] = mal_value_new_undefined();
    }
    slots[0] = mal_value_from_request_object(r);
    MalRootSpan rs;
    mal_gc_root(&rs, slots, sizeof(slots) / sizeof(slots[0]));
    slots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "GET", 3)); // method
    slots[2] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));    // url
    slots[6] = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, "about:client", 12)); // referrer
    slots[7] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0)); // referrerPolicy
    slots[8] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "cors", 4));
    slots[9] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "same-origin", 11));
    slots[10] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "default", 7));
    slots[11] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "follow", 6));
    slots[12] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0)); // integrity
    MalRequestObject *source_request = nullptr;
    bool body_override = false;
    const char *content_type = nullptr;
    i32 request_mode = 2;
    i32 request_cache = 0;
    bool duplex_present = false;

    if (argc >= 1 && mal_value_is_request_object(args[0])) {
        MalRequestObject *src = mal_value_to_request_object(args[0]);
        source_request = src;
        slots[1] = src->method;
        slots[2] = src->url;
        slots[3] = src->headers;
        slots[6] = src->referrer;
        slots[7] = src->referrer_policy;
        slots[8] = src->mode;
        slots[9] = src->credentials;
        slots[10] = src->cache;
        slots[11] = src->redirect;
        slots[12] = src->integrity;
        MalString *source_mode = mal_value_to_string(src->mode);
        request_mode = mal_string_equals_ascii(source_mode, "same-origin") ? 0
            : mal_string_equals_ascii(source_mode, "no-cors") ? 1 : 2;
        request_cache = mal_string_equals_ascii(
            mal_value_to_string(src->cache), "only-if-cached") ? 5 : 0;
        if (src->body != nullptr) {
            r->body = malloc(src->body_len == 0 ? 1 : src->body_len);
            if (r->body == nullptr) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Request body allocation failed");
                goto request_error;
            }
            if (src->body_len > 0) {
                memcpy(r->body, src->body, src->body_len);
            }
            r->body_len = src->body_len;
        }
    } else if (argc >= 1 && !mal_value_is_undefined(args[0])) {
        MalString *u;
        if (!mal_vm_to_string(vm, args[0], &u) || !mal_fetch_request_url(vm, u)) {
            goto request_error;
        }
        slots[2] = mal_value_from_string(u);
    }

    if (argc >= 2 && mal_value_is_object(args[1])) {
        if (!mal_fetch_validate_request_init(
                vm, args[1], &slots[6], &request_mode, &request_cache,
                &duplex_present)) {
            goto request_error;
        }
        MalValue v;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "method"), &v)) goto request_error;
        if (!mal_value_is_undefined(v)) {
            MalString *m;
            if (!mal_vm_to_string(vm, v, &m)) goto request_error;
            slots[1] = mal_value_from_string(m);
        }
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "headers"), &v)) goto request_error;
        if (!mal_value_is_undefined(v)) {
            slots[3] = v;
        }
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "body"), &v)) goto request_error;
        if (!mal_value_is_nil(v)) {
            slots[4] = v;
            body_override = true;
        }
    }

    // A body from init replaces any copied body. A Request used as the init
    // dictionary exposes its byte-backed body through the Body stream getter;
    // preserve those source bytes rather than treating that lazy stream as a
    // streaming upload.
    if (mal_value_is_readable_stream_object(slots[4])) {
        MalRequestObject *body_source = argc >= 2 && mal_value_is_request_object(args[1])
            ? mal_value_to_request_object(args[1]) : nullptr;
        if (body_source != nullptr && body_source->body != nullptr
            && mal_ops_same_value(body_source->body_stream, slots[4])) {
            free(r->body);
            r->body = malloc(body_source->body_len == 0 ? 1 : body_source->body_len);
            if (r->body == nullptr) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Request body allocation failed");
                goto request_error;
            }
            if (body_source->body_len > 0) {
                memcpy(r->body, body_source->body, body_source->body_len);
            }
            r->body_len = body_source->body_len;
        } else {
            if (!duplex_present) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "RequestInit.duplex is required for a ReadableStream body");
                goto request_error;
            }
            if (request_mode != 0 && request_mode != 2) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "ReadableStream request bodies require same-origin or cors mode");
                goto request_error;
            }
            if (mal_readable_stream_is_locked(slots[4])
                || mal_readable_stream_is_disturbed(slots[4])) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "ReadableStream BodyInit is locked or disturbed");
                goto request_error;
            }
            free(r->body);
            r->body = nullptr;
            r->body_len = 0;
            r->body_stream = slots[4];
        }
    } else if (mal_fetch_is_form_data(slots[4])) {
        free(r->body);
        r->body = mal_form_data_serialize(
            vm, mal_fetch_to_form_data(slots[4]), &r->body_len);
        if (r->body == nullptr) goto request_error;
        content_type = MAL_FORM_DATA_CONTENT_TYPE;
    } else if (mal_fetch_is_blob(slots[4])) {
        MalBlobObject *blob = mal_fetch_to_blob(slots[4]);
        free(r->body);
        r->body = malloc(blob->length == 0 ? 1 : blob->length);
        if (r->body == nullptr) {
            mal_vm_throw_allocation_error(vm);
            goto request_error;
        }
        if (blob->length > 0) memcpy(r->body, blob->bytes, blob->length);
        r->body_len = blob->length;
        content_type = blob->type_length > 0 ? blob->type : nullptr;
    } else if (mal_value_is_string(slots[4])) {
        MalString *bs = mal_value_to_string(slots[4]);
        free(r->body);
        r->body = mal_fetch_utf8_encode(vm, bs, &r->body_len);
        if (r->body == nullptr) goto request_error;
        content_type = "text/plain;charset=UTF-8";
    } else {
        const byte *sb;
        usize sl;
        MalFetchBufferSourceResult buffer_result =
            mal_fetch_buffer_source(vm, slots[4], &sb, &sl);
        if (buffer_result == MAL_FETCH_BUFFER_SOURCE_ERROR) goto request_error;
        if (buffer_result == MAL_FETCH_BUFFER_SOURCE_OK) {
            free(r->body);
            r->body = malloc(sl == 0 ? 1 : sl);
            if (r->body == nullptr) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Request body allocation failed");
                goto request_error;
            }
            if (sl > 0) {
                memcpy(r->body, sb, sl);
            }
            r->body_len = sl;
        } else if (!mal_value_is_undefined(slots[4])) {
            bool is_search_params = mal_value_is_url_search_params_object(slots[4]);
            MalString *bs;
            if (!mal_vm_to_string(vm, slots[4], &bs)) goto request_error;
            free(r->body);
            r->body = mal_fetch_utf8_encode(vm, bs, &r->body_len);
            if (r->body == nullptr) goto request_error;
            content_type = is_search_params
                ? "application/x-www-form-urlencoded;charset=UTF-8"
                : "text/plain;charset=UTF-8";
        }
    }

    MalString *method;
    if (!mal_vm_to_string(vm, slots[1], &method)) goto request_error;
    if (!mal_fetch_normalize_method(vm, method, &slots[1])) goto request_error;
    method = mal_value_to_string(slots[1]);
    if (request_mode == 1 && !mal_fetch_string_ascii_equal_ci(method, "GET")
        && !mal_fetch_string_ascii_equal_ci(method, "HEAD")
        && !mal_fetch_string_ascii_equal_ci(method, "POST")) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "no-cors Request method is not CORS-safelisted");
        goto request_error;
    }
    if ((r->body != nullptr || !mal_value_is_undefined(r->body_stream)) &&
        (mal_fetch_string_ascii_equal_ci(method, "GET") ||
            mal_fetch_string_ascii_equal_ci(method, "HEAD"))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "GET and HEAD requests cannot have a body");
        goto request_error;
    }
    MalHeadersGuard headers_guard = request_mode == 1
        ? MAL_HEADERS_GUARD_REQUEST_NO_CORS : MAL_HEADERS_GUARD_REQUEST;
    slots[5] = mal_value_from_headers_object(
        mal_headers_from_init_guarded(vm, slots[3], headers_guard));
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) goto request_error;
    mal_fetch_default_content_type(
        vm, mal_value_to_headers_object(slots[5]), content_type);
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) goto request_error;

    if (source_request != nullptr && source_request->body != nullptr && !body_override) {
        MalFetchBody source_body;
        (void) mal_fetch_body_from_value(args[0], &source_body);
        if (!mal_fetch_body_begin(vm, args[0], &source_body)) {
            if (vm->completion.kind == MAL_COMPLETION_NORMAL) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Cannot construct a Request from a used body");
            }
            goto request_error;
        }
    }
    if (source_request != nullptr && source_request->body == nullptr
        && !mal_value_is_undefined(source_request->body_stream) && !body_override) {
        r->body_stream = mal_readable_stream_create_proxy(
            vm, source_request->body_stream);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto request_error;
    }

    r->method = slots[1];
    r->url = slots[2];
    r->headers = slots[5];
    r->referrer = slots[6];
    r->referrer_policy = slots[7];
    r->mode = slots[8];
    r->credentials = slots[9];
    r->cache = slots[10];
    r->redirect = slots[11];
    r->integrity = slots[12];
    if (!mal_value_is_undefined(r->body_stream)) {
        mal_gc_card(&r->object.header, r->body_stream);
    }
    for (usize i = 1; i < sizeof(slots) / sizeof(slots[0]); i++) {
        if (i == 3 || i == 4) continue;
        mal_gc_card(&r->object.header, slots[i]);
    }

    mal_gc_unroot(&rs);
    return slots[0];

request_error:
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

static MalRequestObject *mal_request_this_or_throw(MalVm *vm, MalValue self) {
    if (mal_value_is_request_object(self)) return mal_value_to_request_object(self);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Request getter called on incompatible receiver");
    return nullptr;
}

#define MAL_REQUEST_FIELD_GETTER(name, field) \
    static MalValue name(MalVm *vm, MalValue self, const MalValue *args, i32 argc, \
        MalValue nt, MalValue callee) { \
        (void) args; \
        (void) argc; \
        (void) nt; \
        (void) callee; \
        MalRequestObject *request = mal_request_this_or_throw(vm, self); \
        return request == nullptr ? mal_value_new_undefined() : request->field; \
    }

MAL_REQUEST_FIELD_GETTER(mal_request_get_method, method)
MAL_REQUEST_FIELD_GETTER(mal_request_get_url, url)
MAL_REQUEST_FIELD_GETTER(mal_request_get_headers, headers)
MAL_REQUEST_FIELD_GETTER(mal_request_get_referrer, referrer)
MAL_REQUEST_FIELD_GETTER(mal_request_get_referrer_policy, referrer_policy)
MAL_REQUEST_FIELD_GETTER(mal_request_get_mode, mode)
MAL_REQUEST_FIELD_GETTER(mal_request_get_credentials, credentials)
MAL_REQUEST_FIELD_GETTER(mal_request_get_cache, cache)
MAL_REQUEST_FIELD_GETTER(mal_request_get_redirect, redirect)
MAL_REQUEST_FIELD_GETTER(mal_request_get_integrity, integrity)

#undef MAL_REQUEST_FIELD_GETTER

static MalValue mal_request_constant_getter(
    MalVm *vm, MalValue self, const byte *value) {
    if (mal_request_this_or_throw(vm, self) == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_intrinsic_ascii(vm, value));
}

#define MAL_REQUEST_CONSTANT_GETTER(name, value) \
    static MalValue name(MalVm *vm, MalValue self, const MalValue *args, i32 argc, \
        MalValue nt, MalValue callee) { \
        (void) args; \
        (void) argc; \
        (void) nt; \
        (void) callee; \
        return mal_request_constant_getter(vm, self, (const byte *) value); \
    }

MAL_REQUEST_CONSTANT_GETTER(mal_request_get_destination, "")
MAL_REQUEST_CONSTANT_GETTER(mal_request_get_duplex, "half")

#undef MAL_REQUEST_CONSTANT_GETTER

static MalValue mal_request_false_getter(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_request_this_or_throw(vm, self) == nullptr
        ? mal_value_new_undefined() : mal_value_new_boolean(false);
}

static MalValue mal_request_clone(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalRequestObject *source = mal_request_this_or_throw(vm, self);
    if (source == nullptr) return mal_value_new_undefined();
    if (!mal_value_is_undefined(source->body_stream)
        && (mal_readable_stream_is_locked(source->body_stream)
            || mal_readable_stream_is_disturbed(source->body_stream))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot clone a Request with a used body");
        return mal_value_new_undefined();
    }

    MalRequestObject *clone = mal_request_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE]));
    MalValue roots[3] = {
        mal_value_from_request_object(clone),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 3);
    if (source->body != nullptr) {
        clone->body = malloc(source->body_len == 0 ? 1 : source->body_len);
        if (clone->body == nullptr) {
            mal_gc_unroot(&rs);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "Request body allocation failed");
            return mal_value_new_undefined();
        }
        if (source->body_len > 0) memcpy(clone->body, source->body, source->body_len);
        clone->body_len = source->body_len;
    }
    MalHeadersObject *source_headers = mal_value_to_headers_object(source->headers);
    clone->headers = mal_value_from_headers_object(
        mal_headers_from_init_guarded(vm, source->headers, source_headers->guard));
    clone->method = source->method;
    clone->url = source->url;
    clone->referrer = source->referrer;
    clone->referrer_policy = source->referrer_policy;
    clone->mode = source->mode;
    clone->credentials = source->credentials;
    clone->cache = source->cache;
    clone->redirect = source->redirect;
    clone->integrity = source->integrity;
    if (source->body == nullptr
        && !mal_value_is_undefined(source->body_stream)) {
        if (!mal_readable_stream_tee(
                vm, source->body_stream, &roots[1], &roots[2])) {
            mal_gc_unroot(&rs);
            return mal_value_new_undefined();
        }
        mal_gc_write_barrier(source->body_stream);
        source->body_stream = roots[1];
        mal_gc_card(&source->object.header, roots[1]);
        clone->body_stream = roots[2];
        mal_gc_card(&clone->object.header, roots[2]);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&rs);
    return result;
}

/* ---------------------------------------------------------------------------
 * Mal.serve request state.
 *
 * Inbound framing is llhttp's (MalHttpCodec) — this layer only buffers the decoded
 * body so the WinterTC handler can see a whole Request. Two bounds matter: the total
 * buffered body (413 past MAL_FETCH_REQUEST_BODY_MAX) and the request target
 * (414 past MAL_FETCH_TARGET_MAX); per-turn read bounds stay in the transport.
 * --------------------------------------------------------------------------- */

#define MAL_FETCH_REQUEST_BODY_MAX ((usize) 16 * 1024 * 1024)
#define MAL_FETCH_TARGET_MAX ((usize) 8 * 1024)
#define MAL_FETCH_URL_MAX ((usize) 16 * 1024)
/* uri-host (253 for a maximal DNS name) plus ":65535". */
#define MAL_FETCH_HOST_MAX ((usize) 259)

typedef struct MalFetchSnapshotHeader {
    const char *name;
    usize name_len;
    const char *value;
    usize value_len;
} MalFetchSnapshotHeader;

/*
 * Per-request host state, packed into one allocation (struct, header array, then
 * NUL-terminated field bytes). It deliberately outlives MalHttpConn: a handler's
 * promise can settle after the peer disconnected or the response already flushed,
 * so `conn` is cleared the instant the transport reports completion or failure and
 * `refs` (transport + pending promise reaction) keeps the struct itself alive.
 * Nothing may dereference `conn` without a null check.
 */
typedef struct MalFetchRequest {
    MalVm *vm;
    MalHttpConn *conn;
    int refs;
    bool responded;
    bool head_request;
    bool body_overflow;
    bool body_failed;
    byte *body;
    usize body_len;
    usize body_cap;
    const char *method;
    usize method_len;
    const char *target;
    usize target_len;
    MalFetchSnapshotHeader *headers;
    usize header_count;
} MalFetchRequest;

static bool mal_fetch_snapshot_add(usize *total, usize length) {
    if (length == SIZE_MAX || *total > SIZE_MAX - (length + 1)) return false;
    *total += length + 1;
    return true;
}

static const char *mal_fetch_snapshot_copy(
    char **cursor, const char *bytes, usize length) {
    char *copy = *cursor;
    if (length > 0) memcpy(copy, bytes, length);
    copy[length] = '\0';
    *cursor += length + 1;
    return copy;
}

static bool mal_fetch_snapshot_header(
    const MalFetchRequest *req, const char *name, const char **value, usize *value_len) {
    usize name_len = strlen(name);
    for (usize i = 0; i < req->header_count; i++) {
        if (req->headers[i].name_len != name_len) continue;
        bool equal = true;
        for (usize j = 0; j < name_len; j++) {
            if (mal_ascii_to_lower((u8) req->headers[i].name[j]) != (u8) name[j]) {
                equal = false;
                break;
            }
        }
        if (equal) {
            *value = req->headers[i].value;
            *value_len = req->headers[i].value_len;
            return true;
        }
    }
    return false;
}

static MalFetchRequest *mal_fetch_request_new(
    MalVm *vm, MalHttpConn *conn, const MalHttpCodecHead *head) {
    usize total = (usize) sizeof(MalFetchRequest);
    usize header_size = (usize) sizeof(MalFetchSnapshotHeader);
    if (head->field_count > (SIZE_MAX - total) / header_size) return nullptr;
    total += head->field_count * header_size;
    if (!mal_fetch_snapshot_add(&total, head->method_length)
        || !mal_fetch_snapshot_add(&total, head->target_length)) {
        return nullptr;
    }
    for (usize i = 0; i < head->field_count; i++) {
        if (!mal_fetch_snapshot_add(&total, head->fields[i].name_length)
            || !mal_fetch_snapshot_add(&total, head->fields[i].value_length)) {
            return nullptr;
        }
    }
    MalFetchRequest *req = calloc(1, total);
    if (req == nullptr) return nullptr;
    req->vm = vm;
    req->conn = conn;
    req->refs = 1; // the transport's reference
    req->headers = (MalFetchSnapshotHeader *) (req + 1);
    req->header_count = head->field_count;
    char *cursor = (char *) &req->headers[head->field_count];
    req->method_len = head->method_length;
    req->method = mal_fetch_snapshot_copy(
        &cursor, (const char *) mal_http_codec_head_method(head), head->method_length);
    req->target_len = head->target_length;
    req->target = mal_fetch_snapshot_copy(
        &cursor, (const char *) mal_http_codec_head_target(head), head->target_length);
    for (usize i = 0; i < head->field_count; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        req->headers[i].name_len = field->name_length;
        req->headers[i].name = mal_fetch_snapshot_copy(
            &cursor, (const char *) mal_http_codec_field_name(head, field),
            field->name_length);
        req->headers[i].value_len = field->value_length;
        req->headers[i].value = mal_fetch_snapshot_copy(
            &cursor, (const char *) mal_http_codec_field_value(head, field),
            field->value_length);
    }
    req->head_request = req->method_len == 4 && memcmp(req->method, "HEAD", 4) == 0;
    return req;
}

static void mal_fetch_request_retain(MalFetchRequest *req) {
    req->refs++;
}

static void mal_fetch_request_release(MalFetchRequest *req) {
    if (--req->refs > 0) return;
    free(req->body);
    free(req);
}

/* The transport is gone (peer disconnect, abort, or a flushed response): drop the
 * connection pointer so a later promise settlement cannot reach freed memory. */
static void mal_fetch_response_complete(void *data, bool success) {
    (void) success;
    MalFetchRequest *req = data;
    req->conn = nullptr;
    mal_fetch_request_release(req);
}

static MalValue mal_fetch_make_request(MalVm *vm, MalFetchRequest *req) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REQUEST_PROTOTYPE]);
    MalRequestObject *r = mal_request_object_new(&vm->heap, proto);
    MalValue result = mal_value_from_request_object(r);
    MalRootSpan rs;
    mal_gc_root(&rs, &result, 1);
    r->referrer = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, "about:client", 12));
    r->referrer_policy = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    r->mode = mal_value_from_string(mal_string_new_ascii(&vm->heap, "cors", 4));
    r->credentials = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, "same-origin", 11));
    r->cache = mal_value_from_string(mal_string_new_ascii(&vm->heap, "default", 7));
    r->redirect = mal_value_from_string(mal_string_new_ascii(&vm->heap, "follow", 6));
    r->integrity = mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    if (req->body_len > 0) {
        r->body = malloc(req->body_len);
        if (r->body == nullptr) {
            mal_gc_unroot(&rs);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "Request body allocation failed");
            return mal_value_new_undefined();
        }
        memcpy(r->body, req->body, req->body_len);
        r->body_len = req->body_len;
    }

    MalString *method = mal_string_new_ascii(&vm->heap, req->method, req->method_len);
    r->method = mal_value_from_string(method);

    // url = "http://" + Host + request-target (spec wants an absolute URL string).
    // Sized exactly: snprintf reports the untruncated length, so measuring into a
    // fixed stack buffer would hand the over-long remainder to the JS string.
    // mal_fetch_stream_handler refused duplicates, so this first match is the same
    // field it validated as a URI authority; the fallback covers only HTTP/1.0.
    const char *host_hdr;
    usize host_len;
    if (!mal_fetch_snapshot_header(req, "host", &host_hdr, &host_len)) {
        host_hdr = "localhost";
        host_len = 9;
    }
    static const char scheme[] = "http://";
    usize scheme_len = sizeof(scheme) - 1;
    usize url_len = scheme_len + host_len + req->target_len;
    char *urlbuf = malloc(url_len == 0 ? 1 : url_len);
    if (urlbuf == nullptr) {
        mal_gc_unroot(&rs);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Request URL allocation failed");
        return mal_value_new_undefined();
    }
    memcpy(urlbuf, scheme, scheme_len);
    if (host_len > 0) memcpy(urlbuf + scheme_len, host_hdr, host_len);
    if (req->target_len > 0) {
        memcpy(urlbuf + scheme_len + host_len, req->target, req->target_len);
    }
    MalString *url = mal_string_new_ascii(&vm->heap, (const byte *) urlbuf, url_len);
    free(urlbuf);
    r->url = mal_value_from_string(url);

    // request.headers (a Headers instance built from the parsed headers).
    MalHeadersObject *headers = mal_headers_create(vm);
    for (usize i = 0; i < req->header_count; i++) {
        mal_headers_append_bytes(vm, headers, req->headers[i].name,
            req->headers[i].name_len, req->headers[i].value, req->headers[i].value_len);
    }
    r->headers = mal_value_from_headers_object(headers);

    mal_gc_unroot(&rs);
    return result;
}

/* ---------------------------------------------------------------------------
 * The handler hook + Mal.serve.
 * --------------------------------------------------------------------------- */

/* MalFetchRequest is a host C struct (not a GC cell), so a native reaction carries
 * the pointer in a slot boxed as an f64 (48-bit pointers are exact in a double).
 * The reaction pair holds a reference for as long as it can run, so the pointer is
 * always live when it is unboxed — but `req->conn` may already be null by then. */
static MalValue mal_fetch_box_request(MalFetchRequest *req) {
    return mal_value_from_f64((f64) (uptr) req);
}

static MalFetchRequest *mal_fetch_unbox_request(MalValue value) {
    return (MalFetchRequest *) (uptr) mal_value_to_f64(value);
}

/* Case-insensitive match of a header name (UTF-16) against a lowercase ASCII literal. */
static bool mal_fetch_name_is(const MalString *name, const char *ascii) {
    return mal_string_equals_ascii_ci(name, ascii);
}

/* Serialize a Response's Headers into an HTTP header block ("Name: Value\r\n" per
 * line), skipping host-managed framing headers and ensuring a Content-Type. Returns
 * malloc'd bytes + len (caller frees), or null (=> host default) when there is no
 * Headers object. Clears *ok when the block could not be allocated. */
static char *mal_fetch_serialize_headers(
    MalResponseObject *r, usize *out_len, bool *ok) {
    static const char default_ct[] = "Content-Type: text/plain; charset=utf-8\r\n";
    *ok = true;
    MalHeadersObject *headers[2];
    i32 header_count = 0;
    if (mal_value_is_headers_object(r->server_headers)) {
        headers[header_count++] = mal_value_to_headers_object(r->server_headers);
    }
    if (mal_value_is_headers_object(r->headers)) {
        headers[header_count++] = mal_value_to_headers_object(r->headers);
    }
    if (header_count == 0) {
        *out_len = 0;
        return nullptr;
    }

    bool has_ct = false;
    usize size = 0;
    for (i32 set = 0; set < header_count; set++) {
        MalHeadersObject *h = headers[set];
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
    }
    if (!has_ct) {
        size += strlen(default_ct);
    }

    char *buf = malloc(size == 0 ? 1 : size);
    if (buf == nullptr) {
        *ok = false;
        *out_len = 0;
        return nullptr;
    }
    usize o = 0;
    if (!has_ct) {
        memcpy(buf, default_ct, strlen(default_ct));
        o += strlen(default_ct);
    }
    for (i32 set = 0; set < header_count; set++) {
        MalHeadersObject *h = headers[set];
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
    }
    *out_len = o;
    return buf;
}

/* Send a fixed-text reply, honouring the request method's body rules. */
static void mal_fetch_respond_text(
    MalFetchRequest *req, int status, const char *reason, const char *body, usize body_len) {
    if (req->conn == nullptr || req->responded) return;
    req->responded = true;
    if (req->head_request) {
        mal_http_conn_respond_framed(
            req->conn, status, reason, nullptr, 0, "", 0, (i64) body_len);
        return;
    }
    mal_http_conn_respond(req->conn, status, reason, nullptr, 0, body, body_len);
}

/* Serialize a settled handler result (a Response, or a 500 if it isn't one). */
static void mal_fetch_respond_with(MalFetchRequest *req, MalValue result) {
    if (req->conn == nullptr || req->responded) return;
    if (!mal_value_is_response_object(result)) {
        mal_fetch_respond_text(req, 500, "Internal Server Error",
            "handler must return a Response", 30);
        return;
    }
    MalResponseObject *r = mal_value_to_response_object(result);
    // Response.error() is a network error, not a message: status 0 has no status
    // line and its statusText/headers are not answers to this request. Anything
    // outside the wire range would emit "HTTP/1.1 0 ..." and desynchronize the peer.
    if (r->status < 100 || r->status > 599) {
        mal_fetch_respond_text(req, 500, "Internal Server Error",
            "handler returned a network error response", 41);
        return;
    }
    usize hlen = 0;
    bool serialized = false;
    char *block = mal_fetch_serialize_headers(r, &hlen, &serialized);
    if (!serialized) {
        mal_fetch_respond_text(req, 500, "Internal Server Error", "handler error", 13);
        return;
    }
    const char *reason = mal_fetch_reason(r->status);
    char *custom_reason = nullptr;
    if (mal_value_is_string(r->status_text)) {
        MalString *status_text = mal_value_to_string(r->status_text);
        usize length = mal_string_length(status_text);
        if (length > 0) {
            custom_reason = malloc(length + 1);
            if (custom_reason != nullptr) {
                const c16 *units = mal_string_code_units(status_text);
                for (usize i = 0; i < length; i++) custom_reason[i] = (char) units[i];
                custom_reason[length] = '\0';
                reason = custom_reason;
            }
        }
    }

    // A body on HEAD or an entity-forbidden status desynchronizes the response queue
    // of every keep-alive peer, so transmit nothing and only advertise the length
    // where RFC 9110 still expects one (HEAD mirrors GET; 1xx/204/304 carry none).
    bool entity_forbidden =
        (r->status >= 100 && r->status < 200) || r->status == 204 || r->status == 304;
    req->responded = true;
    if (entity_forbidden) {
        mal_http_conn_respond_framed(req->conn, r->status, reason, block, hlen, "", 0, -1);
    } else if (req->head_request) {
        mal_http_conn_respond_framed(
            req->conn, r->status, reason, block, hlen, "", 0, (i64) r->body_len);
    } else {
        mal_http_conn_respond(req->conn, r->status, reason, block, hlen,
            r->body != nullptr ? r->body : "", r->body_len);
    }
    free(custom_reason);
    free(block);
}

static MalValue mal_fetch_on_fulfilled(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt,
    MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) nt;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalFetchRequest *req =
        mal_fetch_unbox_request(mal_native_function_object_get_slot(self, 0));
    mal_fetch_respond_with(req, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    mal_fetch_request_release(req);
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
    MalFetchRequest *req =
        mal_fetch_unbox_request(mal_native_function_object_get_slot(self, 0));
    mal_fetch_respond_text(req, 500, "Internal Server Error", "handler rejected", 16);
    mal_fetch_request_release(req);
    return mal_value_new_undefined();
}

/* Run the WinterTC handler now that the whole request is buffered. */
static void mal_fetch_dispatch(MalVm *vm, MalFetchRequest *req) {
    if (req->responded || req->conn == nullptr) return;
    if (req->body_overflow) {
        mal_http_conn_close_after_response(req->conn);
        mal_fetch_respond_text(req, 413, "Content Too Large", "request body too large", 22);
        return;
    }
    if (req->body_failed) {
        mal_http_conn_close_after_response(req->conn);
        mal_fetch_respond_text(req, 500, "Internal Server Error", "handler error", 13);
        return;
    }
    MalValue handler = vm->intrinsics[MAL_INTRINSIC_FETCH_HANDLER];
    if (!mal_value_is_callable(handler)) {
        mal_fetch_respond_text(req, 500, "Internal Server Error", "no handler", 10);
        return;
    }

    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, countof(roots));
    roots[0] = mal_fetch_make_request(vm, req);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_gc_unroot(&rs);
        mal_fetch_respond_text(req, 500, "Internal Server Error", "handler error", 13);
        return;
    }
    MalCompletion c = mal_vm_call_value(vm, handler, mal_value_new_undefined(), &roots[0], 1);
    if (c.kind == MAL_COMPLETION_THROW) {
        // Swallow the handler's synchronous throw so it doesn't leak into the loop.
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_gc_unroot(&rs);
        mal_fetch_respond_text(req, 500, "Internal Server Error", "handler error", 13);
        return;
    }

    // Normalize the result to a promise and respond when it settles — covers a
    // sync Response and an async Promise<Response> through one path.
    roots[1] = c.value;
    MalValue promise;
    if (!mal_promise_resolve_value(vm, roots[1], &promise)) {
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_gc_unroot(&rs);
        mal_fetch_respond_text(req, 500, "Internal Server Error", "handler error", 13);
        return;
    }
    roots[1] = promise;

    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalString *name = mal_intrinsic_ascii(vm, (const byte *) "");
    MalValue request_slot = mal_fetch_box_request(req);
    MalNativeFunctionObject *on_fulfilled = mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, name, mal_fetch_on_fulfilled, &request_slot, 1);
    MalNativeFunctionObject *on_rejected = mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, name, mal_fetch_on_rejected, &request_slot, 1);
    // Exactly one reaction runs, so one reference covers the pair.
    mal_fetch_request_retain(req);
    mal_promise_perform_then(vm, roots[1],
        mal_value_from_native_function_object(on_fulfilled),
        mal_value_from_native_function_object(on_rejected),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&rs);
}

/* Transport → buffer. The codec owns framing; this only bounds the total body. */
static void mal_fetch_request_data(void *data, byte *owned_bytes, usize length) {
    MalFetchRequest *req = data;
    if (req->body_overflow || req->body_failed) {
        free(owned_bytes);
        return;
    }
    if (length > MAL_FETCH_REQUEST_BODY_MAX - req->body_len) {
        req->body_overflow = true;
        free(owned_bytes);
        if (req->conn != nullptr) mal_http_conn_request_discard(req->conn);
        return;
    }
    usize required = req->body_len + length;
    if (required > req->body_cap) {
        usize capacity = req->body_cap == 0 ? 1024 : req->body_cap;
        while (capacity < required) {
            if (capacity > MAL_FETCH_REQUEST_BODY_MAX / 2) {
                capacity = MAL_FETCH_REQUEST_BODY_MAX;
                break;
            }
            capacity *= 2;
        }
        byte *grown = realloc(req->body, capacity);
        if (grown == nullptr) {
            req->body_failed = true;
            free(owned_bytes);
            if (req->conn != nullptr) mal_http_conn_request_discard(req->conn);
            return;
        }
        req->body = grown;
        req->body_cap = capacity;
    }
    memcpy(req->body + req->body_len, owned_bytes, length);
    req->body_len = required;
    free(owned_bytes);
}

static void mal_fetch_request_end(void *data, bool success) {
    MalFetchRequest *req = data;
    if (req->conn == nullptr) return;
    // conn_close invokes the request-end callback after freeing the transport and
    // invokes the response-complete callback (which clears req->conn) afterwards.
    // On failure the transport is therefore already gone; touching req->conn here
    // would recreate the disconnect use-after-free this state is meant to prevent.
    if (!success) return;
    mal_http_conn_request_release(req->conn);
    mal_fetch_dispatch(req->vm, req);
}

/* Bytes that may appear in a reg-name. Everything a URL parser treats as a
 * component boundary is excluded, so the composed "http://" + Host + target can
 * never resolve to an authority other than the one the peer sent. */
static bool mal_fetch_host_reg_char(byte c) {
    if (c <= 0x20 || c >= 0x7f) return false;
    switch (c) {
        case '"': case '#': case '%': case '\'': case '/': case ':': case '<':
        case '>': case '?': case '@': case '[': case '\\': case ']': case '^':
        case '`': case '{': case '|': case '}':
            return false;
        default: return true;
    }
}

/* Validate a Host field as RFC 9110 `uri-host [ ":" port ]`. Userinfo, embedded
 * path/query/fragment delimiters, whitespace, control bytes, an unbracketed IPv6
 * literal, and an empty or out-of-range port are all rejected rather than
 * normalized, because every one of them makes the origin the application derives
 * from request.url differ from the origin a proxy in front of it derived. */
static bool mal_fetch_host_valid(const char *value, usize length) {
    if (length == 0 || length > MAL_FETCH_HOST_MAX) return false;
    usize host_end;
    if (value[0] == '[') {
        usize close = 0;
        bool colon = false;
        for (usize i = 1; i < length; i++) {
            byte c = (byte) value[i];
            if (c == ']') {
                close = i;
                break;
            }
            if (c == ':') {
                colon = true;
                continue;
            }
            bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
                || (c >= 'A' && c <= 'F');
            if (!hex && c != '.') return false;
        }
        if (close < 2 || !colon) return false;
        host_end = close + 1;
    } else {
        host_end = length;
        for (usize i = 0; i < length; i++) {
            if (value[i] == ':') {
                host_end = i;
                break;
            }
            if (!mal_fetch_host_reg_char((byte) value[i])) return false;
        }
        if (host_end == 0) return false;
    }
    if (host_end == length) return true;
    if (value[host_end] != ':') return false;
    usize digits = length - host_end - 1;
    if (digits == 0 || digits > 5) return false;
    u32 port = 0;
    for (usize i = host_end + 1; i < length; i++) {
        if (value[i] < '0' || value[i] > '9') return false;
        port = port * 10 + (u32) (value[i] - '0');
    }
    return port <= 65535;
}

static void mal_fetch_stream_handler(
    void *data, MalVm *vm, MalHttpConn *conn, const MalHttpCodecHead *head) {
    (void) data;
    // Reject over-long targets before composing an absolute URL from them; leaving
    // the stream callbacks unregistered makes the transport discard the body.
    const char *host = nullptr;
    usize host_len = 0;
    usize host_count = 0;
    for (usize i = 0; i < head->field_count; i++) {
        const MalHttpCodecField *field = &head->fields[i];
        if (field->name_length != 4) continue;
        const char *name = (const char *) mal_http_codec_field_name(head, field);
        if (mal_ascii_to_lower((u8) name[0]) != 'h'
            || mal_ascii_to_lower((u8) name[1]) != 'o'
            || mal_ascii_to_lower((u8) name[2]) != 's'
            || mal_ascii_to_lower((u8) name[3]) != 't') {
            continue;
        }
        if (host_count == 0) {
            host = (const char *) mal_http_codec_field_value(head, field);
            host_len = field->value_length;
        }
        host_count++;
    }
    // Origin servers need one unambiguous authority. A duplicate Host is refused for
    // every version so a proxy and the application can never disagree about which
    // copy wins; 1.1 additionally requires the field. Only a missing 1.0 Host falls
    // back to "localhost", and the first (now: only) field is both what is validated
    // here and what mal_fetch_make_request composes the URL from. An absolute or
    // authority-form target is refused too: this adapter cannot normalize it.
    bool host_required = head->major_version > 1 || head->minor_version >= 1;
    const byte *target = mal_http_codec_head_target(head);
    if (host_count > 1
        || (host_count == 1 && !mal_fetch_host_valid(host, host_len))
        || (host_count == 0 && host_required)
        || head->target_length == 0 || target[0] != '/') {
        mal_http_conn_close_after_response(conn);
        mal_http_conn_respond(conn, 400, "Bad Request", nullptr, 0, "Bad Request", 11);
        return;
    }
    if (head->target_length > MAL_FETCH_TARGET_MAX
        || head->target_length + host_len + 7 > MAL_FETCH_URL_MAX) {
        mal_http_conn_close_after_response(conn);
        mal_http_conn_respond(conn, 414, "URI Too Long", nullptr, 0, "URI too long", 12);
        return;
    }
    // A declared length past the cap is refused before a single body byte is read;
    // an undeclared (chunked) body is bounded while it accumulates instead.
    if (head->content_length > (i64) MAL_FETCH_REQUEST_BODY_MAX) {
        mal_http_conn_close_after_response(conn);
        mal_http_conn_respond(
            conn, 413, "Content Too Large", nullptr, 0, "request body too large", 22);
        return;
    }

    MalFetchRequest *req = mal_fetch_request_new(vm, conn, head);
    if (req == nullptr) {
        mal_http_conn_close_after_response(conn);
        mal_http_conn_respond(conn, 500, "Internal Server Error", nullptr, 0,
            "request allocation failed", 25);
        return;
    }
    mal_http_conn_on_request_stream(
        conn, mal_fetch_request_data, mal_fetch_request_end, req);
    mal_http_conn_on_response_complete(conn, mal_fetch_response_complete, req);
    // Buffered semantics: consume the body as fast as the transport delivers it.
    // The per-turn read budget and the codec's body-event cap still apply; the total
    // is bounded by MAL_FETCH_REQUEST_BODY_MAX in mal_fetch_request_data.
    mal_http_conn_request_autoread(conn);
}

/* Read one transport limit from the options bag. Absent leaves the caller's value
 * (0) in place, which the transport reads as "use the secure default" — a limit is
 * never disabled, only retuned. Anything that is not an exact non-negative integer
 * is a configuration mistake and throws rather than silently degrading the bound. */
static bool mal_serve_limit(
    MalVm *vm, MalValue opts, const char *name, u32 *out) {
    MalValue value;
    if (!mal_vm_get_property(
            vm, opts, mal_intrinsic_string_key(vm, (const byte *) name), &value)
        || mal_value_is_undefined(value)) {
        return true;
    }
    f64 number = mal_ops_is_number(value) ? mal_ops_to_number(value) : (f64) NAN;
    if (!(number >= 0) || number > 2147483647.0 || floor(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Mal.serve limits must be integers from 0 through 2147483647");
        return false;
    }
    *out = (u32) number;
    return true;
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

    MalHttpServerLimits limits = {0};
    u32 max_connections = 0;
    if (!mal_serve_limit(vm, opts, "headersTimeout", &limits.headers_timeout_ms)
        || !mal_serve_limit(vm, opts, "requestTimeout", &limits.request_timeout_ms)
        || !mal_serve_limit(vm, opts, "keepAliveTimeout", &limits.keep_alive_timeout_ms)
        || !mal_serve_limit(vm, opts, "maxConnections", &max_connections)) {
        return mal_value_new_undefined();
    }
    limits.max_connections = max_connections;

    // Store the handler in a rooted intrinsic slot and install the transport hook.
    vm->intrinsics[MAL_INTRINSIC_FETCH_HANDLER] = fetch_val;

    MalHttpServer *server =
        mal_http_server_start_stream_handler(vm, host, port, mal_fetch_stream_handler, nullptr);
    if (server == nullptr) {
        return mal_value_new_undefined(); // The required exception remains unsupported.
    }
    // The reactor cannot accept before this JS turn yields, so the policy is in
    // force for every connection this server will ever see.
    if (!mal_http_server_configure_limits(server, &limits)) {
        mal_http_server_stop(server);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "Failed to configure Mal.serve limits");
        return mal_value_new_undefined();
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

    // Blob constructor + immutable byte-backed prototype surface.
    MalObject *blob_proto = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *blob_ctor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "Blob"), 0,
        mal_blob_constructor);
    mal_native_function_object_set_constructor(blob_ctor);
    vm->intrinsics[MAL_INTRINSIC_BLOB_CONSTRUCTOR] =
        mal_value_from_native_function_object(blob_ctor);
    vm->intrinsics[MAL_INTRINSIC_BLOB_PROTOTYPE] = mal_value_from_object(blob_proto);
    mal_intrinsic_define_data(vm, (MalObject *) blob_ctor, (const byte *) "prototype",
        vm->intrinsics[MAL_INTRINSIC_BLOB_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, blob_proto, (const byte *) "constructor",
        vm->intrinsics[MAL_INTRINSIC_BLOB_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_fetch_define_getter(vm, blob_proto, (const byte *) "size", mal_blob_get_size);
    mal_fetch_define_getter(vm, blob_proto, (const byte *) "type", mal_blob_get_type);
    mal_intrinsic_define_method_n(vm, blob_proto, (const byte *) "text", 0, mal_blob_text);
    mal_intrinsic_define_method_n(
        vm, blob_proto, (const byte *) "arrayBuffer", 0, mal_blob_array_buffer);
    mal_intrinsic_define_method_n(vm, blob_proto, (const byte *) "bytes", 0, mal_blob_bytes);
    mal_intrinsic_define_method_n(vm, blob_proto, (const byte *) "stream", 0, mal_blob_stream);
    MalPropertyDesc blob_tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "Blob")),
        MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(blob_proto,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &blob_tag_desc);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "Blob",
        vm->intrinsics[MAL_INTRINSIC_BLOB_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // FormData constructor, live iterators, and ordered entry operations.
    MalObject *form_data_iterator_proto = mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_FORM_DATA_ITERATOR_PROTOTYPE] =
        mal_value_from_object(form_data_iterator_proto);
    mal_intrinsic_define_method_n(vm, form_data_iterator_proto,
        (const byte *) "next", 0, mal_form_data_iterator_next);
    MalPropertyDesc form_data_iterator_tag = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(
            vm, (const byte *) "FormData Iterator")),
        MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(form_data_iterator_proto,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG),
        &form_data_iterator_tag);

    MalObject *form_data_proto = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *form_data_ctor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype,
        mal_intrinsic_ascii(vm, (const byte *) "FormData"), 0,
        mal_form_data_constructor);
    mal_native_function_object_set_constructor(form_data_ctor);
    vm->intrinsics[MAL_INTRINSIC_FORM_DATA_CONSTRUCTOR] =
        mal_value_from_native_function_object(form_data_ctor);
    vm->intrinsics[MAL_INTRINSIC_FORM_DATA_PROTOTYPE] =
        mal_value_from_object(form_data_proto);
    mal_intrinsic_define_data(vm, (MalObject *) form_data_ctor,
        (const byte *) "prototype", vm->intrinsics[MAL_INTRINSIC_FORM_DATA_PROTOTYPE],
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, form_data_proto, (const byte *) "constructor",
        vm->intrinsics[MAL_INTRINSIC_FORM_DATA_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalPropertyDesc form_data_tag = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "FormData")),
        MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(form_data_proto,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG),
        &form_data_tag);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "append", 2, mal_form_data_append);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "delete", 1, mal_form_data_delete);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "get", 1, mal_form_data_get);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "getAll", 1, mal_form_data_get_all);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "has", 1, mal_form_data_has);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "set", 2, mal_form_data_set);
    MalValue form_data_entries_fn = mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "entries", 0, mal_form_data_entries);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "keys", 0, mal_form_data_keys);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "values", 0, mal_form_data_values);
    mal_intrinsic_define_method_n(
        vm, form_data_proto, (const byte *) "forEach", 1, mal_form_data_for_each);
    MalPropertyDesc form_data_iterator_desc = mal_intrinsic_data_desc(
        form_data_entries_fn, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(form_data_proto,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR),
        &form_data_iterator_desc);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "FormData",
        vm->intrinsics[MAL_INTRINSIC_FORM_DATA_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

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
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "text", 0, mal_response_body_text);
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "json", 0, mal_response_body_json);
    mal_intrinsic_define_method_n(
        vm, resp_proto, (const byte *) "arrayBuffer", 0, mal_response_body_array_buffer);
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "bytes", 0, mal_response_body_bytes);
    mal_intrinsic_define_method_n(vm, resp_proto, (const byte *) "blob", 0, mal_response_body_blob);
    mal_intrinsic_define_method_n(
        vm, resp_proto, (const byte *) "formData", 0, mal_response_body_form_data);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "body", mal_response_body_get_body);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "bodyUsed", mal_response_body_get_used);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "status", mal_response_get_status);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "ok", mal_response_get_ok);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "statusText", mal_response_get_status_text);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "type", mal_response_get_type);
    mal_fetch_define_getter(vm, resp_proto, (const byte *) "url", mal_response_get_url);
    mal_fetch_define_getter(
        vm, resp_proto, (const byte *) "redirected", mal_response_get_redirected);
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
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "text", 0, mal_request_body_text);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "json", 0, mal_request_body_json);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "clone", 0, mal_request_clone);
    mal_intrinsic_define_method_n(
        vm, req_proto, (const byte *) "arrayBuffer", 0, mal_request_body_array_buffer);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "bytes", 0, mal_request_body_bytes);
    mal_intrinsic_define_method_n(vm, req_proto, (const byte *) "blob", 0, mal_request_body_blob);
    mal_intrinsic_define_method_n(
        vm, req_proto, (const byte *) "formData", 0, mal_request_body_form_data);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "body", mal_request_body_get_body);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "bodyUsed", mal_request_body_get_used);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "method", mal_request_get_method);
    mal_fetch_define_readonly_getter(vm, req_proto, (const byte *) "url", mal_request_get_url);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "headers", mal_request_get_headers);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "destination", mal_request_get_destination);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "referrer", mal_request_get_referrer);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "referrerPolicy", mal_request_get_referrer_policy);
    mal_fetch_define_readonly_getter(vm, req_proto, (const byte *) "mode", mal_request_get_mode);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "credentials", mal_request_get_credentials);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "cache", mal_request_get_cache);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "redirect", mal_request_get_redirect);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "integrity", mal_request_get_integrity);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "isReloadNavigation", mal_request_false_getter);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "isHistoryNavigation", mal_request_false_getter);
    mal_fetch_define_readonly_getter(
        vm, req_proto, (const byte *) "duplex", mal_request_get_duplex);

    // Headers (constructor + prototype; registers its own GC tracer/finalizer).
    mal_headers_install(vm, global_this);

    // Mal namespace + Mal.serve.
    MalObject *mal_ns = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_method_n(vm, mal_ns, (const byte *) "serve", 1, mal_serve);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "Mal",
        mal_value_from_object(mal_ns), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // GC hooks for Fetch-owned buffers and the traced Headers/body-stream fields.
    mal_gc_register_tracer(MAL_HEAP_RESPONSE_OBJECT, mal_response_trace);
    mal_gc_register_finalizer(MAL_HEAP_RESPONSE_OBJECT, mal_response_finalize);
    mal_gc_register_tracer(MAL_HEAP_REQUEST_OBJECT, mal_request_trace);
    mal_gc_register_finalizer(MAL_HEAP_REQUEST_OBJECT, mal_request_finalize);
    mal_gc_register_finalizer(MAL_HEAP_BLOB_OBJECT, mal_blob_finalize);
    mal_gc_register_tracer(MAL_HEAP_FORM_DATA_OBJECT, mal_form_data_trace);
    mal_gc_register_finalizer(MAL_HEAP_FORM_DATA_OBJECT, mal_form_data_finalize);
    mal_gc_register_tracer(
        MAL_HEAP_FORM_DATA_ITERATOR_OBJECT, mal_form_data_iterator_trace);
}
