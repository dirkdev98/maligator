#pragma once

#include "./defaults.h"

/*
 * node:crypto host built-in (runtime layer, behind surface.node / MAL_NODE).
 *
 * A deliberately tiny slice: the one-shot `crypto.hash(algorithm, data,
 * outputEncoding)` helper and `crypto.randomUUID()`. The SHA-256 core is pure,
 * self-contained C (FIPS 180-4) with no OpenSSL / Rust dependency. UUIDs use the
 * engine-neutral host entropy API and set the RFC 4122 version 4 / variant bits.
 *
 * Supported surface (anything outside it throws TypeError): algorithm as the
 * primitive string "sha256", data as a primitive string (UTF-8 encoded,
 * mandatory) or a byte source (ArrayBuffer, TypedArray, or DataView, hashed as
 * raw bytes), and optional output encoding as the primitive string "hex".
 * Detached buffers and views made out of bounds by a resize are rejected.
 */

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;

/**
 * Fill the `node:crypto` export slots (`hash` and `randomUUID`) with native values.
 * Matches the engine-neutral MalHostInstaller ABI (see runtime/src/vm.h): the
 * emitted host-install manifest references this symbol for a program that imports
 * a supported export from `node:crypto`. Unknown slots are left untouched.
 */
void mal_host_install_node_crypto(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
