#pragma once

#include "vm.h"

void mal_module_link_registry_init(MalModuleLinkRegistry *registry);
void mal_module_link_registry_free(MalModuleLinkRegistry *registry);

/**
 * Resolve `image`'s imports against the exports of the images already in `vm`,
 * recording each target in its MalModuleLink. A namespace no earlier image created
 * gets a fresh slot after the image's own globals, `global_base + global_count`
 * onwards; `*out_new_slots` counts them. Throws a SyntaxError and returns false,
 * without changing the VM, when an import or a duplicate export cannot link.
 */
bool mal_vm_resolve_module_imports(
    MalVm *vm, const MalRuntimeImage *image, i32 global_base, i32 *out_new_slots);

/**
 * Publish `image`'s exports and the fresh namespace slots of its imports once it
 * is spliced. `global_remap` maps each image-local global slot to its absolute
 * slot (nullptr for the first image, whose slots are absolute); `cjs_base` is the
 * absolute id of the image's first CommonJS module.
 */
bool mal_vm_publish_module_exports(
    MalVm *vm, const MalRuntimeImage *image, const i32 *global_remap, i32 cjs_base);
