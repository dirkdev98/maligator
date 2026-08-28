#pragma once

#include "vm.h"

typedef struct MalCompilerNativeOverlay {
    const char *wire_digest;
    i32 function_count;
    const MalCompiledFunction *entries;
} MalCompilerNativeOverlay;

/** Attach a matching optional native overlay to the newly spliced compiler image. */
bool mal_compiler_native_attach(
    MalVm *vm,
    i32 function_base,
    i32 function_count,
    const MalNativeProgramRelocation *relocation
);
