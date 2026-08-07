#pragma once

#include "./defaults.h"

/*
 * node:crypto host built-in (runtime layer, behind surface.node / MAL_NODE).
 *
 * Covers the authentication-grade surface: SHA-1/SHA-256/MD5 `createHash`,
 * SHA-256 `createHmac`, one-shot `hash`, `pbkdf2Sync`, `timingSafeEqual`,
 * `randomBytes`/`randomInt`/`randomUUID` (sync and callback where Node has
 * one), and Argon2d/i/id via `argon2Sync` and the off-event-loop `argon2`.
 * The digest cores are pure, self-contained C (FIPS 180-4) with no OpenSSL
 * dependency; Argon2 goes through the host worker pool onto a Rust primitive.
 *
 * Deliberate divergences from Node 24.14.1, all pinned in
 * tests/local/node-crypto.mts:
 *   * `parameters.secret` / `parameters.associatedData` of a wrong type throw a
 *     proper TypeError rather than Node's ERR_INTERNAL_ASSERTION bug.
 *   * Argon2 `memory` and `tagLength` accept Node's full documented range and
 *     are then subject to a host resource policy (see MalArgon2Config). A
 *     request inside Node's range but past the ceilings is a fixed JavaScript
 *     Error; Node's answer to the same request is a SIGKILLed process.
 * Still narrower than Node: only sha1/sha256/md5 digests, only sha256 HMAC and
 * pbkdf2, and `crypto.hash` accepts an ArrayBuffer input that Node rejects.
 *
 * Asynchrony, stated plainly: only Argon2 leaves the event loop. `argon2` runs
 * on the host worker pool; `randomBytes(size, cb)` and `randomInt(..., cb)` draw
 * their entropy synchronously on the calling thread and then post the finished
 * value, so the callback lands as a macrotask with Node's ordering but the draw
 * itself is not off-loop. Node uses its threadpool for both. For the 16-32 byte
 * draws this surface targets the difference is unobservable; a multi-gigabyte
 * `randomBytes` would stall the loop here where Node's would not. Moving them
 * to a worker is a separate increment — it needs a second pool, and issue #16
 * only requires Argon2 off the loop.
 */

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;

/**
 * Fill the curated `node:crypto` export slots with native values.
 * Matches the engine-neutral MalHostInstaller ABI (see runtime/src/vm.h): the
 * emitted host-install manifest references this symbol for a program that imports
 * a supported export from `node:crypto`. Unknown slots are left untouched.
 */
void mal_host_install_node_crypto(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);

/**
 * Macrotask source for the asynchronous crypto callbacks (`argon2`,
 * `randomBytes(cb)`, `randomInt(cb)`). Returns false when the head host task
 * belongs to another runtime module, so the cooperative drain protocol keeps
 * net/http from being starved.
 */
bool mal_node_crypto_drain(MalVm *vm);

/** Release pending asynchronous crypto state for an isolate (teardown). */
void mal_node_crypto_free(MalVm *vm);
