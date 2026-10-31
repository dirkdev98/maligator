#ifndef MAL_FFI_H
#define MAL_FFI_H

/*
 * The interface generated C library bindings compile against. It declares only
 * `Mal`-prefixed names over standard headers, so a binding unit can include a
 * library's headers without the runtime's own headers in the same unit. Binding
 * units compile as C23.
 *
 * Conversions never coerce: a value of the wrong type throws a TypeError and an
 * out-of-range or non-integral number throws a RangeError, each naming its site.
 * After a conversion returns false, the binding returns any value and the pending
 * throw propagates.
 */

#include <stddef.h>
#include <stdint.h>

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;
typedef uint64_t MalValue;

typedef MalValue (*MalFfiFunction)(
    MalVm *vm, MalValue this_value, const MalValue *args, int32_t arg_count,
    MalValue new_target, MalValue callee);
typedef void (*MalFfiInstaller)(
    MalVm *vm, const MalHostInstallSlot *slots, int32_t count,
    const MalHostLaunchContext *launch);

/** Where a conversion happens, for error messages. */
typedef struct MalFfiSite {
    const char *function;
    const char *parameter;
    /** The struct field being converted, or null for the parameter itself. */
    const char *field;
} MalFfiSite;

/** One module export; exactly one of `function` and `constant` is set. */
typedef struct MalFfiExport {
    const char *name;
    /** The function's `length`. */
    int32_t length;
    MalFfiFunction function;
    /** Evaluates the C constant expression when the export is first installed. */
    MalValue (*constant)(MalVm *vm);
} MalFfiExport;

typedef struct MalFfiLibrary {
    /** The module specifier, such as `maligator:ffi/raylib`. */
    const char *specifier;
    /** Sorted by name in byte order. */
    const MalFfiExport *exports;
    int32_t export_count;
} MalFfiLibrary;

/** A read-only accessor a struct handle exposes for one value field. */
typedef struct MalFfiField {
    const char *name;
    MalFfiFunction get;
} MalFfiField;

/**
 * A C type whose values are resources the program opens and closes. A handle
 * holds either the pointer the library returned or a copy of a struct the
 * library passes by value. A closed handle throws instead of reaching C.
 */
typedef struct MalFfiHandleType {
    /** The C type name, for messages and `Symbol.toStringTag`. */
    const char *name;
    /** Bytes of the struct a handle copies, or 0 for a handle that holds a pointer. */
    size_t size;
    /** Release the resource; receives the pointer or the struct's address. May be null. */
    void (*destroy)(void *value);
    /** Whether collection releases an owned handle the program never closed. */
    bool collect;
    const MalFfiField *fields;
    int32_t field_count;
} MalFfiHandleType;

/**
 * Wrap a resource in a new handle: `value` is the pointer, or the address of the
 * struct to copy. Disposing an owned handle releases the resource; a borrowed
 * handle only closes.
 */
MalValue mal_ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned);
/**
 * The resource behind an open handle of `type`: the pointer, or the address of
 * the copied struct, which the library may update in place. A nullable site
 * accepts null and yields a null pointer.
 */
bool mal_ffi_to_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out);
/** Close a handle whose resource the library's destroy function just released. */
void mal_ffi_close_handle(MalValue value);

/**
 * Fill each slot with its export. A VM materializes each export once, so every
 * image that imports the module observes the same function and constant values.
 */
void mal_ffi_install(
    MalVm *vm, const MalFfiLibrary *library, const MalHostInstallSlot *slots, int32_t count);

/** Resolve an installer by symbol name for images loaded from the wire format. */
MalFfiInstaller mal_ffi_resolve_installer(const char *name, size_t length);

/*
 * The runtime's value encoding, so scalar conversions inline into every binding: a
 * double is its own bits below the tag base, an int32 sits in the low half under
 * its class tag, and the singletons are fixed values. mal_ffi.c asserts that these
 * match the runtime's definitions.
 */
#define MAL_FFI_VALUE_TAG_BASE UINT64_C(0xFFF8000000000000)
#define MAL_FFI_VALUE_CLASS_MASK UINT64_C(0xFFFF000000000000)
#define MAL_FFI_VALUE_INT32 UINT64_C(0xFFF8000000000000)
#define MAL_FFI_VALUE_NULL UINT64_C(0xFFF9000000000002)
#define MAL_FFI_VALUE_UNDEFINED UINT64_C(0xFFF9000000000003)
#define MAL_FFI_VALUE_TRUE UINT64_C(0xFFF9000000000004)
#define MAL_FFI_VALUE_FALSE UINT64_C(0xFFF9000000000005)
#define MAL_FFI_VALUE_NAN UINT64_C(0x7FF8000000000000)

/** Throw a TypeError naming what the site expects; returns false. */
bool mal_ffi_expected(MalVm *vm, const MalFfiSite *site, const char *expectation);
/** The general case of `mal_ffi_to_integer`, for any value. */
bool mal_ffi_number_to_integer(
    MalVm *vm, MalValue value, int32_t bits, bool is_signed, const MalFfiSite *site, int64_t *out);

/** An exact integer of at most 32 bits, given as a Number. */
static inline bool mal_ffi_to_integer(
    MalVm *vm, MalValue value, int32_t bits, bool is_signed, const MalFfiSite *site,
    int64_t *out) {
    if ((value & MAL_FFI_VALUE_CLASS_MASK) == MAL_FFI_VALUE_INT32) {
        int64_t integer = (int32_t) (uint32_t) value;
        int64_t minimum = is_signed ? -(INT64_C(1) << (bits - 1)) : 0;
        int64_t maximum = is_signed ? (INT64_C(1) << (bits - 1)) - 1 : (INT64_C(1) << bits) - 1;
        if (integer >= minimum && integer <= maximum) {
            *out = integer;
            return true;
        }
    }
    return mal_ffi_number_to_integer(vm, value, bits, is_signed, site, out);
}
/** A 64-bit integer, given as a BigInt. */
bool mal_ffi_to_int64(
    MalVm *vm, MalValue value, const MalFfiSite *site, int64_t *out);
bool mal_ffi_to_uint64(
    MalVm *vm, MalValue value, const MalFfiSite *site, uint64_t *out);
static inline bool mal_ffi_to_number(
    MalVm *vm, MalValue value, const MalFfiSite *site, double *out) {
    if (value < MAL_FFI_VALUE_TAG_BASE) {
        __builtin_memcpy(out, &value, sizeof(*out));
        return true;
    }
    if ((value & MAL_FFI_VALUE_CLASS_MASK) == MAL_FFI_VALUE_INT32) {
        *out = (int32_t) (uint32_t) value;
        return true;
    }
    return mal_ffi_expected(vm, site, "a number");
}

static inline bool mal_ffi_to_boolean(
    MalVm *vm, MalValue value, const MalFfiSite *site, bool *out) {
    if (value != MAL_FFI_VALUE_TRUE && value != MAL_FFI_VALUE_FALSE) {
        return mal_ffi_expected(vm, site, "a boolean");
    }
    *out = value == MAL_FFI_VALUE_TRUE;
    return true;
}

/** Encoded strings that fit stay in the binding's frame instead of the heap. */
#define MAL_FFI_STRING_INLINE 256
/** Bytes of C elements an array argument keeps in the binding's frame before using the heap. */
#define MAL_FFI_ARRAY_INLINE 256

/**
 * A UTF-8, NUL-terminated copy the binding owns until `mal_ffi_string_release`.
 * Only `data` needs initializing, to null: zeroing the inline buffer would cost
 * more than the copy. A short string points into the struct, so it must not move
 * while in use.
 */
typedef struct MalFfiString {
    char *data;
    size_t length;
    char inline_data[MAL_FFI_STRING_INLINE];
} MalFfiString;

/** Strings with an embedded NUL throw instead of truncating. */
bool mal_ffi_to_string(
    MalVm *vm, MalValue value, const MalFfiSite *site, MalFfiString *out);
void mal_ffi_string_release(MalFfiString *string);
/** A heap copy the caller frees, for strings that outlive one conversion such as array elements. */
bool mal_ffi_to_owned_string(MalVm *vm, MalValue value, const MalFfiSite *site, char **out);

/**
 * The memory of an ArrayBuffer or view, which C may read and write until the call
 * returns. Shared buffers are rejected, and a binding resolves buffers after every
 * other argument so no JavaScript runs between this and the call. The buffer stays
 * pinned against detaching and transfer, including by JavaScript a callback runs,
 * until `mal_ffi_unpin` receives `pin`.
 */
bool mal_ffi_to_bytes(
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, void **data,
    size_t *length, void **pin);
/** Release a pin from `mal_ffi_to_bytes`; null is ignored. */
void mal_ffi_unpin(void *pin);
/** The element count of an array argument; null yields 0 for a nullable site. */
bool mal_ffi_to_array_length(
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, int32_t *length);
/** Check that a buffer or array count fits the C integer parameter that carries it. */
bool mal_ffi_check_count(
    MalVm *vm, size_t count, int32_t bits, bool is_signed, const MalFfiSite *site);

/**
 * The fields of a struct passed by value, in declaration order. Bindings declare it
 * mutable and zero `slot`: the runtime numbers each type on first use, so a VM finds
 * the type's object shape by index.
 */
typedef struct MalFfiRecordType {
    const char *const *fields;
    int32_t field_count;
    _Atomic int32_t slot;
} MalFfiRecordType;

/**
 * Read every field of a record argument into `values`, which must stay rooted
 * while the binding converts them. An ordinary object with the record's shape,
 * such as a matching object literal, is read slot by slot; any other object reads
 * each field with [[Get]].
 */
bool mal_ffi_record_fields(
    MalVm *vm, MalValue record, MalFfiRecordType *type, const MalFfiSite *site,
    MalValue *values);

/** Read element `index` of an array that must have exactly `length` elements. */
bool mal_ffi_element(
    MalVm *vm, MalValue array, int32_t index, int32_t length, const MalFfiSite *site, MalValue *out);

static inline MalValue mal_ffi_undefined(void) {
    return MAL_FFI_VALUE_UNDEFINED;
}

static inline MalValue mal_ffi_null(void) {
    return MAL_FFI_VALUE_NULL;
}

static inline MalValue mal_ffi_from_boolean(bool value) {
    return value ? MAL_FFI_VALUE_TRUE : MAL_FFI_VALUE_FALSE;
}

static inline MalValue mal_ffi_from_int32(int32_t value) {
    return MAL_FFI_VALUE_INT32 | (uint32_t) value;
}

/** Every NaN becomes the canonical one, since other NaN bits would read as tagged values. */
static inline MalValue mal_ffi_from_number(double value) {
    if (value != value) return MAL_FFI_VALUE_NAN;
    MalValue bits;
    __builtin_memcpy(&bits, &value, sizeof(bits));
    return bits;
}

/** BigInt results allocate and may throw an allocation error. */
MalValue mal_ffi_from_int64(MalVm *vm, int64_t value);
MalValue mal_ffi_from_uint64(MalVm *vm, uint64_t value);
/** Copy a NUL-terminated UTF-8 string, replacing malformed sequences; NULL yields null. */
MalValue mal_ffi_from_string(MalVm *vm, const char *value);
/** Copy `length` bytes into a new Uint8Array. */
MalValue mal_ffi_from_bytes(MalVm *vm, const void *data, size_t length);
/**
 * An ordinary object for a struct passed by value, created with its final shape.
 * `values` holds one value per field and must stay rooted until this returns.
 */
MalValue mal_ffi_new_record(MalVm *vm, MalFfiRecordType *type, const MalValue *values);
MalValue mal_ffi_new_array(MalVm *vm, int32_t length);
/** Store an element; both values stay rooted for the duration of the call. */
bool mal_ffi_set_element(MalVm *vm, MalValue array, int32_t index, MalValue value);
bool mal_ffi_threw(MalVm *vm);
/**
 * What a callback trampoline receives as its user data: the VM and the JavaScript
 * function, which the binding keeps rooted for the duration of the call.
 */
typedef struct MalFfiCallback {
    MalVm *vm;
    MalValue function;
} MalFfiCallback;

/** Check that a callback argument is callable; null passes for a nullable site. */
bool mal_ffi_to_function(MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site);
/**
 * Call a callback's JavaScript function with `args`, which must stay rooted. Returns
 * false with a pending throw that later callbacks of the call see through `mal_ffi_threw`.
 */
bool mal_ffi_call(
    MalVm *vm, MalValue function, const MalValue *args, int32_t count, MalValue *result);
/** Throw the engine's allocation error after a binding's own allocation failed. */
bool mal_ffi_out_of_memory(MalVm *vm);

/**
 * Keep values reachable while later allocations run. The layout matches the
 * runtime's root span; unroot in reverse order before returning.
 */
typedef struct MalFfiRoots {
    struct MalFfiRoots *prev;
    MalValue *slots;
    int32_t count;
} MalFfiRoots;

void mal_ffi_root(MalFfiRoots *roots, MalValue *slots, int32_t count);
void mal_ffi_unroot(MalFfiRoots *roots);

#endif
