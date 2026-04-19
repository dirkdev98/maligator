#pragma once

#include "./defaults.h"
#include "vm.h"

void mal_op_create_number(MalCallable * callable, MalInstruction* instruction);

void mal_op_binary(MalCallable * callable, MalInstruction* instruction);
