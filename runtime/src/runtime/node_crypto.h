#pragma once

#include "./defaults.h"

/*
 * node:crypto host built-in (runtime layer, behind surface.node / MAL_NODE).
 *
 * Covers MD5/SHA-1/SHA-224/SHA-256/SHA-384/SHA-512 `createHash`, `createHmac`
 * (string, buffer or secret KeyObject keys), one-shot `hash`, `pbkdf2`/`pbkdf2Sync`,
 * `scrypt`/`scryptSync`, `hkdf`/`hkdfSync`, `timingSafeEqual`, the random APIs
 * (`randomBytes`/`randomFill`/`randomInt`/`randomUUID`/`randomUUIDv7`/
 * `getRandomValues`), `createSecretKey`, `createCipheriv`/`createDecipheriv` for
 * AES-128/192/256-CBC/CTR/GCM and ChaCha20-Poly1305, a WebCrypto `subtle` with
 * digest, raw HMAC sign/verify and AES-GCM encrypt/decrypt, and Argon2d/i/id via
 * `argon2Sync` and the off-event-loop `argon2`. Digests are self-contained C
 * (FIPS 180-4); ciphers and Argon2 are pure-Rust primitives behind flat ABIs.
 *
 * Deliberate divergences from Node 24.14.1, all pinned in
 * tests/local/node-crypto.mts:
 *   * `parameters.secret` / `parameters.associatedData` of a wrong type throw a
 *     proper TypeError rather than Node's ERR_INTERNAL_ASSERTION bug.
 *   * Argon2 `memory` and `tagLength` accept Node's full documented range and
 *     are then subject to a host resource policy (see MalArgon2Config). A
 *     request inside Node's range but past the ceilings is a fixed JavaScript
 *     Error; Node's answer to the same request is a SIGKILLed process.
 * Still narrower than Node: only the digests and ciphers above, Cipheriv is not a
 * Transform stream (update/final only), and `crypto.hash` accepts an ArrayBuffer
 * input that Node rejects.
 *
 * Asynchrony: Argon2, pbkdf2, scrypt and hkdf run on host worker pools.
 * `randomBytes`, `randomFill` and `randomInt` draw entropy on the calling thread
 * and post the finished value, so the callback lands as a macrotask with Node's
 * ordering while the draw itself stays on the loop. `subtle` operations compute
 * on the calling thread and settle their promise before returning.
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
 * Macrotask source for the asynchronous crypto callbacks (`argon2`, the
 * key derivations, `randomBytes(cb)`, `randomFill(cb)`, `randomInt(cb)`). Returns false when the head host task
 * belongs to another runtime module, so the cooperative drain protocol keeps
 * net/http from being starved.
 */
bool mal_node_crypto_drain(MalVm *vm);
