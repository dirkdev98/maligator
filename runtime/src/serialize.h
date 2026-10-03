#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;

/*
 * Structured serialization into a VM-free native snapshot.
 *
 * A MalSerializedValue holds only plain bytes plus owned native resources
 * (copied/transferred ArrayBuffer stores, retained shared backings, host
 * descriptors). It never points into any language heap after commit, so it may
 * cross threads and outlive the sender isolate.
 *
 * Transaction:
 *   1. mal_serialize      - validate the whole graph and transfer list, encode,
 *                           then run step 2 once every getter has finished.
 *                           No observable side effects beyond user getters.
 *   2. mal_serialized_value_validate - recheck every transferable: a getter
 *                           may detach a listed buffer or close/transfer a
 *                           listed port. Repeat it if user code ran since 1.
 *   3. (owner admits the snapshot into the receiver queue; no user code may run
 *      between 2 and 4)
 *   4. mal_serialize_commit - revalidate, then steal every transferred store,
 *                           detach its source and commit host descriptors.
 *                           Sender mutator only. Returns false with nothing
 *                           detached when step 2 would now fail.
 *   or mal_serialized_value_release before commit: nothing was detached.
 *   5. mal_deserialize_take - receiver mutator; transferred host resources may be
 *                           adopted only once, as specified by their hooks.
 *   6. mal_serialized_value_release - any thread, once.
 */
typedef struct MalSerializedValue MalSerializedValue;

typedef struct MalSerializeLimits {
    u64 max_bytes;   // encoded payload + copied buffer bytes; 0 = unlimited
    u32 max_objects; // object records; 0 = unlimited
} MalSerializeLimits;

/*
 * Host-object extension (MessagePort, WorkerUrl, ...). `encode` runs on the
 * sender mutator for an object the core does not know; it returns true and
 * fills a native descriptor when it owns the object. A descriptor must not
 * reference language values. `transfer` is true when the object appeared in the
 * transfer list. `commit` runs at mal_serialize_commit for transferred
 * descriptors (e.g. neuter the sender port); the snapshot keeps no language
 * values, so its `value` argument is always undefined and the descriptor must
 * identify the sender object. `decode` runs on the receiver mutator. `release`
 * frees a descriptor that was never decoded-and-adopted. Optional `validate`
 * runs for transferred descriptors at mal_serialized_value_validate and again
 * at commit; it returns false without side effects when the object was closed,
 * transferred or otherwise became untransferable after encode. Optional
 * `reject` runs once for every object before the core encodes it (ordinary
 * objects included) and for every listed transferable; true fails the clone
 * with DataCloneError (Node markAsUncloneable). It must not run JS.
 */
typedef struct MalSerializeHostDescriptor {
    u32 kind;
    void *resource;
} MalSerializeHostDescriptor;

typedef struct MalSerializeHooks {
    void *data;
    bool (*encode)(void *data, MalVm *vm, MalValue value, bool transfer, MalSerializeHostDescriptor *out);
    void (*commit)(void *data, MalVm *vm, MalValue value, MalSerializeHostDescriptor *descriptor);
    bool (*decode)(void *data, MalVm *vm, MalSerializeHostDescriptor *descriptor, MalValue *out);
    void (*release)(MalSerializeHostDescriptor *descriptor);
    bool (*validate)(void *data, MalVm *vm, const MalSerializeHostDescriptor *descriptor);
    bool (*reject)(void *data, MalVm *vm, MalValue object);
} MalSerializeHooks;

/*
 * Returns null on failure. A user getter exception stays pending on `vm`;
 * otherwise *out_error names the DataCloneError message the caller throws.
 * `transfer_list` is undefined or an Array. `hooks` may be null.
 */
MalSerializedValue *mal_serialize(
    MalVm *vm, MalValue value, MalValue transfer_list,
    const MalSerializeLimits *limits, const MalSerializeHooks *hooks,
    const char **out_error);

/*
 * False with *out_error naming the DataCloneError when a listed ArrayBuffer was
 * detached or a host transferable failed `validate` since mal_serialize. Has no
 * effect either way.
 */
bool mal_serialized_value_validate(MalVm *vm, const MalSerializedValue *snapshot, const char **out_error);

/*
 * Revalidates, then commits. On false nothing was detached or committed; the
 * caller releases the snapshot and throws the DataCloneError that
 * mal_serialized_value_validate reports. Either way the snapshot drops its
 * sender heap pointers here, so a failed snapshot can never commit later.
 */
bool mal_serialize_commit(MalVm *vm, MalSerializedValue *snapshot);

/* Copies backing stores so a snapshot without one-shot host resources remains reusable.
 * Returns false with a pending exception (allocation, host decode failure). */
bool mal_deserialize(
    MalVm *vm, MalSerializedValue *snapshot, const MalSerializeHooks *hooks, MalValue *out);

/* Consumes one-shot transport data, adopting stores with their existing process charge.
 * No later decode is allowed, even after failure. Release the snapshot on either outcome:
 * receiver wrappers own adopted stores; the snapshot still owns every unadopted resource.
 * Transfer-bearing snapshots must be committed before either decoding operation. */
bool mal_deserialize_take(
    MalVm *vm, MalSerializedValue *snapshot, const MalSerializeHooks *hooks, MalValue *out);

void mal_serialized_value_release(MalSerializedValue *snapshot);

/*
 * Bytes a queued snapshot pins, for mailbox admission: encoded payload, owned
 * copied/transferred buffer allocations and bookkeeping. Identical before and
 * after commit, so a mailbox may record it at admission and subtract the same
 * value later. Shared backings count only their record (the process
 * shared-memory cap owns their bytes). Saturates at UINT64_MAX instead of
 * wrapping. Process-budget charges (gc_process.h) are separate and exact.
 */
u64 mal_serialized_value_size(const MalSerializedValue *snapshot);

/*
 * The transfer list as serialized. Host transferables are encoded even when
 * unreachable from the value (a Node reply MessagePort), so the receiver
 * recovers them by transfer-list position; null for ArrayBuffer entries.
 * Valid before and after commit, until release.
 */
u32 mal_serialized_value_transfer_count(const MalSerializedValue *snapshot);
const MalSerializeHostDescriptor *mal_serialized_value_transferred_host(
    const MalSerializedValue *snapshot, u32 transfer_index);
