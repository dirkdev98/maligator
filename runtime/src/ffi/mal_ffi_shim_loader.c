#include "mal_ffi_shim.h"

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const MalFfiShimRuntime shim_runtime = {
#define MAL_FFI_FUNCTION(name, result, attributes, parameters) .name = name,
#define MAL_FFI_GLOBAL(name, type) .name = &name,
#include "mal_ffi_api.h"
#undef MAL_FFI_GLOBAL
#undef MAL_FFI_FUNCTION
};

typedef struct LoadedShim {
    const MalFfiShimBinding *binding;
    size_t name_length;
    struct LoadedShim *next;
} LoadedShim;

/* Startup publishes every installer before any VM or worker resolves an image. */
static LoadedShim *loaded_shims;

MalFfiInstaller mal_ffi_resolve_installer(const char *name, size_t length) {
    for (const LoadedShim *shim = loaded_shims; shim != nullptr; shim = shim->next) {
        if (shim->name_length == length && memcmp(name, shim->binding->name, length) == 0)
            return shim->binding->install;
    }
    return nullptr;
}

bool mal_ffi_load_shim(const char *path) {
    void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (handle == nullptr) {
        fprintf(stderr, "could not load C library shim %s: %s\n", path, dlerror());
        return false;
    }
    MalFfiShimRegister install = (MalFfiShimRegister) dlsym(handle, "mal_ffi_shim_register");
    if (install == nullptr) {
        fprintf(stderr, "could not find the registration entry in C library shim %s: %s\n", path, dlerror());
        dlclose(handle);
        return false;
    }
    const MalFfiShimBinding *binding = install(MAL_FFI_SHIM_ABI, sizeof(shim_runtime), &shim_runtime);
    if (binding == nullptr || binding->name == nullptr || binding->install == nullptr) {
        fprintf(stderr, "incompatible C library shim %s\n", path);
        dlclose(handle);
        return false;
    }
    const size_t length = strlen(binding->name);
    if (mal_ffi_resolve_installer(binding->name, length) != nullptr) {
        fprintf(stderr, "duplicate C library installer %s in %s\n", binding->name, path);
        dlclose(handle);
        return false;
    }
    LoadedShim *shim = malloc(sizeof(*shim));
    if (shim == nullptr) {
        dlclose(handle);
        return false;
    }
    *shim = (LoadedShim) { binding, length, loaded_shims };
    loaded_shims = shim;
    // Native code may retain callbacks and resource pointers beyond a VM's lifetime.
    // Keep the loader reference until the process exits.
    return true;
}
