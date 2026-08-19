#pragma once

#include "./defaults.h"
#include "vm.h"

/**
 * Runtime loader for the binary definition wire format produced by
 * `serializeVmDefinition` (src/compiler/target/serialize-vm.ts). It materializes
 * the same `MalVmDefinition` that src/compiler/target/emit-vm.ts bakes into C
 * literals — functions,
 * instructions, immortal string/bigint constant cells, handlers, and debug
 * tables — but from a buffer the running VM can ingest without a C compile. This
 * is the bridge that runtime `eval` (and a future bytecode cache) runs over.
 *
 * A loaded definition owns one growable arena holding all of its materialized
 * structs; it is freed as a unit. Constant string/bigint cells are flagged
 * IMMORTAL (the GC never traces or sweeps them), matching the baked path.
 */
typedef struct MalLoadedDefinition MalLoadedDefinition;
typedef MalHostInstaller (*MalHostInstallerResolver)(const char *name, usize length);

/**
 * Parse `buf` (length `len`) into freshly allocated runtime structs. `buf` need
 * not outlive the call — everything kept is copied into the loaded definition's
 * arena. Returns the loaded definition, or nullptr on a malformed or
 * version-mismatched buffer, with *out_err set to a static reason string (left
 * untouched on success). Pass a null out_err to ignore the reason.
 */
MalLoadedDefinition *mal_vm_load_definition(const u8 *buf, usize len, const char **out_err);

/**
 * Load a definition whose host-install manifest may name portable installers.
 * Engine-only embeddings use mal_vm_load_definition; a product embedding passes
 * its explicit runtime registry here so the engine archive has no host-layer
 * link dependency.
 */
MalLoadedDefinition *mal_vm_load_definition_with_host_resolver(
    const u8 *buf,
    usize len,
    const char **out_err,
    MalHostInstallerResolver resolver);

/** The public definition a loaded buffer exposes (for mal_vm_init / splice). */
const MalVmDefinition *mal_loaded_definition_get(const MalLoadedDefinition *loaded);

/** Free a loaded definition and every allocation it owns. */
void mal_vm_loaded_definition_free(MalLoadedDefinition *loaded);
