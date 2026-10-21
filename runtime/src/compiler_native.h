#pragma once

#include "vm.h"

typedef struct MalNativeOverlay {
    const char *wire_digest;
    i32 function_count;
    const MalCompiledFunction *entries;
    /** Attaching these entries makes the host image scan native stacks for roots. */
    bool conservative_stack_roots;
    /*
     * Process-wide bases of a program fragment, set by its first attach. The eval
     * compiler's overlay leaves both null: each VM splices it at its own position and
     * keeps the bases in vm->compiler_native_relocation.
     */
    MalNativeProgramRelocation *relocation;
    bool *relocation_attached;
    /** Process-wide storage for the relocation's resolved imported global slots. */
    i32 *global_imports;
    i32 global_import_count;
} MalNativeOverlay;

/** Attach a matching optional native overlay to the newly spliced compiler image. */
bool mal_compiler_native_attach(
    MalVm *vm,
    i32 function_base,
    i32 function_count,
    const MalNativeProgramRelocation *relocation
);

/**
 * Install a program fragment's overlay on `program`, the image just loaded or
 * spliced at `relocation` with its imports resolved. Fails when the overlay belongs
 * to another image or another attach placed or linked the fragment differently.
 */
bool mal_native_overlay_attach_fragment(
    MalVm *vm,
    const MalNativeOverlay *overlay,
    const MalRuntimeImage *program,
    const MalNativeProgramRelocation *relocation
);
