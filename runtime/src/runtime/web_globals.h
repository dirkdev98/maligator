#pragma once

#include "object.h"

typedef struct MalVm MalVm;

/*
 * Install the self-contained WinterTC "Minimum Common API" globals that need no
 * external library: TextEncoder / TextDecoder, btoa / atob, queueMicrotask,
 * performance (now / timeOrigin), and crypto (randomUUID / getRandomValues).
 *
 * Host entry only (like mal_fetch_install): these are not part of the shared
 * intrinsics, so the bare test262 VM never sees them.
 */
void mal_web_globals_install(MalVm *vm, MalObject *global_this);
