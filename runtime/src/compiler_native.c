#include <string.h>

#include "compiler_native.h"

#if MAL_EVAL && defined(MAL_COMPILER_NATIVE)

#ifndef MAL_COMPILER_WIRE_DIGEST
#error "MAL_COMPILER_WIRE_DIGEST must identify the native compiler wire"
#endif

extern const MalCompilerNativeOverlay mal_eval_compiler_native_overlay;

bool mal_compiler_native_attach(
    MalVm *vm,
    i32 function_base,
    i32 function_count,
    const MalNativeProgramRelocation *relocation
) {
    const MalCompilerNativeOverlay *overlay = &mal_eval_compiler_native_overlay;
    if (overlay->function_count != function_count ||
        strcmp(overlay->wire_digest, MAL_COMPILER_WIRE_DIGEST) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                           "eval: baked native compiler does not match its wire image");
        return false;
    }
    vm->compiler_native_relocation = *relocation;
    MalFunction *functions = (MalFunction *) vm->runtime_image->functions;
    for (i32 index = 0; index < function_count; index++) {
        if (overlay->entries[index] == nullptr) continue;
        MalFunction *function = &functions[function_base + index];
        function->compiled = overlay->entries[index];
    }
    return true;
}

#else

bool mal_compiler_native_attach(
    MalVm *vm,
    i32 function_base,
    i32 function_count,
    const MalNativeProgramRelocation *relocation
) {
    (void) vm;
    (void) function_base;
    (void) function_count;
    (void) relocation;
    return true;
}

#endif
