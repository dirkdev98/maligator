#include "serialize.h"

#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "builtin_data_view.h"
#include "builtin_regexp.h"
#include "date_object.h"
#include "gc.h"
#include "gc_process.h"
#include "heap.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "key.h"
#include "map_object.h"
#include "object.h"
#include "object_ops.h"
#include "primitive_wrapper_object.h"
#include "property_iter.h"
#include "regexp_object.h"
#include "rooted_collection.h"
#include "secure_scrub.h"
#include "set_object.h"
#include "shared_memory.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

typedef enum {
    SER_UNDEFINED = 1,
    SER_NULL,
    SER_TRUE,
    SER_FALSE,
    SER_NUMBER,
    SER_STRING,
    SER_BIGINT,
    SER_BACKREF,
    SER_OBJECT,
    SER_ARRAY,
    SER_DATE,
    SER_ARRAY_BUFFER,
    SER_SHARED_ARRAY_BUFFER,
    SER_TYPED_ARRAY,
    SER_MAP,
    SER_SET,
    SER_HOST,
    SER_DATA_VIEW,
    SER_REGEXP,
    SER_ERROR,
    SER_BOXED,
} SerTag;

// Error prototypes a clone may name; anything else deserializes as Error.
static const struct {
    const char *name;
    MalIntrinsic prototype;
} ser_error_kinds[] = {
    {"Error", MAL_INTRINSIC_ERROR_PROTOTYPE},
    {"EvalError", MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE},
    {"RangeError", MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE},
    {"ReferenceError", MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE},
    {"SyntaxError", MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE},
    {"TypeError", MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE},
    {"URIError", MAL_INTRINSIC_URI_ERROR_PROTOTYPE},
};

typedef enum {
    SER_RESOURCE_BUFFER,
    SER_RESOURCE_SHARED,
    SER_RESOURCE_HOST,
} SerResourceKind;

typedef struct {
    SerResourceKind kind;
    bool sensitive;
    // Transferred buffers stay sender-owned (no bytes) until commit.
    bool transfer;
    bool resizable;
    byte *data;
    u32 length;
    u32 max_length;
    // Bytes owned at `data`: length for copies, the source allocation for
    // transfers (a resizable store reserves up to max_length or more). A
    // transfer records it at encode, while the sender still owns it; an
    // attached store's allocation never changes, so admission sees the final
    // size. Whenever `data` is non-null, this many bytes are charged to the
    // process budget (a transfer keeps the sender's charge).
    u32 capacity;
    MalSharedMemory *shared;
    MalSerializeHostDescriptor host;
} SerResource;

struct MalSerializedValue {
    byte *bytes;
    usize length;
    SerResource *resources;
    u32 resource_count;
    u32 object_count;
    bool committed;
    bool consumed;
    // Set by a failed commit, which dropped transfer_sources: the snapshot can
    // never commit, and validate keeps reporting this DataCloneError.
    const char *abort_error;
    // Sender-mutator-only until commit, which frees it on either outcome.
    // Callers keep the transfer list reachable between serialize and commit.
    MalArrayBufferObject **transfer_sources;
    u32 *transfer_resources;
    u32 transfer_count;
    // Process-budget charge for the snapshot's own allocations (record, byte
    // vector, resource and transfer tables); buffer payloads charge apart.
    usize native_charge;
    const MalSerializeHooks *hooks;
};

typedef struct {
    MalVm *vm;
    MalSerializedValue *snap;
    usize capacity;
    u32 resource_capacity;
    MalMapObject *memo;
    // Transfer list items read once before encoding: a getter may mutate the
    // caller's array, and every later lookup must match transfer_sources.
    MalRootedValueList transfers;
    const MalSerializeLimits *limits;
    const MalSerializeHooks *hooks;
    const char *error;
    u64 copied_bytes;
} SerEncoder;

static bool enc_fail(SerEncoder *enc, const char *message) {
    if (enc->error == nullptr) {
        enc->error = message;
    }
    return false;
}

static bool enc_reserve(SerEncoder *enc, usize extra) {
    MalSerializedValue *snap = enc->snap;
    if (enc->limits != nullptr && enc->limits->max_bytes != 0 &&
        snap->length + extra + enc->copied_bytes > enc->limits->max_bytes) {
        return enc_fail(enc, "structured clone exceeds the byte limit");
    }
    if (snap->length + extra <= enc->capacity) {
        return true;
    }
    usize capacity = enc->capacity == 0 ? 256 : enc->capacity;
    while (capacity < snap->length + extra) {
        capacity *= 2;
    }
    byte *bytes = realloc(snap->bytes, capacity);
    if (bytes == nullptr) {
        return enc_fail(enc, "out of memory while serializing");
    }
    snap->bytes = bytes;
    enc->capacity = capacity;
    return true;
}

static bool enc_put(SerEncoder *enc, const void *data, usize size) {
    if (!enc_reserve(enc, size)) {
        return false;
    }
    memcpy(enc->snap->bytes + enc->snap->length, data, size);
    enc->snap->length += size;
    return true;
}

static bool enc_u8(SerEncoder *enc, u8 value) {
    return enc_put(enc, &value, 1);
}

static bool enc_u32(SerEncoder *enc, u32 value) {
    return enc_put(enc, &value, sizeof value);
}

static SerResource *enc_resource(SerEncoder *enc, u32 *out_index) {
    MalSerializedValue *snap = enc->snap;
    if (snap->resource_count == enc->resource_capacity) {
        u32 capacity = enc->resource_capacity == 0 ? 4 : enc->resource_capacity * 2;
        SerResource *resources = realloc(snap->resources, capacity * sizeof(SerResource));
        if (resources == nullptr) {
            enc_fail(enc, "out of memory while serializing");
            return nullptr;
        }
        snap->resources = resources;
        enc->resource_capacity = capacity;
    }
    *out_index = snap->resource_count;
    SerResource *resource = &snap->resources[snap->resource_count++];
    memset(resource, 0, sizeof *resource);
    return resource;
}

// Assign the next record id; ids are implicit in encode order on both sides.
static bool enc_memoize(SerEncoder *enc, MalValue value) {
    MalSerializedValue *snap = enc->snap;
    if (enc->limits != nullptr && enc->limits->max_objects != 0 &&
        snap->object_count >= enc->limits->max_objects) {
        return enc_fail(enc, "structured clone exceeds the object limit");
    }
    mal_map_object_set(enc->memo, value, mal_value_from_u32(snap->object_count++));
    return true;
}

static bool enc_string(SerEncoder *enc, MalString *string) {
    usize length = mal_string_length(string);
    if (length > UINT32_MAX || !enc_u8(enc, SER_STRING) || !enc_u32(enc, (u32) length) ||
        !enc_reserve(enc, length * sizeof(c16))) {
        return enc_fail(enc, "string too large to serialize");
    }
    mal_string_copy_range_to(string, 0, length, (c16 *) (enc->snap->bytes + enc->snap->length));
    enc->snap->length += length * sizeof(c16);
    return true;
}

static i32 transfer_index_of(SerEncoder *enc, MalValue value) {
    for (usize i = 0; i < enc->transfers.count; i++) {
        if (enc->transfers.values[i] == value) {
            return (i32) i;
        }
    }
    return -1;
}

static bool enc_value(SerEncoder *enc, MalValue value);

static bool enc_array_buffer(SerEncoder *enc, MalValue value) {
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(value);
    u32 index;
    if (buffer->shared) {
        SerResource *resource = enc_resource(enc, &index);
        if (resource == nullptr) {
            return false;
        }
        resource->kind = SER_RESOURCE_SHARED;
        mal_shared_memory_retain(buffer->shared_memory);
        resource->shared = buffer->shared_memory;
        return enc_memoize(enc, value) && enc_u8(enc, SER_SHARED_ARRAY_BUFFER) && enc_u32(enc, index);
    }
    if (buffer->detached) {
        return enc_fail(enc, "a detached ArrayBuffer cannot be cloned");
    }
    i32 transfer = transfer_index_of(enc, value);
    SerResource *resource = enc_resource(enc, &index);
    if (resource == nullptr) {
        return false;
    }
    resource->kind = SER_RESOURCE_BUFFER;
    resource->sensitive = buffer->sensitive;
    resource->length = buffer->byte_length;
    resource->max_length = buffer->max_byte_length;
    resource->resizable = buffer->resizable;
    if (transfer >= 0) {
        resource->transfer = true;
        resource->capacity = buffer->allocation_capacity;
        enc->snap->transfer_resources[transfer] = index;
    } else if (buffer->byte_length > 0) {
        enc->copied_bytes += buffer->byte_length;
        if (enc->limits != nullptr && enc->limits->max_bytes != 0 &&
            enc->snap->length + enc->copied_bytes > enc->limits->max_bytes) {
            return enc_fail(enc, "structured clone exceeds the byte limit");
        }
        resource->data = malloc(buffer->byte_length);
        if (resource->data == nullptr) {
            return enc_fail(enc, "out of memory while serializing");
        }
        resource->capacity = buffer->byte_length;
        mal_gc_process_charge(resource->capacity);
        memcpy(resource->data, buffer->data, buffer->byte_length);
    }
    return enc_memoize(enc, value) && enc_u8(enc, SER_ARRAY_BUFFER) && enc_u32(enc, index);
}

static bool enc_typed_array(SerEncoder *enc, MalValue value) {
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    mal_array_buffer_object_refresh_shared_length(array->buffer);
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        return enc_fail(enc, "an out-of-bounds TypedArray cannot be cloned");
    }
    if (!enc_memoize(enc, value) || !enc_u8(enc, SER_TYPED_ARRAY) || !enc_u8(enc, (u8) array->kind) ||
        !enc_u32(enc, array->byte_offset) || !enc_u32(enc, mal_typed_array_object_length(array)) ||
        !enc_u8(enc, array->length_tracking ? 1 : 0)) {
        return false;
    }
    // The buffer is its own record so views sharing it stay aliased.
    return enc_value(enc, mal_value_from_array_buffer_object(array->buffer));
}

static bool enc_collection(SerEncoder *enc, MalValue value, bool is_set) {
    if (!enc_memoize(enc, value) || !enc_u8(enc, is_set ? SER_SET : SER_MAP)) {
        return false;
    }
    // Snapshot entries first: a getter reached while encoding a member may
    // mutate the collection.
    MalRootedValueList entries;
    mal_rooted_value_list_init(&entries);
    if (is_set) {
        MalValue key;
        MalSetIter iter;
        mal_set_iter_init(&iter, mal_value_to_set_object(value)->entries);
        while (mal_set_iter_next(&iter, &key)) {
            mal_rooted_value_list_append(&entries, key);
        }
    } else {
        MalValue key, mapped;
        MalMapIter iter;
        mal_map_iter_init(&iter, mal_value_to_map_object(value)->entries);
        while (mal_map_iter_next(&iter, &key, &mapped)) {
            mal_rooted_value_list_append(&entries, key);
            mal_rooted_value_list_append(&entries, mapped);
        }
    }
    bool ok = entries.count <= UINT32_MAX && enc_u32(enc, (u32) entries.count);
    for (usize i = 0; ok && i < entries.count; i++) {
        ok = enc_value(enc, entries.values[i]);
    }
    mal_rooted_value_list_dispose(&entries);
    return ok;
}

static bool enc_properties(SerEncoder *enc, MalValue value) {
    MalRootedValueList keys;
    mal_rooted_value_list_init(&keys);
    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_SYMBOL) {
            mal_rooted_value_list_append(&keys, key.value);
        }
    }
    // The count is patched afterwards: a getter may delete a later key, which
    // StructuredSerialize then skips (HasOwnProperty is rechecked per key).
    usize count_at = enc->snap->length;
    u32 written = 0;
    bool ok = keys.count <= UINT32_MAX && enc_u32(enc, 0);
    for (usize i = 0; ok && i < keys.count; i++) {
        MalKey key = mal_key_from_value(keys.values[i]);
        bool present = false;
        MalPropertyDesc own;
        if (!mal_vm_get_own_property(enc->vm, value, key, &present, &own)) {
            ok = false;
            break;
        }
        if (!present) {
            continue;
        }
        MalValue property = mal_value_new_undefined();
        if (!mal_vm_get_property(enc->vm, value, key, &property)) {
            ok = false;
            break;
        }
        // A getter's fresh result is reachable only from here until memoized.
        MalRootSpan span;
        mal_gc_root(&span, &property, 1);
        ok = enc_value(enc, keys.values[i]) && enc_value(enc, property);
        mal_gc_unroot(&span);
        written++;
    }
    if (ok) {
        memcpy(enc->snap->bytes + count_at, &written, sizeof written);
    }
    mal_rooted_value_list_dispose(&keys);
    return ok;
}

// Reads an own data property without running accessors; *out stays undefined
// when the property is absent or an accessor.
static bool enc_own_data(SerEncoder *enc, MalValue object, const char *name, bool *found, MalValue *out) {
    MalPropertyDesc own;
    *found = false;
    if (!mal_vm_get_own_property(enc->vm, object, mal_intrinsic_string_key(enc->vm, name), found, &own)) {
        return false;
    }
    *found = *found && (own.flags & MAL_PROPERTY_ACCESSOR) == 0;
    if (*found) {
        *out = own.value;
    }
    return true;
}

// HTML StructuredSerialize for Error: Get(name) mapped to a standard name (else
// "Error"; no ToString), the own data "message" ToString'd. As accompanying
// data (HTML allows it; V8 does the same) a string Get(stack) and an own data
// "cause", which is serialized as a value. Each field is read once and written
// immediately, so no getter result outlives its root.
static bool enc_error(SerEncoder *enc, MalValue value) {
    MalVm *vm = enc->vm;
    if (!enc_memoize(enc, value)) {
        return false;
    }
    MalValue field = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, &field, 1);
    bool ok = mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, "name"), &field);
    u8 kind = 0;
    if (ok && mal_value_is_string(field)) {
        for (u8 i = 0; i < sizeof ser_error_kinds / sizeof ser_error_kinds[0]; i++) {
            if (mal_string_equals_ascii(mal_value_to_string(field), ser_error_kinds[i].name)) {
                kind = i;
                break;
            }
        }
    }
    ok = ok && enc_u8(enc, SER_ERROR) && enc_u8(enc, kind);

    bool found = false;
    field = mal_value_new_undefined();
    ok = ok && enc_own_data(enc, value, "message", &found, &field);
    MalString *message = nullptr;
    ok = ok && (!found || mal_vm_to_string(vm, field, &message));
    ok = ok && enc_u8(enc, message != nullptr ? 1 : 0) && (message == nullptr || enc_string(enc, message));

    field = mal_value_new_undefined();
    ok = ok && mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, "stack"), &field);
    bool has_stack = ok && mal_value_is_string(field);
    ok = ok && enc_u8(enc, has_stack ? 1 : 0) && (!has_stack || enc_string(enc, mal_value_to_string(field)));

    field = mal_value_new_undefined();
    ok = ok && enc_own_data(enc, value, "cause", &found, &field);
    ok = ok && enc_u8(enc, found ? 1 : 0) && (!found || enc_value(enc, field));
    mal_gc_unroot(&span);
    return ok;
}

static bool enc_value(SerEncoder *enc, MalValue value) {
    MalVm *vm = enc->vm;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        return enc_u8(enc, SER_UNDEFINED);
    }
    if (mal_value_is_null(value)) {
        return enc_u8(enc, SER_NULL);
    }
    if (mal_value_is_boolean(value)) {
        return enc_u8(enc, mal_value_to_boolean(value) ? SER_TRUE : SER_FALSE);
    }
    if (mal_value_is_string(value)) {
        return enc_string(enc, mal_value_to_string(value));
    }
    if (mal_value_is_bigint(value)) {
        i128 big = mal_bigint_value(mal_value_to_bigint(value));
        return enc_u8(enc, SER_BIGINT) && enc_put(enc, &big, sizeof big);
    }
    if (mal_value_is_symbol(value)) {
        return enc_fail(enc, "a Symbol cannot be cloned");
    }
    if (!mal_value_is_object(value)) {
        f64 number = mal_ops_to_number(value);
        return enc_u8(enc, SER_NUMBER) && enc_put(enc, &number, sizeof number);
    }
    if (mal_map_object_has(enc->memo, value)) {
        f64 id = mal_ops_to_number(mal_map_object_get(enc->memo, value));
        return enc_u8(enc, SER_BACKREF) && enc_u32(enc, (u32) id);
    }
    if (enc->hooks != nullptr && enc->hooks->reject != nullptr && enc->hooks->reject(enc->hooks->data, vm, value)) {
        return vm->completion.kind != MAL_COMPLETION_THROW &&
            enc_fail(enc, "an object marked as uncloneable cannot be cloned");
    }
    if (mal_value_is_callable(value)) {
        return enc_fail(enc, "a function cannot be cloned");
    }
    if (mal_value_is_array_buffer_object(value)) {
        return enc_array_buffer(enc, value);
    }
    if (mal_value_is_typed_array_object(value)) {
        return enc_typed_array(enc, value);
    }
    if (mal_value_is_date_object(value)) {
        f64 time = mal_value_to_date_object(value)->date_value;
        return enc_memoize(enc, value) && enc_u8(enc, SER_DATE) && enc_put(enc, &time, sizeof time);
    }
    if (mal_value_is_map_object(value) || mal_value_is_set_object(value)) {
        return enc_collection(enc, value, mal_value_is_set_object(value));
    }
    if (mal_value_is_array_object(value)) {
        u32 length = mal_array_object_length(mal_value_to_array_object(value));
        return enc_memoize(enc, value) && enc_u8(enc, SER_ARRAY) && enc_u32(enc, length) &&
            enc_properties(enc, value);
    }
    if (mal_value_is_data_view_object(value)) {
        MalDataViewObject *view = mal_value_to_data_view_object(value);
        if (mal_data_view_object_is_out_of_bounds(view)) {
            return enc_fail(enc, "an out-of-bounds DataView cannot be cloned");
        }
        bool tracking = mal_data_view_object_length_tracking(view);
        if (!enc_memoize(enc, value) || !enc_u8(enc, SER_DATA_VIEW) ||
            !enc_u32(enc, mal_data_view_object_byte_offset(view)) ||
            !enc_u32(enc, mal_data_view_object_byte_length(view)) ||
            !enc_u8(enc, tracking ? 1 : 0)) {
            return false;
        }
        return enc_value(enc, mal_value_from_array_buffer_object(mal_data_view_object_buffer(view)));
    }
    if (mal_value_is_regexp_object(value)) {
        MalRegExpObject *regexp = mal_value_to_regexp_object(value);
        return enc_memoize(enc, value) && enc_u8(enc, SER_REGEXP) &&
            enc_string(enc, regexp->source) && enc_string(enc, regexp->flags);
    }
    if (mal_value_is_primitive_wrapper(value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_SYMBOL) {
            return enc_fail(enc, "a Symbol object cannot be cloned");
        }
        return enc_memoize(enc, value) && enc_u8(enc, SER_BOXED) &&
            enc_value(enc, wrapper->primitive_data);
    }
    if (mal_value_heap_type(value) == MAL_HEAP_OBJECT && mal_value_to_object(value)->has_error_data) {
        return enc_error(enc, value);
    }
    if (enc->hooks != nullptr && enc->hooks->encode != nullptr) {
        MalSerializeHostDescriptor descriptor = {0};
        i32 transfer_index = transfer_index_of(enc, value);
        bool transfer = transfer_index >= 0;
        if (enc->hooks->encode(enc->hooks->data, vm, value, transfer, &descriptor)) {
            u32 index;
            SerResource *resource = enc_resource(enc, &index);
            if (resource == nullptr) {
                if (enc->hooks->release != nullptr) {
                    enc->hooks->release(&descriptor);
                }
                return false;
            }
            resource->kind = SER_RESOURCE_HOST;
            resource->transfer = transfer;
            resource->host = descriptor;
            if (transfer) {
                enc->snap->transfer_resources[transfer_index] = index;
            }
            return enc_memoize(enc, value) && enc_u8(enc, SER_HOST) && enc_u32(enc, index);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
    }
    // Plain objects only: proxies, RegExp, Error, DataView, weak collections
    // and other exotic/host objects are rejected rather than flattened.
    if (mal_value_heap_type(value) == MAL_HEAP_OBJECT) {
        return enc_memoize(enc, value) && enc_u8(enc, SER_OBJECT) && enc_properties(enc, value);
    }
    return enc_fail(enc, "value cannot be cloned");
}

static bool enc_validate_transfers(SerEncoder *enc, MalValue list_value) {
    if (mal_value_is_undefined(list_value)) {
        return true;
    }
    if (!mal_value_is_array_object(list_value)) {
        return enc_fail(enc, "transfer list must be an array");
    }
    MalArrayObject *list = mal_value_to_array_object(list_value);
    u32 length = mal_array_object_length(list);
    MalSerializedValue *snap = enc->snap;
    snap->transfer_sources = calloc(length == 0 ? 1 : length, sizeof(MalArrayBufferObject *));
    snap->transfer_resources = calloc(length == 0 ? 1 : length, sizeof(u32));
    if (snap->transfer_sources == nullptr || snap->transfer_resources == nullptr) {
        return enc_fail(enc, "out of memory while serializing");
    }
    for (u32 i = 0; i < length; i++) {
        MalValue item;
        if (!mal_array_object_dense_get(list, i, &item)) {
            return enc_fail(enc, "transfer list item is not transferable");
        }
        if (transfer_index_of(enc, item) >= 0) {
            return enc_fail(enc, "duplicate transferable");
        }
        mal_rooted_value_list_append(&enc->transfers, item);
        snap->transfer_resources[i] = UINT32_MAX;
        if (mal_value_is_array_buffer_object(item)) {
            MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(item);
            if (buffer->detached || buffer->shared || buffer->immutable) {
                return enc_fail(enc, "ArrayBuffer cannot be transferred");
            }
            snap->transfer_sources[i] = buffer;
        } else if (enc->hooks == nullptr || enc->hooks->encode == nullptr) {
            return enc_fail(enc, "transfer list item is not transferable");
        }
    }
    snap->transfer_count = length;
    return true;
}

// Transfer tables are allocated with at least one slot.
static usize ser_transfer_slots(const MalSerializedValue *snap) {
    return snap->transfer_count == 0 ? 1 : snap->transfer_count;
}

static usize ser_transfer_sources_bytes(const MalSerializedValue *snap) {
    return snap->transfer_sources == nullptr ? 0 : ser_transfer_slots(snap) * sizeof(MalArrayBufferObject *);
}

// Commit drops the sender heap pointers on either outcome, before the snapshot
// can leave the sender mutator.
static void ser_drop_transfer_sources(MalSerializedValue *snap) {
    usize bytes = ser_transfer_sources_bytes(snap);
    free(snap->transfer_sources);
    snap->transfer_sources = nullptr;
    mal_gc_process_release(bytes);
    snap->native_charge -= bytes;
}

MalSerializedValue *mal_serialize(
    MalVm *vm, MalValue value, MalValue transfer_list,
    const MalSerializeLimits *limits, const MalSerializeHooks *hooks,
    const char **out_error) {
    *out_error = nullptr;
    MalSerializedValue *snap = calloc(1, sizeof(MalSerializedValue));
    if (snap == nullptr) {
        *out_error = "out of memory while serializing";
        return nullptr;
    }
    snap->hooks = hooks;
    MalValue memo = mal_value_from_map_object(mal_map_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE])));
    MalValue roots[3] = {value, transfer_list, memo};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    SerEncoder enc = {
        .vm = vm,
        .snap = snap,
        .memo = mal_value_to_map_object(memo),
        .limits = limits,
        .hooks = hooks,
    };
    mal_rooted_value_list_init(&enc.transfers);
    bool ok = enc_validate_transfers(&enc, transfer_list) && enc_value(&enc, value);
    // Every ArrayBuffer listed for transfer must appear in the graph so commit
    // can detach exactly the buffers the receiver will own.
    for (u32 i = 0; ok && i < snap->transfer_count; i++) {
        if (snap->transfer_resources[i] != UINT32_MAX) {
            continue;
        }
        if (snap->transfer_sources[i] != nullptr) {
            SerResource *resource = enc_resource(&enc, &snap->transfer_resources[i]);
            ok = resource != nullptr;
            if (ok) {
                resource->kind = SER_RESOURCE_BUFFER;
                resource->transfer = true;
                resource->sensitive = snap->transfer_sources[i]->sensitive;
                resource->length = snap->transfer_sources[i]->byte_length;
                resource->max_length = snap->transfer_sources[i]->max_byte_length;
                resource->resizable = snap->transfer_sources[i]->resizable;
                resource->capacity = snap->transfer_sources[i]->allocation_capacity;
            }
            continue;
        }
        // Host transferables listed but unreachable from the value (a Node
        // MessagePort reply port) still move with the message.
        MalValue item = enc.transfers.values[i];
        if (hooks->reject != nullptr && hooks->reject(hooks->data, vm, item)) {
            ok = vm->completion.kind != MAL_COMPLETION_THROW &&
                enc_fail(&enc, "an object marked as uncloneable cannot be transferred");
            break;
        }
        MalSerializeHostDescriptor descriptor = {0};
        if (!hooks->encode(hooks->data, vm, item, true, &descriptor)) {
            ok = vm->completion.kind != MAL_COMPLETION_THROW &&
                enc_fail(&enc, "transfer list item is not transferable");
            break;
        }
        u32 index;
        SerResource *resource = enc_resource(&enc, &index);
        if (resource == nullptr) {
            if (hooks->release != nullptr) {
                hooks->release(&descriptor);
            }
            ok = false;
            break;
        }
        resource->kind = SER_RESOURCE_HOST;
        resource->transfer = true;
        resource->host = descriptor;
        snap->transfer_resources[i] = index;
    }
    mal_rooted_value_list_dispose(&enc.transfers);
    mal_gc_unroot(&span);
    // Getters have all run; reject a transferable they detached, closed or
    // re-transferred before the caller admits or commits anything.
    if (ok && !mal_serialized_value_validate(vm, snap, &enc.error)) {
        ok = false;
    }
    if (!ok) {
        *out_error = vm->completion.kind == MAL_COMPLETION_THROW ? nullptr : enc.error;
        mal_serialized_value_release(snap);
        return nullptr;
    }
    snap->native_charge = sizeof *snap + enc.capacity +
        (usize) enc.resource_capacity * sizeof(SerResource) + ser_transfer_sources_bytes(snap) +
        (snap->transfer_resources == nullptr ? 0 : ser_transfer_slots(snap) * sizeof(u32));
    mal_gc_process_charge(snap->native_charge);
    return snap;
}

bool mal_serialized_value_validate(MalVm *vm, const MalSerializedValue *snap, const char **out_error) {
    *out_error = nullptr;
    if (snap->committed) {
        return true;
    }
    if (snap->abort_error != nullptr) {
        *out_error = snap->abort_error;
        return false;
    }
    for (u32 i = 0; i < snap->transfer_count; i++) {
        MalArrayBufferObject *source = snap->transfer_sources[i];
        if (source == nullptr) {
            continue;
        }
        // Admission sized the message by the allocation recorded at encode;
        // an attached ordinary store keeps it, so a mismatch is a defect.
        u32 index = snap->transfer_resources[i];
        if (source->detached || source->immutable || index == UINT32_MAX ||
            snap->resources[index].capacity != source->allocation_capacity) {
            *out_error = "a transferred ArrayBuffer was detached during serialization";
            return false;
        }
    }
    const MalSerializeHooks *hooks = snap->hooks;
    if (hooks == nullptr || hooks->validate == nullptr) {
        return true;
    }
    for (u32 i = 0; i < snap->resource_count; i++) {
        const SerResource *resource = &snap->resources[i];
        if (resource->kind == SER_RESOURCE_HOST && resource->transfer &&
            !hooks->validate(hooks->data, vm, &resource->host)) {
            *out_error = "a transferred object was closed or transferred during serialization";
            return false;
        }
    }
    return true;
}

bool mal_serialize_commit(MalVm *vm, MalSerializedValue *snap) {
    if (snap->committed) {
        return true;
    }
    const char *error;
    if (!mal_serialized_value_validate(vm, snap, &error)) {
        if (snap->abort_error == nullptr) {
            snap->abort_error = error;
            ser_drop_transfer_sources(snap);
        }
        return false;
    }
    for (u32 i = 0; i < snap->transfer_count; i++) {
        MalArrayBufferObject *source = snap->transfer_sources[i];
        u32 index = snap->transfer_resources[i];
        if (source == nullptr || index == UINT32_MAX) {
            continue;
        }
        SerResource *resource = &snap->resources[index];
        // Steal the allocation together with its process charge; the sender
        // wrapper keeps no path to it and releases nothing. A getter may have
        // resized the source since encode, so take its current length; the
        // receiver views were encoded against the resizable/max metadata, and
        // validate proved the capacity unchanged.
        resource->data = source->data;
        resource->length = source->byte_length;
        resource->sensitive = source->sensitive;
        source->data = nullptr;
        source->allocation_capacity = 0;
        source->sensitive = false;
        mal_array_buffer_object_detach(source);
    }
    for (u32 i = 0; i < snap->resource_count; i++) {
        SerResource *resource = &snap->resources[i];
        if (resource->kind == SER_RESOURCE_HOST && resource->transfer &&
            snap->hooks != nullptr && snap->hooks->commit != nullptr) {
            snap->hooks->commit(snap->hooks->data, vm, mal_value_new_undefined(), &resource->host);
        }
    }
    // transfer_resources stays for the receiver's transferred-host lookup.
    ser_drop_transfer_sources(snap);
    snap->committed = true;
    return true;
}

u32 mal_serialized_value_transfer_count(const MalSerializedValue *snap) {
    return snap->transfer_count;
}

const MalSerializeHostDescriptor *mal_serialized_value_transferred_host(
    const MalSerializedValue *snap, u32 transfer_index) {
    if (transfer_index >= snap->transfer_count) {
        return nullptr;
    }
    u32 index = snap->transfer_resources[transfer_index];
    if (index == UINT32_MAX || snap->resources[index].kind != SER_RESOURCE_HOST) {
        return nullptr;
    }
    return &snap->resources[index].host;
}

static u64 ser_add_saturating(u64 total, u64 extra) {
    u64 sum;
    return __builtin_add_overflow(total, extra, &sum) ? UINT64_MAX : sum;
}

u64 mal_serialized_value_size(const MalSerializedValue *snap) {
    if (snap == nullptr) {
        return 0;
    }
    u64 total = sizeof *snap;
    total = ser_add_saturating(total, snap->length);
    total = ser_add_saturating(total, (u64) snap->resource_count * sizeof(SerResource));
    total = ser_add_saturating(total, (u64) snap->transfer_count * (sizeof(u32) + sizeof(void *)));
    for (u32 i = 0; i < snap->resource_count; i++) {
        const SerResource *resource = &snap->resources[i];
        // Copied and transferred buffers are owned by the message; shared
        // memory is already accounted by the process shared-memory cap. A
        // transfer's capacity is its source allocation from encode, so the
        // size is the same before and after commit even if a getter resized
        // the source.
        if (resource->kind == SER_RESOURCE_BUFFER) {
            total = ser_add_saturating(total, resource->capacity > resource->length ? resource->capacity : resource->length);
        }
    }
    return total;
}

typedef struct {
    MalVm *vm;
    MalSerializedValue *snap;
    usize cursor;
    MalValue *table; // rooted object records by id
    u32 next_id;
    const MalSerializeHooks *hooks;
    bool take;
} SerDecoder;

static bool dec_get(SerDecoder *dec, void *out, usize size) {
    if (dec->cursor + size > dec->snap->length) {
        return false;
    }
    memcpy(out, dec->snap->bytes + dec->cursor, size);
    dec->cursor += size;
    return true;
}

static bool dec_u32(SerDecoder *dec, u32 *out) {
    return dec_get(dec, out, sizeof *out);
}

static void dec_record(SerDecoder *dec, MalValue value) {
    // The encoder counted every record; a mismatch would be a codec bug.
    if (dec->next_id >= dec->snap->object_count) {
        abort();
    }
    dec->table[dec->next_id++] = value;
}

static bool dec_value(SerDecoder *dec, MalValue *out);

static bool dec_properties(SerDecoder *dec, MalObject *object) {
    u32 count;
    if (!dec_u32(dec, &count)) {
        return false;
    }
    for (u32 i = 0; i < count; i++) {
        MalValue pair[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, pair, 2);
        bool ok = dec_value(dec, &pair[0]) && dec_value(dec, &pair[1]);
        if (ok) {
            // CreateDataProperty: inherited setters and __proto__ never run.
            MalPropertyDesc desc = {
                .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
                .value = pair[1],
                .getter = mal_value_new_undefined(),
                .setter = mal_value_new_undefined(),
            };
            (void) mal_object_define_own(object, mal_key_from_value(pair[0]), &desc);
        }
        mal_gc_unroot(&span);
        if (!ok) {
            return false;
        }
    }
    return true;
}

static MalArrayBufferObject *dec_buffer(SerDecoder *dec, SerResource *resource) {
    MalVm *vm = dec->vm;
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    // Resizable buffers keep resizable/maxByteLength (HTML [[ArrayBufferMaxByteLength]]).
    u32 max_length = resource->resizable ? resource->max_length : resource->length;
    if (max_length < resource->length || (resource->transfer && max_length > resource->capacity)) {
        return nullptr;
    }
    if (resource->length > resource->capacity ||
        (resource->capacity > 0 && resource->data == nullptr)) {
        return nullptr;
    }
    if (dec->take && max_length <= resource->capacity) {
        // The backing already carries its process charge; only the empty wrapper is new.
        MalArrayBufferObject *buffer = mal_array_buffer_object_new_uninitialized(
            &vm->heap, prototype, 0, 0, false, false);
        buffer->data = resource->data;
        buffer->byte_length = resource->length;
        buffer->max_byte_length = max_length;
        buffer->allocation_capacity = resource->capacity;
        buffer->resizable = resource->resizable;
        buffer->sensitive = resource->sensitive;
        resource->data = nullptr;
        return buffer;
    }
    MalArrayBufferObject *buffer = mal_array_buffer_object_new_uninitialized(
        &vm->heap, prototype, resource->length, max_length, resource->resizable, false);
    if (max_length > 0 && buffer->data == nullptr) {
        return nullptr;
    }
    if (resource->length > 0) {
        memcpy(buffer->data, resource->data, resource->length);
    }
    buffer->sensitive = resource->sensitive;
    return buffer;
}

static bool dec_value(SerDecoder *dec, MalValue *out) {
    MalVm *vm = dec->vm;
    u8 tag;
    if (!dec_get(dec, &tag, 1)) {
        return false;
    }
    switch ((SerTag) tag) {
    case SER_UNDEFINED:
        *out = mal_value_new_undefined();
        return true;
    case SER_NULL:
        *out = mal_value_new_null();
        return true;
    case SER_TRUE:
    case SER_FALSE:
        *out = mal_value_new_boolean(tag == SER_TRUE);
        return true;
    case SER_NUMBER: {
        f64 number;
        if (!dec_get(dec, &number, sizeof number)) {
            return false;
        }
        *out = mal_ops_number_value(number);
        return true;
    }
    case SER_STRING: {
        u32 length;
        if (!dec_u32(dec, &length) || dec->cursor + (usize) length * sizeof(c16) > dec->snap->length) {
            return false;
        }
        *out = mal_value_from_string(mal_string_new_copy(
            &vm->heap, (const c16 *) (dec->snap->bytes + dec->cursor), length));
        dec->cursor += (usize) length * sizeof(c16);
        return true;
    }
    case SER_BIGINT: {
        i128 big;
        if (!dec_get(dec, &big, sizeof big)) {
            return false;
        }
        *out = mal_value_from_bigint(mal_bigint_new(&vm->heap, big));
        return true;
    }
    case SER_BACKREF: {
        u32 id;
        if (!dec_u32(dec, &id) || id >= dec->next_id) {
            return false;
        }
        *out = dec->table[id];
        return true;
    }
    case SER_OBJECT: {
        MalObject *object = mal_intrinsic_new_object(vm);
        *out = mal_value_from_object(object);
        dec_record(dec, *out);
        return dec_properties(dec, object);
    }
    case SER_ARRAY: {
        u32 length;
        if (!dec_u32(dec, &length)) {
            return false;
        }
        *out = mal_value_from_array_object(mal_intrinsic_new_array(vm, length));
        dec_record(dec, *out);
        return dec_properties(dec, mal_value_to_object(*out));
    }
    case SER_DATE: {
        f64 time;
        if (!dec_get(dec, &time, sizeof time)) {
            return false;
        }
        MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE]);
        *out = mal_value_from_date_object(mal_date_object_new(&vm->heap, prototype, time));
        dec_record(dec, *out);
        return true;
    }
    case SER_ARRAY_BUFFER:
    case SER_SHARED_ARRAY_BUFFER: {
        u32 index;
        if (!dec_u32(dec, &index) || index >= dec->snap->resource_count) {
            return false;
        }
        SerResource *resource = &dec->snap->resources[index];
        MalArrayBufferObject *buffer;
        if (tag == SER_SHARED_ARRAY_BUFFER) {
            buffer = mal_array_buffer_object_wrap_shared(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE]),
                resource->shared);
        } else {
            buffer = dec_buffer(dec, resource);
            if (buffer == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return false;
            }
        }
        *out = mal_value_from_array_buffer_object(buffer);
        dec_record(dec, *out);
        return true;
    }
    case SER_TYPED_ARRAY: {
        u8 kind;
        u32 byte_offset;
        u32 length;
        u8 tracking;
        if (!dec_get(dec, &kind, 1) || !dec_u32(dec, &byte_offset) || !dec_u32(dec, &length) ||
            !dec_get(dec, &tracking, 1) || kind >= MAL_TA_KIND_COUNT) {
            return false;
        }
        // Reserve the view's id before its buffer record, matching encode order.
        u32 id = dec->next_id++;
        MalValue buffer_value = mal_value_new_undefined();
        MalRootSpan span;
        mal_gc_root(&span, &buffer_value, 1);
        bool ok = dec_value(dec, &buffer_value) && mal_value_is_array_buffer_object(buffer_value);
        if (ok) {
            // A view over a resizable or growable buffer may legitimately be
            // out of bounds (a getter shrank it after the view was encoded);
            // the runtime bounds-checks those. A fixed-length buffer cannot
            // change length, so an out-of-range view there is a codec defect.
            MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(buffer_value);
            u64 end = (u64) byte_offset +
                (tracking != 0 ? 0 : (u64) length * mal_typed_array_element_size((MalTypedArrayKind) kind));
            ok = buffer->resizable || buffer->shared || end <= mal_array_buffer_object_byte_length(buffer);
        }
        if (ok) {
            MalObject *prototype = mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind]);
            *out = mal_value_from_typed_array_object(mal_typed_array_object_new(
                &vm->heap, prototype, mal_value_to_array_buffer_object(buffer_value),
                (MalTypedArrayKind) kind, byte_offset, length, tracking != 0));
            dec->table[id] = *out;
        }
        mal_gc_unroot(&span);
        return ok;
    }
    case SER_MAP:
    case SER_SET: {
        bool is_set = tag == SER_SET;
        MalObject *prototype = mal_value_to_object(
            vm->intrinsics[is_set ? MAL_INTRINSIC_SET_PROTOTYPE : MAL_INTRINSIC_MAP_PROTOTYPE]);
        *out = is_set ? mal_value_from_set_object(mal_set_object_new(&vm->heap, prototype))
                      : mal_value_from_map_object(mal_map_object_new(&vm->heap, prototype));
        dec_record(dec, *out);
        u32 count;
        if (!dec_u32(dec, &count)) {
            return false;
        }
        usize stride = is_set ? 1 : 2;
        for (u32 i = 0; i < count; i += (u32) stride) {
            MalValue pair[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
            MalRootSpan span;
            mal_gc_root(&span, pair, 2);
            bool ok = dec_value(dec, &pair[0]) && (is_set || dec_value(dec, &pair[1]));
            if (ok && is_set) {
                mal_set_object_add(mal_value_to_set_object(*out), pair[0]);
            } else if (ok) {
                mal_map_object_set(mal_value_to_map_object(*out), pair[0], pair[1]);
            }
            mal_gc_unroot(&span);
            if (!ok) {
                return false;
            }
        }
        return true;
    }
    case SER_DATA_VIEW: {
        u32 byte_offset;
        u32 byte_length;
        u8 tracking;
        if (!dec_u32(dec, &byte_offset) || !dec_u32(dec, &byte_length) || !dec_get(dec, &tracking, 1)) {
            return false;
        }
        u32 id = dec->next_id++;
        MalValue buffer_value = mal_value_new_undefined();
        MalRootSpan span;
        mal_gc_root(&span, &buffer_value, 1);
        bool ok = dec_value(dec, &buffer_value) && mal_value_is_array_buffer_object(buffer_value);
        if (ok) {
            MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(buffer_value);
            u32 available = mal_array_buffer_object_byte_length(buffer);
            ok = buffer->resizable || buffer->shared ||
                (byte_offset <= available && (tracking != 0 || (u64) byte_offset + byte_length <= available));
        }
        if (ok) {
            MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_PROTOTYPE]);
            *out = mal_value_from_data_view_object(mal_data_view_object_new(
                &vm->heap, prototype, mal_value_to_array_buffer_object(buffer_value),
                byte_offset, byte_length, tracking != 0));
            dec->table[id] = *out;
        }
        mal_gc_unroot(&span);
        return ok;
    }
    case SER_REGEXP: {
#if MAL_REGEXP
        MalValue strings[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, strings, 2);
        bool ok = dec_value(dec, &strings[0]) && dec_value(dec, &strings[1]) &&
            mal_value_is_string(strings[0]) && mal_value_is_string(strings[1]);
        if (ok) {
            *out = mal_regexp_create(vm, mal_value_to_string(strings[0]), mal_value_to_string(strings[1]));
            ok = vm->completion.kind != MAL_COMPLETION_THROW;
        }
        mal_gc_unroot(&span);
        if (ok) {
            dec_record(dec, *out);
        }
        return ok;
#else
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp cloning is disabled by this build");
        return false;
#endif
    }
    case SER_ERROR: {
        u8 kind;
        if (!dec_get(dec, &kind, 1) || kind >= sizeof ser_error_kinds / sizeof ser_error_kinds[0]) {
            return false;
        }
        MalObject *error = mal_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[ser_error_kinds[kind].prototype]));
        error->has_error_data = true;
        *out = mal_value_from_object(error);
        dec_record(dec, *out);
        // message and stack (strings), then cause (any value); each is a
        // non-enumerable own data property like the constructor installs.
        static const char *const fields[] = {"message", "stack", "cause"};
        MalValue field = mal_value_new_undefined();
        MalRootSpan span;
        mal_gc_root(&span, &field, 1);
        bool ok = true;
        for (usize i = 0; ok && i < sizeof fields / sizeof fields[0]; i++) {
            u8 present;
            ok = dec_get(dec, &present, 1);
            if (!ok || present == 0) {
                continue;
            }
            ok = dec_value(dec, &field) && (i == 2 || mal_value_is_string(field));
            if (ok) {
                mal_intrinsic_define_data(vm, error, fields[i], field,
                    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
            }
        }
        mal_gc_unroot(&span);
        return ok;
    }
    case SER_BOXED: {
        // The payload is a primitive, so no record id is consumed before ours.
        MalValue primitive = mal_value_new_undefined();
        MalRootSpan span;
        mal_gc_root(&span, &primitive, 1);
        bool ok = dec_value(dec, &primitive);
        MalPrimitiveWrapperKind kind = MAL_PRIMITIVE_WRAPPER_NUMBER;
        MalIntrinsic prototype = MAL_INTRINSIC_NUMBER_PROTOTYPE;
        if (ok && mal_value_is_string(primitive)) {
            kind = MAL_PRIMITIVE_WRAPPER_STRING;
            prototype = MAL_INTRINSIC_STRING_PROTOTYPE;
        } else if (ok && mal_value_is_boolean(primitive)) {
            kind = MAL_PRIMITIVE_WRAPPER_BOOLEAN;
            prototype = MAL_INTRINSIC_BOOLEAN_PROTOTYPE;
        } else if (ok && mal_value_is_bigint(primitive)) {
            kind = MAL_PRIMITIVE_WRAPPER_BIGINT;
            prototype = MAL_INTRINSIC_BIGINT_PROTOTYPE;
        } else if (ok && !mal_ops_is_number(primitive)) {
            ok = false;
        }
        if (ok) {
            *out = mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
                &vm->heap, mal_value_to_object(vm->intrinsics[prototype]), kind, primitive));
            dec_record(dec, *out);
        }
        mal_gc_unroot(&span);
        return ok;
    }
    case SER_HOST: {
        u32 index;
        if (!dec_u32(dec, &index) || index >= dec->snap->resource_count ||
            dec->hooks == nullptr || dec->hooks->decode == nullptr) {
            return false;
        }
        if (!dec->hooks->decode(dec->hooks->data, vm, &dec->snap->resources[index].host, out)) {
            return false;
        }
        dec_record(dec, *out);
        return true;
    }
    }
    return false;
}

static bool deserialize(
    MalVm *vm, MalSerializedValue *snap, const MalSerializeHooks *hooks, MalValue *out, bool take) {
    *out = mal_value_new_undefined();
    if (snap->consumed) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "structured clone was already consumed");
        return false;
    }
    if (!snap->committed && snap->transfer_count > 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "structured clone was not committed");
        return false;
    }
    if (take) snap->consumed = true;
    u32 slots = snap->object_count == 0 ? 1 : snap->object_count;
    MalValue *table = calloc(slots, sizeof(MalValue));
    if (table == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (u32 i = 0; i < slots; i++) {
        table[i] = mal_value_new_undefined();
    }
    MalRootSpan table_span;
    mal_gc_root(&table_span, table, (i32) slots);
    MalRootSpan out_span;
    mal_gc_root(&out_span, out, 1);
    SerDecoder dec = {.vm = vm, .snap = snap, .table = table, .hooks = hooks, .take = take};
    bool ok = dec_value(&dec, out);
    mal_gc_unroot(&out_span);
    mal_gc_unroot(&table_span);
    free(table);
    if (!ok && vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "malformed structured clone");
    }
    return ok;
}

bool mal_deserialize(
    MalVm *vm, MalSerializedValue *snap, const MalSerializeHooks *hooks, MalValue *out) {
    return deserialize(vm, snap, hooks, out, false);
}

bool mal_deserialize_take(
    MalVm *vm, MalSerializedValue *snap, const MalSerializeHooks *hooks, MalValue *out) {
    return deserialize(vm, snap, hooks, out, true);
}

void mal_serialized_value_release(MalSerializedValue *snap) {
    if (snap == nullptr) {
        return;
    }
    for (u32 i = 0; i < snap->resource_count; i++) {
        SerResource *resource = &snap->resources[i];
        switch (resource->kind) {
        case SER_RESOURCE_BUFFER:
            if (resource->data != nullptr) {
                if (resource->sensitive) {
                    mal_secure_scrub(resource->data, resource->capacity);
                }
                free(resource->data);
                mal_gc_process_release(resource->capacity);
            }
            break;
        case SER_RESOURCE_SHARED:
            mal_shared_memory_release(resource->shared);
            break;
        case SER_RESOURCE_HOST:
            if (snap->hooks != nullptr && snap->hooks->release != nullptr) {
                snap->hooks->release(&resource->host);
            }
            break;
        }
    }
    free(snap->resources);
    free(snap->transfer_sources);
    free(snap->transfer_resources);
    free(snap->bytes);
    mal_gc_process_release(snap->native_charge);
    free(snap);
}
