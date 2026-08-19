#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/** Create the JSON namespace object with stringify and parse. */
void mal_builtin_json_install(MalVm *vm);

/** Parse text with the intrinsic JSON parser, without observing JSON.parse mutations. */
MalValue mal_builtin_json_parse_intrinsic(MalVm *vm, MalValue text);
