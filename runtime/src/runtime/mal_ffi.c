#include "../ffi/mal_ffi.h"

#include <limits.h>
#include <stdarg.h>
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

/**
 * `ffi_fail` with a formatted expectation. Kept out of line: its buffer would give
 * every conversion that can fail a large, canary-checked frame.
 */
static __attribute__((noinline, format(printf, 4, 5))) bool ffi_failf(
    MalVm *vm, MalIntrinsic prototype, const MalFfiSite *site, const char *format, ...) {
    char expectation[160];
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(expectation, sizeof(expectation), format, arguments);
    va_end(arguments);
    return ffi_fail(vm, prototype, site, expectation);
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
        return ffi_failf(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "an integer from %lld to %lld",
            (long long) minimum, (long long) maximum);
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
    MalVm *vm, MalValue value, bool nullable, bool counted, const MalFfiSite *site, MalFfiString *out) {
    out->data = nullptr;
    out->length = 0;
    if (nullable && mal_value_is_null(value)) return true;
    if (!mal_value_is_string(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, nullable ? "a string or null" : "a string");
    }
    const MalString *string = mal_value_to_string(value);
    // A UTF-16 code unit encodes to at most three bytes; a pair's four cover two units.
    usize units = mal_string_length(string);
    char *data = out->inline_data;
    usize capacity = sizeof(out->inline_data);
    // ASCII can fit inline even when UTF-8's worst-case expansion would require a heap copy.
    if (units >= capacity) {
        data = units > (SIZE_MAX - 1) / 3 ? nullptr : malloc(units * 3 + 1);
        if (data == nullptr) return mal_ffi_out_of_memory(vm);
        capacity = units * 3 + 1;
    }
    usize length = 0;
    bool encoded = false;
    bool nul = false;
    if (units != 0 && string->latin1 && string->storage < MAL_STRING_STORAGE_DEPENDENT) {
        // A flat ASCII string is its own UTF-8: one pass copies it and checks for high
        // bytes and NULs. Otherwise the general encoder overwrites the copy.
        MalStringSegment segment = mal_string_flat_segment((MalString *) string);
        u8 high = 0;
        u8 zero = 0;
        for (usize index = 0; index < units; index++) {
            u8 unit = segment.latin1_units[index];
            high |= unit;
            zero |= unit == 0;
            data[index] = (char) unit;
        }
        if (high < 0x80) {
            length = units;
            encoded = true;
            nul = zero != 0;
        }
    }
    if (!encoded) {
        if (units > (capacity - 1) / 3) {
            data = units > (SIZE_MAX - 1) / 3 ? nullptr : malloc(units * 3 + 1);
            if (data == nullptr) return mal_ffi_out_of_memory(vm);
            capacity = units * 3 + 1;
        }
        mal_string_utf8_encode_into(string, (byte *) data, capacity, nullptr, &length);
        // NUL is the only code point whose UTF-8 encoding contains a zero byte.
        nul = memchr(data, 0, length) != nullptr;
    }
    data[length] = '\0';
    out->data = data;
    out->length = length;
    if (nul && !counted) {
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
    if (!mal_ffi_to_string(vm, value, false, false, site, &string)) return false;
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

__attribute__((always_inline)) bool mal_ffi_to_bytes(
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
    return ffi_failf(
        vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "at most %llu elements",
        (unsigned long long) maximum);
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
        return ffi_failf(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "an array of %d elements", (int) length);
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

MalValue mal_ffi_from_string_length(MalVm *vm, const char *value, size_t length) {
    if (value == nullptr) return mal_value_new_null();
    if (length > 3 * MAL_STRING_MAX_CODE_UNITS) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "C string is too large");
        return mal_value_new_undefined();
    }
    MalUtf8DecodeStatus status;
    MalString *string = mal_string_from_utf8_report(
        &vm->heap, (const byte *) value, length, nullptr, &status);
    if (string == nullptr) {
        if (status == MAL_UTF8_DECODE_LENGTH_OVERFLOW)
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "C string is too large");
        else mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

MalFfiCopyStatus mal_ffi_copy_callback_bytes(
    const void *source, uint64_t length, bool text, void **out) {
    *out = nullptr;
    if (source == nullptr) return MAL_FFI_COPY_OK;
    uint64_t limit = text ? 3 * MAL_STRING_MAX_CODE_UNITS : INT32_MAX;
    if (length > limit || length > SIZE_MAX) return MAL_FFI_COPY_RANGE;
    void *copy = malloc(length == 0 ? 1 : (size_t) length);
    if (copy == nullptr) return MAL_FFI_COPY_MEMORY;
    memcpy(copy, source, (size_t) length);
    *out = copy;
    return MAL_FFI_COPY_OK;
}

void mal_ffi_callback_copy_error(MalVm *vm, MalFfiCopyStatus status) {
    if (status == MAL_FFI_COPY_RANGE)
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "C callback byte count is out of range");
    else if (status == MAL_FFI_COPY_MEMORY) mal_vm_throw_allocation_error(vm);
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

typedef struct MalFfiHandleView {
    const MalFfiHandleType *type;
    struct MalFfiHandleView *next;
} MalFfiHandleView;

typedef struct MalFfiRetainedField {
    MalValue buffer;
    MalArrayBufferPin *pin;
    void *data;
    usize length;
} MalFfiRetainedField;

typedef struct MalFfiHandleObject {
    MalObject object;
    MalObjectStorage object_storage;
    const MalFfiHandleType *type;
    /** View observations cannot replace the policy acquired with ownership. */
    const MalFfiHandleType *owner_type;
    MalFfiHandleView *views;
    MalFfiRetainedField *retained;
    const void *operation;
    /** Stable C storage, or the library's pointer; null once closed. */
    void *value;
    bool owned;
    /** Outer storage belongs to this wrapper, independently of C resource ownership. */
    bool owns_storage;
    /** Cleanup is in progress; callbacks cannot use or close this resource. */
    bool closing;
    bool worker_closing;
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

typedef struct MalFfiClose {
    struct MalFfiClose *next;
    const void *site;
    MalFfiCallback *callback;
    void *key;
    MalValue handle;
    const void *operation;
    u64 scope;
    void *storage;
    MalArrayBufferStoreLease **stores;
    i32 store_count;
    u64 callback_identity;
    bool committed;
} MalFfiClose;

typedef struct MalFfiAsyncGroup {
    _Atomic u32 references;
    MalVm *vm;
    MalValue error;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    bool failed;
    bool active;
} MalFfiAsyncGroup;

static MAL_ISOLATE_LOCAL MalFfiAsyncGroup *ffi_worker_group;

static void ffi_group_release(MalFfiAsyncGroup *group) {
    if (group != nullptr
        && atomic_fetch_sub_explicit(&group->references, 1, memory_order_acq_rel) == 1)
        free(group);
}

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
    /** The library may call from other threads; those calls queue for the VM thread. */
    bool queued;
    /** Released while calls still waited in the queue; the last of them completes it. */
    bool released;
    _Atomic u32 waiting;
    /** Queued messages can outlive both VM detach and C's final release. */
    _Atomic u32 references;
    MalFfiClose *close;
    /** Only its VM reads this association; worker posts carry a separate native reference. */
    MalFfiAsyncGroup *group;
} MalFfiKept;

static void ffi_close_free(MalFfiClose *close);
static void ffi_close_detach(MalFfiKept *kept);

static void ffi_kept_unref(MalFfiKept *kept) {
    if (atomic_fetch_sub_explicit(&kept->references, 1, memory_order_acq_rel) == 1) {
        ffi_close_free(kept->close);
        free(kept);
    }
}

/**
 * Collected handles may release callbacks, whose VM roots can change only after
 * collection. A library callback cannot enter JavaScript while this is set.
 */
static _Thread_local bool ffi_finalizing;

typedef struct MalFfiHandleEntry {
    const MalFfiHandleType *type;
    void *pointer;
    /** Null for an empty slot. */
    MalFfiHandleObject *handle;
} MalFfiHandleEntry;

enum {
    MAL_FFI_ASYNC_QUEUED,
    MAL_FFI_ASYNC_RUNNING,
    MAL_FFI_ASYNC_FINISHED,
    MAL_FFI_ASYNC_CANCELLED,
};

typedef struct MalFfiAsyncPayload {
    struct MalFfiAsyncPayload *next;
    _Atomic u32 references;
    _Atomic int phase;
    bool must_run;
    void *data;
    MalFfiAsyncRun run;
    MalFfiAsyncRelease release;
    MalFfiAsyncGroup *group;
    MalFfiCallback **callbacks;
    i32 callback_count;
} MalFfiAsyncPayload;
static void ffi_async_release(void *data);
static void ffi_async_cancel_queued(MalVm *vm);

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
    /**
     * The host operation other threads post queued callback calls to, open while any
     * kept callback accepts them, so the event loop waits for their calls.
     */
    MalHostHandle inbox;
    u32 inbox_users;
    u32 kept_slots;
    u32 *free_slots;
    u32 free_count;
    u32 free_capacity;
    bool accepting_waits;
    MalFfiAsyncPayload *retired_async;
};

/**
 * Orders other threads' posts to a VM's inbox against its teardown: they post under
 * the lock while the context still names its VM, and teardown detaches under it.
 */
static pthread_mutex_t ffi_queue_lock = PTHREAD_MUTEX_INITIALIZER;
static MalFfiClose *ffi_closes;

typedef struct MalFfiWait {
    struct MalFfiWait *next;
    /** Comparison key only: the request may outlive both VM and callback context. */
    MalVm *vm;
    pthread_cond_t changed;
    u32 references;
    bool done;
    bool succeeded;
    void *message;
    MalFfiQueuedFree free;
} MalFfiWait;

static MalFfiWait *ffi_waiters;

static void ffi_wait_finish(MalFfiWait *wait, bool succeeded) {
    pthread_mutex_lock(&ffi_queue_lock);
    if (!wait->done) {
        wait->done = true;
        wait->succeeded = succeeded;
        pthread_cond_signal(&wait->changed);
    }
    pthread_mutex_unlock(&ffi_queue_lock);
}

static void ffi_wait_release(MalFfiWait *wait) {
    pthread_mutex_lock(&ffi_queue_lock);
    bool last = --wait->references == 0;
    if (last) {
        MalFfiWait **link = &ffi_waiters;
        while (*link != wait) link = &(*link)->next;
        *link = wait->next;
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    if (last) {
        pthread_cond_destroy(&wait->changed);
        wait->free(wait->message);
        free(wait);
    }
}

void mal_ffi_callbacks_shutdown(MalVm *vm) {
    // Unblocking producers must not let queued calls acquire new C-side ownership.
    ffi_async_cancel_queued(vm);
    pthread_mutex_lock(&ffi_queue_lock);
    if (vm->ffi != nullptr) vm->ffi->accepting_waits = false;
    for (MalFfiWait *wait = ffi_waiters; wait != nullptr; wait = wait->next) {
        if (wait->vm != vm || wait->done) continue;
        wait->done = true;
        pthread_cond_signal(&wait->changed);
    }
    pthread_mutex_unlock(&ffi_queue_lock);
}

static void ffi_state_free(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return;
    mal_ffi_callbacks_shutdown(vm);
    // Teardown finalizers run after this, so the handles must forget the table first.
    for (usize index = 0; index < state->handle_capacity; index++) {
        if (state->handles[index].handle != nullptr) state->handles[index].handle->registry = nullptr;
    }
    // Libraries may still hold kept callbacks and release them later: detach instead
    // of freeing, so a late call finds no VM and a late release frees the context.
    pthread_mutex_lock(&ffi_queue_lock);
    MalFfiKept *retired = nullptr;
    for (MalFfiKept *kept = state->kept; kept != nullptr;) {
        MalFfiKept *next = kept->next;
        ffi_close_detach(kept);
        kept->callback.vm = nullptr;
        // A live VM kept this released context rooted until its queued calls retired.
        if (kept->released) {
            kept->next = retired;
            retired = kept;
        }
        kept = next;
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    while (retired != nullptr) {
        MalFfiKept *next = retired->next;
        ffi_kept_unref(retired);
        retired = next;
    }
    // Contexts the library already released only wait for this VM; nothing holds them.
    MalFfiKept *pending = atomic_exchange(&state->pending_releases, nullptr);
    while (pending != nullptr) {
        MalFfiKept *next = pending->pending;
        ffi_kept_unref(pending);
        pending = next;
    }
    // Unobserved native results can call destructors; every callback must be detached first.
    while (state->retired_async != nullptr) {
        MalFfiAsyncPayload *payload = state->retired_async;
        state->retired_async = payload->next;
        ffi_async_release(payload);
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
    state->accepting_waits = true;
    return state;
}

static const MalFfiHandleType *ffi_handle_family(const MalFfiHandleType *type) {
    return type->family == nullptr ? type : type->family;
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

/** An open pointer must be registered before C can hand out an alias to it. */
static bool ffi_handle_register(MalFfiState *state, MalFfiHandleObject *handle) {
    if ((state->handle_count + 1) * 2 > state->handle_capacity) {
        usize capacity = state->handle_capacity == 0 ? 16 : state->handle_capacity * 2;
        MalFfiHandleEntry *grown = calloc(capacity, sizeof(*grown));
        if (grown == nullptr) return false;
        MalFfiHandleEntry *previous = state->handles;
        usize previous_capacity = state->handle_capacity;
        state->handles = grown;
        state->handle_capacity = capacity;
        for (usize index = 0; index < previous_capacity; index++) {
            if (previous[index].handle != nullptr) ffi_handle_place(state, previous[index]);
        }
        free(previous);
    }
    ffi_handle_place(state, (MalFfiHandleEntry) {ffi_handle_family(handle->type), handle->value, handle});
    state->handle_count++;
    handle->registry = state;
    return true;
}

/** Remove a handle's entry, shifting later probes back so lookups stay correct. */
static void ffi_handle_unregister(MalFfiHandleObject *handle) {
    MalFfiState *state = handle->registry;
    if (state == nullptr) return;
    handle->registry = nullptr;
    usize mask = state->handle_capacity - 1;
    usize slot = ffi_handle_slot(ffi_handle_family(handle->type), handle->value, state->handle_capacity);
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
    // Wide structs get their keys from the heap, so the shape exists for any of them.
    MalString *inline_keys[64];
    MalString **keys = type->field_count <= (i32) countof(inline_keys)
        ? inline_keys
        : malloc(sizeof(*keys) * (usize) type->field_count);
    if (keys == nullptr) return nullptr;
    for (i32 index = 0; index < type->field_count; index++) {
        keys[index] = mal_intrinsic_ascii(vm, (const byte *) type->fields[index]);
    }
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, keys, (u32) type->field_count);
    if (keys != inline_keys) free(keys);
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
            const MalValue *fields = mal_object_fields_nonempty(object);
            for (i32 index = 0; index < type->field_count; index++) values[index] = fields[index];
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

/**
 * Read a record's immediate fields into `leaves`, depth first. Returns the position
 * after them, or null when some level lacks its record's shape.
 */
static MalValue *ffi_record_leaves(
    MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves) {
    if (!mal_value_is_heap_type(record, MAL_HEAP_OBJECT)) return nullptr;
    MalObject *object = mal_value_to_object(record);
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr || object->shape != shape) return nullptr;
    // The shape proves every field is an own slot; a record has at least one.
    const MalValue *fields = mal_object_fields_nonempty(object);
    i32 count = type->field_count;
    MalFfiRecordType *const *nested = type->nested;
    for (i32 index = 0; index < count; index++) {
        MalFfiRecordType *inner = nested == nullptr ? nullptr : nested[index];
        if (inner == nullptr) *leaves++ = fields[index];
        else if ((leaves = ffi_record_leaves(vm, fields[index], inner, leaves)) == nullptr) {
            return nullptr;
        }
    }
    return leaves;
}

bool mal_ffi_record_leaves(MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves) {
    return ffi_record_leaves(vm, record, type, leaves) != nullptr;
}

bool mal_ffi_try_record_elements(
    MalVm *vm, MalValue array, int32_t length, MalFfiRecordType *type,
    MalValue *values) {
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr || !mal_value_is_array_object(array)) return false;
    MalArrayObject *object = mal_value_to_array_object(array);
    if (mal_array_object_length(object) != (u32) length || object->elements == nullptr
        || object->dense_count < (u32) length) return false;
    const MalValue *dense = object->elements;
    i32 count = type->field_count;
    for (i32 index = 0; index < length; index++) {
        MalValue element = dense[index];
        if (mal_value_is_array_hole(element) || !mal_value_is_heap_type(element, MAL_HEAP_OBJECT)
            || mal_value_to_object(element)->shape != shape) return false;
        MalValue *fields = values + (usize) index * (usize) count;
        const MalValue *slots = mal_object_fields_nonempty(mal_value_to_object(element));
        for (i32 field = 0; field < count; field++) fields[field] = slots[field];
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

void mal_ffi_callback_lost(void) {
    fputs(
        "maligator: a C library called a callback outside the call it was passed to, or from another thread\n",
        stderr);
    abort();
}

[[noreturn]] static void ffi_wrong_thread(void) {
    fputs("maligator: a C library called back into JavaScript from another thread\n", stderr);
    abort();
}

static void ffi_run_pending_releases(MalVm *vm);

static MAL_ISOLATE_LOCAL byte ffi_callback_thread;

void mal_ffi_callback_init(MalFfiCallback *callback, MalVm *vm, MalValue function) {
    callback->vm = vm;
    callback->function = function;
    callback->thread_identity = &ffi_callback_thread;
}

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
    mal_ffi_callback_init(&kept->callback, vm, held[0]);
    atomic_init(&kept->references, 1);
    kept->slot = slot;
    kept->thread = pthread_self();
    kept->next = state->kept;
    if (state->kept != nullptr) state->kept->previous = kept;
    state->kept = kept;
    return &kept->callback;
}

static void ffi_inbox_leave(MalVm *vm);

/** Drop a released context's slot and free it; runs on the VM thread outside collection. */
static void ffi_release_now(MalFfiKept *kept) {
    MalVm *vm = kept->callback.vm;
    if (vm != nullptr && kept->queued) {
        // Queued calls still name this context; the last one to run completes the release.
        if (atomic_load(&kept->waiting) > 0) {
            kept->released = true;
            return;
        }
        ffi_inbox_leave(vm);
    }
    ffi_close_detach(kept);
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
    ffi_kept_unref(kept);
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

static bool ffi_inbox_post_release(MalFfiKept *kept);

void mal_ffi_release(void *data) {
    if (data == nullptr) return;
    MalFfiKept *kept = data;
    pthread_mutex_lock(&ffi_queue_lock);
    MalVm *vm = kept->callback.vm;
    // A queued callback's release goes through its inbox, which wakes the event loop
    // that waits for it.
    if (vm != nullptr && kept->queued && (ffi_finalizing || !pthread_equal(kept->thread, pthread_self()))
        && ffi_inbox_post_release(kept)) {
        pthread_mutex_unlock(&ffi_queue_lock);
        return;
    }
    // Inside a collection or on another thread the VM cannot be touched; queue the
    // context for the VM thread, which runs the queue after its next C call.
    if (vm != nullptr && (ffi_finalizing || !pthread_equal(kept->thread, pthread_self()))) {
        MalFfiState *state = vm->ffi;
        MalFfiKept *head = atomic_load(&state->pending_releases);
        do {
            kept->pending = head;
        } while (!atomic_compare_exchange_weak(&state->pending_releases, &head, kept));
        pthread_mutex_unlock(&ffi_queue_lock);
        return;
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    ffi_release_now(kept);
}

static void ffi_async_run(void *data) {
    MalFfiAsyncPayload *payload = data;
    int queued = MAL_FFI_ASYNC_QUEUED;
    if (!atomic_compare_exchange_strong_explicit(&payload->phase, &queued,
            MAL_FFI_ASYNC_RUNNING, memory_order_acq_rel, memory_order_acquire)) return;
    MalFfiAsyncGroup *previous = ffi_worker_group;
    ffi_worker_group = payload->group;
    payload->run(payload->data);
    ffi_worker_group = previous;
    atomic_store_explicit(&payload->phase, MAL_FFI_ASYNC_FINISHED, memory_order_release);
}

static void ffi_async_release(void *data) {
    MalFfiAsyncPayload *payload = data;
    if (atomic_fetch_sub_explicit(&payload->references, 1, memory_order_acq_rel) == 1) {
        payload->release(payload->data);
        for (i32 index = 0; index < payload->callback_count; index++)
            if (payload->callbacks[index] != nullptr) mal_ffi_callback_drop(payload->callbacks[index]);
        free(payload->callbacks);
        ffi_group_release(payload->group);
        free(payload);
    }
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
    /** Host teardown can discard its result before VM cleanup retires argument pins. */
    MalFfiAsyncPayload *payload;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} MalFfiAsync;

static MAL_ISOLATE_LOCAL MalFfiAsync *ffi_async_pending;
static MAL_ISOLATE_LOCAL bool ffi_async_installed;

static void ffi_async_cancel_queued(MalVm *vm) {
    for (MalFfiAsync *call = ffi_async_pending; call != nullptr; call = call->next) {
        if (call->vm != vm || call->payload->must_run) continue;
        int queued = MAL_FFI_ASYNC_QUEUED;
        (void) atomic_compare_exchange_strong_explicit(&call->payload->phase, &queued,
            MAL_FFI_ASYNC_CANCELLED, memory_order_acq_rel, memory_order_acquire);
    }
}

static void ffi_async_detach(MalFfiAsyncPayload *payload) {
    payload->group->active = false;
    for (i32 index = 0; index < payload->callback_count; index++) {
        MalFfiKept *kept = (MalFfiKept *) payload->callbacks[index];
        if (kept != nullptr && kept->group == payload->group) kept->group = nullptr;
    }
}

static void ffi_async_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalFfiAsync *call = ffi_async_pending; call != nullptr; call = call->next) {
        if (call->vm != vm) continue;
        mal_gc_mark_value(call->promise);
        mal_gc_mark_value(call->payload->group->error);
        for (i32 index = 0; index < call->keep_count; index++) mal_gc_mark_value(call->keep[index]);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) call->async_context));
    }
}

static void ffi_async_free(MalVm *vm) {
    ffi_async_cancel_queued(vm);
    MalFfiAsync **link = &ffi_async_pending;
    while (*link != nullptr) {
        MalFfiAsync *call = *link;
        if (call->vm != vm) {
            link = &call->next;
            continue;
        }
        MalRootSpan kept;
        mal_gc_root(&kept, call->keep, call->keep_count);
        *link = call->next;
        ffi_async_detach(call->payload);
        (void) call->complete(vm, call->payload->data, false);
        if (vm->ffi != nullptr) {
            call->payload->next = vm->ffi->retired_async;
            vm->ffi->retired_async = call->payload;
        } else ffi_async_release(call->payload);
        mal_gc_unroot(&kept);
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
    MalRootSpan kept;
    mal_gc_root(&kept, call->keep, call->keep_count);
    *link = call->next;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, call->realm);
#endif
    MalValue roots[4] = {
        call->promise, mal_value_new_undefined(),
        mal_async_internal_value((MalHeapHeader *) call->async_context),
        call->payload->group->error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, call->async_context);
    void *data = mal_blocking_work_result_data(task.data);
    bool ran = data != nullptr && task.result != MAL_HOST_TERMINAL_CANCELLED
        && atomic_load_explicit(&call->payload->phase, memory_order_acquire) == MAL_FFI_ASYNC_FINISHED;
    ffi_async_detach(call->payload);
    if (call->payload->group->failed)
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
    // The completion releases what the call held, so it runs even when the work did not.
    roots[1] = call->complete(vm, call->payload->data, ran);
    if (call->payload->group->failed)
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
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
    ffi_async_release(call->payload);
    mal_host_task_release(&host->tasks, &task);
    mal_gc_unroot(&kept);
    free(call->keep);
    free(call);
    return true;
}

bool mal_ffi_async(
    MalVm *vm, void *data, MalFfiAsyncRun run, MalFfiAsyncComplete complete,
    MalFfiAsyncRelease release, const MalValue *keep, int32_t keep_count,
    const MalFfiInputs *inputs, MalFfiCallback *const *callbacks, int32_t callback_count,
    MalValue *promise, bool must_run) {
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
    i32 input_count = inputs == nullptr ? 0 : inputs->count;
    if (input_count > INT32_MAX - keep_count) return mal_ffi_out_of_memory(vm);
    i32 total = keep_count + input_count;
    MalFfiAsync *call = calloc(1, sizeof(*call));
    MalFfiAsyncPayload *payload = calloc(1, sizeof(*payload));
    MalFfiAsyncGroup *group = calloc(1, sizeof(*group));
    MalFfiCallback **held_callbacks = callback_count == 0 ? nullptr
        : malloc(sizeof(*held_callbacks) * (usize) callback_count);
    MalValue *kept = total == 0 ? nullptr : malloc(sizeof(*kept) * (usize) total);
    if (call == nullptr || payload == nullptr || group == nullptr
        || (callback_count > 0 && held_callbacks == nullptr) || (total > 0 && kept == nullptr)) {
        free(call);
        free(payload);
        free(kept);
        free(group);
        free(held_callbacks);
        return mal_ffi_out_of_memory(vm);
    }
    if (keep_count > 0) memcpy(kept, keep, sizeof(*kept) * (usize) keep_count);
    if (input_count > 0) memcpy(kept + keep_count, inputs->values, sizeof(*kept) * (usize) input_count);
    *call = (MalFfiAsync) {
        .vm = vm,
        .promise = *promise,
        .keep = kept,
        .keep_count = total,
        .complete = complete,
        .payload = payload,
        .async_context = mal_async_context_capture(vm),
#if MAL_REALMS
        .realm = vm->current_realm,
#endif
    };
    *group = (MalFfiAsyncGroup) {
        .references = 1, .vm = vm, .error = mal_value_new_undefined(), .active = true,
        .async_context = call->async_context,
#if MAL_REALMS
        .realm = call->realm,
#endif
    };
    for (i32 index = 0; index < callback_count; index++) {
        held_callbacks[index] = callbacks[index];
        if (callbacks[index] == nullptr) continue;
        mal_ffi_callback_hold(callbacks[index]);
        ((MalFfiKept *) callbacks[index])->group = group;
    }
    *payload = (MalFfiAsyncPayload) {
        .references = 2, .phase = MAL_FFI_ASYNC_QUEUED, .must_run = must_run, .data = data, .run = run, .release = release,
        .group = group, .callbacks = held_callbacks, .callback_count = callback_count};
    MalBlockingWorkReservation reservation = {0};
    if (!mal_blocking_work_reserve(host, sizeof(*call), &reservation)
        || !mal_blocking_work_start(host, ffi_async_run, payload, ffi_async_release, &reservation, &call->operation, must_run)) {
        mal_blocking_work_reservation_release(&reservation);
        free(kept);
        free(call);
        ffi_async_detach(payload);
        for (i32 index = 0; index < callback_count; index++)
            if (held_callbacks[index] != nullptr) mal_ffi_callback_drop(held_callbacks[index]);
        free(held_callbacks);
        ffi_group_release(group);
        free(payload);
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
    MalVm *vm = callback->vm;
    if (vm == nullptr || ffi_finalizing) return nullptr;
    if (callback->thread_identity != &ffi_callback_thread) ffi_wrong_thread();
    return vm;
}

void mal_ffi_callback_hold(MalFfiCallback *callback) {
    atomic_fetch_add_explicit(&((MalFfiKept *) callback)->references, 1, memory_order_relaxed);
}

void mal_ffi_callback_drop(MalFfiCallback *callback) {
    ffi_kept_unref((MalFfiKept *) callback);
}

typedef struct MalFfiReplacedEntry {
    void *key;
    MalFfiKept *kept[2];
    u64 identity[2];
    unsigned lane;
    MalFfiReplacement *pending;
    u64 pending_identity;
    bool retired;
} MalFfiReplacedEntry;

/**
 * Replaced callbacks are process-wide, as the libraries' own setter state is, so
 * worker VMs share them. Preparation reserves a key on the VM; workers publish it
 * immediately before C runs. Both trampoline generations remain routable until
 * the setter returns, since C can invoke either while replacing its registration.
 */
static pthread_mutex_t ffi_replaced_lock = PTHREAD_MUTEX_INITIALIZER;
/** Every site that ever held an entry, so destroying a handle finds its callbacks. */
static MalFfiReplaced *ffi_replaced_sites;
/** Entries keyed by a handle; destroying a handle skips the scan while there are none. */
static _Atomic usize ffi_replaced_keyed;
/** Registration order separates callbacks of resources that reuse an address. */
static u64 ffi_replaced_identity;

static MalFfiReplacedEntry *ffi_replaced_find(MalFfiReplaced *site, void *key) {
    MalFfiReplacedEntry *entries = site->entries;
    for (usize index = 0; index < site->count; index++) {
        if (entries[index].key == key && !entries[index].retired) return &entries[index];
    }
    return nullptr;
}

static MalFfiReplacedEntry *ffi_replacement_entry(MalFfiReplacement *replacement) {
    MalFfiReplaced *site = replacement->site;
    MalFfiReplacedEntry *entries = site->entries;
    for (usize index = 0; index < site->count; index++) {
        if (entries[index].pending == replacement) return &entries[index];
    }
    return nullptr;
}

static void ffi_replaced_remove(MalFfiReplaced *site, MalFfiReplacedEntry *entry) {
    MalFfiReplacedEntry *entries = site->entries;
    if (entry->key != nullptr) ffi_replaced_keyed--;
    *entry = entries[--site->count];
}

bool mal_ffi_replace_prepare(
    MalVm *vm, MalFfiReplaced *site, void *key, MalFfiCallback *callback,
    MalFfiReplacement *replacement) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
    if (entry != nullptr && entry->pending != nullptr) {
        pthread_mutex_unlock(&ffi_replaced_lock);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "A C callback replacement is already pending for this key");
        return false;
    }
    if (entry == nullptr) {
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
        entry = &((MalFfiReplacedEntry *) site->entries)[site->count++];
        *entry = (MalFfiReplacedEntry) {.key = key, .lane = 1};
        if (key != nullptr) ffi_replaced_keyed++;
    }
    *replacement = (MalFfiReplacement) {
        .site = site, .key = key, .callback = callback, .lane = entry->lane ^ 1};
    entry->pending = replacement;
    entry->pending_identity = ++ffi_replaced_identity;
    if (callback != nullptr) mal_ffi_callback_hold(callback);
    pthread_mutex_unlock(&ffi_replaced_lock);
    return true;
}

void mal_ffi_replace_commit(MalFfiReplacement *replacement) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replacement_entry(replacement);
    if (entry == nullptr || entry->retired || replacement->committed
        || entry->kept[replacement->lane] != nullptr) abort();
    entry->kept[replacement->lane] = (MalFfiKept *) replacement->callback;
    entry->identity[replacement->lane] = ++ffi_replaced_identity;
    entry->lane = replacement->lane;
    replacement->committed = true;
    pthread_mutex_unlock(&ffi_replaced_lock);
}

void mal_ffi_replace_finish(MalFfiReplacement *replacement) {
    if (replacement->site == nullptr) return;
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replacement_entry(replacement);
    if (entry == nullptr || entry->pending != replacement) abort();
    MalFfiCallback *retired;
    if (replacement->committed) {
        unsigned previous = replacement->lane ^ 1;
        MalFfiKept *kept = entry->kept[previous];
        retired = kept == nullptr ? nullptr : &kept->callback;
        entry->kept[previous] = nullptr;
        entry->identity[previous] = 0;
    } else retired = replacement->callback;
    entry->pending = nullptr;
    entry->pending_identity = 0;
    if (entry->kept[0] == nullptr && entry->kept[1] == nullptr)
        ffi_replaced_remove(replacement->site, entry);
    pthread_mutex_unlock(&ffi_replaced_lock);
    // Releasing can queue VM work or detach a closing handle; never hold the registry lock.
    mal_ffi_release(retired);
    if (replacement->callback != nullptr) mal_ffi_callback_drop(replacement->callback);
    replacement->site = nullptr;
}

MalFfiCallback *mal_ffi_replaced(MalFfiReplaced *site, void *key, unsigned lane) {
    if (lane > 1) abort();
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
    MalFfiKept *kept = entry == nullptr ? nullptr : entry->kept[lane];
    if (kept != nullptr)
        atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
    // Checked under the lock: the owning thread may release the context right after.
    bool foreign = kept != nullptr && !pthread_equal(kept->thread, pthread_self());
    bool live = foreign && !kept->queued && kept->callback.vm != nullptr;
    // A queued callback's call from another thread reserves its place in the queue
    // here, before the lock lets the VM thread replace and release the context.
    if (foreign && kept->queued) {
        atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
        atomic_fetch_add(&kept->waiting, 1);
        foreign = false;
    }
    pthread_mutex_unlock(&ffi_replaced_lock);
    if (foreign && live) ffi_wrong_thread();
    return kept == nullptr ? nullptr : &kept->callback;
}

/** Release the callbacks kept for a handle whose resource was just destroyed. */
static void ffi_replaced_drop_before(void *key, u64 identity) {
    if (key == nullptr || atomic_load_explicit(&ffi_replaced_keyed, memory_order_relaxed) == 0) {
        return;
    }
    for (;;) {
        MalFfiKept *kept = nullptr;
        pthread_mutex_lock(&ffi_replaced_lock);
        for (MalFfiReplaced *site = ffi_replaced_sites; site != nullptr && kept == nullptr;
             site = site->next) {
            MalFfiReplacedEntry *entries = site->entries;
            for (usize index = 0; index < site->count && kept == nullptr;) {
                MalFfiReplacedEntry *entry = &entries[index];
                if (entry->key != key) { index++; continue; }
                for (unsigned lane = 0; lane < 2; lane++) {
                    if (entry->kept[lane] == nullptr || entry->identity[lane] > identity) continue;
                    kept = entry->kept[lane];
                    entry->kept[lane] = nullptr;
                    entry->identity[lane] = 0;
                    break;
                }
                if (entry->kept[0] == nullptr && entry->kept[1] == nullptr) {
                    if (entry->pending == nullptr) {
                        ffi_replaced_remove(site, entry);
                        continue;
                    }
                    // A close may create a new resource at this address before its setter returns.
                    if (entry->pending_identity <= identity) entry->retired = true;
                }
                index++;
            }
        }
        pthread_mutex_unlock(&ffi_replaced_lock);
        // Released outside the lock: a release runs on the VM thread or queues for it.
        if (kept == nullptr) return;
        mal_ffi_release(kept);
    }
}

static void ffi_replaced_drop(void *key) {
    ffi_replaced_drop_before(key, UINT64_MAX);
}

/** A queued call of a kept callback from another thread, or with no `run`, its release. */
typedef struct MalFfiQueuedCall {
    MalFfiKept *kept;
    MalFfiQueuedRun run;
    MalFfiQueuedFree free;
    void *message;
    bool ran;
    MalFfiWait *wait;
    MalFfiAsyncGroup *group;
} MalFfiQueuedCall;

static MAL_ISOLATE_LOCAL bool ffi_inbox_installed;

static void ffi_queued_destroy(void *data) {
    MalFfiQueuedCall *call = data;
    // A call the host drops without running gives back its place in the queue.
    if (call->run != nullptr) {
        if (!call->ran) atomic_fetch_sub(&call->kept->waiting, 1);
        ffi_kept_unref(call->kept);
    } else if (!call->ran) {
        ffi_kept_unref(call->kept);
    }
    if (call->wait != nullptr) {
        ffi_wait_finish(call->wait, false);
        ffi_wait_release(call->wait);
    } else if (call->message != nullptr) call->free(call->message);
    ffi_group_release(call->group);
    free(call);
}

/** Caller holds the queue lock so VM detach cannot retire the inbox during posting. */
static bool ffi_inbox_post_release(MalFfiKept *kept) {
    MalFfiQueuedCall *call = malloc(sizeof(*call));
    if (call == nullptr) return false;
    *call = (MalFfiQueuedCall) {.kept = kept};
    MalVm *vm = kept->callback.vm;
    bool posted = vm != nullptr
        && mal_host_post_progress(mal_host(vm), vm->ffi->inbox, call, ffi_queued_destroy);
    if (!posted) free(call);
    return posted;
}

static void ffi_inbox_leave(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    MalHost *host = mal_host(vm);
    if (--state->inbox_users > 0 || host == nullptr) return;
    // The terminal task retires the inbox once the drain consumes it, and the loop
    // stops waiting for calls from other threads.
    (void) mal_host_operation_complete(&host->tasks, state->inbox, MAL_HOST_TERMINAL_OK, nullptr, nullptr);
    mal_reactor_release_work(&host->reactor);
}

static bool ffi_inbox_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || vm->ffi == nullptr || !mal_host_peek_task(&host->tasks, &task)) {
        return false;
    }
    if (mal_host_operation_owner(&host->tasks, task.operation) != vm->ffi) return false;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    if (task.kind == MAL_HOST_TASK_TERMINAL) {
        mal_host_operation_unbind(&host->tasks, task.operation, vm->ffi);
        mal_host_task_release(&host->tasks, &task);
        return true;
    }
    MalFfiQueuedCall *call = task.data;
    MalFfiKept *kept = call->kept;
    if (call->run == nullptr) {
        call->ran = true;
        mal_host_task_release(&host->tasks, &task);
        ffi_release_now(kept);
        return true;
    }
    bool pending = true;
    if (call->wait != nullptr) {
        pthread_mutex_lock(&ffi_queue_lock);
        pending = !call->wait->done;
        pthread_mutex_unlock(&ffi_queue_lock);
    }
    MalFfiAsyncGroup *group = call->group != nullptr ? call->group : kept->group;
    bool grouped = group != nullptr && group->active && group->vm == vm;
    bool ran = pending && kept->callback.vm == vm && !(grouped && group->failed);
    MalAsyncContextScope scope;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
#endif
    if (grouped) {
#if MAL_REALMS
        mal_realm_switch(vm, group->realm);
#endif
        mal_async_context_scope_enter(vm, &scope, group->async_context);
    }
    if (ran) call->run(vm, &kept->callback, call->message);
    call->ran = true;
    bool succeeded = ran && vm->completion.kind != MAL_COMPLETION_THROW;
    if (grouped && vm->completion.kind == MAL_COMPLETION_THROW) {
        if (!group->failed) group->error = vm->completion.value;
        group->failed = true;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }
    if (grouped) {
        mal_async_context_scope_exit(vm, &scope);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
    }
    if (call->wait != nullptr)
        ffi_wait_finish(call->wait, succeeded);
    u32 left = atomic_fetch_sub(&kept->waiting, 1) - 1;
    mal_host_task_release(&host->tasks, &task);
    if (left == 0 && kept->released) ffi_release_now(kept);
    return true;
}

MalFfiCallback *mal_ffi_keep_queued(MalVm *vm, MalValue function) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "Callbacks a C library calls from other threads need an event loop, such as the web platform surface");
        return nullptr;
    }
    MalFfiCallback *callback = mal_ffi_keep(vm, function);
    if (callback == nullptr) return nullptr;
    MalFfiState *state = vm->ffi;
    if (state->inbox_users == 0) {
        // The inbox keeps the event loop waiting while the library may still call.
        bool started = mal_host_operation_start(&host->tasks, &state->inbox);
        bool bound = started && mal_host_operation_bind(&host->tasks, state->inbox, state);
        bool retained = bound && mal_reactor_retain_work(&host->reactor);
        if (!retained || !mal_host_operation_activate(&host->tasks, state->inbox)) {
            if (retained) mal_reactor_release_work(&host->reactor);
            if (bound) mal_host_operation_unbind(&host->tasks, state->inbox, state);
            if (started) (void) mal_host_operation_abort_start(&host->tasks, state->inbox);
            mal_ffi_release(callback);
            mal_vm_throw_allocation_error(vm);
            return nullptr;
        }
        if (!ffi_inbox_installed) {
            mal_host_register_macrotask_drain(ffi_inbox_drain, false);
            ffi_inbox_installed = true;
        }
    }
    state->inbox_users++;
    ((MalFfiKept *) callback)->queued = true;
    return callback;
}

bool mal_ffi_callback_here(MalFfiCallback *callback) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    return pthread_equal(kept->thread, pthread_self())
        || (!kept->queued && kept->callback.vm == nullptr);
}

void mal_ffi_callback_reserve(MalFfiCallback *callback) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    if (!kept->queued) ffi_wrong_thread();
    atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
    atomic_fetch_add(&kept->waiting, 1);
}

static bool ffi_callback_post_locked(
    MalFfiKept *kept, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release,
    MalFfiWait *wait) {
    MalFfiQueuedCall *call = message == nullptr ? nullptr : malloc(sizeof(*call));
    if (call != nullptr) {
        *call = (MalFfiQueuedCall) {
            .kept = kept, .run = run, .free = release, .message = message, .wait = wait};
        MalVm *vm = kept->callback.vm;
        MalFfiAsyncGroup *group = ffi_worker_group;
        if (group != nullptr && group->vm == vm) {
            atomic_fetch_add_explicit(&group->references, 1, memory_order_relaxed);
            call->group = group;
        }
        bool posted = vm != nullptr
            && (wait == nullptr || vm->ffi->accepting_waits)
            && mal_host_post_progress(mal_host(vm), vm->ffi->inbox, call, ffi_queued_destroy);
        if (posted) return true;
        ffi_group_release(call->group);
        free(call);
    }
    return false;
}

bool mal_ffi_callback_queue(
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    pthread_mutex_lock(&ffi_queue_lock);
    bool posted = ffi_callback_post_locked(kept, run, message, release, nullptr);
    pthread_mutex_unlock(&ffi_queue_lock);
    if (posted) return true;
    if (message != nullptr) release(message);
    // A release that waited for this call stays pending: only the VM thread may free it.
    atomic_fetch_sub(&kept->waiting, 1);
    ffi_kept_unref(kept);
    return false;
}

int mal_ffi_callback_wait_enter(void) {
    // A canceled condition wait reacquires the queue lock. Defer cancellation until
    // the generated frame has released the request and its keyed or close references.
    int previous;
    if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &previous) != 0) abort();
    return previous;
}

void mal_ffi_callback_wait_leave(int cancellation_state) {
    if (pthread_setcancelstate(cancellation_state, nullptr) != 0) abort();
    if (cancellation_state == PTHREAD_CANCEL_ENABLE) pthread_testcancel();
}

bool mal_ffi_callback_wait(
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release,
    void *result, size_t result_offset, size_t result_size) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    MalFfiWait *wait = message == nullptr ? nullptr : calloc(1, sizeof(*wait));
    if (wait == nullptr || pthread_cond_init(&wait->changed, nullptr) != 0) {
        free(wait);
        if (message != nullptr) release(message);
        atomic_fetch_sub(&kept->waiting, 1);
        ffi_kept_unref(kept);
        return false;
    }
    wait->references = 1;
    wait->message = message;
    wait->free = release;
    pthread_mutex_lock(&ffi_queue_lock);
    wait->vm = kept->callback.vm;
    wait->next = ffi_waiters;
    ffi_waiters = wait;
    bool posted = ffi_callback_post_locked(kept, run, message, release, wait);
    if (posted) wait->references++;
    while (posted && !wait->done) pthread_cond_wait(&wait->changed, &ffi_queue_lock);
    bool succeeded = posted && wait->succeeded;
    if (succeeded && result_size > 0)
        memcpy(result, (byte *) message + result_offset, result_size);
    pthread_mutex_unlock(&ffi_queue_lock);
    ffi_wait_release(wait);
    if (!posted) {
        atomic_fetch_sub(&kept->waiting, 1);
        ffi_kept_unref(kept);
    }
    return succeeded;
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

/** Forget the resource; freeing caller-owned storage also releases its keyed callbacks. */
static void ffi_handle_forget(MalFfiHandleObject *handle) {
    if (handle->registry != nullptr) ffi_handle_unregister(handle);
    if (handle->retained != nullptr) {
        for (i32 index = 0; index < handle->type->managed_field_count; index++) {
            MalFfiRetainedField *field = &handle->retained[index];
            if (!ffi_finalizing) mal_gc_write_barrier(field->buffer);
            mal_array_buffer_object_release_pin(field->pin);
        }
        free(handle->retained);
        handle->retained = nullptr;
    }
    if (handle->owns_storage) {
        ffi_replaced_drop(handle->value);
        free(handle->value);
    }
    handle->value = nullptr;
}

static void ffi_close_free(MalFfiClose *close) {
    if (close == nullptr) return;
    free(close->storage);
    for (i32 index = 0; index < close->store_count; index++)
        mal_array_buffer_store_release(close->stores[index]);
    free(close->stores);
    free(close);
}

/** Retire VM ownership before publishing detachment; native ownership remains. */
static void ffi_close_detach(MalFfiKept *kept) {
    MalFfiClose *close = kept->close;
    if (close == nullptr || !close->committed || mal_value_is_undefined(close->handle)) return;
    MalFfiHandleObject *handle = ffi_handle(close->handle);
    if (handle->value == close->key) ffi_handle_forget(handle);
    else close->key = nullptr;
    handle->closing = false;
    handle->worker_closing = false;
    handle->operation = nullptr;
    mal_ffi_unpin_handle(handle);
    close->handle = mal_value_new_undefined();
}

bool mal_ffi_close_prepare(
    MalVm *vm, MalFfiCallback *callback, MalValue value, const void *site,
    const MalFfiSite *error) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr || handle->value == nullptr || handle->pins != 1 || handle->closing)
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, error,
            "a handle no other C call is using");
    MalFfiClose *close = calloc(1, sizeof(*close));
    if (close == nullptr) return mal_ffi_out_of_memory(vm);
    close->site = site;
    close->callback = callback;
    close->key = handle->value;
    close->handle = value;
    if (handle->retained != nullptr) {
        close->stores = calloc((usize) handle->type->managed_field_count, sizeof(*close->stores));
        if (close->stores == nullptr) {
            ffi_close_free(close);
            return mal_ffi_out_of_memory(vm);
        }
        for (i32 index = 0; index < handle->type->managed_field_count; index++) {
            MalFfiRetainedField *field = &handle->retained[index];
            if (field->pin == nullptr) continue;
            MalArrayBufferStoreLease *lease = mal_array_buffer_object_retain_store(
                mal_value_to_array_buffer_object(field->buffer));
            if (lease == nullptr) {
                ffi_close_free(close);
                return mal_ffi_out_of_memory(vm);
            }
            close->stores[close->store_count++] = lease;
        }
    }
    MalValue roots[3] = {value, callback->function, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    bool ok = !mal_ffi_threw(vm)
        && mal_ffi_set_element(vm, roots[2], 0, roots[0])
        && mal_ffi_set_element(vm, roots[2], 1, roots[1]);
    MalValue holder;
    if (ok) ok = ffi_prepared(vm, FFI_KEPT_IDENTITY, &holder)
        && mal_object_set(mal_value_to_object(holder), mal_key_index(((MalFfiKept *) callback)->slot), roots[2]);
    mal_gc_unroot(&root);
    if (!ok) {
        ffi_close_free(close);
        return false;
    }
    ((MalFfiKept *) callback)->close = close;
    return true;
}

void mal_ffi_close_commit(MalFfiCallback *callback, void **pin, bool worker) {
    MalFfiClose *close = ((MalFfiKept *) callback)->close;
    MalFfiHandleObject *handle = *pin;
    close->scope = handle->scope;
    close->operation = handle->operation;
    handle->closing = true;
    handle->worker_closing = worker;
    handle->scope = 0;
    handle->operation = nullptr;
    if (handle->owns_storage) {
        close->storage = handle->value;
        handle->owns_storage = false;
    }
    *pin = nullptr;
    close->committed = true;
    pthread_mutex_lock(&ffi_queue_lock);
    close->next = ffi_closes;
    ffi_closes = close;
    pthread_mutex_unlock(&ffi_queue_lock);
}

void mal_ffi_close_start(MalFfiCallback *callback) {
    MalFfiClose *close = ((MalFfiKept *) callback)->close;
    pthread_mutex_lock(&ffi_replaced_lock);
    u64 identity = ffi_replaced_identity;
    pthread_mutex_unlock(&ffi_replaced_lock);
    pthread_mutex_lock(&ffi_queue_lock);
    close->callback_identity = identity;
    pthread_mutex_unlock(&ffi_queue_lock);
}

void mal_ffi_close_cancel(MalFfiCallback *callback, void **pin) {
    if (callback == nullptr) return;
    MalFfiKept *kept = (MalFfiKept *) callback;
    MalFfiClose *close = kept->close;
    if (close == nullptr || !close->committed) return;
    pthread_mutex_lock(&ffi_queue_lock);
    MalFfiClose **entry = &ffi_closes;
    while (*entry != nullptr && *entry != close) entry = &(*entry)->next;
    if (*entry != close) abort();
    *entry = close->next;
    pthread_mutex_unlock(&ffi_queue_lock);
    MalFfiHandleObject *handle = ffi_handle(close->handle);
    if (*pin != nullptr || handle == nullptr || handle->value != close->key) abort();
    *pin = handle;
    handle->closing = false;
    handle->worker_closing = false;
    handle->scope = close->scope;
    handle->operation = close->operation;
    if (close->storage != nullptr) {
        handle->owns_storage = true;
        close->storage = nullptr;
    }
    kept->close = nullptr;
    ffi_close_free(close);
}

MalFfiCallback *mal_ffi_close_take(const void *site, void *key, MalFfiCallback *data) {
    pthread_mutex_lock(&ffi_queue_lock);
    MalFfiClose **entry = &ffi_closes;
    while (*entry != nullptr && !((*entry)->site == site
        && (data != nullptr ? (*entry)->callback == data : (*entry)->key == key)))
        entry = &(*entry)->next;
    MalFfiClose *close = *entry;
    MalFfiCallback *callback = nullptr;
    if (close != nullptr) {
        *entry = close->next;
        key = close->key;
        callback = close->callback;
        atomic_fetch_add_explicit(&((MalFfiKept *) callback)->references, 1, memory_order_relaxed);
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    if (close != nullptr) ffi_replaced_drop_before(key, close->callback_identity);
    return callback;
}

MalValue mal_ffi_close_value(MalFfiCallback *callback) {
    return ((MalFfiKept *) callback)->close->handle;
}

void mal_ffi_close_finish(MalFfiCallback *callback) {
    ffi_close_detach((MalFfiKept *) callback);
}

void mal_ffi_close_return(MalFfiCallback *callback) {
    if (callback == nullptr) return;
    mal_ffi_release(callback);
    ffi_kept_unref((MalFfiKept *) callback);
}

static void ffi_handle_trace(MalHeapHeader *cell) {
    MalFfiHandleObject *handle = (MalFfiHandleObject *) cell;
    if (handle->retained == nullptr) return;
    for (i32 index = 0; index < handle->type->managed_field_count; index++)
        mal_gc_mark_value(handle->retained[index].buffer);
}

static void ffi_handle_finalize(MalHeapHeader *cell) {
    MalFfiHandleObject *handle = (MalFfiHandleObject *) cell;
    bool previous = ffi_finalizing;
    ffi_finalizing = true;
    if (handle->value != nullptr && handle->owned && handle->owner_type->collect
        && handle->owner_type->destroy != nullptr) {
        if (handle->owner_type->destroy(handle->value)) ffi_replaced_drop(handle->value);
    }
    ffi_handle_forget(handle);
    while (handle->views != nullptr) {
        MalFfiHandleView *view = handle->views;
        handle->views = view->next;
        free(view);
    }
    ffi_finalizing = previous;
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
    if (handle->pins > 0 || handle->closing) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Cannot close a C library handle while a C call uses it");
        return mal_value_new_undefined();
    }
    if (handle->value != nullptr) {
        void *value = handle->value;
        const MalFfiHandleType *owner = handle->owner_type;
        bool release = handle->owned && owner->destroy != nullptr;
        handle->closing = true;
        // Unconditional release can hand out the same pointer again. A conditional
        // release keeps its identity until C confirms it stopped owning the resource.
        if (handle->type->size == 0 && (!release || !owner->destroy_can_fail))
            ffi_handle_forget(handle);
        if (release) {
            if (!owner->destroy(value)) {
                handle->closing = false;
                if (vm->completion.kind != MAL_COMPLETION_THROW) {
                    char message[512];
                    snprintf(message, sizeof(message), "%s did not release the %s handle",
                        owner->destroy_name, owner->name);
                    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
                }
                return mal_value_new_undefined();
            }
            ffi_replaced_drop(value);
        }
        ffi_handle_forget(handle);
        handle->closing = false;
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
        char setter_name[128];
        snprintf(getter_name, sizeof(getter_name), "get %s", field->name);
        snprintf(setter_name, sizeof(setter_name), "set %s", field->name);
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, (const byte *) field->name),
            (const byte *) getter_name, 0, field->get, (const byte *) setter_name, 1, field->set,
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

static void *ffi_allocate_storage(usize size, usize alignment) {
    return alignment <= _Alignof(max_align_t) ? malloc(size) : aligned_alloc(alignment, size);
}

static bool ffi_type_supports(const MalFfiHandleType *actual, const MalFfiHandleType *expected) {
    if (actual == expected) return true;
    for (i32 index = 0; index < actual->view_count; index++) {
        if (actual->views[index] == expected) return true;
    }
    return false;
}

static __attribute__((noinline)) bool ffi_handle_supports(MalFfiHandleObject *handle, const MalFfiHandleType *type) {
    if (ffi_type_supports(handle->type, type)) return true;
    for (MalFfiHandleView *view = handle->views; view != nullptr; view = view->next) {
        if (ffi_type_supports(view->type, type)) return true;
    }
    return false;
}

/** `scope` 0 makes a handle the program holds; otherwise it lives as long as that invocation. */
static MalValue ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, u64 scope, bool owns_storage, bool fresh) {
    MalFfiState *state = type->size == 0 ? ffi_state(vm) : nullptr;
    MalFfiHandleObject *open = state == nullptr ? nullptr : ffi_handle_find(state, ffi_handle_family(type), value);
    if (fresh && open != nullptr && open->closing) {
        ffi_replaced_drop(open->value);
        ffi_handle_forget(open);
        open = nullptr;
    }
    if (open != nullptr && !ffi_scope_active(vm, open->scope)) {
        // C may reuse a callback's stack address for a different resource or type.
        ffi_handle_forget(open);
        open = nullptr;
    }
    if (open != nullptr) {
        if (owned && !open->owned && !open->owns_storage) {
            open->owned = true;
            open->owner_type = type;
        }
        if (open->type != type && !ffi_handle_supports(open, type)) {
            MalFfiHandleView *view = malloc(sizeof(*view));
            if (view == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return mal_value_new_undefined();
            }
            *view = (MalFfiHandleView) {type, open->views};
            open->views = view;
        }
        // A nested loan must not shorten an outer invocation's still-active loan.
        if (scope == 0 || !ffi_scope_active(vm, open->scope)) open->scope = scope;
        return mal_value_from_heap((MalHeapHeader *) open);
    }
    void *stored = value;
    if (type->size > 0) {
        stored = ffi_allocate_storage(type->size, type->alignment);
        if (stored != nullptr) memcpy(stored, value, type->size);
        owns_storage = true;
    }
    MalValue prototype =
        stored == nullptr ? mal_value_new_undefined() : ffi_handle_prototype(vm, library, type);
    if (stored == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) {
        // The resource exists but no handle can own it, so release it now.
        if (owned && type->destroy != nullptr) type->destroy(value);
        if (owns_storage) free(stored);
        if (vm->completion.kind != MAL_COMPLETION_THROW) mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue rooted[2] = {prototype, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, rooted, 2);
    MalFfiHandleObject *handle =
        mal_heap_alloc(&vm->heap, sizeof(MalFfiHandleObject), MAL_HEAP_FFI_HANDLE_OBJECT);
    mal_object_init(
        &vm->heap, &handle->object, MAL_HEAP_FFI_HANDLE_OBJECT, mal_value_to_object(prototype));
    rooted[1] = mal_value_from_heap((MalHeapHeader *) handle);
    handle->type = type;
    handle->owner_type = type;
    handle->views = nullptr;
    handle->retained = nullptr;
    handle->operation = nullptr;
    handle->value = stored;
    handle->owned = owned;
    handle->owns_storage = owns_storage;
    handle->closing = false;
    handle->worker_closing = false;
    handle->registry = nullptr;
    handle->pins = 0;
    handle->scope = scope;
    if (owns_storage && type->managed_field_count > 0) {
        handle->retained = calloc((usize) type->managed_field_count, sizeof(*handle->retained));
        if (handle->retained != nullptr) {
            for (i32 index = 0; index < type->managed_field_count; index++)
                handle->retained[index].buffer = mal_value_new_undefined();
        } else {
            ffi_handle_forget(handle);
            mal_vm_throw_allocation_error(vm);
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW && type->size == 0
        && (state == nullptr || !ffi_handle_register(state, handle))) {
        if (owned && type->destroy != nullptr) type->destroy(stored);
        ffi_handle_forget(handle);
        mal_vm_throw_allocation_error(vm);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : rooted[1];
}

MalValue mal_ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, bool fresh) {
    return ffi_new_handle(vm, library, type, value, owned, 0, false, fresh);
}

MalValue mal_ffi_allocate_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    size_t size, size_t alignment) {
    void *storage = ffi_allocate_storage(size, alignment);
    if (storage == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    memset(storage, 0, size);
    return ffi_new_handle(vm, library, type, storage, false, 0, true, false);
}

MalValue mal_ffi_new_callback_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value) {
    MalFfiState *state = vm->ffi;
    u64 scope = state == nullptr || state->invocation_depth == 0
        ? 0
        : state->invocations[state->invocation_depth - 1];
    return ffi_new_handle(vm, library, type, value, false, scope, false, false);
}

// ThinLTO must specialize the descriptor and optional pin at each binding site.
__attribute__((always_inline)) bool mal_ffi_to_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin) {
    if (pin != nullptr) *pin = nullptr;
    if (nullable && mal_value_is_null(value)) {
        *out = nullptr;
        return true;
    }
    MalFfiHandleObject *handle = ffi_handle(value);
    bool typed = handle != nullptr && (handle->type == type
        || (type->family != nullptr && ffi_handle_supports(handle, type)));
    if (typed && handle->value != nullptr && !handle->closing && ffi_scope_active(vm, handle->scope)) {
        *out = handle->value;
        if (pin != nullptr) {
            handle->pins++;
            *pin = handle;
        }
        return true;
    }
    return typed ? ffi_failf(
                       vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "an open %s handle", type->name)
                 : ffi_failf(
                       vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a %s handle%s", type->name,
                       nullable ? " or null" : "");
}

bool mal_ffi_handle_held(MalVm *vm, void *pin, const MalFfiSite *site) {
    MalFfiHandleObject *handle = pin;
    if (handle == nullptr || handle->scope == 0) return true;
    return ffi_fail(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
        "a handle the program holds, not one a callback lends");
}

bool mal_ffi_handle_idle(MalVm *vm, MalValue value, const MalFfiSite *site) {
    MalFfiHandleObject *handle = ffi_handle(value);
    return handle != nullptr && handle->operation == nullptr
        ? true : ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "state no C operation is using");
}

static bool ffi_state_range(MalFfiHandleObject *handle, i32 index, void **data, usize *length) {
    const MalFfiManagedField *field = &handle->type->managed_fields[index];
    MalFfiRetainedField *range = &handle->retained[index];
    if (!field->read(handle->value, data, length)) return false;
    if (*data == nullptr) return *length == 0;
    if (range->pin == nullptr) return false;
    uptr start = (uptr) range->data;
    uptr pointer = (uptr) *data;
    return pointer >= start && pointer - start <= range->length
        && *length <= range->length - (pointer - start);
}

static bool ffi_state_check(MalVm *vm, MalFfiHandleObject *handle, const MalFfiSite *site) {
    for (i32 index = 0; index < handle->type->managed_field_count; index++) {
        void *data;
        usize length;
        if (!ffi_state_range(handle, index, &data, &length))
            return ffi_failf(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
                "%s within its retained byte range", handle->type->managed_fields[index].name);
    }
    return true;
}

bool mal_ffi_begin_handle_use(MalVm *vm, void *pin, const void *operation, const MalFfiSite *site) {
    MalFfiHandleObject *handle = pin;
    if (handle == nullptr || handle->retained == nullptr) return true;
    if (handle->operation == operation) return true;
    if (handle->operation != nullptr)
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "state no other C operation is using");
    if (!ffi_state_check(vm, handle, site)) return false;
    handle->operation = operation;
    return true;
}

void mal_ffi_end_handle_use(
    MalVm *vm, void *pin, const void *operation, const MalFfiSite *site, bool check) {
    MalFfiHandleObject *handle = pin;
    if (handle == nullptr || handle->operation != operation || handle->pins != 1) return;
    if (check && handle->value != nullptr && vm->completion.kind != MAL_COMPLETION_THROW)
        (void) ffi_state_check(vm, handle, site);
    handle->operation = nullptr;
}

MalValue mal_ffi_state_bytes(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t index, const MalFfiSite *site) {
    void *storage;
    if (!mal_ffi_to_handle(vm, value, type, false, site, &storage, nullptr)
        || !mal_ffi_handle_idle(vm, value, site)) return mal_value_new_undefined();
    MalFfiHandleObject *handle = ffi_handle(value);
    // Accessors belong to the caller allocation's descriptor, even through a view.
    if (handle->type != type || handle->retained == nullptr
        || index < 0 || index >= type->managed_field_count) {
        mal_ffi_expected(vm, site, "the state field's allocating handle");
        return mal_value_new_undefined();
    }
    void *data;
    usize length;
    if (!ffi_state_range(handle, index, &data, &length)) {
        ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "a pointer and count within the retained byte range");
        return mal_value_new_undefined();
    }
    MalFfiRetainedField *range = &handle->retained[index];
    if (range->pin == nullptr || (data == nullptr && range->data != nullptr)) return mal_value_new_null();
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(range->buffer);
    u32 offset = data == nullptr ? 0 : (u32) ((uptr) data - (uptr) buffer->data);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalTypedArrayObject *array = mal_typed_array_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, offset, (u32) length, false);
    mal_gc_unroot(&root);
    return mal_value_from_typed_array_object(array);
}

bool mal_ffi_set_state_bytes(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t index, MalValue bytes,
    const MalFfiSite *site) {
    void *storage;
    if (!mal_ffi_to_handle(vm, value, type, false, site, &storage, nullptr)
        || !mal_ffi_handle_idle(vm, value, site)) return false;
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle->type != type || handle->retained == nullptr
        || index < 0 || index >= type->managed_field_count)
        return mal_ffi_expected(vm, site, "the state field's allocating handle");
    const MalFfiManagedField *field = &type->managed_fields[index];
    MalFfiRetainedField next = {.buffer = mal_value_new_undefined()};
    if (!mal_value_is_null(bytes)) {
        MalBufferSourceSpan span;
        if (!mal_ffi_to_bytes(vm, bytes, false, field->writable, site, &next.data, &next.length, nullptr)
            || !mal_ffi_check_count(vm, next.length, field->count_bits, field->count_signed, site)) return false;
        if (mal_buffer_source_span(bytes, &span) != MAL_BUFFER_SOURCE_SPAN_OK) return false;
        next.pin = mal_array_buffer_object_retain_pin(span.buffer);
        if (next.pin == nullptr) return mal_ffi_out_of_memory(vm);
        next.buffer = mal_value_from_array_buffer_object(span.buffer);
    }
    MalFfiRetainedField *range = &handle->retained[index];
    field->write(storage, next.data, next.length);
    mal_gc_write_barrier(range->buffer);
    MalArrayBufferPin *previous = range->pin;
    *range = next;
    mal_gc_card(&handle->object.header, next.buffer);
    mal_array_buffer_object_release_pin(previous);
    return true;
}

void mal_ffi_unpin_handle(void *pin) {
    if (pin != nullptr) ((MalFfiHandleObject *) pin)->pins--;
}

void mal_ffi_inputs_init(MalFfiInputs *inputs, const void *operation, bool held) {
    *inputs = (MalFfiInputs) {.operation = operation, .held = held, .rooted = true};
    mal_ffi_root(&inputs->roots, nullptr, 0);
}

void mal_ffi_inputs_unroot(MalFfiInputs *inputs) {
    if (inputs->rooted) {
        mal_ffi_unroot(&inputs->roots);
        inputs->rooted = false;
    }
}

bool mal_ffi_input_handle(
    MalVm *vm, MalFfiInputs *inputs, MalValue value, const MalFfiHandleType *type,
    bool nullable, const MalFfiSite *site, void **out) {
    if (inputs == nullptr) return mal_ffi_to_handle(vm, value, type, nullable, site, out, nullptr);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    bool ok = true;
    if (inputs->count == inputs->capacity) {
        usize capacity = inputs->capacity == 0 ? 8 : (usize) inputs->capacity * 2;
        if (capacity > INT32_MAX) capacity = INT32_MAX;
        MalValue *grown = inputs->count == INT32_MAX ? nullptr : realloc(inputs->values, capacity * sizeof(*grown));
        if (grown == nullptr) ok = mal_ffi_out_of_memory(vm);
        else {
            inputs->values = grown;
            inputs->capacity = (i32) capacity;
            inputs->roots.slots = grown;
        }
    }
    void *pin = nullptr;
    if (ok) ok = mal_ffi_to_handle(vm, value, type, nullable, site, out, &pin);
    if (ok && pin != nullptr) {
        inputs->values[inputs->count++] = value;
        inputs->roots.count = inputs->count;
        ok = (!inputs->held || mal_ffi_handle_held(vm, pin, site))
            && mal_ffi_begin_handle_use(vm, pin, inputs->operation, site);
    }
    mal_gc_unroot(&root);
    return ok;
}

void mal_ffi_inputs_release(MalVm *vm, MalFfiInputs *inputs, const MalFfiSite *site, bool check) {
    for (i32 index = 0; index < inputs->count; index++) {
        MalFfiHandleObject *handle = ffi_handle(inputs->values[index]);
        mal_ffi_end_handle_use(vm, handle, inputs->operation, site, check);
        mal_ffi_unpin_handle(handle);
    }
    mal_ffi_inputs_unroot(inputs);
    free(inputs->values);
    inputs->values = nullptr;
    inputs->count = 0;
    inputs->capacity = 0;
}

bool mal_ffi_handle_results_ready(MalVm *vm, const MalFfiHandleType *type, const MalFfiSite *site) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return true;
    for (usize index = 0; index < state->handle_capacity; index++) {
        MalFfiHandleObject *handle = state->handles[index].handle;
        if (handle != nullptr && handle->worker_closing
            && ffi_handle_family(handle->type) == ffi_handle_family(type))
            return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
                "a settled worker close before returning this handle type, or a fresh result fact");
    }
    return true;
}

bool mal_ffi_begin_handle_close(MalVm *vm, void *pin, bool worker, const MalFfiSite *site) {
    if (pin == nullptr) return true;
    MalFfiHandleObject *handle = pin;
    if (handle->owns_storage && handle->type->size == 0)
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
            "library-owned storage for a destroy binding; caller storage needs explicit C cleanup");
    if (handle->pins != 1 || handle->closing)
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
            "a handle no other C call is using");
    handle->closing = true;
    handle->worker_closing = worker;
    return true;
}

void mal_ffi_finish_handle_close(MalValue value, bool released) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr) return;
    handle->closing = false;
    handle->worker_closing = false;
    if (released) {
        ffi_replaced_drop(handle->value);
        ffi_handle_forget(handle);
    }
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
    mal_gc_register_tracer(MAL_HEAP_FFI_HANDLE_OBJECT, ffi_handle_trace);
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
