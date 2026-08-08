#include "vm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "key.h"
#include "value.h"
#include "vm_ops.h"

/*
 * Secret-bearing ArrayBuffer backing stores.
 *
 * The property under test — that a sensitive store is zeroed *before* the block
 * goes back to the allocator — is unobservable from JavaScript and unobservable
 * from C after the fact: reading the block after free() is exactly the bug this
 * prevents. So the driver installs the release observer, which runs on both
 * release paths with the store still mapped, after any scrub and immediately
 * before free().
 *
 * Both paths matter, and for different reasons: detach is the explicit one, and
 * the GC sweep is the one every real secret buffer actually takes, because
 * nothing detaches a digest state or a derived tag.
 */

extern const MalVmDefinition mal_vm_definition;

#define SECRET_LENGTH 96
#define SECRET_BYTE 0xa7

typedef struct SecretObservation {
    /* Only this buffer is recorded: a sweep releases whatever else the isolate
     * happens to be done with, and those are not what any check here is about. */
    const MalArrayBufferObject *target;
    int releases;
    u32 capacity;
    /* Set when a released store still held a byte of the pattern written into it. */
    bool residue;
    bool sensitive;
} SecretObservation;

static SecretObservation g_observed;

static void secret_release_observer(
    const MalArrayBufferObject *buffer, const byte *data, u32 capacity) {
    if (buffer != g_observed.target) return;
    g_observed.releases++;
    g_observed.capacity = capacity;
    g_observed.sensitive = buffer->sensitive;
    for (u32 i = 0; i < capacity; i++) {
        if (data[i] != (byte) SECRET_BYTE) continue;
        g_observed.residue = true;
        return;
    }
}

static void secret_observation_reset(void) {
    memset(&g_observed, 0, sizeof(g_observed));
}

static MalArrayBufferObject *secret_buffer_new(MalVm *vm, bool sensitive) {
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer = sensitive
        ? mal_array_buffer_object_new_sensitive(&vm->heap, prototype, SECRET_LENGTH)
        : mal_array_buffer_object_new(
              &vm->heap, prototype, SECRET_LENGTH, SECRET_LENGTH, false, false);
    if (buffer == nullptr || buffer->data == nullptr) return nullptr;
    memset(buffer->data, SECRET_BYTE, SECRET_LENGTH);
    g_observed.target = buffer;
    return buffer;
}

static bool secret_detach_scrubs_the_store(MalVm *vm) {
    secret_observation_reset();
    MalArrayBufferObject *buffer = secret_buffer_new(vm, true);
    if (buffer == nullptr) return false;
    mal_array_buffer_object_detach(buffer);
    // Detaching twice must not release a second time.
    mal_array_buffer_object_detach(buffer);
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
    mal_array_buffer_object_detach(buffer);
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
    g_observed.target = buffer;
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
    if (buffer->data == nullptr) return false;
    buffer->sensitive = true;
    memset(buffer->data, SECRET_BYTE, SECRET_LENGTH);
    g_observed.target = buffer;
    bool shrunk = mal_array_buffer_object_resize(buffer, 8);
    mal_array_buffer_object_detach(buffer);
    return shrunk && g_observed.releases == 1 && !g_observed.residue
        && g_observed.capacity == SECRET_LENGTH;
}

/*
 * ArrayBuffer.prototype.transfer() moves the contents into a fresh store and
 * detaches the source, so the flag has to move with them — otherwise
 * transferring a derived key leaves an unscrubbed copy behind. The builtin is
 * the thing under test, so it is called for real; JavaScript cannot observe the
 * flag itself, which is why the assertion is made from here.
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
        MalCompletion completion = mal_vm_call_value(vm, roots[1], roots[0], nullptr, 0);
        ok = completion.kind == MAL_COMPLETION_NORMAL
            && mal_value_is_array_buffer_object(completion.value);
        roots[2] = completion.value;
    }
    ok = ok && mal_value_to_array_buffer_object(roots[2])->sensitive;
    mal_gc_unroot(&root);
    vm->completion.kind = MAL_COMPLETION_NORMAL;
    // transfer() detaches the source, which is what scrubbed it.
    return ok && g_observed.releases == 1 && !g_observed.residue
        && mal_array_buffer_object_is_detached(source);
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
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
    };
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
    mal_vm_free(&vm);
    return passed == total ? 0 : 1;
}
