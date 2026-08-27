#pragma once

#include "vm.h"

/* Convert a WHATWG file: URL object to a malloc-owned POSIX path. The URL's
 * query and fragment are ignored, percent escapes are decoded, and encoded '/'
 * bytes are rejected. When `silent` is true, validation failures return false
 * without changing the VM completion (used by fs.existsSync). */
bool mal_node_file_url_to_path_bytes(
    MalVm *vm, MalValue value, bool silent, char **out, usize *out_length);

void mal_host_install_node_url(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
