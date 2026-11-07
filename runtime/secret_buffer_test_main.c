#include "vm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#include "array_buffer_object.h"
#include "gc.h"
#include "gc_process.h"
#include "intrinsics.h"
#include "key.h"
#include "value.h"
#include "vm_ops.h"

/*
 * Scrubbing must precede allocator reuse, which JavaScript cannot observe and
 * C cannot inspect after free. The native observer sees still-mapped bytes just
 * before release, including when a native owner outlives the VM.
 */

extern const MalRuntimeImage mal_runtime_image;

#define SECRET_LENGTH 96
#define SECRET_BYTE 0xa7

typedef struct SecretObservation {
    /* Only this buffer is recorded: a sweep releases whatever else the isolate
     * happens to be done with, and those are not what any check here is about. */
    uptr target;
    int releases;
    u32 capacity;
    /* Set when a released store still held a byte of the pattern written into it. */
    bool residue;
    bool sensitive;
} SecretObservation;

static SecretObservation g_observed;

static void secret_release_observer(
    const MalArrayBufferReleaseInfo *info, const byte *data, u32 capacity) {
    if (info->identity != g_observed.target) return;
    g_observed.releases++;
    g_observed.capacity = capacity;
    g_observed.sensitive = info->sensitive;
    for (u32 i = 0; i < capacity; i++) {
        if (data[i] != (byte) SECRET_BYTE) continue;
        g_observed.residue = true;
        return;
    }
}

static void secret_observation_reset(void) {
    memset(&g_observed, 0, sizeof(g_observed));
}

/* An ordinary store this small would live in its cell and never reach the release
 * observer, so the ordinary control uses one past the inline limit. */
#define PLAIN_LENGTH (MAL_ARRAY_BUFFER_INLINE_MAX_BYTES + SECRET_LENGTH)

static MalArrayBufferObject *secret_buffer_new(MalVm *vm, bool sensitive) {
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    u32 length = sensitive ? SECRET_LENGTH : PLAIN_LENGTH;
    MalArrayBufferObject *buffer = sensitive
        ? mal_array_buffer_object_new_sensitive(&vm->heap, prototype, length)
        : mal_array_buffer_object_new(&vm->heap, prototype, length, length, false, false);
    if (buffer == nullptr || buffer->data == nullptr) return nullptr;
    memset(buffer->data, SECRET_BYTE, length);
    g_observed.target = (uptr) buffer;
    return buffer;
}

static bool secret_detach_scrubs_the_store(MalVm *vm) {
    secret_observation_reset();
    MalArrayBufferObject *buffer = secret_buffer_new(vm, true);
    if (buffer == nullptr) return false;
    mal_array_buffer_object_detach(&vm->heap, buffer);
    // Detaching twice must not release a second time.
    mal_array_buffer_object_detach(&vm->heap, buffer);
    return g_observed.releases == 1 && !g_observed.residue && g_observed.sensitive
        && g_observed.capacity == SECRET_LENGTH
        && mal_array_buffer_object_is_detached(buffer) && buffer->data == nullptr;
}

/* The rooting here is precise, so an unrooted local is unreachable and the very
 * next collection sweeps it — which is the path a digest state or a derived tag
 * really takes when its owner goes out of scope. */
static bool secret_sweep_scrubs_the_store(MalVm *vm) {
    secret_observation_reset();
    if (secret_buffer_new(vm, true) == nullptr) return false;
    mal_gc_collect(vm);
    return g_observed.releases == 1 && !g_observed.residue && g_observed.sensitive
        && g_observed.capacity == SECRET_LENGTH;
}

/* The flag is what gates the scrub: an ordinary Buffer must not pay for it, so
 * a plain store reaches free() with its bytes intact. This is the assertion that
 * keeps the previous two honest — without it they would also pass if every
 * backing store in the isolate were being scrubbed. */
static bool plain_stores_are_not_scrubbed(MalVm *vm) {
    secret_observation_reset();
    MalArrayBufferObject *buffer = secret_buffer_new(vm, false);
    if (buffer == nullptr) return false;
    mal_array_buffer_object_detach(&vm->heap, buffer);
    return g_observed.releases == 1 && g_observed.residue && !g_observed.sensitive;
}

/* Adoption is how every crypto output buffer is built: the bytes are already
 * malloc'd, and the flag has to survive the handover. */
static bool adopted_stores_carry_the_flag(MalVm *vm) {
    secret_observation_reset();
    byte *bytes = malloc(SECRET_LENGTH);
    if (bytes == nullptr) return false;
    memset(bytes, SECRET_BYTE, SECRET_LENGTH);
    MalArrayBufferObject *buffer = mal_array_buffer_object_adopt(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        bytes, SECRET_LENGTH, true);
    g_observed.target = (uptr) buffer;
    bool adopted = buffer->data == bytes
        && mal_array_buffer_object_byte_length(buffer) == SECRET_LENGTH;
    mal_gc_collect(vm);
    return adopted && g_observed.releases == 1 && !g_observed.residue
        && g_observed.sensitive;
}

/* A shrunken resizable store still holds the bytes past its current length, so
 * the scrub has to cover the allocation rather than byte_length. */
static bool a_shrunken_store_is_scrubbed_to_its_capacity(MalVm *vm) {
    secret_observation_reset();
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &vm->heap, prototype, SECRET_LENGTH, SECRET_LENGTH, true, false);
    if (buffer->data == nullptr || !mal_array_buffer_object_set_sensitive(&vm->heap, buffer, true)) {
        return false;
    }
    memset(buffer->data, SECRET_BYTE, SECRET_LENGTH);
    g_observed.target = (uptr) buffer;
    bool shrunk = mal_array_buffer_object_resize(buffer, 8);
    mal_array_buffer_object_detach(&vm->heap, buffer);
    return shrunk && g_observed.releases == 1 && !g_observed.residue
        && g_observed.capacity == SECRET_LENGTH;
}

/*
 * ArrayBuffer.prototype.transfer() can move the allocation into a smaller
 * logical buffer, so the flag and physical scrub capacity have to move with it.
 * The builtin is called for real, then the result is detached to observe the
 * exact block that survived the transfer.
 */
static bool a_transferred_store_stays_sensitive(MalVm *vm) {
    secret_observation_reset();
    MalArrayBufferObject *source = secret_buffer_new(vm, true);
    if (source == nullptr) return false;
    MalValue roots[] = {
        mal_value_from_array_buffer_object(source),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalKey key = mal_key_from_value(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "transfer")));
    bool ok = mal_vm_get_property(vm, roots[0], key, &roots[1])
        && mal_value_is_callable(roots[1]);
    if (ok) {
        MalValue new_length = mal_value_from_i32(SECRET_LENGTH / 2);
        MalCompletion completion = mal_vm_call_value(
            vm, roots[1], roots[0], &new_length, 1);
        ok = completion.kind == MAL_COMPLETION_NORMAL
            && mal_value_is_array_buffer_object(completion.value);
        roots[2] = completion.value;
    }
    MalArrayBufferObject *result = ok
        ? mal_value_to_array_buffer_object(roots[2])
        : nullptr;
    ok = ok && result->sensitive
        && result->byte_length == SECRET_LENGTH / 2
        && result->allocation_capacity == SECRET_LENGTH
        && mal_array_buffer_object_is_detached(source);
    if (ok) {
        g_observed.target = (uptr) result;
        mal_array_buffer_object_detach(&vm->heap, result);
    }
    mal_gc_unroot(&root);
    vm->completion.kind = MAL_COMPLETION_NORMAL;
    return ok && g_observed.releases == 1 && !g_observed.residue
        && g_observed.capacity == SECRET_LENGTH
        && g_observed.sensitive;
}

typedef struct NativeStore {
    MalArrayBufferStoreLease *lease;
    byte *data;
    u32 capacity;
    uptr identity;
    bool ok;
} NativeStore;

static void *retire_native_store(void *data) {
    NativeStore *store = data;
    secret_observation_reset();
    g_observed.target = store->identity;
    bool intact = true;
    for (u32 index = 0; index < store->capacity; index++)
        intact = intact && store->data[index] == (byte) SECRET_BYTE;
    bool empty = store->data == nullptr;
    usize before = mal_gc_process_bytes();
    mal_array_buffer_store_release(store->lease);
    store->ok = intact && mal_gc_process_bytes() == before - store->capacity
        && g_observed.releases == (empty ? 0 : 1)
        && !g_observed.residue
        && (empty || g_observed.sensitive);
    return nullptr;
}

static NativeStore native_store(MalVm *vm, bool adopted, u32 length, u32 capacity, bool resizable) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer = adopted
        ? mal_array_buffer_object_adopt(&vm->heap, prototype, malloc(capacity), capacity, true)
        : mal_array_buffer_object_new(&vm->heap, prototype, length, capacity, resizable, false);
    if (!mal_array_buffer_object_set_sensitive(&vm->heap, buffer, true)) abort();
    if (buffer->data != nullptr) memset(buffer->data, SECRET_BYTE, buffer->allocation_capacity);
    if (resizable && !mal_array_buffer_object_resize(buffer, 8)) abort();
    MalArrayBufferStoreLease *lease = mal_array_buffer_object_retain_store(&vm->heap, buffer);
    MalArrayBufferStoreLease *other = mal_array_buffer_object_retain_store(&vm->heap, buffer);
    if (lease == nullptr || other == nullptr) abort();
    mal_array_buffer_store_release(other);
    return (NativeStore) {lease, buffer->data, buffer->allocation_capacity, (uptr) buffer, false};
}

int main(void) {
    // Releases are observed after collections, so stack residue must not root dropped stores.
    mal_gc_test_precise_stack_roots = true;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_array_buffer_object_set_release_observer(secret_release_observer);

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"detach scrubs a sensitive store before releasing it",
            secret_detach_scrubs_the_store(&vm)},
        {"the GC sweep scrubs a sensitive store before releasing it",
            secret_sweep_scrubs_the_store(&vm)},
        {"an ordinary store is released without a scrub",
            plain_stores_are_not_scrubbed(&vm)},
        {"an adopted store keeps the sensitive flag through the handover",
            adopted_stores_carry_the_flag(&vm)},
        {"a shrunken resizable store is scrubbed to its full capacity",
            a_shrunken_store_is_scrubbed_to_its_capacity(&vm)},
        {"transfer() carries the sensitive flag onto the moved store",
            a_transferred_store_stays_sensitive(&vm)},
        {"native store ownership survives VM teardown and retires on another thread", false},
    };
    NativeStore stores[] = {
        native_store(&vm, false, SECRET_LENGTH, SECRET_LENGTH, false),
        native_store(&vm, true, SECRET_LENGTH, SECRET_LENGTH, false),
        native_store(&vm, false, 16, SECRET_LENGTH, true),
        native_store(&vm, false, 0, 0, false),
    };
    mal_vm_free(&vm);
    bool native_ok = true;
    for (usize index = 0; index < countof(stores); index++) {
        pthread_t thread;
        if (pthread_create(&thread, nullptr, retire_native_store, &stores[index]) != 0) abort();
        if (pthread_join(thread, nullptr) != 0) abort();
        native_ok = native_ok && stores[index].ok;
    }
    checks[countof(checks) - 1].ok = native_ok;
    int total = (int) countof(checks);
    int passed = 0;
    for (int i = 0; i < total; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("secretbuffertest CHECK FAIL: %s\n", checks[i].name);
        }
    }
    printf("secretbuffertest PASS %d/%d\n", passed, total);

    mal_array_buffer_object_set_release_observer(nullptr);
    return passed == total ? 0 : 1;
}
