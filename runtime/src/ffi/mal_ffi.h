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
#include <stdatomic.h>

typedef struct MalVm MalVm;
typedef struct MalFfiInputs MalFfiInputs;
typedef struct MalFfiWait MalFfiWait;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;
typedef uint64_t MalValue;

/** A synchronous call's private numeric snapshots; active calls never share storage. */
typedef struct MalFfiScratch {
    void *data;
    size_t capacity;
    size_t used;
} MalFfiScratch;

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

/** How a property load reads a scalar field without calling its getter. */
typedef enum MalFfiFieldScalar {
    /** Only the getter reads the field. */
    MAL_FFI_FIELD_CALL,
    MAL_FFI_FIELD_BOOL,
    MAL_FFI_FIELD_INT8,
    MAL_FFI_FIELD_UINT8,
    MAL_FFI_FIELD_INT16,
    MAL_FFI_FIELD_UINT16,
    MAL_FFI_FIELD_INT32,
    MAL_FFI_FIELD_UINT32,
    MAL_FFI_FIELD_FLOAT,
    MAL_FFI_FIELD_DOUBLE,
} MalFfiFieldScalar;

/** Accessors a struct handle exposes for one field. */
typedef struct MalFfiField {
    const char *name;
    MalFfiFunction get;
    MalFfiFunction set;
    /** For a scalar field, its offset in the handle's storage, read as `scalar` describes. */
    uint32_t offset;
    uint8_t scalar;
} MalFfiField;

typedef struct MalFfiManagedField {
    const char *name;
    bool (*read)(void *storage, void **data, size_t *length);
    void (*write)(void *storage, void *data, size_t length);
    int32_t count_bits;
    bool count_signed;
    bool writable;
    bool text;
} MalFfiManagedField;

/** Native access to a process-global pointer and its optional byte count. */
typedef struct MalFfiGlobal {
    const void *key;
    const void *count_key;
    bool (*read)(void **data, size_t *length);
    void (*write)(void *data, size_t length);
    int32_t count_bits;
    bool count_signed;
    bool text;
} MalFfiGlobal;

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
    /** Alignment of copied structs, or 0 when the handle holds a pointer. */
    size_t alignment;
    /** Release the resource; true means it is closed. May be null. */
    bool (*destroy)(void *value);
    const char *destroy_name;
    bool destroy_can_fail;
    /** Whether collection releases an owned handle the program never closed. */
    bool collect;
    /** Every view in this family can represent a resource borrowed from another handle. */
    bool borrows_owner;
    /** A field can assert process lifetime for a resource in this pointer family. */
    bool library_lifetime;
    const MalFfiField *fields;
    int32_t field_count;
    /**
     * Shared registry key; compatibility remains directed through views. Null for
     * a singleton type, so bindings can eliminate compatible-view lookup.
     */
    const struct MalFfiHandleType *family;
    const struct MalFfiHandleType *const *views;
    int32_t view_count;
    const MalFfiManagedField *managed_fields;
    int32_t managed_field_count;
    /** Guarded accessors shared by every prototype in a pointer-view family. */
    const MalFfiField *view_fields;
    int32_t view_field_count;
} MalFfiHandleType;

typedef struct MalFfiDiscardState MalFfiDiscardState;
typedef struct MalFfiDiscardedHandle {
    const MalFfiHandleType *family;
    const void *value;
    bool claimed;
} MalFfiDiscardedHandle;
typedef struct MalFfiDiscards {
    MalFfiDiscardState *state;
    MalFfiDiscardedHandle *items;
    int32_t count;
    int32_t capacity;
} MalFfiDiscards;

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

/** Encoded strings that fit stay in the binding's frame instead of the heap. */
#define MAL_FFI_STRING_INLINE 256
/** Bytes of C elements an array argument keeps in the binding's frame before using the heap. */
#define MAL_FFI_ARRAY_INLINE 256

/**
 * UTF-8 bytes owned by the binding or borrowed for a nonreentrant readonly call.
 * Only `data` needs initializing, to null: zeroing the inline buffer would cost
 * more than the copy. A short string points into the struct, so it must not move
 * while in use.
 */
typedef struct MalFfiString {
    char *data;
    size_t length;
    // Ownership is only consulted for non-inline data, which leaves this buffer unused.
    union {
        char inline_data[MAL_FFI_STRING_INLINE];
        bool borrowed;
    };
} MalFfiString;

enum { MAL_FFI_STRING_COUNTED = 1, MAL_FFI_STRING_BORROW = 2 };

/**
 * Encoded strings of one array input, packed into shared blocks that stay put until
 * `mal_ffi_texts_free`. Zero-initialize before the first `mal_ffi_texts_add`.
 */
typedef struct MalFfiTexts {
    struct MalFfiTextBlock *blocks;
} MalFfiTexts;

typedef enum MalFfiNumericKind {
    MAL_FFI_NUMERIC_INT8, MAL_FFI_NUMERIC_UINT8,
    MAL_FFI_NUMERIC_INT16, MAL_FFI_NUMERIC_UINT16,
    MAL_FFI_NUMERIC_INT32, MAL_FFI_NUMERIC_UINT32,
    MAL_FFI_NUMERIC_BIGINT64, MAL_FFI_NUMERIC_BIGUINT64,
    MAL_FFI_NUMERIC_FLOAT32, MAL_FFI_NUMERIC_FLOAT64,
} MalFfiNumericKind;

/**
 * The fields of a struct passed by value, in declaration order. Bindings declare it
 * mutable and zero `slot`: the runtime numbers each type on first use, so a VM finds
 * the type's object shape by index.
 */
typedef struct MalFfiRecordType {
    const char *const *fields;
    int32_t field_count;
    _Atomic int32_t slot;
    /**
     * Per field, the record type of a nested struct whose fields are all immediate
     * values, or null for an immediate field. Null for a record without nested ones.
     */
    struct MalFfiRecordType *const *nested;
} MalFfiRecordType;

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

typedef enum MalFfiCopyStatus {
    MAL_FFI_COPY_OK,
    MAL_FFI_COPY_RANGE,
    MAL_FFI_COPY_MEMORY,
} MalFfiCopyStatus;

/**
 * What a callback trampoline receives as its user data: the VM and the JavaScript
 * function, which the binding keeps rooted for the duration of the call.
 */
typedef struct MalFfiCallback {
    _Atomic(MalVm *) vm;
    MalValue function;
    /** Undefined for independent callbacks; null after their destruction owner retires. */
    MalValue owner;
    const void *thread_identity;
    /** Native result copies outlive callback frames and the binding's result conversion. */
    void *results;
    /** Borrowed inputs and their roots stay open until a retained context retires. */
    void *inputs;
    bool results_accepting;
    /** A keyed registration cannot keep its own resource alive through a result. */
    void *result_owner;
} MalFfiCallback;

// The operation token permits snapshotting this call's pinned state before C starts.

typedef void (*MalFfiQueuedRun)(MalVm *vm, MalFfiCallback *callback, void *message);
typedef void (*MalFfiQueuedFree)(void *message);

/**
 * The kept callbacks of one setter parameter whose next call replaces the callback,
 * one per key: null for a setter that configures the whole library, or the pointer
 * of the handle it configures. A binding declares one zero-initialized static per
 * such parameter; the runtime owns the fields.
 */
typedef struct MalFfiReplaced {
    struct MalFfiReplaced *next;
    void *entries;
    size_t count;
    size_t capacity;
} MalFfiReplaced;

typedef struct MalFfiReplacement {
    MalFfiReplaced *site;
    void *key;
    MalFfiCallback *callback;
    unsigned lane;
    bool committed;
} MalFfiReplacement;

typedef void (*MalFfiAsyncRun)(void *data);
typedef MalValue (*MalFfiAsyncComplete)(MalVm *vm, void *data, bool ran);
typedef void (*MalFfiAsyncRelease)(void *data);

/**
 * Keep values reachable while later allocations run. The layout matches the
 * runtime's root span; unroot in reverse order before returning.
 */
typedef struct MalFfiRoots {
    struct MalFfiRoots *prev;
    MalValue *slots;
    int32_t count;
} MalFfiRoots;

typedef struct MalFfiResultClaim {
    const MalFfiHandleType *type;
    const MalFfiHandleType *owner_type;
    void *value;
    void *views;
    MalValue *handles;
    uint32_t flags;
    bool fresh;
    bool cleanup;
    bool handed_off;
    bool inventoried;
} MalFfiResultClaim;

typedef struct MalFfiResults {
    MalFfiRoots roots;
    MalFfiResultClaim *claims;
    struct MalFfiResults *previous;
    void *state;
    void *allocation;
    int32_t *lookup;
    size_t lookup_capacity;
    int32_t count;
    int32_t capacity;
} MalFfiResults;

/**
 * Resources nested in compound inputs stay rooted and pinned through the call. The
 * first few pin into inline slots; like the root span, the struct stays in place
 * from initialization until release.
 */
struct MalFfiInputs {
    MalFfiRoots roots;
    MalValue *values;
    int32_t count;
    int32_t capacity;
    const void *operation;
    bool worker;
    bool rooted;
    MalValue inline_values[8];
};

#ifdef MAL_FFI_BUILD_SHIM
#define MAL_FFI_FUNCTION(name, result, attributes, parameters) [[maybe_unused]] static result (*name) parameters;
#define MAL_FFI_GLOBAL(name, type) [[maybe_unused]] static type *name;
#else
#define MAL_FFI_FUNCTION(name, result, attributes, parameters) attributes result name parameters;
#define MAL_FFI_GLOBAL(name, type) extern type name;
#endif
#include "mal_ffi_api.h"
#undef MAL_FFI_GLOBAL
#undef MAL_FFI_FUNCTION

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

/**
 * Complete queued releases after a direct entry's C call, as `mal_ffi_collectable_end`
 * does for an ordinary call, so they still run after the VM thread's next C call.
 */
static inline void mal_ffi_direct_leave(MalVm *vm) {
#ifdef MAL_FFI_BUILD_SHIM
    _Atomic uint32_t *queued_releases = mal_ffi_queued_releases;
#else
    _Atomic uint32_t *queued_releases = &mal_ffi_queued_releases;
#endif
    if (__builtin_expect(atomic_load_explicit(queued_releases, memory_order_relaxed) != 0, 0))
        mal_ffi_direct_releases(vm);
}

#endif
