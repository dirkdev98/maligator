#pragma once

#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;

/** Install the shared web/Node body types and their GC hooks in a host realm. */
void mal_fetch_types_install(MalVm *vm, MalObject *global_this);

/** Install the web body types of the web platform surface. */
void mal_fetch_install(MalVm *vm, MalObject *global_this);

/**
 * Start a `maligator:http` listener from `options` (`handler`, `hostname`, `port` and
 * the transport limits) and return its handle, `{ port, close() }`, or undefined
 * after throwing. The handler receives each buffered Request and returns a Response
 * or a promise for one.
 */
MalValue mal_fetch_server_start(MalVm *vm, MalValue options);
