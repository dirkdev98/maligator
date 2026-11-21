#include "language_components.h"

#include <string.h>

const MalLanguageComponent *mal_language_components[MAL_LANGUAGE_COMPONENT_COUNT];

static bool image_selects(const MalRuntimeImage *image, MalHostInstaller installer) {
    for (i32 i = 0; image != nullptr && i < image->host_install_count; i++) {
        if (image->host_installs[i].installer == installer) return true;
    }
    return false;
}

// Realm initialization runs these once; keep them out of its inlined body.
__attribute__((noinline)) bool mal_language_component_selected(const MalVm *vm, MalLanguageComponentId id) {
    const MalLanguageComponent *component = mal_language_components[id];
    return component != nullptr && image_selects(vm->runtime_image, component->installer);
}

MalHostInstaller mal_language_component_resolve_installer(const char *name, usize length) {
    for (i32 id = 0; id < MAL_LANGUAGE_COMPONENT_COUNT; id++) {
        const MalLanguageComponent *component = mal_language_components[id];
        if (component != nullptr && strlen(component->name) == length &&
            memcmp(component->name, name, length) == 0) {
            return component->installer;
        }
    }
    return nullptr;
}

__attribute__((noinline)) void mal_language_components_install(MalVm *vm, MalLanguageComponentId first, MalLanguageComponentId last) {
    for (MalLanguageComponentId id = first; id <= last; id++) {
        if (!mal_language_component_selected(vm, id)) continue;
        mal_language_components[id]->install(vm);
    }
}
