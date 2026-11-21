/* Include with MAL_FFI_FUNCTION and MAL_FFI_GLOBAL to declare or bind the runtime API. */

/** Free-compatible count * size storage with native alignment; overflow and allocation failure return null. */
MAL_FFI_FUNCTION(mal_ffi_allocate_storage, void *, , (size_t count, size_t size, size_t alignment))

/** Zero count * size bytes with native alignment; overflow and allocation failure return null. */
MAL_FFI_FUNCTION(mal_ffi_calloc_storage, void *, , (size_t count, size_t size, size_t alignment))

MAL_FFI_FUNCTION(mal_ffi_scratch_allocate, void *, , (MalVm *vm, MalFfiScratch *scratch, size_t count,
    size_t size, size_t alignment, size_t reserve))

MAL_FFI_FUNCTION(mal_ffi_scratch_free, void, , (MalFfiScratch *scratch, void *data))

MAL_FFI_FUNCTION(mal_ffi_scratch_release, void, , (MalVm *vm, MalFfiScratch *scratch))

/** Snapshot native storage before allocating a JavaScript result. */
MAL_FFI_FUNCTION(mal_ffi_get_global_value, MalValue, , (MalVm *vm, const MalFfiGlobal *global, const MalFfiSite *site))

/** Copies outlive the assigning VM and remain owned until replacement or clearing. */
MAL_FFI_FUNCTION(mal_ffi_set_global_value, bool, , (MalVm *vm, const MalFfiGlobal *global, MalValue value, const MalFfiSite *site))

/** Read a separately exported count under the retained-global lock, without VM allocation. */
MAL_FFI_FUNCTION(mal_ffi_read_global_count, void, , (void (*read)(void *out), void *out))

/**
 * Wrap a resource in a new handle: `value` is the pointer, or the address of the
 * struct to copy. Disposing an owned handle releases the resource; a borrowed
 * handle only closes. `fresh` asserts a new lifetime even when C reuses the
 * address of a closing handle.
 */
MAL_FFI_FUNCTION(mal_ffi_new_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, bool fresh))

/**
 * Wrap a library pointer to a complete struct whose handle type otherwise copies
 * structs. The handle keeps that pointer as its storage, so C changes stay visible
 * and destroy receives it; the handle never frees it itself.
 */
MAL_FFI_FUNCTION(mal_ffi_new_struct_pointer_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned))

/** A canonical borrowed child whose owning resource remains reachable and guarded. */
MAL_FFI_FUNCTION(mal_ffi_new_owner_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    void *value, MalValue owner))

/** Prove the destruction boundary before reading a borrowed descendant's C fields. */
MAL_FFI_FUNCTION(mal_ffi_owner_ready, bool, , (MalVm *vm, MalValue value, const MalFfiSite *site))

/** Library lifetime survives view disposal and protects native-only result cleanup. */
MAL_FFI_FUNCTION(mal_ffi_new_library_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value))

MAL_FFI_FUNCTION(mal_ffi_is_library_resource, bool, , (const MalFfiHandleType *type, const void *value))

/** Reserve native teardown state before admitting an owned-pointer worker result. */
MAL_FFI_FUNCTION(mal_ffi_discards_init, bool, , (MalVm *vm, MalFfiDiscards *discards,
    MalFfiDiscardedHandle *items, int32_t capacity))

MAL_FFI_FUNCTION(mal_ffi_discards_finish, void, , (MalFfiDiscards *discards))

/** Record conversion attempts and return whether an abandoned pointer needs destruction.
 * Native-only callers use the frozen claims published before VM teardown releases work.
 */
MAL_FFI_FUNCTION(mal_ffi_discard_claim, bool, , (MalVm *vm, MalFfiDiscards *discards,
    const MalFfiHandleType *type, const void *value, bool fresh))

/** Query raw ownership without allocating or recording a conversion attempt. */
MAL_FFI_FUNCTION(mal_ffi_discard_needed, bool, , (MalVm *vm, const MalFfiDiscards *discards,
    const MalFfiHandleType *type, const void *value, bool fresh))

MAL_FFI_FUNCTION(mal_ffi_same_resource, bool, , (const MalFfiHandleType *left_type, const void *left,
    const MalFfiHandleType *right_type, const void *right))

MAL_FFI_FUNCTION(mal_ffi_discard_resource, void, , (MalVm *vm, const MalFfiDiscards *discards,
    const MalFfiHandleType *type, void *value, bool fresh))

/**
 * Allocate zeroed caller storage and wrap its stable pointer. Disposing or collecting
 * this handle frees the outer storage; C initialization and cleanup are explicit.
 */
MAL_FFI_FUNCTION(mal_ffi_allocate_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    size_t size, size_t alignment))

/** Validate a native queried layout before allocating zeroed opaque caller storage. */
MAL_FFI_FUNCTION(mal_ffi_allocate_opaque_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    uint64_t size, uint64_t alignment, const MalFfiSite *site))

/** Allocate caller storage for a trailing array, rejecting size and alignment-rounding overflow. */
MAL_FFI_FUNCTION(mal_ffi_allocate_trailing_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    uint64_t count, size_t offset, size_t stride, size_t minimum, size_t alignment,
    const MalFfiSite *site))

/**
 * A borrowed handle for a callback argument. It reads as closed once the callback
 * returns, unless the program already held a handle for the same pointer.
 */
MAL_FFI_FUNCTION(mal_ffi_new_callback_handle, MalValue, , (
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value))

/** Bracket a trampoline that lends handles: the callback invocation they belong to. */
MAL_FFI_FUNCTION(mal_ffi_callback_enter, bool, , (MalVm *vm))

MAL_FFI_FUNCTION(mal_ffi_callback_leave, void, , (MalVm *vm))

/**
 * The resource behind an open handle of `type`: the pointer, or the address of
 * the copied struct, which the library may update in place. A nullable site
 * accepts null and yields a null pointer. With a non-null `pin`, the handle stays
 * open until `mal_ffi_unpin_handle` receives `*pin`: JavaScript that runs during
 * the call, in a getter or a callback, cannot close it while C uses it.
 */
MAL_FFI_FUNCTION(mal_ffi_to_handle, bool, , (
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin))

MAL_FFI_FUNCTION(mal_ffi_unpin_handle, void, , (void *pin))

/** Managed state permits one C operation at a time; aliases share that operation. */
MAL_FFI_FUNCTION(mal_ffi_begin_handle_use, bool, , (MalVm *vm, void *pin, const void *operation, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_end_handle_use, void, , (MalVm *vm, void *pin, const void *operation, const MalFfiSite *site, bool check))

MAL_FFI_FUNCTION(mal_ffi_handle_idle, bool, , (MalVm *vm, MalValue value, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_state_value, MalValue, , (MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t field, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_set_state_value, bool, , (MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t field, MalValue input, const MalFfiSite *site))

/** Worker pins block field reads and reject resources a callback only lends. */
MAL_FFI_FUNCTION(mal_ffi_to_worker_handle, bool, , (
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin))

MAL_FFI_FUNCTION(mal_ffi_unpin_worker_handle, void, , (void *pin))

/** Begin cleanup with the sole pin, rejecting reentry until its result is known. */
MAL_FFI_FUNCTION(mal_ffi_begin_handle_close, bool, , (MalVm *vm, void *pin, bool worker, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_begin_handle_initialization, bool, , (MalVm *vm, void *pin, const MalFfiHandleType *type,
    bool worker, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_finish_handle_initialization, void, , (MalValue value, bool initialized))

/** Reject ambiguous pointer results before C can create a resource at a closing address. */
MAL_FFI_FUNCTION(mal_ffi_handle_results_ready, bool, , (MalVm *vm, const MalFfiHandleType *type, const MalFfiSite *site))

/** Finish cleanup, restoring a failed handle or closing a released resource. */
MAL_FFI_FUNCTION(mal_ffi_finish_handle_close, void, , (MalValue value, bool released))

/**
 * Fill each slot with its export. A VM materializes each export once, so every
 * image that imports the module observes the same function and constant values.
 */
MAL_FFI_FUNCTION(mal_ffi_install, void, , (
    MalVm *vm, const MalFfiLibrary *library, const MalHostInstallSlot *slots, int32_t count))

/** Capture a function pointer's object representation in private, GC-traced slots. */
MAL_FFI_FUNCTION(mal_ffi_new_callable, MalValue, , (
    MalVm *vm, const char *name, int32_t length, MalFfiFunction function,
    const void *target, size_t target_size, MalValue owner))

/** Validate the signature and pin a captured owner before argument conversion. */
MAL_FFI_FUNCTION(mal_ffi_callable_target, bool, , (
    MalVm *vm, MalValue callee, MalFfiFunction function, void *target,
    size_t target_size, const MalFfiHandleType *owner_type, void **owner_pin, MalValue *owner_value,
    const MalFfiSite *site))

/** Throw a TypeError naming what the site expects; returns false. */
MAL_FFI_FUNCTION(mal_ffi_expected, bool, , (MalVm *vm, const MalFfiSite *site, const char *expectation))

/** The general case of `mal_ffi_to_integer`, for any value. */
MAL_FFI_FUNCTION(mal_ffi_number_to_integer, bool, , (
    MalVm *vm, MalValue value, int32_t bits, bool is_signed, const MalFfiSite *site, int64_t *out))

/** An integer of `bits` width (1 through 64), given as a BigInt. */
MAL_FFI_FUNCTION(mal_ffi_to_int64, bool, , (
    MalVm *vm, MalValue value, int32_t bits, const MalFfiSite *site, int64_t *out))

MAL_FFI_FUNCTION(mal_ffi_to_uint64, bool, , (
    MalVm *vm, MalValue value, int32_t bits, const MalFfiSite *site, uint64_t *out))

/** Borrowing excludes JS reentry and pointer results; counted inputs allow embedded NUL. */
MAL_FFI_FUNCTION(mal_ffi_to_string, bool, , (
    MalVm *vm, MalValue value, bool nullable, uint32_t flags, const MalFfiSite *site, MalFfiString *out))

MAL_FFI_FUNCTION(mal_ffi_string_release, void, , (MalFfiString *string))

/** A heap copy the caller frees, for strings that outlive one conversion such as global values. */
MAL_FFI_FUNCTION(mal_ffi_to_owned_string, bool, , (MalVm *vm, MalValue value, const MalFfiSite *site, char **out))

MAL_FFI_FUNCTION(mal_ffi_texts_add, bool, , (MalVm *vm, MalFfiTexts *texts, MalValue value, const MalFfiSite *site, char **out))

MAL_FFI_FUNCTION(mal_ffi_texts_free, void, , (MalFfiTexts *texts))

/**
 * The memory of an ArrayBuffer or view, which C may read and write until the call
 * returns. Shared buffers are rejected, and a binding resolves buffers after every
 * other argument so no JavaScript runs between this and the call. With a non-null
 * `pin`, for a call that can run callbacks, the buffer stays pinned against
 * detaching and transfer until `mal_ffi_unpin` receives `*pin`. A `writable` parameter rejects immutable
 * buffers, whose contents must never change.
 */
MAL_FFI_FUNCTION(mal_ffi_to_bytes, bool, , (
    MalVm *vm, MalValue value, bool nullable, bool writable, const MalFfiSite *site,
    void **data, size_t *length, void **pin))

/** A direct TypedArray brand check, without proxies or observable property reads. */
MAL_FFI_FUNCTION(mal_ffi_is_typed_array, bool, , (MalValue value))

/**
 * A new dense Array holding `length` C numbers of `kind`, boxed as their scalar
 * results are. Excludes the 64-bit kinds, whose elements allocate BigInts.
 */
MAL_FFI_FUNCTION(mal_ffi_numeric_array, MalValue, , (MalVm *vm, const void *data, int32_t length, MalFfiNumericKind kind))

/**
 * Resolve matching numeric storage after all argument getters. The extent is
 * current, attached, unshared, and compatible with the C element layout; storage C
 * may write is also mutable. A non-null pin protects the storage until
 * `mal_ffi_unpin`; numeric writes remain possible.
 */
MAL_FFI_FUNCTION(mal_ffi_to_numeric_view, bool, , (
    MalVm *vm, MalValue value, MalFfiNumericKind expected, size_t element_size, size_t alignment,
    bool writable, const MalFfiSite *site, const void **data, int32_t *length, void **pin))

/** Copy a fixed row after checking its UTF-8 capacity or exact byte length. */
MAL_FFI_FUNCTION(mal_ffi_to_fixed_string, bool, , (MalVm *vm, MalValue value, void *target, size_t capacity, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_to_fixed_bytes, bool, , (MalVm *vm, MalValue value, void *target, size_t capacity, const MalFfiSite *site))

/** Release a native buffer loan; null is ignored. */
MAL_FFI_FUNCTION(mal_ffi_unpin, void, , (void *pin))

/** The element count of an array argument; null yields 0 for a nullable site. */
MAL_FFI_FUNCTION(mal_ffi_to_array_length, bool, , (
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, int32_t *length))

/** Check that a buffer or array count fits the C integer parameter that carries it. */
MAL_FFI_FUNCTION(mal_ffi_check_count, bool, , (
    MalVm *vm, size_t count, int32_t bits, bool is_signed, const MalFfiSite *site))

/**
 * Check that a buffer or array of `available` units holds the `required` units its
 * length factors multiply to. `valid` is false when a factor is negative or the
 * product overflows 64 bits.
 */
MAL_FFI_FUNCTION(mal_ffi_check_extent, bool, , (
    MalVm *vm, uint64_t available, uint64_t required, bool valid, const char *unit,
    const MalFfiSite *site))

/** Check a native count before allocating or reading a caller-owned array buffer. */
MAL_FFI_FUNCTION(mal_ffi_check_array_count, bool, , (
    MalVm *vm, uint64_t count, uint64_t capacity, const MalFfiSite *site))

/**
 * Read a nested record argument's immediate fields into `leaves`, depth first in
 * field order, when the record and every nested one is an ordinary object with its
 * record's shape. Otherwise false, with nothing thrown: the binding then reads each
 * level with `mal_ffi_record_fields`.
 */
MAL_FFI_FUNCTION(mal_ffi_record_leaves, bool, , (MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves))

/**
 * Read every field of a record argument into `values`, which must stay rooted
 * while the binding converts them. An ordinary object with the record's shape,
 * such as a matching object literal, is read slot by slot; any other object reads
 * each field with [[Get]].
 */
MAL_FFI_FUNCTION(mal_ffi_record_fields, bool, , (
    MalVm *vm, MalValue record, MalFfiRecordType *type, const MalFfiSite *site,
    MalValue *values))

/**
 * Copy own slots of exact ordinary record shapes in a dense Array, without running
 * getters or traps. False means ineligible; ignore any copied prefix and convert
 * sequentially. The caller keeps the array rooted while its slots are read.
 */
MAL_FFI_FUNCTION(mal_ffi_try_record_elements, bool, , (
    MalVm *vm, MalValue array, int32_t length, MalFfiRecordType *type,
    MalValue *values))

/**
 * Copy a packed ordinary Number Array without invoking JavaScript. On false,
 * ignore the destination and convert sequentially. The caller roots the source.
 */
MAL_FFI_FUNCTION(mal_ffi_try_f64_elements, bool, , (MalValue array, int32_t length, double *out))

/**
 * The same for exact integers of 8, 16 or 32 `bits`, into elements of that width.
 * False leaves no thrown exception, so the sequential conversion reports the failure.
 */
MAL_FFI_FUNCTION(mal_ffi_try_integer_elements, bool, , (
    MalValue array, int32_t length, int32_t bits, bool is_signed, void *out))

/** Read element `index` of an array that must have exactly `length` elements. */
MAL_FFI_FUNCTION(mal_ffi_element, bool, , (
    MalVm *vm, MalValue array, int32_t index, int32_t length, const MalFfiSite *site, MalValue *out))

/** BigInt results allocate and may throw an allocation error. */
MAL_FFI_FUNCTION(mal_ffi_from_int64, MalValue, , (MalVm *vm, int64_t value))

MAL_FFI_FUNCTION(mal_ffi_from_uint64, MalValue, , (MalVm *vm, uint64_t value))

/** Copy a NUL-terminated UTF-8 string, replacing malformed sequences; NULL yields null. */
MAL_FFI_FUNCTION(mal_ffi_from_string, MalValue, , (MalVm *vm, const char *value))

/** Copy exactly length UTF-8 bytes, replacing invalid sequences and preserving NULs. */
MAL_FFI_FUNCTION(mal_ffi_from_string_length, MalValue, , (MalVm *vm, const char *value, size_t length))

/** Decode a character row only when its terminator lies within the native bound. */
MAL_FFI_FUNCTION(mal_ffi_from_fixed_string, MalValue, , (MalVm *vm, const void *value, size_t capacity))

/** Copy a counted callback argument on its producer thread without touching the VM. */
MAL_FFI_FUNCTION(mal_ffi_copy_callback_bytes, MalFfiCopyStatus, , (
    const void *source, uint64_t length, bool text, void **out))

/** Preserve native element alignment while copying a notification's array storage. */
MAL_FFI_FUNCTION(mal_ffi_copy_callback_array, MalFfiCopyStatus, , (
    const void *source, uint64_t length, size_t stride, size_t alignment, void **out))

/** Copy a pointer table and its terminated strings into one message-owned allocation. */
MAL_FFI_FUNCTION(mal_ffi_copy_callback_strings, MalFfiCopyStatus, , (
    const void *source, uint64_t length, size_t stride, size_t alignment, void **out))

/** Report a producer's copy failure when its message reaches the VM thread. */
MAL_FFI_FUNCTION(mal_ffi_callback_copy_error, void, , (MalVm *vm, MalFfiCopyStatus status))

/** Copy `length` bytes into a new Uint8Array. */
MAL_FFI_FUNCTION(mal_ffi_from_bytes, MalValue, , (MalVm *vm, const void *data, size_t length))

/**
 * An ordinary object for a struct passed by value, created with its final shape.
 * `values` holds one value per field and must stay rooted until this returns.
 */
MAL_FFI_FUNCTION(mal_ffi_new_record, MalValue, , (MalVm *vm, MalFfiRecordType *type, const MalValue *values))

/**
 * Make `object`, a compiled caller's stack object, an ordinary object of `type`'s
 * shape whose fields are `slots`, which the caller keeps rooted. False after an
 * allocation throw.
 */
MAL_FFI_FUNCTION(mal_ffi_stack_record, bool, , (MalVm *vm, MalFfiRecordType *type, void *object, MalValue *slots))

MAL_FFI_FUNCTION(mal_ffi_new_array, MalValue, , (MalVm *vm, int32_t length))

/** Store an element; both values stay rooted for the duration of the call. */
MAL_FFI_FUNCTION(mal_ffi_set_element, bool, , (MalVm *vm, MalValue array, int32_t index, MalValue value))

/**
 * An Array of `length` whose elements arrive in order through `mal_ffi_push_element`,
 * without property stores. The caller roots it; unfilled slots read as holes.
 */
MAL_FFI_FUNCTION(mal_ffi_new_dense_array, MalValue, , (MalVm *vm, int32_t length))

/** Append element `index`, which must follow the elements already pushed. */
MAL_FFI_FUNCTION(mal_ffi_push_element, bool, , (MalVm *vm, MalValue array, int32_t index, MalValue value))

MAL_FFI_FUNCTION(mal_ffi_threw, bool, , (MalVm *vm))

/** Record the owning thread before C can call a stack or retained context. */
MAL_FFI_FUNCTION(mal_ffi_callback_init, void, , (MalFfiCallback *callback, MalVm *vm, MalValue function))

MAL_FFI_FUNCTION(mal_ffi_callback_own, bool, , (MalVm *vm, MalFfiCallback *callback, MalValue value,
    const void *operation, const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_callback_pin_owner, bool, , (MalVm *vm, MalFfiCallback *callback, MalValue *value, void **pin,
    const MalFfiSite *site))

MAL_FFI_FUNCTION(mal_ffi_callback_result_copy, void *, , (
    MalVm *vm, MalFfiCallback *callback, const void *source, size_t length, bool terminated,
    bool registration))

/** Lease a program-held resource and backing stores through its call or registration. */
MAL_FFI_FUNCTION(mal_ffi_callback_result_handle, bool, , (
    MalVm *vm, MalFfiCallback *callback, MalValue value, const MalFfiHandleType *type,
    bool nullable, bool registration, const MalFfiSite *site, void **out))

/** Retire call-scoped copies after output conversion, or a retained context's final native reference. */
MAL_FFI_FUNCTION(mal_ffi_callback_results_free, void, , (MalFfiCallback *callback))

/**
 * A callback context for a library that keeps the callback after the call returns.
 * It roots `function` until the library passes it to `mal_ffi_release`. Null after
 * an allocation throw.
 */
MAL_FFI_FUNCTION(mal_ffi_keep, MalFfiCallback *, , (MalVm *vm, MalValue function))

/** Prepare a one-shot close, rooting its handle and leasing retained backing stores. */
MAL_FFI_FUNCTION(mal_ffi_close_prepare, bool, , (
    MalVm *vm, MalFfiCallback *callback, MalValue handle, const void *site,
    const MalFfiSite *error))

/** Publish the close before admission; adopts the converted handle's pin. */
MAL_FFI_FUNCTION(mal_ffi_close_commit, void, , (MalFfiCallback *callback, void **pin, bool worker))

/** Snapshot registrations after replacement commits, immediately before C runs. */
MAL_FFI_FUNCTION(mal_ffi_close_start, void, , (MalFfiCallback *callback))

/** Restore VM ownership only when worker admission failed and C never received the close. */
MAL_FFI_FUNCTION(mal_ffi_close_cancel, void, , (MalFfiCallback *callback, void **pin))

/** Claim a completion once, retaining its context through the native callback frame. */
MAL_FFI_FUNCTION(mal_ffi_close_take, MalFfiCallback *, , (const void *site, void *key, MalFfiCallback *data))

MAL_FFI_FUNCTION(mal_ffi_close_value, MalValue, , (MalFfiCallback *callback))

/** Invalidate the wrapper and retire VM pins before running completion JavaScript. */
MAL_FFI_FUNCTION(mal_ffi_close_finish, void, , (MalFfiCallback *callback))

/** Retire C's ownership and the execution reference acquired by close_take. */
MAL_FFI_FUNCTION(mal_ffi_close_return, void, , (MalFfiCallback *callback))

/**
 * The destructor a binding hands the library for a kept callback's user data. A
 * release from another thread, or from a destroy function the collector runs, is
 * queued and completes later on the VM thread.
 */
MAL_FFI_FUNCTION(mal_ffi_release, void, , (void *data))

/**
 * The VM a callback runs in, or null when JavaScript cannot run: once that VM
 * is gone, or while the collector runs a handle's destroy function. Aborts when the
 * library calls back from another thread.
 */
MAL_FFI_FUNCTION(mal_ffi_callback_vm, MalVm *, , (MalFfiCallback *callback))

MAL_FFI_FUNCTION(mal_ffi_callback_owner_vm, MalVm *, , (MalFfiCallback *callback))

/**
 * How many library callbacks have entered `vm`. Unchanged across a C call, no
 * JavaScript ran during it, so its results convert as in a callback-free program.
 */
MAL_FFI_FUNCTION(mal_ffi_reentries, uint64_t, , (MalVm *vm))

/**
 * Whether an enclosing result conversion still holds claims. A result that takes
 * ownership of a pointer such a conversion claims needs its own transaction.
 */
MAL_FFI_FUNCTION(mal_ffi_results_pending, bool, , (MalVm *vm))

/** Keep a native invocation alive if completion retires its registry ownership. */
MAL_FFI_FUNCTION(mal_ffi_callback_hold, void, , (MalFfiCallback *callback))

MAL_FFI_FUNCTION(mal_ffi_callback_drop, void, , (MalFfiCallback *callback))

/**
 * Abort for a callback without user data that arrives outside the call it was passed
 * to, or on another thread.
 */
MAL_FFI_FUNCTION(mal_ffi_callback_lost, void, [[noreturn]], (void))

/**
 * `mal_ffi_keep` for a callback the library may also call from other threads, whose
 * calls then queue for the VM thread. Needs an event loop, which waits while any such
 * callback is kept. Null after a throw.
 */
MAL_FFI_FUNCTION(mal_ffi_keep_queued, MalFfiCallback *, , (MalVm *vm, MalValue function))

/** Whether a call of the callback arrives on its VM's thread, or once that VM is gone. */
MAL_FFI_FUNCTION(mal_ffi_callback_here, bool, , (MalFfiCallback *callback))

/**
 * Reserve a queued call of a callback with user data, which keeps the context alive
 * until `mal_ffi_callback_queue` consumes the reservation. `mal_ffi_replaced`
 * reserves for callbacks without user data, under the lock their setters take.
 */
MAL_FFI_FUNCTION(mal_ffi_callback_reserve, void, , (MalFfiCallback *callback))

/**
 * From another thread: queue `run(vm, callback, message)` for the VM thread, which
 * frees the message with `release` afterwards. Consumes the reservation and the
 * message, which may be null when copying it failed; false when the call was dropped.
 */
MAL_FFI_FUNCTION(mal_ffi_callback_queue, bool, , (
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release))

/**
 * Consume a reservation and message, waiting on a foreign thread for successful VM
 * execution. The returned request retains the message until its explicit release,
 * including on cancellation. Read result storage only after success. The generated
 * entry disables cancellation until its request and native references retire.
 * Release a non-null request even when waiting returns false.
 */
MAL_FFI_FUNCTION(mal_ffi_callback_wait, bool, , (
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release,
    MalFfiWait **request))

MAL_FFI_FUNCTION(mal_ffi_callback_wait_release, void, , (MalFfiWait *request))

MAL_FFI_FUNCTION(mal_ffi_callback_wait_enter, int, , (void))

MAL_FFI_FUNCTION(mal_ffi_callback_wait_leave, void, , (int cancellation_state))

/** Cancel waiting callbacks before joining any thread that might be producing one. */
MAL_FFI_FUNCTION(mal_ffi_callbacks_shutdown, void, , (MalVm *vm))

/**
 * Reserve a setter's key without changing its current callback. On success the
 * transaction owns the callback's base reference and remains at this address until
 * finish. The binding selects its trampoline using `lane`; another setter for the
 * reserved key throws. A failed preparation leaves ownership with the caller.
 */
MAL_FFI_FUNCTION(mal_ffi_replace_prepare, bool, , (
    MalVm *vm, MalFfiReplaced *site, void *key, MalFfiCallback *callback,
    MalFfiReplacement *replacement))

/** Publish the prepared callback immediately before C runs, without touching the VM. */
MAL_FFI_FUNCTION(mal_ffi_replace_commit, void, , (MalFfiReplacement *replacement))

/** End previous result publications at C return; native references retire at finish. */
MAL_FFI_FUNCTION(mal_ffi_replace_return, void, , (MalFfiReplacement *replacement))

/** Retire the previous callback, or the unsubmitted callback, after C stops using it. */
MAL_FFI_FUNCTION(mal_ffi_replace_finish, void, , (MalFfiReplacement *replacement))

/**
 * The callback `site` keeps for `key`, for a trampoline that receives no user data,
 * or null. When it belongs to a VM on another thread, a queued callback's call is
 * reserved, and any other aborts. A nonnull result owns an execution reference
 * that the entry wrapper retires with `mal_ffi_callback_drop` after returning or
 * handing its separate queued reservation to the inbox.
 */
MAL_FFI_FUNCTION(mal_ffi_replaced, MalFfiCallback *, , (MalFfiReplaced *site, void *key, unsigned lane))

/**
 * Bracket a C call that may run JavaScript when the binding runs as an ordinary
 * native call, which keeps the collector off: everything the binding holds is
 * rooted, so the collector may run inside callbacks instead of letting a
 * long-running call grow the heap. The end also completes queued releases.
 */
MAL_FFI_FUNCTION(mal_ffi_collectable_begin, void, , (MalVm *vm))

MAL_FFI_FUNCTION(mal_ffi_collectable_end, void, , (MalVm *vm))

/** Releases queued in any VM by another thread or a collection, not yet completed. */
MAL_FFI_GLOBAL(mal_ffi_queued_releases, _Atomic uint32_t)

/** Out of line and cold, so link-time inlining keeps the release loop off every call. */
MAL_FFI_FUNCTION(mal_ffi_direct_releases, void, __attribute__((cold, noinline)), (MalVm *vm))

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
MAL_FFI_FUNCTION(mal_ffi_async, bool, , (
    MalVm *vm, void *data, MalFfiAsyncRun run, MalFfiAsyncComplete complete,
    MalFfiAsyncRelease release, const MalValue *keep, int32_t keep_count,
    const MalFfiInputs *inputs, MalFfiCallback *const *callbacks, int32_t callback_count,
    MalValue *promise, bool must_run))

/** A promise rejected with the pending throw, which this clears. */
MAL_FFI_FUNCTION(mal_ffi_rejected, MalValue, , (MalVm *vm))

/** Check that a callback argument is callable; null passes for a nullable site. */
MAL_FFI_FUNCTION(mal_ffi_to_function, bool, , (MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site))

/**
 * Call a callback's JavaScript function with `args`, which must stay rooted. Returns
 * false with a pending throw that later callbacks of the call see through `mal_ffi_threw`.
 */
MAL_FFI_FUNCTION(mal_ffi_call, bool, , (
    MalVm *vm, MalValue function, const MalValue *args, int32_t count, MalValue *result))

/** Throw the engine's allocation error after a binding's own allocation failed. */
MAL_FFI_FUNCTION(mal_ffi_out_of_memory, bool, , (MalVm *vm))

MAL_FFI_FUNCTION(mal_ffi_root, void, , (MalFfiRoots *roots, MalValue *slots, int32_t count))

MAL_FFI_FUNCTION(mal_ffi_unroot, void, , (MalFfiRoots *roots))

/**
 * Stage pointer views and ownership until every output and final input check succeeds.
 * Inventory all claims before conversion, including aliases that conversion can expose.
 * Initialize before input roots and finish after their release, in root-stack order.
 */
MAL_FFI_FUNCTION(mal_ffi_results_init, void, , (MalFfiResults *results, MalFfiResultClaim *claims,
    MalValue *handles, int32_t capacity))

/** Grow before inventory; raw resources still belong to the caller if reservation fails. */
MAL_FFI_FUNCTION(mal_ffi_results_reserve, bool, , (MalVm *vm, MalFfiResults *results, uint64_t capacity))

/** Register alias freshness before ordered claims choose their type and ownership. */
MAL_FFI_FUNCTION(mal_ffi_result_hint, void, , (MalFfiResults *results, const MalFfiHandleType *type, void *value))

MAL_FFI_FUNCTION(mal_ffi_result_claim, void, , (MalVm *vm, MalFfiResults *results,
    const MalFfiHandleType *type, void *value, bool owned, bool fresh))

MAL_FFI_FUNCTION(mal_ffi_result_handle, MalValue, , (MalVm *vm, MalFfiResults *results,
    const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, bool fresh))

MAL_FFI_FUNCTION(mal_ffi_results_finish, void, , (MalVm *vm, MalFfiResults *results))

MAL_FFI_FUNCTION(mal_ffi_inputs_init, void, , (MalFfiInputs *inputs, const void *operation, bool worker))

MAL_FFI_FUNCTION(mal_ffi_inputs_unroot, void, , (MalFfiInputs *inputs))

MAL_FFI_FUNCTION(mal_ffi_inputs_release, void, , (MalVm *vm, MalFfiInputs *inputs, const MalFfiSite *site, bool check))

MAL_FFI_FUNCTION(mal_ffi_input_handle, bool, , (MalVm *vm, MalFfiInputs *inputs, MalValue value,
    const MalFfiHandleType *type, bool nullable, const MalFfiSite *site, void **out))

/** Lease owner-bound inputs before publishing a retained callback to C. */
MAL_FFI_FUNCTION(mal_ffi_callback_retain_owners, bool, , (MalVm *vm, MalFfiCallback *callback, MalValue value, const MalFfiInputs *inputs,
    const MalFfiSite *site))
