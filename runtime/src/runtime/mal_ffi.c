#include "../ffi/mal_ffi.h"

#include <limits.h>
#include <stdatomic.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_bigint.h"
#include "heap.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "shape.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static_assert(sizeof(MalFfiRoots) == sizeof(MalRootSpan));
static_assert(offsetof(MalFfiRoots, slots) == offsetof(MalRootSpan, slots));
static_assert(offsetof(MalFfiRoots, count) == offsetof(MalRootSpan, count));
static_assert(MAL_FFI_VALUE_TAG_BASE == MAL_VALUE_TAG_BASE);
static_assert(MAL_FFI_VALUE_CLASS_MASK == MAL_VALUE_CLASS_MASK);
static_assert(MAL_FFI_VALUE_INT32 == MAL_VALUE_INT32);
static_assert(MAL_FFI_VALUE_NULL == MAL_VALUE_NULL);
static_assert(MAL_FFI_VALUE_UNDEFINED == MAL_VALUE_UNDEFINED);
static_assert(MAL_FFI_VALUE_TRUE == MAL_VALUE_TRUE);
static_assert(MAL_FFI_VALUE_FALSE == MAL_VALUE_FALSE);
static_assert(MAL_FFI_VALUE_NAN == MAL_VALUE_NAN);

static bool ffi_fail(
    MalVm *vm, MalIntrinsic prototype, const MalFfiSite *site, const char *expectation) {
    char message[512];
    if (site->field == nullptr) {
        snprintf(
            message, sizeof(message), "%s: %s expects %s", site->function, site->parameter,
            expectation);
    } else {
        snprintf(
            message, sizeof(message), "%s: %s.%s expects %s", site->function, site->parameter,
            site->field, expectation);
    }
    mal_vm_throw_error(vm, prototype, (const byte *) message);
    return false;
}

bool mal_ffi_expected(MalVm *vm, const MalFfiSite *site, const char *expectation) {
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
}

bool mal_ffi_number_to_integer(
    MalVm *vm, MalValue value, int32_t bits, bool is_signed, const MalFfiSite *site, int64_t *out) {
    if (!mal_ops_is_number(value)) return mal_ffi_expected(vm, site, "a number");
    i64 minimum = is_signed ? -(INT64_C(1) << (bits - 1)) : 0;
    i64 maximum = is_signed ? (INT64_C(1) << (bits - 1)) - 1 : (INT64_C(1) << bits) - 1;
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number || number < (f64) minimum
        || number > (f64) maximum) {
        char expectation[96];
        snprintf(
            expectation, sizeof(expectation), "an integer from %lld to %lld",
            (long long) minimum, (long long) maximum);
        return ffi_fail(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, expectation);
    }
    *out = (i64) number;
    return true;
}

static bool ffi_bigint(
    MalVm *vm, MalValue value, const MalFfiSite *site, i128 *out) {
    if (!mal_value_is_bigint(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a bigint");
    }
    *out = mal_bigint_value(mal_value_to_bigint(value));
    return true;
}

bool mal_ffi_to_int64(
    MalVm *vm, MalValue value, const MalFfiSite *site, int64_t *out) {
    i128 integer;
    if (!ffi_bigint(vm, value, site, &integer)) return false;
    if (integer < (i128) INT64_MIN || integer > (i128) INT64_MAX) {
        return ffi_fail(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a bigint in the signed 64-bit range");
    }
    *out = (i64) integer;
    return true;
}

bool mal_ffi_to_uint64(
    MalVm *vm, MalValue value, const MalFfiSite *site, uint64_t *out) {
    i128 integer;
    if (!ffi_bigint(vm, value, site, &integer)) return false;
    if (integer < 0 || integer > (i128) UINT64_MAX) {
        return ffi_fail(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a bigint in the unsigned 64-bit range");
    }
    *out = (u64) integer;
    return true;
}

bool mal_ffi_to_string(
    MalVm *vm, MalValue value, const MalFfiSite *site, MalFfiString *out) {
    out->data = nullptr;
    out->length = 0;
    if (!mal_value_is_string(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a string");
    }
    const MalString *string = mal_value_to_string(value);
    // A UTF-16 code unit encodes to at most three bytes; a pair's four cover two units.
    usize units = mal_string_length(string);
    char *data = out->inline_data;
    usize capacity = sizeof(out->inline_data);
    if (units > (capacity - 1) / 3) {
        data = units > (SIZE_MAX - 1) / 3 ? nullptr : malloc(units * 3 + 1);
        if (data == nullptr) return mal_ffi_out_of_memory(vm);
        capacity = units * 3 + 1;
    }
    usize length = 0;
    bool encoded = false;
    if (units != 0 && string->latin1 && string->storage < MAL_STRING_STORAGE_DEPENDENT) {
        // A flat ASCII string is its own UTF-8; copying it skips the general encoder.
        MalStringSegment segment = mal_string_flat_segment((MalString *) string);
        u8 high = 0;
        for (usize index = 0; index < units; index++) high |= segment.latin1_units[index];
        if (high < 0x80) {
            memcpy(data, segment.latin1_units, units);
            length = units;
            encoded = true;
        }
    }
    if (!encoded) mal_string_utf8_encode_into(string, (byte *) data, capacity, nullptr, &length);
    data[length] = '\0';
    out->data = data;
    out->length = length;
    // NUL is the only code point whose UTF-8 encoding contains a zero byte.
    if (memchr(data, 0, length) != nullptr) {
        mal_ffi_string_release(out);
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a string without NUL characters");
    }
    return true;
}

void mal_ffi_string_release(MalFfiString *string) {
    if (string->data != string->inline_data) free(string->data);
    string->data = nullptr;
    string->length = 0;
}

bool mal_ffi_to_owned_string(MalVm *vm, MalValue value, const MalFfiSite *site, char **out) {
    *out = nullptr;
    MalFfiString string;
    if (!mal_ffi_to_string(vm, value, site, &string)) return false;
    if (string.data != string.inline_data) {
        *out = string.data;
        return true;
    }
    char *copy = malloc(string.length + 1);
    if (copy == nullptr) return mal_ffi_out_of_memory(vm);
    memcpy(copy, string.data, string.length + 1);
    *out = copy;
    return true;
}

bool mal_ffi_to_bytes(
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, void **data,
    size_t *length) {
    if (nullable && mal_value_is_null(value)) {
        *data = nullptr;
        *length = 0;
        return true;
    }
    MalBufferSourceSpan span;
    MalBufferSourceSpanStatus status = mal_buffer_source_span(value, &span);
    if (status == MAL_BUFFER_SOURCE_SPAN_OK && !span.shared) {
        *data = span.data;
        *length = span.length;
        return true;
    }
    const char *expectation = status == MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE
        ? (nullable ? "an ArrayBuffer, a view, or null" : "an ArrayBuffer or a view")
        : status == MAL_BUFFER_SOURCE_SPAN_OK ? "a buffer that is not shared"
                                              : "a buffer that is attached and in bounds";
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
}

bool mal_ffi_to_array_length(
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, int32_t *length) {
    if (nullable && mal_value_is_null(value)) {
        *length = 0;
        return true;
    }
    bool is_array = false;
    if (mal_value_is_object(value) && !mal_vm_is_array(vm, value, &is_array)) return false;
    MalValue array_length = mal_value_new_undefined();
    if (is_array && !mal_vm_get_static(vm, value, (const byte *) "length", &array_length)) {
        return false;
    }
    if (!is_array || !mal_ops_is_number(array_length)) {
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, nullable ? "an array or null" : "an array");
    }
    f64 count = mal_ops_number_as_f64(array_length);
    if (count > (f64) INT32_MAX) {
        return ffi_fail(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "an array of at most 2147483647 elements");
    }
    *length = (int32_t) count;
    return true;
}

bool mal_ffi_check_count(
    MalVm *vm, size_t count, int32_t bits, bool is_signed, const MalFfiSite *site) {
    u64 maximum = bits >= 64 ? (is_signed ? (u64) INT64_MAX : UINT64_MAX)
                             : (is_signed ? (UINT64_C(1) << (bits - 1)) - 1 : (UINT64_C(1) << bits) - 1);
    if ((u64) count <= maximum) return true;
    char expectation[96];
    snprintf(expectation, sizeof(expectation), "at most %llu elements", (unsigned long long) maximum);
    return ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, expectation);
}

bool mal_ffi_element(
    MalVm *vm, MalValue array, int32_t index, int32_t length, const MalFfiSite *site, MalValue *out) {
    bool is_array = false;
    if (mal_value_is_object(array) && !mal_vm_is_array(vm, array, &is_array)) return false;
    MalValue array_length = mal_value_new_undefined();
    if (is_array && !mal_vm_get_static(vm, array, (const byte *) "length", &array_length)) {
        return false;
    }
    if (!is_array || !mal_ops_is_number(array_length)
        || mal_ops_number_as_f64(array_length) != (f64) length) {
        char expectation[64];
        snprintf(expectation, sizeof(expectation), "an array of %d elements", (int) length);
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
    }
    return mal_vm_get_property(vm, array, mal_key_index((u32) index), out);
}

MalValue mal_ffi_from_int64(MalVm *vm, int64_t value) {
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) value));
}

MalValue mal_ffi_from_uint64(MalVm *vm, uint64_t value) {
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) value));
}

MalValue mal_ffi_from_string(MalVm *vm, const char *value) {
    if (value == nullptr) return mal_value_new_null();
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) value, strlen(value));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

MalValue mal_ffi_from_bytes(MalVm *vm, const void *data, size_t length) {
    if (length > UINT32_MAX) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "C buffer is too large");
        return mal_value_new_undefined();
    }
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) length, (u32) length, false, false);
    if (length > 0) memcpy(buffer->data, data, length);
    MalValue buffer_value = mal_value_from_array_buffer_object(buffer);
    MalRootSpan root;
    mal_gc_root(&root, &buffer_value, 1);
    MalTypedArrayObject *array = mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]), buffer,
        MAL_TA_UINT8, 0, (u32) length, false);
    mal_gc_unroot(&root);
    return mal_value_from_typed_array_object(array);
}

typedef struct MalFfiState MalFfiState;

typedef struct MalFfiHandleObject {
    MalObject object;
    MalObjectStorage object_storage;
    const MalFfiHandleType *type;
    /** The pointer, or the malloc'd copy of a struct; null once closed. */
    void *value;
    bool owned;
    /** The table that finds this open pointer handle by its pointer, or null. */
    MalFfiState *registry;
} MalFfiHandleObject;

typedef struct MalFfiHandleEntry {
    const MalFfiHandleType *type;
    void *pointer;
    /** Null for an empty slot. */
    MalFfiHandleObject *handle;
} MalFfiHandleEntry;

/**
 * Per-VM binding state: the shape each record type's objects share, indexed by the
 * type's slot, and the open handle of each pointer, so a library returning a pointer
 * twice yields one handle. Handle entries are weak; a handle leaves the table when
 * it closes or is collected.
 */
struct MalFfiState {
    MalShape **shapes;
    usize shape_capacity;
    /** Open addressing with linear probing; capacity is zero or a power of two. */
    MalFfiHandleEntry *handles;
    usize handle_count;
    usize handle_capacity;
};

static void ffi_state_free(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return;
    // Teardown finalizers run after this, so the handles must forget the table first.
    for (usize index = 0; index < state->handle_capacity; index++) {
        if (state->handles[index].handle != nullptr) state->handles[index].handle->registry = nullptr;
    }
    free(state->handles);
    free(state->shapes);
    free(state);
    vm->ffi = nullptr;
}

static MalFfiState *ffi_state(MalVm *vm) {
    if (vm->ffi != nullptr) return vm->ffi;
    MalFfiState *state = calloc(1, sizeof(*state));
    if (state == nullptr || !mal_vm_register_runtime_cleanup(vm, ffi_state_free)) {
        free(state);
        return nullptr;
    }
    vm->ffi = state;
    return state;
}

static usize ffi_handle_slot(const MalFfiHandleType *type, const void *pointer, usize capacity) {
    u64 key = (u64) (uptr) pointer ^ ((u64) (uptr) type * UINT64_C(0x9E3779B97F4A7C15));
    key ^= key >> 29;
    key *= UINT64_C(0xBF58476D1CE4E5B9);
    key ^= key >> 32;
    return (usize) key & (capacity - 1);
}

static MalFfiHandleObject *ffi_handle_find(
    MalFfiState *state, const MalFfiHandleType *type, const void *pointer) {
    if (state->handle_capacity == 0) return nullptr;
    for (usize slot = ffi_handle_slot(type, pointer, state->handle_capacity);;
         slot = (slot + 1) & (state->handle_capacity - 1)) {
        MalFfiHandleEntry *entry = &state->handles[slot];
        if (entry->handle == nullptr) return nullptr;
        if (entry->type == type && entry->pointer == pointer) return entry->handle;
    }
}

static void ffi_handle_place(MalFfiState *state, MalFfiHandleEntry entry) {
    usize slot = ffi_handle_slot(entry.type, entry.pointer, state->handle_capacity);
    while (state->handles[slot].handle != nullptr) slot = (slot + 1) & (state->handle_capacity - 1);
    state->handles[slot] = entry;
}

/** Record an open pointer handle; without memory it simply stays unregistered. */
static void ffi_handle_register(MalFfiState *state, MalFfiHandleObject *handle) {
    if ((state->handle_count + 1) * 2 > state->handle_capacity) {
        usize capacity = state->handle_capacity == 0 ? 16 : state->handle_capacity * 2;
        MalFfiHandleEntry *grown = calloc(capacity, sizeof(*grown));
        if (grown == nullptr) return;
        MalFfiHandleEntry *previous = state->handles;
        usize previous_capacity = state->handle_capacity;
        state->handles = grown;
        state->handle_capacity = capacity;
        for (usize index = 0; index < previous_capacity; index++) {
            if (previous[index].handle != nullptr) ffi_handle_place(state, previous[index]);
        }
        free(previous);
    }
    ffi_handle_place(state, (MalFfiHandleEntry) {handle->type, handle->value, handle});
    state->handle_count++;
    handle->registry = state;
}

/** Remove a handle's entry, shifting later probes back so lookups stay correct. */
static void ffi_handle_unregister(MalFfiHandleObject *handle) {
    MalFfiState *state = handle->registry;
    if (state == nullptr) return;
    handle->registry = nullptr;
    usize mask = state->handle_capacity - 1;
    usize slot = ffi_handle_slot(handle->type, handle->value, state->handle_capacity);
    while (state->handles[slot].handle != handle) slot = (slot + 1) & mask;
    state->handles[slot] = (MalFfiHandleEntry) {0};
    state->handle_count--;
    for (usize next = (slot + 1) & mask; state->handles[next].handle != nullptr;
         next = (next + 1) & mask) {
        MalFfiHandleEntry entry = state->handles[next];
        state->handles[next] = (MalFfiHandleEntry) {0};
        ffi_handle_place(state, entry);
    }
}

static MalFfiHandleObject *ffi_handle(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FFI_HANDLE_OBJECT)
        ? (MalFfiHandleObject *) mal_value_to_object(value)
        : nullptr;
}

static bool ffi_store(MalVm *vm, MalValue target, MalKey key, MalValue value) {
    if (!mal_object_set(mal_value_to_object(target), key, value)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    return true;
}

static bool ffi_set_field(MalVm *vm, MalValue record, const char *name, MalValue value) {
    MalValue held[2] = {record, value};
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    MalKey key = mal_intrinsic_string_key(vm, (const byte *) name);
    bool stored = ffi_store(vm, held[0], key, held[1]);
    mal_gc_unroot(&root);
    return stored;
}

/** The last slot handed to a record type; slots are process-wide and never reused. */
static _Atomic i32 ffi_record_slots;

static i32 ffi_record_slot(MalFfiRecordType *type) {
    i32 slot = atomic_load_explicit(&type->slot, memory_order_acquire);
    if (slot != 0) return slot;
    i32 fresh = atomic_fetch_add_explicit(&ffi_record_slots, 1, memory_order_relaxed) + 1;
    // Another VM thread may number the type first; both then use its slot.
    if (atomic_compare_exchange_strong_explicit(
            &type->slot, &slot, fresh, memory_order_acq_rel, memory_order_acquire)) {
        return fresh;
    }
    return slot;
}

/** The shape of `type`'s objects; shapes live as long as the heap's transition tree. */
static MalShape *ffi_record_shape(MalVm *vm, MalFfiRecordType *type) {
    MalFfiState *state = vm->ffi;
    i32 slot = ffi_record_slot(type);
    if (state != nullptr && (usize) slot < state->shape_capacity && state->shapes[slot] != nullptr) {
        return state->shapes[slot];
    }
    state = ffi_state(vm);
    if (state == nullptr) return nullptr;
    if ((usize) slot >= state->shape_capacity) {
        usize capacity = state->shape_capacity == 0 ? 16 : state->shape_capacity;
        while (capacity <= (usize) slot) capacity *= 2;
        MalShape **grown = realloc(state->shapes, capacity * sizeof(*grown));
        if (grown == nullptr) return nullptr;
        memset(grown + state->shape_capacity, 0, (capacity - state->shape_capacity) * sizeof(*grown));
        state->shapes = grown;
        state->shape_capacity = capacity;
    }
    MalString *keys[64];
    if (type->field_count > (i32) countof(keys)) return nullptr;
    for (i32 index = 0; index < type->field_count; index++) {
        keys[index] = mal_intrinsic_ascii(vm, (const byte *) type->fields[index]);
    }
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, keys, (u32) type->field_count);
    state->shapes[slot] = shape;
    return shape;
}

bool mal_ffi_record_fields(
    MalVm *vm, MalValue record, MalFfiRecordType *type, const MalFfiSite *site,
    MalValue *values) {
    if (mal_value_is_heap_type(record, MAL_HEAP_OBJECT)) {
        MalObject *object = mal_value_to_object(record);
        MalShape *shape = ffi_record_shape(vm, type);
        if (shape != nullptr && object->shape == shape) {
            for (i32 index = 0; index < type->field_count; index++) {
                values[index] = mal_object_field_load_shaped(object, (u32) index);
            }
            return true;
        }
    }
    if (!mal_value_is_object(record)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "an object");
    }
    for (i32 index = 0; index < type->field_count; index++) {
        if (!mal_vm_get_static(vm, record, (const byte *) type->fields[index], &values[index])) {
            return false;
        }
    }
    return true;
}

MalValue mal_ffi_new_record(MalVm *vm, MalFfiRecordType *type, const MalValue *values) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape != nullptr) {
        return mal_value_from_object(
            mal_object_new_shaped(&vm->heap, prototype, shape, values, (u32) type->field_count));
    }
    // A struct wider than the shape helper allows still gets an ordinary object.
    MalValue record = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &record, 1);
    for (i32 index = 0; index < type->field_count && !mal_ffi_threw(vm); index++) {
        ffi_set_field(vm, record, type->fields[index], values[index]);
    }
    mal_gc_unroot(&root);
    return record;
}

MalValue mal_ffi_new_array(MalVm *vm, int32_t length) {
    return mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) length));
}

bool mal_ffi_set_element(MalVm *vm, MalValue array, int32_t index, MalValue value) {
    MalValue held[2] = {array, value};
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    bool stored = ffi_store(vm, held[0], mal_key_index((u32) index), held[1]);
    mal_gc_unroot(&root);
    return stored;
}

bool mal_ffi_threw(MalVm *vm) {
    return vm->completion.kind == MAL_COMPLETION_THROW;
}

bool mal_ffi_to_function(MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site) {
    if ((nullable && mal_value_is_null(value)) || mal_value_is_callable(value)) return true;
    return ffi_fail(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, nullable ? "a function or null" : "a function");
}

bool mal_ffi_call(
    MalVm *vm, MalValue function, const MalValue *args, int32_t count, MalValue *result) {
    MalCompletion completion =
        mal_vm_call_value(vm, function, mal_value_new_undefined(), args, count);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return false;
    }
    *result = completion.value;
    return true;
}

bool mal_ffi_out_of_memory(MalVm *vm) {
    mal_vm_throw_allocation_error(vm);
    return false;
}

void mal_ffi_root(MalFfiRoots *roots, MalValue *slots, int32_t count) {
    mal_gc_root((MalRootSpan *) roots, slots, count);
}

void mal_ffi_unroot(MalFfiRoots *roots) {
    mal_gc_unroot((MalRootSpan *) roots);
}

/**
 * Values a VM materializes once per identity, so every image observes the same
 * function, constant, and handle prototype. Returns the cached value, or
 * undefined when `identity` has none yet.
 */
static bool ffi_prepared(MalVm *vm, const char *identity, MalValue *out) {
    for (MalPreparedValue *prepared = vm->prepared_values; prepared != nullptr;
         prepared = prepared->next) {
        if (strcmp(prepared->identity, identity) == 0) {
            *out = prepared->value;
            return true;
        }
    }
    return false;
}

/** Cache `value` under `identity`, taking ownership of the identity string. */
static bool ffi_prepare(MalVm *vm, char *identity, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalPreparedValue *prepared = calloc(1, sizeof(*prepared));
    char *data = strdup("");
    mal_gc_unroot(&root);
    if (prepared == nullptr || data == nullptr) {
        free(prepared);
        free(data);
        free(identity);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    prepared->identity = identity;
    prepared->data = data;
    prepared->value = value;
    prepared->next = vm->prepared_values;
    vm->prepared_values = prepared;
    return true;
}

/** A malloc'd `<specifier>#<name>` identity, or null after an allocation throw. */
static char *ffi_identity(MalVm *vm, const MalFfiLibrary *library, const char *name) {
    usize length = strlen(library->specifier) + 1 + strlen(name) + 1;
    char *identity = malloc(length);
    if (identity == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    snprintf(identity, length, "%s#%s", library->specifier, name);
    return identity;
}

/** Forget the resource without releasing it; the struct copy is freed here. */
static void ffi_handle_forget(MalFfiHandleObject *handle) {
    if (handle->registry != nullptr) ffi_handle_unregister(handle);
    if (handle->type->size > 0) free(handle->value);
    handle->value = nullptr;
}

static void ffi_handle_finalize(MalHeapHeader *cell) {
    MalFfiHandleObject *handle = (MalFfiHandleObject *) cell;
    if (handle->value != nullptr && handle->owned && handle->type->collect
        && handle->type->destroy != nullptr) {
        handle->type->destroy(handle->value);
    }
    ffi_handle_forget(handle);
}

static MalValue ffi_handle_dispose(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalFfiHandleObject *handle = ffi_handle(this_value);
    if (handle == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "[Symbol.dispose] requires a C library handle");
        return mal_value_new_undefined();
    }
    if (handle->value != nullptr) {
        void *value = handle->value;
        bool release = handle->owned && handle->type->destroy != nullptr;
        // Close before releasing: the library may hand out the same pointer again.
        if (handle->type->size == 0) ffi_handle_forget(handle);
        if (release) handle->type->destroy(value);
        ffi_handle_forget(handle);
    }
    return mal_value_new_undefined();
}

static MalValue ffi_handle_prototype(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type) {
    usize name_length = strlen("type:") + strlen(type->name) + 1;
    char *name = malloc(name_length);
    if (name == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    snprintf(name, name_length, "type:%s", type->name);
    char *identity = ffi_identity(vm, library, name);
    free(name);
    if (identity == nullptr) return mal_value_new_undefined();
    MalValue cached;
    if (ffi_prepared(vm, identity, &cached)) {
        free(identity);
        return cached;
    }
    MalValue held[2] = {
        mal_value_from_object(mal_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]))),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    MalObject *prototype = mal_value_to_object(held[0]);
    mal_intrinsic_define_symbol_method(
        vm, prototype, MAL_INTRINSIC_SYMBOL_DISPOSE, (const byte *) "[Symbol.dispose]",
        ffi_handle_dispose);
    held[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) type->name));
    MalValue tag = vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (mal_value_is_symbol(tag)) {
        MalPropertyDesc description = {.value = held[1], .flags = MAL_PROPERTY_CONFIGURABLE};
        mal_object_define_own(prototype, mal_key_from_value(tag), &description);
    }
    for (i32 index = 0; index < type->field_count; index++) {
        const MalFfiField *field = &type->fields[index];
        char getter_name[128];
        snprintf(getter_name, sizeof(getter_name), "get %s", field->name);
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, (const byte *) field->name),
            (const byte *) getter_name, 0, field->get, nullptr, 0, nullptr,
            MAL_PROPERTY_CONFIGURABLE);
    }
    MalValue result = held[0];
    mal_gc_unroot(&root);
    if (!ffi_prepare(vm, identity, result)) return mal_value_new_undefined();
    return result;
}

MalValue mal_ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned) {
    MalFfiState *state = type->size == 0 ? ffi_state(vm) : nullptr;
    MalFfiHandleObject *open = state == nullptr ? nullptr : ffi_handle_find(state, type, value);
    if (open != nullptr) {
        // One pointer, one handle: closing it through any path closes it everywhere.
        if (owned) open->owned = true;
        return mal_value_from_heap((MalHeapHeader *) open);
    }
    void *stored = value;
    if (type->size > 0) {
        stored = malloc(type->size);
        if (stored != nullptr) memcpy(stored, value, type->size);
    }
    MalValue prototype =
        stored == nullptr ? mal_value_new_undefined() : ffi_handle_prototype(vm, library, type);
    if (stored == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) {
        // The resource exists but no handle can own it, so release it now.
        if (owned && type->destroy != nullptr) type->destroy(value);
        if (type->size > 0) free(stored);
        if (vm->completion.kind != MAL_COMPLETION_THROW) mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, &prototype, 1);
    MalFfiHandleObject *handle =
        mal_heap_alloc(&vm->heap, sizeof(MalFfiHandleObject), MAL_HEAP_FFI_HANDLE_OBJECT);
    mal_object_init(
        &vm->heap, &handle->object, MAL_HEAP_FFI_HANDLE_OBJECT, mal_value_to_object(prototype));
    handle->type = type;
    handle->value = stored;
    handle->owned = owned;
    handle->registry = nullptr;
    if (state != nullptr) ffi_handle_register(state, handle);
    mal_gc_unroot(&root);
    return mal_value_from_heap((MalHeapHeader *) handle);
}

bool mal_ffi_to_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out) {
    if (nullable && mal_value_is_null(value)) {
        *out = nullptr;
        return true;
    }
    MalFfiHandleObject *handle = ffi_handle(value);
    char expectation[160];
    if (handle != nullptr && handle->type == type) {
        if (handle->value != nullptr) {
            *out = handle->value;
            return true;
        }
        snprintf(expectation, sizeof(expectation), "an open %s handle", type->name);
    } else {
        snprintf(
            expectation, sizeof(expectation), "a %s handle%s", type->name,
            nullable ? " or null" : "");
    }
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
}

void mal_ffi_close_handle(MalValue value) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle != nullptr) ffi_handle_forget(handle);
}

static const MalFfiExport *ffi_find_export(const MalFfiLibrary *library, const char *name) {
    i32 low = 0;
    i32 high = library->export_count - 1;
    while (low <= high) {
        i32 middle = low + (high - low) / 2;
        int order = strcmp(library->exports[middle].name, name);
        if (order == 0) return &library->exports[middle];
        if (order < 0) low = middle + 1;
        else high = middle - 1;
    }
    return nullptr;
}

static MalValue ffi_export_value(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiExport *entry) {
    char *identity = ffi_identity(vm, library, entry->name);
    if (identity == nullptr) return mal_value_new_undefined();
    MalValue value;
    if (ffi_prepared(vm, identity, &value)) {
        free(identity);
        return value;
    }
    if (entry->function != nullptr) {
        MalObject *prototype =
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
        value = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, prototype, mal_intrinsic_ascii(vm, (const byte *) entry->name),
            entry->length, entry->function));
    } else {
        value = entry->constant(vm);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(identity);
            return mal_value_new_undefined();
        }
    }
    if (!ffi_prepare(vm, identity, value)) return mal_value_new_undefined();
    return value;
}

void mal_ffi_install(
    MalVm *vm, const MalFfiLibrary *library, const MalHostInstallSlot *slots, int32_t count) {
    mal_gc_register_finalizer(MAL_HEAP_FFI_HANDLE_OBJECT, ffi_handle_finalize);
    for (i32 index = 0; index < count; index++) {
        const MalFfiExport *entry = ffi_find_export(library, slots[index].name);
        if (entry == nullptr) {
            char message[512];
            snprintf(
                message, sizeof(message), "%s has no export '%s'", library->specifier,
                slots[index].name);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
            return;
        }
        MalValue value = ffi_export_value(vm, library, entry);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        vm->globals[slots[index].slot] = value;
    }
}
