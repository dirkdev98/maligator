#pragma once

#include "./defaults.h"
#include "host_task.h"

/*
 * Argon2 derivation (host layer). Structurally identical to dns.{c,h}: a bounded
 * worker pool doing blocking CPU work on plain host data, posting exactly one
 * terminal task per operation back to the reactor thread.
 *
 * Ownership contract: mal_argon2_start copies every byte input into job-owned
 * storage on the calling thread before returning, so a worker never reads JS
 * heap memory. A collection, a detach(), or a resize() during a derivation
 * therefore cannot invalidate anything in flight.
 *
 * Two properties are deliberate and load-bearing:
 *   * An in-flight derivation is NOT cancellable — Argon2 has no cancellation
 *     point. Shutdown blocks for at most one derivation per worker, so the
 *     product max_passes x max_memory_kib is what bounds worst-case shutdown
 *     latency. Both factors are host policy (see MalArgon2Config); neither is
 *     left to the application, because an application that reads its cost
 *     parameters out of a stored credential record does not choose them either.
 *   * Peak footprint is worker_count x max_memory_kib, so the defaults below
 *     bound a two-worker pool at 512 MiB of Argon2 matrix. Raising the ceiling
 *     raises that product; an embedder that does so owns the consequence.
 */

typedef struct MalHost MalHost;

typedef struct MalArgon2 {
    struct MalArgon2State *state;
} MalArgon2;

typedef struct MalArgon2Result MalArgon2Result;

typedef struct MalArgon2Params {
    /* Already validated against Node's bounds by the runtime adapter. */
    u32 variant;
    u32 parallelism;
    u32 passes;
    u32 memory_kib;
    u32 tag_length;
    const byte *message;
    usize message_len;
    const byte *nonce;
    usize nonce_len;
    const byte *secret;
    usize secret_len;
    const byte *associated_data;
    usize associated_data_len;
} MalArgon2Params;

typedef enum MalArgon2StartResult {
    MAL_ARGON2_START_OK = 0,
    MAL_ARGON2_START_INVALID_ARGUMENT,
    MAL_ARGON2_START_SATURATED,
    MAL_ARGON2_START_SHUTDOWN,
    MAL_ARGON2_START_SYSTEM_ERROR,
    /* Within Node's documented parameter range but beyond this host's resource
     * policy (see MalArgon2Config). Nothing is allocated. */
    MAL_ARGON2_START_POLICY,
} MalArgon2StartResult;

/* Host-layer-only status, never produced by the Rust backend: the parameters
 * are valid Argon2 but exceed the configured resource ceilings. Numbered past
 * the MAL_ARGON2_STATUS_* codes in mal_argon2.h so the two never collide. */
#define MAL_ARGON2_STATUS_POLICY (-4)

/* Test/embedding derivation hook, so C drivers can gate a "derivation" on a
 * mutex instead of burning real Argon2 time. Runs on a worker thread and must
 * return one of the MAL_ARGON2_STATUS_* codes from mal_argon2.h. */
typedef i32 (*MalArgon2Derive)(
    const MalArgon2Params *params, byte *out, usize out_len, void *data);

typedef struct MalArgon2Config {
    usize worker_count;
    usize queue_capacity;
    /* Resource policy. Every ceiling is checked before anything is allocated
     * and before the backend is entered; over any one of them the derivation is
     * refused with MAL_ARGON2_STATUS_POLICY. Zero selects the default. */
    u32 max_memory_kib;
    u32 max_tag_length;
    /* Bounds the one cost parameter whose price is unbounded and whose work
     * cannot be interrupted once started. */
    u32 max_passes;
    MalArgon2Derive derive;
    void *derive_data;
} MalArgon2Config;

/*
 * Authentication-grade defaults. Node's documented ranges go to 2^32-1 for
 * `memory` (4 TiB), `tagLength` (4 GiB), and `passes`; honouring them literally
 * means a single call can exhaust the machine, and with `panic = "abort"` in the
 * Rust profile an allocator failure inside the derivation takes the process with
 * it. Node's own answer to that request is a SIGKILL.
 *
 * So the host imposes a policy on top of Node's validation: the parameter
 * *range* stays exactly Node's, and a request inside that range but past these
 * ceilings becomes a fixed JavaScript Error. 256 MiB is ~5x the largest OWASP
 * Argon2id recommendation (46 MiB) and still bounds worker_count x memory to
 * half a gigabyte with the default two workers. 16 MiB of tag is ~500 000x any
 * real credential tag.
 *
 * `passes` needs the same treatment and for a sharper reason: its cost is linear
 * and unbounded, and unlike an oversized `memory` it cannot fail fast — the
 * derivation simply runs, uninterruptibly, holding a worker and blocking
 * shutdown's join. 8 still leaves headroom over the largest common Argon2id
 * recommendation (t=3), while pinning worst-case uninterruptible work at eight
 * passes over 256 MiB per worker.
 * The parameter is the one an application is least likely to choose for itself:
 * the standard verify flow reads m/t/p back out of the stored credential record,
 * so whoever can write that record picks the cost.
 *
 * An embedder that genuinely needs more raises them through mal_argon2_configure.
 */
#define MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB 262144u
#define MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH 16777216u
#define MAL_ARGON2_DEFAULT_MAX_PASSES 8u

bool mal_argon2_init(MalArgon2 *argon2, MalHost *host);
void mal_argon2_shutdown(MalArgon2 *argon2);
void mal_argon2_free(MalArgon2 *argon2);

/* Accepted only before the lazy worker pool has started. */
bool mal_argon2_configure(MalArgon2 *argon2, const MalArgon2Config *config);

/* On MAL_ARGON2_START_OK, `operation` receives a live handle and exactly one
 * terminal host task will follow. Other returns create no operation. Every
 * byte input is copied before this returns. */
MalArgon2StartResult mal_argon2_start(
    MalHost *host, const MalArgon2Params *params, MalHostHandle *operation);
bool mal_argon2_cancel(MalHost *host, MalHostHandle operation);
/** Release worker records after their posted terminal has transferred or lost cancellation. */
void mal_argon2_reap_completed(MalArgon2 *argon2);

/* Synchronous derivation for argon2Sync: no thread, no operation handle.
 * Returns a MAL_ARGON2_STATUS_* code, including MAL_ARGON2_STATUS_POLICY. */
i32 mal_argon2_derive_sync(
    MalArgon2 *argon2, const MalArgon2Params *params, byte *out, usize out_len);

/* Check `params` against this host's resource policy without allocating
 * anything, so a caller can refuse before sizing its own output buffer.
 * Returns MAL_ARGON2_STATUS_OK or MAL_ARGON2_STATUS_POLICY. A null `argon2`
 * checks against the compiled defaults. */
i32 mal_argon2_check_policy(MalArgon2 *argon2, const MalArgon2Params *params);

/* Terminal payload accessors. The task owns the result until
 * mal_host_task_release; take the data first to retain it longer. */
const byte *mal_argon2_result_tag(const MalArgon2Result *result, usize *length);
i32 mal_argon2_result_status(const MalArgon2Result *result);
void mal_argon2_result_release(MalArgon2Result *result);

usize mal_argon2_queued(MalArgon2 *argon2);
usize mal_argon2_workers(MalArgon2 *argon2);
bool mal_argon2_accepting(MalArgon2 *argon2);
