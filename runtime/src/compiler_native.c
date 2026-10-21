#include <string.h>

#include "compiler_native.h"

bool mal_native_overlay_attach_fragment(
    MalVm *vm,
    const MalNativeOverlay *overlay,
    const MalRuntimeImage *program,
    const MalNativeProgramRelocation *relocation
) {
    i32 function_count = program->function_count;
    if (overlay->function_count != function_count || overlay->relocation == nullptr) return false;
    i32 import_count = 0;
    for (i32 index = 0; index < program->module_import_count; index++) {
        if (program->module_imports[index].kind != MAL_MODULE_LINK_CJS) import_count++;
    }
    if (import_count != overlay->global_import_count) return false;
    const MalNativeProgramRelocation *attached = overlay->relocation;
    if (*overlay->relocation_attached) {
        if (attached->function_base != relocation->function_base ||
            attached->global_base != relocation->global_base ||
            attached->string_base != relocation->string_base ||
            attached->bigint_base != relocation->bigint_base ||
            attached->literal_template_base != relocation->literal_template_base) {
            return false;
        }
    }
    for (i32 index = 0, ordinal = 0; index < program->module_import_count; index++) {
        const MalModuleLink *link = &program->module_imports[index];
        if (link->kind == MAL_MODULE_LINK_CJS) continue;
        if (*overlay->relocation_attached) {
            if (overlay->global_imports[ordinal] != link->target) return false;
        } else {
            overlay->global_imports[ordinal] = link->target;
        }
        ordinal++;
    }
    if (!*overlay->relocation_attached) {
        *overlay->relocation = *relocation;
        overlay->relocation->global_imports = overlay->global_imports;
        *overlay->relocation_attached = true;
    }
    if (overlay->conservative_stack_roots) {
        vm->live_runtime_image.conservative_stack_roots = true;
        mal_vm_sync_entry_stack_limit(vm);
    }
    MalFunction *functions = (MalFunction *) vm->runtime_image->functions;
    for (i32 index = 0; index < function_count; index++) {
        if (overlay->entries[index] == nullptr) continue;
        functions[relocation->function_base + index].compiled = overlay->entries[index];
        mal_vm_refresh_call_entry(vm, relocation->function_base + index);
    }
    return true;
}

#if MAL_EVAL && defined(MAL_COMPILER_NATIVE)

#ifndef MAL_COMPILER_WIRE_DIGEST
#error "MAL_COMPILER_WIRE_DIGEST must identify the native compiler wire"
#endif

extern const MalNativeOverlay mal_eval_compiler_native_overlay;

bool mal_compiler_native_attach(
    MalVm *vm,
    i32 function_base,
    i32 function_count,
    const MalNativeProgramRelocation *relocation
) {
    const MalNativeOverlay *overlay = &mal_eval_compiler_native_overlay;
    if (overlay->function_count != function_count ||
        strcmp(overlay->wire_digest, MAL_COMPILER_WIRE_DIGEST) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                           "eval: baked native compiler does not match its wire image");
        return false;
    }
    vm->compiler_native_relocation = *relocation;
    if (overlay->conservative_stack_roots) {
        vm->live_runtime_image.conservative_stack_roots = true;
        mal_vm_sync_entry_stack_limit(vm);
    }
    MalFunction *functions = (MalFunction *) vm->runtime_image->functions;
    for (i32 index = 0; index < function_count; index++) {
        if (overlay->entries[index] == nullptr) continue;
        MalFunction *function = &functions[function_base + index];
        function->compiled = overlay->entries[index];
        mal_vm_refresh_call_entry(vm, function_base + index);
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
