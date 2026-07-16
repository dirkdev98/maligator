#include <assert.h>
#include <stdio.h>

#include "vm.h"

// === GENERATED from tests/local/tmp2.js via `node src/index.ts tests/local/tmp2.js` ===
static const c16 mal_string_0_code_units[] = { 0 };
static const c16 mal_string_1_code_units[] = { 105, 115, 80, 114, 105, 109, 101 };
static const c16 mal_string_2_code_units[] = { 108, 111, 103 };
static const c16 mal_string_3_code_units[] = { 112, 114, 105, 109, 101, 115, 32, 98, 101, 108, 111, 119 };
static const c16 mal_string_4_code_units[] = { 61 };
static const c16 mal_string_5_code_units[] = { 40, 108, 97, 114, 103, 101, 115, 116, 58 };
static const c16 mal_string_6_code_units[] = { 41 };
static const c16 mal_string_7_code_units[] = { 112, 114, 105, 109, 101, 32, 98, 101, 110, 99, 104, 109, 97, 114, 107, 32, 101, 120, 112, 101, 99, 116, 101, 100, 32, 57, 53, 57, 50, 32, 112, 114, 105, 109, 101, 115, 32, 98, 117, 116, 32, 103, 111, 116, 32 };
static const c16 mal_string_8_code_units[] = { 112, 114, 105, 109, 101, 32, 98, 101, 110, 99, 104, 109, 97, 114, 107, 32, 101, 120, 112, 101, 99, 116, 101, 100, 32, 108, 97, 114, 103, 101, 115, 116, 32, 112, 114, 105, 109, 101, 32, 57, 57, 57, 57, 49, 32, 98, 117, 116, 32, 103, 111, 116, 32 };

static MalString mal_strings[] = {
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 0, .code_units = mal_string_0_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 7, .code_units = mal_string_1_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 3, .code_units = mal_string_2_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 12, .code_units = mal_string_3_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 1, .code_units = mal_string_4_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 9, .code_units = mal_string_5_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 1, .code_units = mal_string_6_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 45, .code_units = mal_string_7_code_units },
    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = 53, .code_units = mal_string_8_code_units },
};

static const i32 mal_function_0_instruction_data[] = {
    1, 0,
    7, 2, 3, 5, 6, 7, 8, 9,
    1, 6,
    1, 8,
};

static const MalInstruction mal_function_0_instructions[] = {
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 100000 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 2, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 16 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 36 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 2, .data_offset = 0 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 22 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 30 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 0, .src = 4, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 30 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 4, .src = 2, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 5 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 9, .string_index = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 10, .callee = 4, .this_value = 0, .data_offset = 2 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 9, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 9592 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 9, .right = 8, .op = MAL_BIN_STRICT_NEQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 52 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 58 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 9, .index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 8, .right = 9, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 9, .callee = 7, .data_offset = 10 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 9 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 9, .index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 99991 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 9, .right = 6, .op = MAL_BIN_STRICT_NEQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 63 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 69 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 9, .index = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 6, .right = 9, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 9, .callee = 7, .data_offset = 12 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 9 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 9 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 9 } },
};

static const MalInstruction mal_function_1_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 2, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 8 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 2, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 13 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 15 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 2, .op = MAL_BIN_REM } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 2, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 22 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 24 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 27 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_LTE } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 34 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 48 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_REM } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 43 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 27 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 4 } },
};

static const MalFunction mal_functions[] = {
    {
        .name_string_index = 0,
        .kind = MAL_FUNCTION_KIND_NORMAL,
        .parameter_count = 0,
        .length = 0,
        .register_count = 11,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 71,
        .instructions = mal_function_0_instructions,
        .instruction_data_count = 14,
        .instruction_data = mal_function_0_instruction_data,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 1,
        .kind = MAL_FUNCTION_KIND_NORMAL,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 50,
        .instructions = mal_function_1_instructions,
        .instruction_data_count = 0,
        .instruction_data = nullptr,
        .handler_count = 0,
        .handlers = nullptr,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 2,
    .functions = mal_functions,
    .string_constant_count = 9,
    .string_constants = mal_strings,
    .bigint_constant_count = 0,
    .bigint_constants = nullptr,
    .global_count = 4,
};
// === END GENERATED ===

// Runs the compiled tests/local/tmp2.js prime-number benchmark. The fixture
// self-checks its result and throws on a mismatch, so normal completion means
// the benchmark produced the expected output.
int main(void) {
    MalVm vm;

    mal_vm_init(&vm, &mal_vm_definition);
    auto callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    mal_vm_free_callable(callable);
    mal_vm_free(&vm);

    return 0;
}
