#include "../ffi/mal_ffi.h"

#include <limits.h>
#include <stdatomic.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "async_context.h"
#include "blocking_work.h"
#include "builtin_promise.h"
#include "host.h"
#include "web_host_timer.h"
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
    MalVm *vm, MalValue value, bool nullable, bool writable, const MalFfiSite *site,
    void **data, size_t *length, void **pin) {
    if (pin != nullptr) *pin = nullptr;
    if (nullable && mal_value_is_null(value)) {
        *data = nullptr;
        *length = 0;
        return true;
    }
    MalBufferSourceSpan span;
    MalBufferSourceSpanStatus status = mal_buffer_source_span(value, &span);
    if (status == MAL_BUFFER_SOURCE_SPAN_OK && writable && span.buffer->immutable) {
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a buffer that is not immutable");
    }
    if (status == MAL_BUFFER_SOURCE_SPAN_OK && !span.shared) {
        *data = span.data;
        *length = span.length;
        if (pin != nullptr) {
            span.buffer->pins++;
            *pin = span.buffer;
        }
        return true;
    }
    const char *expectation = status == MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE
        ? (nullable ? "an ArrayBuffer, a view, or null" : "an ArrayBuffer or a view")
        : status == MAL_BUFFER_SOURCE_SPAN_OK ? "a buffer that is not shared"
                                              : "a buffer that is attached and in bounds";
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
}

void mal_ffi_unpin(void *pin) {
    if (pin != nullptr) ((MalArrayBufferObject *) pin)->pins--;
}

bool mal_ffi_to_array_length(
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, int32_t *length) {
    if (nullable && mal_value_is_null(value)) {
        *length = 0;
        return true;
    }
    if (mal_value_is_array_object(value)
        && mal_array_object_length(mal_value_to_array_object(value)) <= (u32) INT32_MAX) {
        *length = (int32_t) mal_array_object_length(mal_value_to_array_object(value));
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
    // An Array's dense elements are own data properties, so reading one runs no JavaScript.
    if (mal_value_is_array_object(array)) {
        MalArrayObject *object = mal_value_to_array_object(array);
        if (mal_array_object_length(object) == (u32) length
            && mal_array_object_dense_get(object, (u32) index, out)) {
            return true;
        }
    }
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
    /** C calls using the handle; it cannot close while any are. */
    u32 pins;
    /**
     * The callback invocation this borrowed argument belongs to, or 0 for a handle
     * the program holds. Once that invocation returns the handle reads as closed:
     * the library only lent the resource for the callback.
     */
    u64 scope;
} MalFfiHandleObject;

/** A kept callback; trampolines receive a pointer to `callback`, its first member. */
typedef struct MalFfiKept {
    MalFfiCallback callback;
    /** The element of the VM's kept-function holder that roots `callback.function`. */
    u32 slot;
    pthread_t thread;
    struct MalFfiKept *previous;
    struct MalFfiKept *next;
    /** Link in the VM's queue of releases that arrived where the VM could not run them. */
    struct MalFfiKept *pending;
} MalFfiKept;

/**
 * Set while a collected handle's destroy function runs inside the collector, where
 * a library might call back or release a kept callback but no JavaScript can run.
 */
static _Thread_local bool ffi_finalizing;

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
    /** Callbacks libraries still hold, and the kept-function holder's reusable slots. */
    MalFfiKept *kept;
    /** Releases from a collection or another thread, run on the VM thread later. */
    _Atomic(MalFfiKept *) pending_releases;
    /** Callback invocations in progress, innermost last, numbered from 1. */
    u64 *invocations;
    usize invocation_depth;
    usize invocation_capacity;
    u64 last_invocation;
    /** Whether the runtime cleanup that drops pending async calls is registered. */
    bool async_cleanup;
    u32 kept_slots;
    u32 *free_slots;
    u32 free_count;
    u32 free_capacity;
};

static void ffi_state_free(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return;
    // Teardown finalizers run after this, so the handles must forget the table first.
    for (usize index = 0; index < state->handle_capacity; index++) {
        if (state->handles[index].handle != nullptr) state->handles[index].handle->registry = nullptr;
    }
    // Libraries may still hold kept callbacks and release them later: detach instead
    // of freeing, so a late call finds no VM and a late release frees the context.
    for (MalFfiKept *kept = state->kept; kept != nullptr; kept = kept->next) {
        kept->callback.vm = nullptr;
    }
    // Contexts the library already released only wait for this VM; nothing holds them.
    MalFfiKept *pending = atomic_exchange(&state->pending_releases, nullptr);
    while (pending != nullptr) {
        MalFfiKept *next = pending->pending;
        free(pending);
        pending = next;
    }
    free(state->free_slots);
    free(state->invocations);
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

/** Slots are plain numbers that publish nothing else, so relaxed ordering suffices. */
static i32 ffi_record_slot(MalFfiRecordType *type) {
    i32 slot = atomic_load_explicit(&type->slot, memory_order_relaxed);
    if (slot != 0) return slot;
    i32 fresh = atomic_fetch_add_explicit(&ffi_record_slots, 1, memory_order_relaxed) + 1;
    // Another VM thread may number the type first; both then use its slot.
    if (atomic_compare_exchange_strong_explicit(
            &type->slot, &slot, fresh, memory_order_relaxed, memory_order_relaxed)) {
        return fresh;
    }
    return slot;
}

/**
 * Create the shape of `type`'s objects on a VM's first use. Kept out of line: its
 * key buffer would give every lookup a large, canary-checked frame.
 */
static __attribute__((noinline)) MalShape *ffi_record_shape_create(MalVm *vm, MalFfiRecordType *type, i32 slot) {
    MalFfiState *state = ffi_state(vm);
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

/** The shape of `type`'s objects; shapes live as long as the heap's transition tree. */
static inline MalShape *ffi_record_shape(MalVm *vm, MalFfiRecordType *type) {
    MalFfiState *state = vm->ffi;
    i32 slot = ffi_record_slot(type);
    if (state != nullptr && (usize) slot < state->shape_capacity && state->shapes[slot] != nullptr) {
        return state->shapes[slot];
    }
    return ffi_record_shape_create(vm, type, slot);
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

static bool ffi_record_leaves(
    MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue **leaves) {
    if (!mal_value_is_heap_type(record, MAL_HEAP_OBJECT)) return false;
    MalObject *object = mal_value_to_object(record);
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr || object->shape != shape) return false;
    for (i32 index = 0; index < type->field_count; index++) {
        MalValue field = mal_object_field_load_shaped(object, (u32) index);
        MalFfiRecordType *nested = type->nested == nullptr ? nullptr : type->nested[index];
        if (nested == nullptr) *(*leaves)++ = field;
        else if (!ffi_record_leaves(vm, field, nested, leaves)) return false;
    }
    return true;
}

bool mal_ffi_record_leaves(MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves) {
    return ffi_record_leaves(vm, record, type, &leaves);
}

bool mal_ffi_record_elements(
    MalVm *vm, MalValue array, int32_t length, MalFfiRecordType *type,
    const MalFfiSite *site, MalValue *values) {
    MalShape *shape = ffi_record_shape(vm, type);
    i32 count = type->field_count;
    for (i32 index = 0; index < length; index++) {
        MalValue *fields = values + (usize) index * (usize) count;
        MalValue element;
        // A dense element that already has the record's shape reads without running JavaScript.
        if (shape != nullptr && mal_value_is_array_object(array)) {
            MalArrayObject *object = mal_value_to_array_object(array);
            if (mal_array_object_length(object) == (u32) length &&
                mal_array_object_dense_get(object, (u32) index, &element) &&
                mal_value_is_heap_type(element, MAL_HEAP_OBJECT) &&
                mal_value_to_object(element)->shape == shape) {
                for (i32 field = 0; field < count; field++) {
                    fields[field] = mal_object_field_load_shaped(
                        mal_value_to_object(element), (u32) field);
                }
                continue;
            }
        }
        if (!mal_ffi_element(vm, array, index, length, site, &element)) return false;
        MalRootSpan root;
        mal_gc_root(&root, &element, 1);
        bool read = mal_ffi_record_fields(vm, element, type, site, fields);
        mal_gc_unroot(&root);
        if (!read) return false;
    }
    return true;
}

bool mal_ffi_stack_record(MalVm *vm, MalFfiRecordType *type, void *object, MalValue *slots) {
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr) return mal_ffi_out_of_memory(vm);
    mal_object_init_embedded_stack(
        &vm->heap, object, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        shape, slots);
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

/** The prepared value holding every kept callback's function, one per slot. */
static const char FFI_KEPT_IDENTITY[] = "maligator:ffi#kept";

[[noreturn]] static void ffi_wrong_thread(void) {
    fputs("maligator: a C library called back into JavaScript from another thread\n", stderr);
    abort();
}

static void ffi_run_pending_releases(MalVm *vm);

MalFfiCallback *mal_ffi_keep(MalVm *vm, MalValue function) {
    MalValue held[2] = {function, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    MalFfiState *state = ffi_state(vm);
    MalFfiKept *kept = calloc(1, sizeof(*kept));
    bool ready = state != nullptr && kept != nullptr;
    if (ready) ffi_run_pending_releases(vm);
    if (ready && !ffi_prepared(vm, FFI_KEPT_IDENTITY, &held[1])) {
        // A holder without a prototype, so no inherited setter can refuse a slot.
        held[1] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        char *identity = strdup(FFI_KEPT_IDENTITY);
        ready = identity != nullptr && ffi_prepare(vm, identity, held[1]);
        if (identity == nullptr) mal_vm_throw_allocation_error(vm);
    }
    u32 slot = 0;
    if (ready) {
        bool reused = state->free_count > 0;
        slot = reused ? state->free_slots[--state->free_count] : state->kept_slots++;
        ready = mal_ffi_set_element(vm, held[1], (int32_t) slot, held[0]);
        if (!ready && reused) state->free_count++;
    }
    mal_gc_unroot(&root);
    if (!ready) {
        free(kept);
        if (!mal_ffi_threw(vm)) mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    kept->callback = (MalFfiCallback) {vm, held[0]};
    kept->slot = slot;
    kept->thread = pthread_self();
    kept->next = state->kept;
    if (state->kept != nullptr) state->kept->previous = kept;
    state->kept = kept;
    return &kept->callback;
}

/** Drop a released context's slot and free it; runs on the VM thread outside collection. */
static void ffi_release_now(MalFfiKept *kept) {
    MalVm *vm = kept->callback.vm;
    if (vm != nullptr) {
        MalFfiState *state = vm->ffi;
        MalValue array;
        if (ffi_prepared(vm, FFI_KEPT_IDENTITY, &array)) {
            // Overwriting an existing element allocates nothing, so this cannot throw.
            (void) mal_object_set(
                mal_value_to_object(array), mal_key_index(kept->slot), mal_value_new_undefined());
        }
        if (state->free_count == state->free_capacity) {
            u32 capacity = state->free_capacity == 0 ? 8 : state->free_capacity * 2;
            u32 *grown = realloc(state->free_slots, capacity * sizeof(*grown));
            if (grown != nullptr) {
                state->free_slots = grown;
                state->free_capacity = capacity;
            }
        }
        // Without room the slot is simply never reused.
        if (state->free_count < state->free_capacity) {
            state->free_slots[state->free_count++] = kept->slot;
        }
        if (kept->previous != nullptr) kept->previous->next = kept->next;
        else state->kept = kept->next;
        if (kept->next != nullptr) kept->next->previous = kept->previous;
    }
    free(kept);
}

static void ffi_run_pending_releases(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr || atomic_load_explicit(&state->pending_releases, memory_order_relaxed) == nullptr) {
        return;
    }
    MalFfiKept *pending = atomic_exchange(&state->pending_releases, nullptr);
    while (pending != nullptr) {
        MalFfiKept *next = pending->pending;
        ffi_release_now(pending);
        pending = next;
    }
}

void mal_ffi_release(void *data) {
    if (data == nullptr) return;
    MalFfiKept *kept = data;
    MalVm *vm = kept->callback.vm;
    // Inside a collection or on another thread the VM cannot be touched; queue the
    // context for the VM thread, which runs the queue after its next C call.
    if (vm != nullptr && (ffi_finalizing || !pthread_equal(kept->thread, pthread_self()))) {
        MalFfiState *state = vm->ffi;
        MalFfiKept *head = atomic_load(&state->pending_releases);
        do {
            kept->pending = head;
        } while (!atomic_compare_exchange_weak(&state->pending_releases, &head, kept));
        return;
    }
    ffi_release_now(kept);
}

/** A C call running on a blocking worker, until its completion settles `promise`. */
typedef struct MalFfiAsync {
    struct MalFfiAsync *next;
    MalVm *vm;
    MalHostHandle operation;
    MalValue promise;
    /** Arguments the call uses in place, such as pinned buffers and handles. */
    MalValue *keep;
    i32 keep_count;
    MalFfiAsyncComplete complete;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} MalFfiAsync;

static MAL_ISOLATE_LOCAL MalFfiAsync *ffi_async_pending;
static MAL_ISOLATE_LOCAL bool ffi_async_installed;

static void ffi_async_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalFfiAsync *call = ffi_async_pending; call != nullptr; call = call->next) {
        if (call->vm != vm) continue;
        mal_gc_mark_value(call->promise);
        for (i32 index = 0; index < call->keep_count; index++) mal_gc_mark_value(call->keep[index]);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) call->async_context));
    }
}

static void ffi_async_free(MalVm *vm) {
    MalFfiAsync **link = &ffi_async_pending;
    while (*link != nullptr) {
        MalFfiAsync *call = *link;
        if (call->vm != vm) {
            link = &call->next;
            continue;
        }
        *link = call->next;
        free(call->keep);
        free(call);
    }
}

static bool ffi_async_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    MalFfiAsync **link = &ffi_async_pending;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    MalFfiAsync *call = *link;
    if (call == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    *link = call->next;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, call->realm);
#endif
    MalValue roots[3] = {
        call->promise, mal_value_new_undefined(),
        mal_async_internal_value((MalHeapHeader *) call->async_context)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, call->async_context);
    void *data = mal_blocking_work_result_data(task.data);
    bool ran = data != nullptr && task.result != MAL_HOST_TERMINAL_CANCELLED;
    // The completion releases what the call held, so it runs even when the work did not.
    if (data != nullptr) roots[1] = call->complete(vm, data, ran);
    if (!ran && vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) "A C library call did not run");
    }
    bool rejected = vm->completion.kind == MAL_COMPLETION_THROW;
    if (rejected) {
        roots[1] = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }
    mal_promise_settle_direct(
        vm, roots[0], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], rejected, roots[1]);
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    free(call->keep);
    free(call);
    mal_host_task_release(&host->tasks, &task);
    return true;
}

bool mal_ffi_async(
    MalVm *vm, void *data, MalFfiAsyncRun run, MalFfiAsyncComplete complete,
    MalFfiAsyncRelease release, const MalValue *keep, int32_t keep_count, MalValue *promise) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "Async C library calls need an event loop, such as the web platform surface");
        return false;
    }
    MalFfiState *state = ffi_state(vm);
    if (state == nullptr) return mal_ffi_out_of_memory(vm);
    if (!state->async_cleanup) {
        if (!mal_vm_register_runtime_cleanup(vm, ffi_async_free)) return mal_ffi_out_of_memory(vm);
        state->async_cleanup = true;
    }
    if (!ffi_async_installed) {
        mal_gc_register_root_source(ffi_async_scan_roots, nullptr);
        mal_host_register_macrotask_drain(ffi_async_drain, false);
        ffi_async_installed = true;
    }
    MalValue resolve;
    MalValue reject;
    mal_promise_new_direct_capability(vm, promise, &resolve, &reject);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    MalFfiAsync *call = calloc(1, sizeof(*call));
    MalValue *kept = keep_count == 0 ? nullptr : malloc(sizeof(*kept) * (usize) keep_count);
    if (call == nullptr || (keep_count > 0 && kept == nullptr)) {
        free(call);
        free(kept);
        return mal_ffi_out_of_memory(vm);
    }
    if (keep_count > 0) memcpy(kept, keep, sizeof(*kept) * (usize) keep_count);
    *call = (MalFfiAsync) {
        .vm = vm,
        .promise = *promise,
        .keep = kept,
        .keep_count = keep_count,
        .complete = complete,
        .async_context = mal_async_context_capture(vm),
#if MAL_REALMS
        .realm = vm->current_realm,
#endif
    };
    MalBlockingWorkReservation reservation = {0};
    if (!mal_blocking_work_reserve(host, sizeof(*call), &reservation)
        || !mal_blocking_work_start(host, run, data, release, &reservation, &call->operation)) {
        mal_blocking_work_reservation_release(&reservation);
        free(kept);
        free(call);
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "A C library call could not be scheduled");
        return false;
    }
    call->next = ffi_async_pending;
    ffi_async_pending = call;
    return true;
}

MalValue mal_ffi_rejected(MalVm *vm) {
    MalValue roots[2] = {vm->completion.value, mal_value_new_undefined()};
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue resolve;
    MalValue reject;
    mal_promise_new_direct_capability(vm, &roots[1], &resolve, &reject);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_promise_settle_direct(
            vm, roots[1], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], true, roots[0]);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
}

void mal_ffi_collectable_begin(MalVm *vm) {
    mal_gc_native_rooted_begin(vm);
}

void mal_ffi_collectable_end(MalVm *vm) {
    mal_gc_native_rooted_end(vm);
    ffi_run_pending_releases(vm);
}

MalVm *mal_ffi_callback_vm(MalFfiCallback *callback) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    if (kept->callback.vm == nullptr || ffi_finalizing) return nullptr;
    if (!pthread_equal(kept->thread, pthread_self())) ffi_wrong_thread();
    return kept->callback.vm;
}

typedef struct MalFfiReplacedEntry {
    void *key;
    MalFfiKept *kept;
} MalFfiReplacedEntry;

/**
 * Replaced callbacks are process-wide, as the libraries' own setter state is, so
 * worker VMs share them. Only VM threads change entries, but a library may call a
 * trampoline from any thread, so lookups take the lock too.
 */
static pthread_mutex_t ffi_replaced_lock = PTHREAD_MUTEX_INITIALIZER;
/** Every site that ever held an entry, so destroying a handle finds its callbacks. */
static MalFfiReplaced *ffi_replaced_sites;
/** Entries keyed by a handle; destroying a handle skips the scan while there are none. */
static _Atomic usize ffi_replaced_keyed;

static MalFfiReplacedEntry *ffi_replaced_find(MalFfiReplaced *site, void *key) {
    MalFfiReplacedEntry *entries = site->entries;
    for (usize index = 0; index < site->count; index++) {
        if (entries[index].key == key) return &entries[index];
    }
    return nullptr;
}

static void ffi_replaced_remove(MalFfiReplaced *site, MalFfiReplacedEntry *entry) {
    MalFfiReplacedEntry *entries = site->entries;
    if (entry->key != nullptr) ffi_replaced_keyed--;
    *entry = entries[--site->count];
}

bool mal_ffi_replace(
    MalVm *vm, MalFfiReplaced *site, void *key, MalFfiCallback *callback,
    MalFfiCallback **previous) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
    *previous = entry == nullptr ? nullptr : &entry->kept->callback;
    if (entry != nullptr && callback == nullptr) ffi_replaced_remove(site, entry);
    else if (entry != nullptr) entry->kept = (MalFfiKept *) callback;
    else if (callback != nullptr) {
        if (site->count == site->capacity) {
            usize capacity = site->capacity == 0 ? 4 : site->capacity * 2;
            MalFfiReplacedEntry *grown = realloc(site->entries, capacity * sizeof(*grown));
            if (grown == nullptr) {
                pthread_mutex_unlock(&ffi_replaced_lock);
                return mal_ffi_out_of_memory(vm);
            }
            if (site->capacity == 0) {
                site->next = ffi_replaced_sites;
                ffi_replaced_sites = site;
            }
            site->entries = grown;
            site->capacity = capacity;
        }
        ((MalFfiReplacedEntry *) site->entries)[site->count++] =
            (MalFfiReplacedEntry) {key, (MalFfiKept *) callback};
        if (key != nullptr) ffi_replaced_keyed++;
    }
    pthread_mutex_unlock(&ffi_replaced_lock);
    return true;
}

MalFfiCallback *mal_ffi_replaced(MalFfiReplaced *site, void *key) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
    MalFfiKept *kept = entry == nullptr ? nullptr : entry->kept;
    // Checked under the lock: the owning thread may release the context right after.
    bool foreign = kept != nullptr && kept->callback.vm != nullptr
        && !pthread_equal(kept->thread, pthread_self());
    pthread_mutex_unlock(&ffi_replaced_lock);
    if (foreign) ffi_wrong_thread();
    return kept == nullptr ? nullptr : &kept->callback;
}

/** Release the callbacks kept for a handle whose resource was just destroyed. */
static void ffi_replaced_drop(void *key) {
    if (key == nullptr || atomic_load_explicit(&ffi_replaced_keyed, memory_order_relaxed) == 0) {
        return;
    }
    for (;;) {
        MalFfiKept *kept = nullptr;
        pthread_mutex_lock(&ffi_replaced_lock);
        for (MalFfiReplaced *site = ffi_replaced_sites; site != nullptr && kept == nullptr;
             site = site->next) {
            MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
            if (entry == nullptr) continue;
            kept = entry->kept;
            ffi_replaced_remove(site, entry);
        }
        pthread_mutex_unlock(&ffi_replaced_lock);
        // Released outside the lock: a release runs on the VM thread or queues for it.
        if (kept == nullptr) return;
        mal_ffi_release(kept);
    }
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
        ffi_finalizing = true;
        handle->type->destroy(handle->value);
        ffi_replaced_drop(handle->value);
        ffi_finalizing = false;
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
    if (handle->pins > 0) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Cannot close a C library handle while a C call uses it");
        return mal_value_new_undefined();
    }
    if (handle->value != nullptr) {
        void *value = handle->value;
        bool release = handle->owned && handle->type->destroy != nullptr;
        // Close before releasing: the library may hand out the same pointer again.
        if (handle->type->size == 0) ffi_handle_forget(handle);
        if (release) {
            handle->type->destroy(value);
            ffi_replaced_drop(value);
        }
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

static bool ffi_scope_active(MalVm *vm, u64 scope) {
    if (scope == 0) return true;
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return false;
    for (usize index = state->invocation_depth; index > 0; index--) {
        if (state->invocations[index - 1] == scope) return true;
    }
    return false;
}

bool mal_ffi_callback_enter(MalVm *vm) {
    MalFfiState *state = ffi_state(vm);
    if (state != nullptr && state->invocation_depth == state->invocation_capacity) {
        usize capacity = state->invocation_capacity == 0 ? 8 : state->invocation_capacity * 2;
        u64 *grown = realloc(state->invocations, capacity * sizeof(*grown));
        if (grown == nullptr) {
            state = nullptr;
        } else {
            state->invocations = grown;
            state->invocation_capacity = capacity;
        }
    }
    if (state == nullptr) return mal_ffi_out_of_memory(vm);
    state->invocations[state->invocation_depth++] = ++state->last_invocation;
    return true;
}

void mal_ffi_callback_leave(MalVm *vm) {
    vm->ffi->invocation_depth--;
}

/** `scope` 0 makes a handle the program holds; otherwise it lives as long as that invocation. */
static MalValue ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, u64 scope) {
    MalFfiState *state = type->size == 0 ? ffi_state(vm) : nullptr;
    MalFfiHandleObject *open = state == nullptr ? nullptr : ffi_handle_find(state, type, value);
    if (open != nullptr) {
        // One pointer, one handle: closing it through any path closes it everywhere.
        if (owned) open->owned = true;
        // A lent handle the library lends again, or returns outright, lives on with it;
        // one the program already held stays the program's.
        if (open->scope != 0) open->scope = scope;
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
    handle->pins = 0;
    handle->scope = scope;
    if (state != nullptr) ffi_handle_register(state, handle);
    mal_gc_unroot(&root);
    return mal_value_from_heap((MalHeapHeader *) handle);
}

MalValue mal_ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned) {
    return ffi_new_handle(vm, library, type, value, owned, 0);
}

MalValue mal_ffi_new_callback_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value) {
    MalFfiState *state = vm->ffi;
    u64 scope = state == nullptr || state->invocation_depth == 0
        ? 0
        : state->invocations[state->invocation_depth - 1];
    return ffi_new_handle(vm, library, type, value, false, scope);
}

bool mal_ffi_to_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin) {
    if (pin != nullptr) *pin = nullptr;
    if (nullable && mal_value_is_null(value)) {
        *out = nullptr;
        return true;
    }
    MalFfiHandleObject *handle = ffi_handle(value);
    char expectation[160];
    if (handle != nullptr && handle->type == type) {
        if (handle->value != nullptr && ffi_scope_active(vm, handle->scope)) {
            *out = handle->value;
            if (pin != nullptr) {
                handle->pins++;
                *pin = handle;
            }
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

void mal_ffi_unpin_handle(void *pin) {
    if (pin != nullptr) ((MalFfiHandleObject *) pin)->pins--;
}

bool mal_ffi_handle_closable(MalVm *vm, void *pin, const MalFfiSite *site) {
    if (pin == nullptr || ((MalFfiHandleObject *) pin)->pins == 1) return true;
    return ffi_fail(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a handle no other C call is using");
}

void mal_ffi_close_handle(MalValue value) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr) return;
    ffi_replaced_drop(handle->value);
    ffi_handle_forget(handle);
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
