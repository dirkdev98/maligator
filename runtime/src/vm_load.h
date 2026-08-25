#pragma once

#include "./defaults.h"
#include "vm.h"

/**
 * Runtime loader for the binary runtime-image wire format produced by
 * `serializeRuntimeImage` (src/compiler/target/program-image-codec.ts). It materializes
 * the same `MalRuntimeImage` that src/compiler/target/emit-program-image.ts bakes into
 * C literals — functions,
 * instructions, immortal string/bigint constant cells, handlers, and debug
 * tables — but from a buffer the running VM can ingest without a C compile. This
 * is the bridge that runtime `eval` (and a future bytecode cache) runs over.
 *
 * A loaded runtime image owns one growable arena holding all of its materialized
 * structs; it is freed as a unit. Constant string/bigint cells are flagged
 * IMMORTAL (the GC never traces or sweeps them), matching the baked path.
 */
typedef struct MalLoadedRuntimeImage MalLoadedRuntimeImage;
typedef MalHostInstaller (*MalHostInstallerResolver)(const char *name, usize length);

/**
 * Parse `buf` (length `len`) into freshly allocated runtime structs. `buf` need
 * not outlive the call — everything kept is copied into the loaded image's
 * arena. Returns the loaded image, or nullptr on a malformed or
 * version-mismatched buffer, with *out_err set to a static reason string (left
 * untouched on success). Pass a null out_err to ignore the reason.
 */
MalLoadedRuntimeImage *mal_runtime_image_load(const u8 *buf, usize len, const char **out_err);

/**
 * Load a runtime image whose host-install manifest may name portable installers.
 * Engine-only embeddings use mal_runtime_image_load; a product embedding passes
 * its explicit runtime registry here so the engine archive has no host-layer
 * link dependency.
 */
MalLoadedRuntimeImage *mal_runtime_image_load_with_host_resolver(
    const u8 *buf,
    usize len,
    const char **out_err,
    MalHostInstallerResolver resolver);

/** The immutable runtime image a loaded buffer exposes (for init or splice). */
const MalRuntimeImage *mal_loaded_runtime_image_get(const MalLoadedRuntimeImage *loaded);

/** Free a loaded runtime image and every allocation it owns. */
void mal_loaded_runtime_image_free(MalLoadedRuntimeImage *loaded);
