#pragma once

#include "./defaults.h"

/**
 * The baked compiler definition for runtime `eval` / `new Function`.
 *
 * `eval-compiler-entry.mts` (the `compileSourceToBuffer` cone + meriyah) is
 * AOT-compiled by maligator into the serialize-vm.ts wire format and `#embed`ded
 * here at build time (src/compiler-bake.ts generates compiler.malw before the
 * runtime archive build). The eval intrinsic splices this definition on first use and runs
 * its top level to publish `__compile`. Returns the embedded bytes and writes
 * the length to *len.
 */
const u8 *mal_compiler_wire_bytes(usize *len);

#if MAL_EVAL
/** Link-visible backing bytes, also reused by the redistributable CLI asset. */
extern const u8 mal_compiler_wire_data[];
#endif
