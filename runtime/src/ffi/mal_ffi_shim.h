#ifndef MAL_FFI_SHIM_H
#define MAL_FFI_SHIM_H

#include "mal_ffi.h"

/* A shim imports only this table. Its C library still links with strict symbol
 * resolution, so a dependency on another project's link scope cannot go unnoticed. */
typedef struct MalFfiShimRuntime {
#define MAL_FFI_FUNCTION(name, result, attributes, parameters) result (*name) parameters;
#define MAL_FFI_GLOBAL(name, type) type *name;
#include "mal_ffi_api.h"
#undef MAL_FFI_GLOBAL
#undef MAL_FFI_FUNCTION
} MalFfiShimRuntime;

typedef struct MalFfiShimBinding {
    const char *name;
    MalFfiInstaller install;
} MalFfiShimBinding;

#define MAL_FFI_SHIM_ABI 1u
typedef const MalFfiShimBinding *(*MalFfiShimRegister)(
    unsigned abi, size_t runtime_size, const MalFfiShimRuntime *runtime);

#ifdef MAL_FFI_BUILD_SHIM
static inline bool mal_ffi_shim_bind_runtime(
    unsigned abi, size_t runtime_size, const MalFfiShimRuntime *runtime) {
    if (abi != MAL_FFI_SHIM_ABI || runtime_size != sizeof(*runtime)) return false;
#define MAL_FFI_FUNCTION(name, result, attributes, parameters) name = runtime->name;
#define MAL_FFI_GLOBAL(name, type) name = runtime->name;
#include "mal_ffi_api.h"
#undef MAL_FFI_GLOBAL
#undef MAL_FFI_FUNCTION
    return true;
}
#endif

#endif
