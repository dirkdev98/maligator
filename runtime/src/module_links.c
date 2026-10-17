#include "module_links.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "intrinsics.h"

void mal_module_link_registry_init(MalModuleLinkRegistry *registry) {
    *registry = (MalModuleLinkRegistry) {0};
}

void mal_module_link_registry_free(MalModuleLinkRegistry *registry) {
    free(registry->entries);
    free(registry->targets);
    free(registry->table);
    mal_module_link_registry_init(registry);
}

static u64 link_hash(i32 kind, const char *module, const char *name) {
    u64 hash = 14695981039346656037ull ^ (u64) kind;
    for (const char *text = module; *text != '\0'; text++) {
        hash = (hash ^ (u8) *text) * 1099511628211ull;
    }
    hash = (hash ^ 0xffu) * 1099511628211ull;
    for (const char *text = name; *text != '\0'; text++) {
        hash = (hash ^ (u8) *text) * 1099511628211ull;
    }
    return hash;
}

static bool link_matches(const MalModuleLink *entry, const MalModuleLink *link) {
    return entry->kind == link->kind && strcmp(entry->module, link->module) == 0 &&
        strcmp(entry->name, link->name) == 0;
}

/** The registry index of `link`'s identity, or -1. */
static i32 registry_find(const MalModuleLinkRegistry *registry, const MalModuleLink *link) {
    if (registry->table_size == 0) return -1;
    u64 mask = (u64) registry->table_size - 1;
    for (u64 probe = link_hash(link->kind, link->module, link->name) & mask;;
         probe = (probe + 1) & mask) {
        i32 index = registry->table[probe];
        if (index < 0) return -1;
        if (link_matches(registry->entries[index], link)) return index;
    }
}

static void registry_place(MalModuleLinkRegistry *registry, i32 index) {
    const MalModuleLink *link = registry->entries[index];
    u64 mask = (u64) registry->table_size - 1;
    u64 probe = link_hash(link->kind, link->module, link->name) & mask;
    while (registry->table[probe] >= 0) probe = (probe + 1) & mask;
    registry->table[probe] = index;
}

/** Make room for `additional` entries while the table stays at most half full. */
static bool registry_reserve(MalModuleLinkRegistry *registry, i32 additional) {
    i32 needed = registry->count + additional;
    if (needed > registry->capacity) {
        i32 capacity = registry->capacity == 0 ? 64 : registry->capacity;
        while (capacity < needed) capacity *= 2;
        const MalModuleLink **entries =
            realloc(registry->entries, sizeof(*entries) * (usize) capacity);
        if (entries == nullptr) return false;
        registry->entries = entries;
        i32 *targets = realloc(registry->targets, sizeof(i32) * (usize) capacity);
        if (targets == nullptr) return false;
        registry->targets = targets;
        registry->capacity = capacity;
    }
    if (needed * 2 <= registry->table_size) return true;
    i32 table_size = registry->table_size == 0 ? 128 : registry->table_size;
    while (needed * 2 > table_size) table_size *= 2;
    i32 *table = malloc(sizeof(i32) * (usize) table_size);
    if (table == nullptr) return false;
    memset(table, 0xff, sizeof(i32) * (usize) table_size);
    free(registry->table);
    registry->table = table;
    registry->table_size = table_size;
    for (i32 index = 0; index < registry->count; index++) registry_place(registry, index);
    return true;
}

static void registry_insert(MalModuleLinkRegistry *registry, const MalModuleLink *link, i32 target) {
    i32 index = registry->count++;
    registry->entries[index] = link;
    registry->targets[index] = target;
    registry_place(registry, index);
}

static void throw_link_error(MalVm *vm, const char *format, const MalModuleLink *link) {
    char message[1024];
    snprintf(message, sizeof message, format, link->module, link->name);
    mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, message);
}

bool mal_vm_resolve_module_imports(
    MalVm *vm, const MalRuntimeImage *image, i32 global_base, i32 *out_new_slots) {
    const MalModuleLinkRegistry *registry = &vm->module_links;
    for (i32 index = 0; index < image->module_export_count; index++) {
        const MalModuleLink *link = &image->module_exports[index];
        if (registry_find(registry, link) >= 0) {
            // Two images owning one module would instantiate it twice.
            throw_link_error(vm, "module '%s' export '%s' is linked by two images", link);
            return false;
        }
    }
    i32 new_slots = 0;
    for (i32 index = 0; index < image->module_import_count; index++) {
        MalModuleLink *link = &image->module_imports[index];
        i32 found = registry_find(registry, link);
        if (found >= 0) {
            link->target = registry->targets[found];
        } else if (link->kind == MAL_MODULE_LINK_NAMESPACE) {
            // No earlier image created this namespace; the first importer's slot
            // becomes the one every later importer shares.
            link->target = global_base + image->global_count + new_slots++;
        } else if (link->kind == MAL_MODULE_LINK_CJS) {
            throw_link_error(vm, "the CommonJS module '%s' is not loaded by an earlier image%.0s", link);
            return false;
        } else {
            throw_link_error(
                vm, "The requested module '%s' does not provide an export named '%s'", link);
            return false;
        }
    }
    *out_new_slots = new_slots;
    return true;
}

bool mal_vm_publish_module_exports(
    MalVm *vm, const MalRuntimeImage *image, const i32 *global_remap, i32 cjs_base) {
    MalModuleLinkRegistry *registry = &vm->module_links;
    if (!registry_reserve(registry, image->module_export_count + image->module_import_count)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (i32 index = 0; index < image->module_export_count; index++) {
        const MalModuleLink *link = &image->module_exports[index];
        registry_insert(
            registry, link,
            link->kind == MAL_MODULE_LINK_CJS ? cjs_base + link->slot
            : global_remap == nullptr     ? link->slot
                                          : global_remap[link->slot]);
    }
    for (i32 index = 0; index < image->module_import_count; index++) {
        const MalModuleLink *link = &image->module_imports[index];
        if (link->kind == MAL_MODULE_LINK_NAMESPACE && registry_find(registry, link) < 0) {
            registry_insert(registry, link, link->target);
        }
    }
    return true;
}
