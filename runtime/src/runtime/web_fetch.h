#pragma once

#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;

/** Install the shared web/Node body types and their GC hooks in a host realm. */
void mal_fetch_types_install(MalVm *vm, MalObject *global_this);

typedef struct MalHeadersObject MalHeadersObject;

/**
 * A Response for a completed fetch: `headers` becomes immutable, `body` is its
 * ReadableStream or undefined for a null body, and `url` the final URL string.
 */
MalValue mal_fetch_response_new(MalVm *vm, i32 status, MalValue status_text,
    MalHeadersObject *headers, MalValue body, MalValue url, bool redirected);

/**
 * Start a `maligator:http` listener from `options` (`handler`, `hostname`, `port` and
 * the transport limits) and return its handle, `{ port, close() }`, or undefined
 * after throwing. The handler receives each buffered Request and returns a Response
 * or a promise for one.
 */
MalValue mal_fetch_server_start(MalVm *vm, MalValue options);
