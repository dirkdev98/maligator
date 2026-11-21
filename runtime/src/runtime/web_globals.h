#pragma once

#include "object.h"

typedef struct MalVm MalVm;

/* Install the UTF-8 TextEncoder/TextDecoder globals shared by web and Node hosts. */
void mal_text_encoding_globals_install(MalVm *vm, MalObject *global_this);

/* Install structuredClone, which is global in both web and Node hosts. */
void mal_structured_clone_global_install(MalVm *vm, MalObject *global_this);
void mal_navigator_global_install(MalVm *vm, MalObject *global_this);
void mal_base64_globals_install(MalVm *vm, MalObject *global_this);
void mal_microtask_global_install(MalVm *vm, MalObject *global_this);

/* performance (now / timeOrigin); the first install in an isolate fixes its time origin. */
void mal_web_performance_install(MalVm *vm, MalObject *global_this);

/* crypto (randomUUID / getRandomValues) over the engine-neutral host entropy API. */
void mal_web_crypto_install(MalVm *vm, MalObject *global_this);
