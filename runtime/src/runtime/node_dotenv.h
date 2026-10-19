#pragma once

#include "vm.h"

/**
 * Parse dotenv `content` (util.parseEnv's grammar) and define each key on `target` as a string;
 * with `keep_existing`, keys `target` already owns are left untouched. False on a pending throw.
 */
bool mal_node_dotenv_parse(MalVm *vm, MalString *content, MalValue target, bool keep_existing);
