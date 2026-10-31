#include "../ffi/mal_ffi.h"

#include <limits.h>
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

bool mal_ffi_to_integer(
    MalVm *vm, MalValue value, int32_t bits, bool is_signed, const MalFfiSite *site, int64_t *out) {
    if (!mal_ops_is_number(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a number");
    }
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

bool mal_ffi_to_number(
    MalVm *vm, MalValue value, const MalFfiSite *site, double *out) {
    if (!mal_ops_is_number(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a number");
    }
    *out = mal_ops_number_as_f64(value);
    return true;
}

bool mal_ffi_to_boolean(
    MalVm *vm, MalValue value, const MalFfiSite *site, bool *out) {
    if (!mal_value_is_boolean(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a boolean");
    }
    *out = mal_value_to_boolean(value);
    return true;
}

bool mal_ffi_to_string(
    MalVm *vm, MalValue value, const MalFfiSite *site, MalFfiString *out) {
    *out = (MalFfiString) {0};
    if (!mal_value_is_string(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a string");
    }
    switch (mal_string_to_utf8_c_string(mal_value_to_string(value), &out->data, &out->length)) {
        case MAL_UTF8_C_STRING_OK:
            return true;
        case MAL_UTF8_C_STRING_EMBEDDED_NUL:
            return ffi_fail(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
                "a string without NUL characters");
        case MAL_UTF8_C_STRING_ALLOCATION_FAILED:
            break;
    }
    mal_vm_throw_allocation_error(vm);
    return false;
}

void mal_ffi_string_release(MalFfiString *string) {
    free(string->data);
    *string = (MalFfiString) {0};
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

MalValue mal_ffi_undefined(void) {
    return mal_value_new_undefined();
}

MalValue mal_ffi_null(void) {
    return mal_value_new_null();
}

MalValue mal_ffi_from_boolean(bool value) {
    return mal_value_new_boolean(value);
}

MalValue mal_ffi_from_int32(int32_t value) {
    return mal_value_from_i32(value);
}

MalValue mal_ffi_from_number(double value) {
    return mal_value_from_f64_convert_nan(value);
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

/** Per-VM binding state: the shape each record type's objects share. */
typedef struct MalFfiState {
    struct {
        const MalFfiRecordType *type;
        MalShape *shape;
    } *shapes;
    usize shape_count;
    usize shape_capacity;
} MalFfiState;

static void ffi_state_free(MalVm *vm) {
    if (vm->ffi == nullptr) return;
    free(vm->ffi->shapes);
    free(vm->ffi);
    vm->ffi = nullptr;
}

/** The shape of `type`'s objects; shapes live as long as the heap's transition tree. */
static MalShape *ffi_record_shape(MalVm *vm, const MalFfiRecordType *type) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) {
        state = calloc(1, sizeof(*state));
        if (state == nullptr || !mal_vm_register_runtime_cleanup(vm, ffi_state_free)) {
            free(state);
            return nullptr;
        }
        vm->ffi = state;
    }
    for (usize index = 0; index < state->shape_count; index++) {
        if (state->shapes[index].type == type) return state->shapes[index].shape;
    }
    if (state->shape_count == state->shape_capacity) {
        usize capacity = state->shape_capacity == 0 ? 8 : state->shape_capacity * 2;
        void *grown = realloc(state->shapes, capacity * sizeof(*state->shapes));
        if (grown == nullptr) return nullptr;
        state->shapes = grown;
        state->shape_capacity = capacity;
    }
    MalString *keys[64];
    if (type->field_count > (i32) countof(keys)) return nullptr;
    for (i32 index = 0; index < type->field_count; index++) {
        keys[index] = mal_intrinsic_ascii(vm, (const byte *) type->fields[index]);
    }
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, keys, (u32) type->field_count);
    state->shapes[state->shape_count].type = type;
    state->shapes[state->shape_count].shape = shape;
    state->shape_count++;
    return shape;
}

bool mal_ffi_record_fields(
    MalVm *vm, MalValue record, const MalFfiRecordType *type, const MalFfiSite *site,
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

MalValue mal_ffi_new_record(MalVm *vm, const MalFfiRecordType *type, const MalValue *values) {
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

typedef struct MalFfiHandleObject {
    MalObject object;
    MalObjectStorage object_storage;
    const MalFfiHandleType *type;
    /** The pointer, or the malloc'd copy of a struct; null once closed. */
    void *value;
    bool owned;
} MalFfiHandleObject;

static MalFfiHandleObject *ffi_handle(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FFI_HANDLE_OBJECT)
        ? (MalFfiHandleObject *) mal_value_to_object(value)
        : nullptr;
}

/** Forget the resource without releasing it; the struct copy is freed here. */
static void ffi_handle_forget(MalFfiHandleObject *handle) {
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
        // Close before releasing: a struct copy is only borrowed by the call.
        if (handle->type->size == 0) handle->value = nullptr;
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
