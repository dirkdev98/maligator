#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the global URI handling functions decodeURI, decodeURIComponent,
 * encodeURI and encodeURIComponent (ECMA-262 sec-uri-handling-functions) and
 * store them in their intrinsic slots. Registration on globalThis happens in
 * intrinsics.c.
 */
void mal_builtin_uri_install(MalVm *vm);

/** Install the Annex B escape/unescape functions on the supplied global. */
void mal_builtin_uri_install_legacy_globals(MalVm *vm, MalObject *global_this);

// Canonical calls with a primitive String input; malformed encodings still throw at runtime.
MalValue mal_builtin_uri_encode_known(MalVm *vm, MalString *string, bool component);
MalValue mal_builtin_uri_decode_known(MalVm *vm, MalString *string, bool preserve_reserved);
MalValue mal_builtin_uri_escape_known(MalVm *vm, MalString *string);
MalValue mal_builtin_uri_unescape_known(MalVm *vm, MalString *string);
