#pragma once

#include "vm.h"

/** Resolve a serialized installer symbol against the host capabilities in this build. */
MalHostInstaller mal_host_resolve_installer(const char *name, usize length);
