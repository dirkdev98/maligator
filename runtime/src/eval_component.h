#pragma once

#include "vm.h"

/**
 * The baked compiler behind runtime `eval` and the Function constructors.
 *
 * Every runtime archive is the same whatever the eval policy, so the compiler and
 * the code that loads what it compiles live in the eval component (runtime/src/eval),
 * which only `engine.eval: true` links. Its constructor registers it here before
 * main. Without it, nothing in the runtime reaches the image loader or the splicer.
 */
typedef struct MalEvalCompiler {
    /**
     * Splice the embedded compiler wire into `vm` and run its entry, which returns
     * the compiler closure privately: application global properties cannot intercept
     * initialization. Sets vm->compiler_fn and vm->compiler_installed, or returns
     * false with a pending throw.
     */
    bool (*install)(MalVm *vm);
    /**
     * Load an image the compiler returned and splice it into `vm`. Returns its entry,
     * or -1 with a pending throw; `splice_failed` tells a failed splice from a
     * malformed image. `stateless` reports an image without global slots, whose
     * entry later calls may reuse. The bytes stay owned by the caller.
     */
    i32 (*splice)(MalVm *vm, const u8 *bytes, usize length, bool *splice_failed,
                  bool *stateless);
    /** Return the realm's existing namespace or publish a compiled one. */
    MalValue (*intern_builtin_namespace)(MalVm *vm, MalValue id, MalValue namespace);
    /** Resolve and evaluate a runtime-compiled import in a promise job. */
    void (*import_builtin)(MalVm *vm, MalValue specifier, MalValue type, MalValue promise);
} MalEvalCompiler;

/** The linked eval component, or null in an executable without one. */
extern const MalEvalCompiler *mal_eval_compiler;
