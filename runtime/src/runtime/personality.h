#pragma once

#include "vm.h"

// A universal development binary applies the image's requested surface, rather than all compiled features.
void mal_runtime_personality_install(MalVm *vm, bool web_platform, bool node);
void mal_runtime_events_ensure(MalVm *vm);
void mal_runtime_events_install_globals(MalVm *vm);
