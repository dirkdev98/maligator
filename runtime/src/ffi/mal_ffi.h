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

/** Free-compatible count * size storage with native alignment; overflow and allocation failure return null. */
void *mal_ffi_allocate_storage(size_t count, size_t size, size_t alignment);
/** Zero count * size bytes with native alignment; overflow and allocation failure return null. */
void *mal_ffi_calloc_storage(size_t count, size_t size, size_t alignment);

typedef struct MalVm MalVm;
typedef struct MalFfiInputs MalFfiInputs;
typedef struct MalFfiWait MalFfiWait;
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

/** Accessors a struct handle exposes for one field. */
typedef struct MalFfiField {
    const char *name;
    MalFfiFunction get;
    MalFfiFunction set;
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
    /** Guarded callable accessors shared by every prototype in a pointer-view family. */
    const MalFfiField *view_fields;
    int32_t view_field_count;
} MalFfiHandleType;

/**
 * Wrap a resource in a new handle: `value` is the pointer, or the address of the
 * struct to copy. Disposing an owned handle releases the resource; a borrowed
 * handle only closes. `fresh` asserts a new lifetime even when C reuses the
 * address of a closing handle.
 */
MalValue mal_ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, bool fresh);
/**
 * Allocate zeroed caller storage and wrap its stable pointer. Disposing or collecting
 * this handle frees the outer storage; C initialization and cleanup are explicit.
 */
MalValue mal_ffi_allocate_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    size_t size, size_t alignment);
/** Validate a native queried layout before allocating zeroed opaque caller storage. */
MalValue mal_ffi_allocate_opaque_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    uint64_t size, uint64_t alignment, const MalFfiSite *site);
/** Allocate caller storage for a trailing array, rejecting size and alignment-rounding overflow. */
MalValue mal_ffi_allocate_trailing_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    uint64_t count, size_t offset, size_t stride, size_t minimum, size_t alignment,
    const MalFfiSite *site);
/**
 * A borrowed handle for a callback argument. It reads as closed once the callback
 * returns, unless the program already held a handle for the same pointer.
 */
MalValue mal_ffi_new_callback_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value);
/** Bracket a trampoline that lends handles: the callback invocation they belong to. */
bool mal_ffi_callback_enter(MalVm *vm);
void mal_ffi_callback_leave(MalVm *vm);
/**
 * The resource behind an open handle of `type`: the pointer, or the address of
 * the copied struct, which the library may update in place. A nullable site
 * accepts null and yields a null pointer. With a non-null `pin`, the handle stays
 * open until `mal_ffi_unpin_handle` receives `*pin`: JavaScript that runs during
 * the call, in a getter or a callback, cannot close it while C uses it.
 */
bool mal_ffi_to_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin);
void mal_ffi_unpin_handle(void *pin);
/** Managed state permits one C operation at a time; aliases share that operation. */
bool mal_ffi_begin_handle_use(MalVm *vm, void *pin, const void *operation, const MalFfiSite *site);
void mal_ffi_end_handle_use(MalVm *vm, void *pin, const void *operation, const MalFfiSite *site, bool check);
bool mal_ffi_handle_idle(MalVm *vm, MalValue value, const MalFfiSite *site);
MalValue mal_ffi_state_value(MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t field, const MalFfiSite *site);
bool mal_ffi_set_state_value(MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t field, MalValue input, const MalFfiSite *site);
/** Worker pins block field reads and reject resources a callback only lends. */
bool mal_ffi_to_worker_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin);
void mal_ffi_unpin_worker_handle(void *pin);
/** Begin cleanup with the sole pin, rejecting reentry until its result is known. */
bool mal_ffi_begin_handle_close(MalVm *vm, void *pin, bool worker, const MalFfiSite *site);
/** Reject ambiguous pointer results before C can create a resource at a closing address. */
bool mal_ffi_handle_results_ready(MalVm *vm, const MalFfiHandleType *type, const MalFfiSite *site);
/** Finish cleanup, restoring a failed handle or closing a released resource. */
void mal_ffi_finish_handle_close(MalValue value, bool released);

/**
 * Fill each slot with its export. A VM materializes each export once, so every
 * image that imports the module observes the same function and constant values.
 */
void mal_ffi_install(
    MalVm *vm, const MalFfiLibrary *library, const MalHostInstallSlot *slots, int32_t count);

/** Capture a function pointer's object representation in private, GC-traced slots. */
MalValue mal_ffi_new_callable(
    MalVm *vm, const char *name, int32_t length, MalFfiFunction function,
    const void *target, size_t target_size, MalValue owner);
/** Validate the signature and pin a captured owner before argument conversion. */
bool mal_ffi_callable_target(
    MalVm *vm, MalValue callee, MalFfiFunction function, void *target,
    size_t target_size, const MalFfiHandleType *owner_type, void **owner_pin, MalValue *owner_value,
    const MalFfiSite *site);

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
/** An integer of `bits` width (1 through 64), given as a BigInt. */
bool mal_ffi_to_int64(
    MalVm *vm, MalValue value, int32_t bits, const MalFfiSite *site, int64_t *out);
bool mal_ffi_to_uint64(
    MalVm *vm, MalValue value, int32_t bits, const MalFfiSite *site, uint64_t *out);
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
/** Borrowing excludes JS reentry and pointer results; counted inputs allow embedded NUL. */
bool mal_ffi_to_string(
    MalVm *vm, MalValue value, bool nullable, uint32_t flags, const MalFfiSite *site, MalFfiString *out);
void mal_ffi_string_release(MalFfiString *string);
/** A heap copy the caller frees, for strings that outlive one conversion such as array elements. */
bool mal_ffi_to_owned_string(MalVm *vm, MalValue value, const MalFfiSite *site, char **out);

/**
 * The memory of an ArrayBuffer or view, which C may read and write until the call
 * returns. Shared buffers are rejected, and a binding resolves buffers after every
 * other argument so no JavaScript runs between this and the call. With a non-null
 * `pin`, for a call that can run callbacks, the buffer stays pinned against
 * detaching and transfer until `mal_ffi_unpin` receives `*pin`. A `writable` parameter rejects immutable
 * buffers, whose contents must never change.
 */
bool mal_ffi_to_bytes(
    MalVm *vm, MalValue value, bool nullable, bool writable, const MalFfiSite *site,
    void **data, size_t *length, void **pin);
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
    /**
     * Per field, the record type of a nested struct whose fields are all immediate
     * values, or null for an immediate field. Null for a record without nested ones.
     */
    struct MalFfiRecordType *const *nested;
} MalFfiRecordType;

/**
 * Read a nested record argument's immediate fields into `leaves`, depth first in
 * field order, when the record and every nested one is an ordinary object with its
 * record's shape. Otherwise false, with nothing thrown: the binding then reads each
 * level with `mal_ffi_record_fields`.
 */
bool mal_ffi_record_leaves(MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves);

/**
 * Read every field of a record argument into `values`, which must stay rooted
 * while the binding converts them. An ordinary object with the record's shape,
 * such as a matching object literal, is read slot by slot; any other object reads
 * each field with [[Get]].
 */
bool mal_ffi_record_fields(
    MalVm *vm, MalValue record, MalFfiRecordType *type, const MalFfiSite *site,
    MalValue *values);

/**
 * Copy own slots of exact ordinary record shapes in a dense Array, without running
 * getters or traps. False means ineligible; ignore any copied prefix and convert
 * sequentially. The caller keeps the array rooted while its slots are read.
 */
bool mal_ffi_try_record_elements(
    MalVm *vm, MalValue array, int32_t length, MalFfiRecordType *type,
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
/** Copy exactly length UTF-8 bytes, replacing invalid sequences and preserving NULs. */
MalValue mal_ffi_from_string_length(MalVm *vm, const char *value, size_t length);
typedef enum MalFfiCopyStatus {
    MAL_FFI_COPY_OK,
    MAL_FFI_COPY_RANGE,
    MAL_FFI_COPY_MEMORY,
} MalFfiCopyStatus;
/** Copy a counted callback argument on its producer thread without touching the VM. */
MalFfiCopyStatus mal_ffi_copy_callback_bytes(
    const void *source, uint64_t length, bool text, void **out);
/** Report a producer's copy failure when its message reaches the VM thread. */
void mal_ffi_callback_copy_error(MalVm *vm, MalFfiCopyStatus status);
/** Copy `length` bytes into a new Uint8Array. */
MalValue mal_ffi_from_bytes(MalVm *vm, const void *data, size_t length);
/**
 * An ordinary object for a struct passed by value, created with its final shape.
 * `values` holds one value per field and must stay rooted until this returns.
 */
MalValue mal_ffi_new_record(MalVm *vm, MalFfiRecordType *type, const MalValue *values);
/**
 * Make `object`, a compiled caller's stack object, an ordinary object of `type`'s
 * shape whose fields are `slots`, which the caller keeps rooted. False after an
 * allocation throw.
 */
bool mal_ffi_stack_record(MalVm *vm, MalFfiRecordType *type, void *object, MalValue *slots);
MalValue mal_ffi_new_array(MalVm *vm, int32_t length);
/** Store an element; both values stay rooted for the duration of the call. */
bool mal_ffi_set_element(MalVm *vm, MalValue array, int32_t index, MalValue value);
bool mal_ffi_threw(MalVm *vm);
/**
 * What a callback trampoline receives as its user data: the VM and the JavaScript
 * function, which the binding keeps rooted for the duration of the call.
 */
typedef struct MalFfiCallback {
    _Atomic(MalVm *) vm;
    MalValue function;
    const void *thread_identity;
    /** Native result copies outlive callback frames and the binding's result conversion. */
    void *results;
    bool results_accepting;
    /** A keyed registration cannot keep its own resource alive through a result. */
    void *result_owner;
} MalFfiCallback;
/** Record the owning thread before C can call a stack or retained context. */
void mal_ffi_callback_init(MalFfiCallback *callback, MalVm *vm, MalValue function);
void *mal_ffi_callback_result_copy(
    MalVm *vm, MalFfiCallback *callback, const void *source, size_t length, bool terminated,
    bool registration);
/** Lease a program-held resource and backing stores through its call or registration. */
bool mal_ffi_callback_result_handle(
    MalVm *vm, MalFfiCallback *callback, MalValue value, const MalFfiHandleType *type,
    bool nullable, bool registration, const MalFfiSite *site, void **out);
/** Retire call-scoped copies after output conversion, or a retained context's final native reference. */
void mal_ffi_callback_results_free(MalFfiCallback *callback);

/**
 * A callback context for a library that keeps the callback after the call returns.
 * It roots `function` until the library passes it to `mal_ffi_release`. Null after
 * an allocation throw.
 */
MalFfiCallback *mal_ffi_keep(MalVm *vm, MalValue function);
/** Prepare a one-shot close, rooting its handle and leasing retained backing stores. */
bool mal_ffi_close_prepare(
    MalVm *vm, MalFfiCallback *callback, MalValue handle, const void *site,
    const MalFfiSite *error);
/** Publish the close before admission; adopts the converted handle's pin. */
void mal_ffi_close_commit(MalFfiCallback *callback, void **pin, bool worker);
/** Snapshot registrations after replacement commits, immediately before C runs. */
void mal_ffi_close_start(MalFfiCallback *callback);
/** Restore VM ownership only when worker admission failed and C never received the close. */
void mal_ffi_close_cancel(MalFfiCallback *callback, void **pin);
/** Claim a completion once, retaining its context through the native callback frame. */
MalFfiCallback *mal_ffi_close_take(const void *site, void *key, MalFfiCallback *data);
MalValue mal_ffi_close_value(MalFfiCallback *callback);
/** Invalidate the wrapper and retire VM pins before running completion JavaScript. */
void mal_ffi_close_finish(MalFfiCallback *callback);
/** Retire C's ownership and the execution reference acquired by close_take. */
void mal_ffi_close_return(MalFfiCallback *callback);
/**
 * The destructor a binding hands the library for a kept callback's user data. A
 * release from another thread, or from a destroy function the collector runs, is
 * queued and completes later on the VM thread.
 */
void mal_ffi_release(void *data);
/**
 * The VM a callback runs in, or null when JavaScript cannot run: once that VM
 * is gone, or while the collector runs a handle's destroy function. Aborts when the
 * library calls back from another thread.
 */
MalVm *mal_ffi_callback_vm(MalFfiCallback *callback);
/** Keep a native invocation alive if completion retires its registry ownership. */
void mal_ffi_callback_hold(MalFfiCallback *callback);
void mal_ffi_callback_drop(MalFfiCallback *callback);
/**
 * Abort for a callback without user data that arrives outside the call it was passed
 * to, or on another thread.
 */
[[noreturn]] void mal_ffi_callback_lost(void);

typedef void (*MalFfiQueuedRun)(MalVm *vm, MalFfiCallback *callback, void *message);
typedef void (*MalFfiQueuedFree)(void *message);

/**
 * `mal_ffi_keep` for a callback the library may also call from other threads, whose
 * calls then queue for the VM thread. Needs an event loop, which waits while any such
 * callback is kept. Null after a throw.
 */
MalFfiCallback *mal_ffi_keep_queued(MalVm *vm, MalValue function);
/** Whether a call of the callback arrives on its VM's thread, or once that VM is gone. */
bool mal_ffi_callback_here(MalFfiCallback *callback);
/**
 * Reserve a queued call of a callback with user data, which keeps the context alive
 * until `mal_ffi_callback_queue` consumes the reservation. `mal_ffi_replaced`
 * reserves for callbacks without user data, under the lock their setters take.
 */
void mal_ffi_callback_reserve(MalFfiCallback *callback);
/**
 * From another thread: queue `run(vm, callback, message)` for the VM thread, which
 * frees the message with `release` afterwards. Consumes the reservation and the
 * message, which may be null when copying it failed; false when the call was dropped.
 */
bool mal_ffi_callback_queue(
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release);
/**
 * Consume a reservation and message, waiting on a foreign thread for successful VM
 * execution. The returned request retains the message until its explicit release,
 * including on cancellation. Read result storage only after success. The generated
 * entry disables cancellation until its request and native references retire.
 * Release a non-null request even when waiting returns false.
 */
bool mal_ffi_callback_wait(
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release,
    MalFfiWait **request);
void mal_ffi_callback_wait_release(MalFfiWait *request);
int mal_ffi_callback_wait_enter(void);
void mal_ffi_callback_wait_leave(int cancellation_state);
/** Cancel waiting callbacks before joining any thread that might be producing one. */
void mal_ffi_callbacks_shutdown(MalVm *vm);

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

/**
 * Reserve a setter's key without changing its current callback. On success the
 * transaction owns the callback's base reference and remains at this address until
 * finish. The binding selects its trampoline using `lane`; another setter for the
 * reserved key throws. A failed preparation leaves ownership with the caller.
 */
bool mal_ffi_replace_prepare(
    MalVm *vm, MalFfiReplaced *site, void *key, MalFfiCallback *callback,
    MalFfiReplacement *replacement);
/** Publish the prepared callback immediately before C runs, without touching the VM. */
void mal_ffi_replace_commit(MalFfiReplacement *replacement);
/** End previous result publications at C return; native references retire at finish. */
void mal_ffi_replace_return(MalFfiReplacement *replacement);
/** Retire the previous callback, or the unsubmitted callback, after C stops using it. */
void mal_ffi_replace_finish(MalFfiReplacement *replacement);
/**
 * The callback `site` keeps for `key`, for a trampoline that receives no user data,
 * or null. When it belongs to a VM on another thread, a queued callback's call is
 * reserved, and any other aborts. A nonnull result owns an execution reference
 * that the entry wrapper retires with `mal_ffi_callback_drop` after returning or
 * handing its separate queued reservation to the inbox.
 */
MalFfiCallback *mal_ffi_replaced(MalFfiReplaced *site, void *key, unsigned lane);
/**
 * Bracket a C call that may run JavaScript when the binding runs as an ordinary
 * native call, which keeps the collector off: everything the binding holds is
 * rooted, so the collector may run inside callbacks instead of letting a
 * long-running call grow the heap. The end also completes queued releases.
 */
void mal_ffi_collectable_begin(MalVm *vm);
void mal_ffi_collectable_end(MalVm *vm);

typedef void (*MalFfiAsyncRun)(void *data);
typedef MalValue (*MalFfiAsyncComplete)(MalVm *vm, void *data, bool ran);
typedef void (*MalFfiAsyncRelease)(void *data);

/**
 * Run `run(data)` on a blocking worker thread, then `complete(vm, data, ran)` on the
 * VM thread: its value fulfills `*promise`, its throw rejects it. `ran` is false when
 * the work was cancelled before it ran; complete still releases what the call held.
 * Teardown calls `complete` with false to retire pins without reading worker state;
 * producers may still be running until the host joins them. `release(data)` frees
 * the data on the owning VM thread after both sides retire it, including a producer
 * joined during shutdown. `keep` and compound input values stay rooted through
 * result conversion and release; shutdown disables collection until heap teardown.
 * Callback contexts remain native until the worker retires. Unhandled callback
 * errors reject this promise; nested JavaScript catches keep their normal behavior.
 * False with a pending throw, leaving `data` to the caller.
 */
bool mal_ffi_async(
    MalVm *vm, void *data, MalFfiAsyncRun run, MalFfiAsyncComplete complete,
    MalFfiAsyncRelease release, const MalValue *keep, int32_t keep_count,
    const MalFfiInputs *inputs, MalFfiCallback *const *callbacks, int32_t callback_count,
    MalValue *promise, bool must_run);
/** A promise rejected with the pending throw, which this clears. */
MalValue mal_ffi_rejected(MalVm *vm);

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

/** Resources nested in compound inputs stay rooted and pinned through the call. */
struct MalFfiInputs {
    MalFfiRoots roots;
    MalValue *values;
    int32_t count;
    int32_t capacity;
    const void *operation;
    bool worker;
    bool rooted;
};

void mal_ffi_inputs_init(MalFfiInputs *inputs, const void *operation, bool worker);
void mal_ffi_inputs_unroot(MalFfiInputs *inputs);
void mal_ffi_inputs_release(MalVm *vm, MalFfiInputs *inputs, const MalFfiSite *site, bool check);
bool mal_ffi_input_handle(MalVm *vm, MalFfiInputs *inputs, MalValue value,
    const MalFfiHandleType *type, bool nullable, const MalFfiSite *site, void **out);

#endif
