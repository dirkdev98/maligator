#pragma once

#include "./defaults.h"

/*
 * node:crypto host built-in (runtime layer, behind surface.node / MAL_NODE).
 *
 * A deliberately tiny slice: one-shot SHA-256 `hash`, streaming SHA-1
 * `createHash`, streaming SHA-256 `createHmac`, `timingSafeEqual`, and
 * `randomUUID`. The digest cores are pure, self-contained C (FIPS 180-4) with
 * no OpenSSL / Rust dependency.
 *
 * The streaming slice accepts only createHash("sha1") and
 * createHmac("sha256", string-or-ArrayBufferView), UTF-8 strings (using utf8 or
 * utf-8, case-insensitively) or ArrayBufferView updates, and digest("base64").
 * The one-shot helper remains
 * hash("sha256", string-or-byte-source, "hex"). Detached and out-of-bounds
 * views are rejected, and finalized streaming state cannot be reused.
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
