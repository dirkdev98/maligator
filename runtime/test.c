#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "function_object.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// === GENERATED from tests/local/tmp2.js via `node src/index.ts tests/local/tmp2.js` ===
static const c16 mal_string_0_code_units[] = { 0 };
static const c16 mal_string_1_code_units[] = { 100, 101, 102, 105, 110, 101, 80, 114, 111, 112, 101, 114, 116, 121 };
static const c16 mal_string_2_code_units[] = { 120 };
static const c16 mal_string_3_code_units[] = { 118, 97, 108, 117, 101 };
static const c16 mal_string_4_code_units[] = { 119, 114, 105, 116, 97, 98, 108, 101 };
static const c16 mal_string_5_code_units[] = { 101, 110, 117, 109, 101, 114, 97, 98, 108, 101 };
static const c16 mal_string_6_code_units[] = { 109, 97, 112 };
static const c16 mal_string_7_code_units[] = { 107, 101, 121, 115 };
static const c16 mal_string_8_code_units[] = { 114, 101, 100, 117, 99, 101 };
static const c16 mal_string_9_code_units[] = { 97, 116, 116, 101, 109, 112, 116 };
static const c16 mal_string_10_code_units[] = { 98, 111, 111, 109 };
static const c16 mal_string_11_code_units[] = { 109, 101, 115, 115, 97, 103, 101 };
static const c16 mal_string_12_code_units[] = { 110, 97, 109, 101 };
static const c16 mal_string_13_code_units[] = { 87, 114, 97, 112, 112, 101, 114 };
static const c16 mal_string_14_code_units[] = { 112, 114, 111, 116, 111, 116, 121, 112, 101 };
static const c16 mal_string_15_code_units[] = { 107, 105, 110, 100 };
static const c16 mal_string_16_code_units[] = { 111, 111, 112, 115 };
static const c16 mal_string_17_code_units[] = { 111, 117, 116, 32, 111, 102, 32, 114, 97, 110, 103, 101 };
static const c16 mal_string_18_code_units[] = { 112, 97, 105, 114, 83, 117, 109 };
static const c16 mal_string_19_code_units[] = { 99, 97, 108, 108 };
static const c16 mal_string_20_code_units[] = { 97, 112, 112, 108, 121 };
static const c16 mal_string_21_code_units[] = { 98, 105, 110, 100 };
static const c16 mal_string_22_code_units[] = { 108, 101, 110, 103, 116, 104 };
static const c16 mal_string_23_code_units[] = { 84, 121, 112, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_24_code_units[] = { 69, 114, 114, 111, 114 };
static const c16 mal_string_25_code_units[] = { 82, 97, 110, 103, 101, 69, 114, 114, 111, 114 };

static const MalStringConstant mal_string_constants[] = {
    { .length = 0, .code_units = mal_string_0_code_units },
    { .length = 14, .code_units = mal_string_1_code_units },
    { .length = 1, .code_units = mal_string_2_code_units },
    { .length = 5, .code_units = mal_string_3_code_units },
    { .length = 8, .code_units = mal_string_4_code_units },
    { .length = 10, .code_units = mal_string_5_code_units },
    { .length = 3, .code_units = mal_string_6_code_units },
    { .length = 4, .code_units = mal_string_7_code_units },
    { .length = 6, .code_units = mal_string_8_code_units },
    { .length = 7, .code_units = mal_string_9_code_units },
    { .length = 4, .code_units = mal_string_10_code_units },
    { .length = 7, .code_units = mal_string_11_code_units },
    { .length = 4, .code_units = mal_string_12_code_units },
    { .length = 7, .code_units = mal_string_13_code_units },
    { .length = 9, .code_units = mal_string_14_code_units },
    { .length = 4, .code_units = mal_string_15_code_units },
    { .length = 4, .code_units = mal_string_16_code_units },
    { .length = 12, .code_units = mal_string_17_code_units },
    { .length = 7, .code_units = mal_string_18_code_units },
    { .length = 4, .code_units = mal_string_19_code_units },
    { .length = 5, .code_units = mal_string_20_code_units },
    { .length = 4, .code_units = mal_string_21_code_units },
    { .length = 6, .code_units = mal_string_22_code_units },
    { .length = 9, .code_units = mal_string_23_code_units },
    { .length = 5, .code_units = mal_string_24_code_units },
    { .length = 10, .code_units = mal_string_25_code_units },
};

static const MalInstruction mal_function_0_instructions[] = {
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 5, .value = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 4 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 6, .value = 5 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 5 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 5, .value = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 2, .this_value = 0, .argument_count = 3, .arguments = (const i32[]) { 1, 3, 4 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 2, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 4, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 6 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 2 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 8 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 0, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 4, 2 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 6 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 5 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 1, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 6 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 87 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 2, .target_ip = 79 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 82 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 10 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 82 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 2, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 87 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 7 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 3, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 104 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 104 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 8 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 9 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 16 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 3, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 10 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 17 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 11 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 5 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 12 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 2, .this_value = 3, .argument_count = 3, .arguments = (const i32[]) { 4, 0, 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 13 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 20 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 6, .key = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 6 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 2, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 6, .argument_count = 2, .arguments = (const i32[]) { 1, 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 14 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 21 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 1, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 4, 6 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 15 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 15 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 16 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 204 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 209 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 209 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 9 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 10 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 16 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 222 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 227 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 227 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 10 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 24 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 234 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 239 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 239 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 11 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 25 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 246 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 251 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 251 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 13 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 14 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 16 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 15 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 18 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 276 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 282 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalExceptionHandler mal_function_0_handlers[] = {
    { .start_ip = 58, .end_ip = 64, .handler_ip = 70 },
    { .start_ip = 89, .end_ip = 95, .handler_ip = 97 },
};

static const MalInstruction mal_function_1_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_2_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_3_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 10 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_4_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_5_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalFunction mal_functions[] = {
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .register_count = 7,
        .captured_count = 0,
        .instruction_count = 284,
        .instructions = mal_function_0_instructions,
        .handler_count = 2,
        .handlers = mal_function_0_handlers,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .register_count = 3,
        .captured_count = 0,
        .instruction_count = 5,
        .instructions = mal_function_1_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 2,
        .register_count = 3,
        .captured_count = 0,
        .instruction_count = 6,
        .instructions = mal_function_2_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 9,
        .parameter_count = 1,
        .register_count = 3,
        .captured_count = 0,
        .instruction_count = 10,
        .instructions = mal_function_3_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 13,
        .parameter_count = 0,
        .register_count = 1,
        .captured_count = 0,
        .instruction_count = 2,
        .instructions = mal_function_4_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 18,
        .parameter_count = 2,
        .register_count = 3,
        .captured_count = 0,
        .instruction_count = 6,
        .instructions = mal_function_5_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 6,
    .functions = mal_functions,
    .string_constant_count = 26,
    .string_constants = mal_string_constants,
    .global_count = 18,
};
// === END GENERATED ===

static MalPropertyDesc test_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc){
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

static MalValue test_native_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    (void) args;

    return mal_value_from_i32(arg_count);
}

static void test_binary_value_ops_handle_int32_arithmetic(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);

    assert(mal_value_to_i32(mal_ops_add(&heap, seven, two)) == 9);
    assert(mal_value_to_i32(mal_ops_subtract(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_multiply(seven, two)) == 14);
    assert(mal_value_to_i32(mal_ops_remainder(seven, two)) == 1);

    mal_heap_free(&heap);
}

static void test_binary_value_ops_handle_bitwise_operations(void) {
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);
    MalValue negative_one = mal_value_from_i32(-1);

    assert(mal_value_to_i32(mal_ops_bit_and(seven, two)) == 2);
    assert(mal_value_to_i32(mal_ops_bit_or(seven, two)) == 7);
    assert(mal_value_to_i32(mal_ops_bit_xor(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_shift_left(seven, two)) == 28);
    assert(mal_value_to_i32(mal_ops_shift_right(mal_value_from_i32(-8), two)) == -2);
    assert(mal_value_to_f64(mal_ops_shift_right_unsigned(negative_one, mal_value_from_i32(0))) == 4294967295.0);
}

static void test_string_values_use_utf16_code_unit_length(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 pile_of_poo[] = {0xD83D, 0xDCA9};
    MalString *string = mal_string_new_copy(&heap, pile_of_poo, countof(pile_of_poo));

    assert(mal_string_length(string) == 2);
    assert(mal_string_code_units(string)[0] == 0xD83D);
    assert(mal_string_code_units(string)[1] == 0xDCA9);

    mal_heap_free(&heap);
}

static void test_string_value_ops_concatenate_and_convert_values(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalValue left = mal_value_from_string(mal_string_new_ascii(&heap, "a", lengthof("a")));
    MalValue result = mal_ops_add(&heap, left, mal_value_from_i32(1));
    MalString *string = mal_value_to_string(result);

    assert(mal_string_length(string) == 2);
    assert(mal_string_code_units(string)[0] == 'a');
    assert(mal_string_code_units(string)[1] == '1');
    assert(mal_value_to_i32(mal_ops_subtract(
        mal_value_from_string(mal_string_new_ascii(&heap, "7", lengthof("7"))),
        mal_value_from_i32(2)
    )) == 5);

    mal_heap_free(&heap);
}

static void test_string_value_ops_compare_strings_and_converted_numbers(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalValue a = mal_value_from_string(mal_string_new_ascii(&heap, "a", lengthof("a")));
    MalValue b = mal_value_from_string(mal_string_new_ascii(&heap, "b", lengthof("b")));
    MalValue ten = mal_value_from_string(mal_string_new_ascii(&heap, "10", lengthof("10")));
    MalValue two = mal_value_from_string(mal_string_new_ascii(&heap, "2", lengthof("2")));

    assert(mal_value_to_boolean(mal_ops_less_than(a, b)));
    assert(mal_value_to_boolean(mal_ops_greater_equal(b, b)));
    assert(mal_value_to_boolean(mal_ops_less_than(ten, two)));
    assert(!mal_value_to_boolean(mal_ops_less_than(mal_value_from_i32(10), two)));
    assert(mal_value_to_boolean(mal_ops_strict_equal(
        mal_value_from_string(mal_string_new_ascii(&heap, "abc", lengthof("abc"))),
        mal_value_from_string(mal_string_new_ascii(&heap, "abc", lengthof("abc")))
    )));
    assert(mal_value_to_boolean(mal_ops_equal(
        mal_value_from_string(mal_string_new_ascii(&heap, "1", lengthof("1"))),
        mal_value_from_i32(1)
    )));

    mal_heap_free(&heap);
}

static void test_vm_binary_op_dispatches_all_binary_operators(void) {
    MalVm vm;
    MalCallable callable = {.vm = &vm, .function = NULL, .registers = (MalValue[3]){0}, .instruction_pointer = 0};
    MalInstruction instruction = {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 2, .left = 0, .right = 1}};

    callable.registers[0] = mal_value_from_i32(7);
    callable.registers[1] = mal_value_from_i32(2);

    instruction.as.binary.op = MAL_BIN_ADD;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 9);

    instruction.as.binary.op = MAL_BIN_SUB;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 5);

    instruction.as.binary.op = MAL_BIN_MUL;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 14);

    instruction.as.binary.op = MAL_BIN_REM;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 1);

    instruction.as.binary.op = MAL_BIN_BIT_AND;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 2);

    instruction.as.binary.op = MAL_BIN_BIT_OR;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 7);

    instruction.as.binary.op = MAL_BIN_BIT_XOR;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 5);

    instruction.as.binary.op = MAL_BIN_SHL;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 28);

    instruction.as.binary.op = MAL_BIN_SHR;
    callable.registers[0] = mal_value_from_i32(-8);
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == -2);

    instruction.as.binary.op = MAL_BIN_USHR;
    callable.registers[0] = mal_value_from_i32(-1);
    callable.registers[1] = mal_value_from_i32(0);
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_f64(callable.registers[2]) == 4294967295.0);
}

static void test_vm_call_frame_returns_to_caller(void) {
    static const i32 call_arguments[] = {1, 2};
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 3, .callee = 0, .argument_count = 2, .arguments = call_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 3}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 2}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 6,
            .instructions = caller_instructions
        },
        {
            .parameter_count = 2, .register_count = 3, .captured_count = 0, .instruction_count = 2,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 5);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_call_frame_fills_missing_parameters_with_undefined(void) {
    static const i32 call_arguments[] = {1};
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 2, .callee = 0, .argument_count = 1, .arguments = call_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 2}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 1}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 3, .captured_count = 0, .instruction_count = 5,
            .instructions = caller_instructions
        },
        {
            .parameter_count = 2, .register_count = 2, .captured_count = 0, .instruction_count = 1,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_is_undefined(vm.globals[0]));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_create_string_uses_utf16_string_constants(void) {
    static const c16 code_units[] = {'o', 'k', 0xD83D, 0xDCA9};
    static const MalStringConstant string_constants[] = {
        {.length = countof(code_units), .code_units = code_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 0, .string_index = 0}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 0, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    MalString *string = mal_value_to_string(vm.globals[0]);
    assert(mal_string_length(string) == 4);
    assert(mal_string_code_units(string)[2] == 0xD83D);
    assert(mal_string_code_units(string)[3] == 0xDCA9);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_object_property_ops_create_read_and_write_properties(void) {
    static const c16 name_units[] = {'f', 'o', 'o'};
    static const c16 index_units[] = {'0'};
    static const MalStringConstant string_constants[] = {
        {.length = countof(name_units), .code_units = name_units},
        {.length = countof(index_units), .code_units = index_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 3, .value = 2}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 4, .object = 0, .key = 1}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 5, .left = 4, .right = 3, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 5}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 6, .value = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 7, .value = 8}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 6, .value = 7}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 8, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 9, .object = 0, .key = 8}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 10, .left = 5, .right = 9, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 10, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 10}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 11, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 13);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_array_property_ops_manage_indices_and_length(void) {
    static const c16 length_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 zero_units[] = {'0'};
    static const MalStringConstant string_constants[] = {
        {.length = countof(length_units), .code_units = length_units},
        {.length = countof(zero_units), .code_units = zero_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_ARRAY, .as.create_array = {.dst = 0, .length = 3}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 4}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 3, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 4, .object = 0, .key = 3}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 5, .value = 5}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 6, .value = 9}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 5, .value = 6}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 7, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 8, .object = 0, .key = 7}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 9, .left = 4, .right = 8, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 9, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 9}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 10, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 10);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_object_new_initializes_base_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalObject *object = mal_object_new(&heap, prototype);

    assert(object != NULL);
    assert(object->header.type == MAL_HEAP_OBJECT);
    assert(object->prototype == prototype);
    assert(object->extensible);
    assert(object->properties != NULL);
    assert(mal_table_mode(object->properties) == MAL_TABLE_MODE_OBJECT);
    assert(mal_table_size(object->properties) == 0);

    mal_heap_free(&heap);
}

static void test_string_new_copy_owns_byte_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 code_units[] = {'a', 'b', 'c'};
    MalString *string = mal_string_new_copy(&heap, code_units, countof(code_units));
    code_units[0] = 'z';

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_OWNED);
    assert(mal_string_length(string) == countof(code_units));
    assert(mal_string_code_units(string) != code_units);
    assert(mal_string_code_units(string)[0] == 'a');
    assert(mal_string_code_units(string)[1] == 'b');
    assert(mal_string_code_units(string)[2] == 'c');
    assert(mal_value_is_string(mal_value_from_string(string)));

    mal_heap_free(&heap);
}

static void test_string_new_external_borrows_code_unit_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 code_units[] = {'a', 'b', 'c'};
    MalString *string = mal_string_new_external(&heap, code_units, countof(code_units));

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_EXTERNAL);
    assert(mal_string_length(string) == countof(code_units));
    assert(mal_string_code_units(string) == code_units);

    mal_heap_free(&heap);
}

static void test_symbol_new_stores_optional_description(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *description = mal_string_new_ascii(&heap, "desc", lengthof("desc"));
    MalSymbol *symbol = mal_symbol_new(&heap, description);
    MalSymbol *anonymous = mal_symbol_new(&heap, NULL);

    assert(symbol != NULL);
    assert(symbol->header.type == MAL_HEAP_SYMBOL);
    assert(mal_symbol_description(symbol) == description);
    assert(mal_symbol_description(anonymous) == NULL);
    assert(symbol != anonymous);
    assert(mal_value_is_symbol(mal_value_from_symbol(symbol)));

    mal_heap_free(&heap);
}

static void test_table_uses_structural_string_keys_and_identity_symbol_keys(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalString *left = mal_string_new_ascii(&heap, "key", lengthof("key"));
    MalString *right = mal_string_new_ascii(&heap, "key", lengthof("key"));
    MalSymbol *left_symbol = mal_symbol_new(&heap, left);
    MalSymbol *right_symbol = mal_symbol_new(&heap, left);

    MalKey string_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(left)};
    MalKey equivalent_string_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(right)};
    MalKey symbol_key = {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(left_symbol)};
    MalKey different_symbol_key = {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(right_symbol)};

    void *string_entry = mal_table_upsert_entry(table, string_key);
    void *symbol_entry = mal_table_upsert_entry(table, symbol_key);

    MalTableLookup string_lookup = mal_table_lookup(table, equivalent_string_key);
    MalTableLookup symbol_lookup = mal_table_lookup(table, different_symbol_key);

    assert(string_lookup.present);
    assert(string_lookup.entry == string_entry);
    assert(!symbol_lookup.present);
    assert(symbol_entry != NULL);
    assert(mal_table_size(table) == 2);

    mal_table_free(table);
    mal_heap_free(&heap);
}

static void test_property_define_lookup_and_entry_accessors(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalString *name = mal_string_new_ascii(&heap, "name", lengthof("name"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc first = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);
    MalPropertyDesc second = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_WRITABLE);

    void *entry = mal_property_define(table, key, &first);
    MalPropertyLookup lookup = mal_property_lookup(table, key);

    assert(lookup.present);
    assert(lookup.entry == entry);
    assert(mal_value_to_i32(lookup.desc.value) == 1);
    assert(lookup.desc.flags == MAL_PROPERTY_ENUMERABLE);
    assert(mal_property_entry_key(table, entry).value == key.value);

    mal_property_write_entry(table, entry, &second);

    MalPropertyDesc written = mal_property_entry_desc(table, entry);

    assert(mal_value_to_i32(written.value) == 2);
    assert(written.flags == MAL_PROPERTY_WRITABLE);
    assert(mal_table_size(table) == 1);

    mal_table_free(table);
    mal_heap_free(&heap);
}

static void test_property_set_value_creates_default_data_descriptor(void) {
    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)};

    void *entry = mal_property_set_value(table, key, mal_value_from_i32(42));
    MalPropertyDesc desc = mal_property_entry_desc(table, entry);

    assert(desc.flags == (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE));
    assert(mal_value_to_i32(desc.value) == 42);
    assert(mal_value_is_undefined(desc.getter));
    assert(mal_value_is_undefined(desc.setter));

    mal_table_free(table);
}

static void test_property_iter_storage_order_yields_insertion_order(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *a = mal_string_new_ascii(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_ascii(&heap, "b", lengthof("b"));
    MalKey first = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(a)};
    MalKey second = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(2)};
    MalKey third = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(b)};
    MalPropertyDesc desc = test_data_desc(mal_value_new_undefined(), MAL_PROPERTY_ENUMERABLE);

    mal_property_define(object->properties, first, &desc);
    mal_property_define(object->properties, second, &desc);
    mal_property_define(object->properties, third, &desc);

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == first.value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == second.value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == third.value);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_property_iter_own_property_order_groups_index_string_and_symbol_keys(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *a = mal_string_new_ascii(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_ascii(&heap, "b", lengthof("b"));
    MalSymbol *left_symbol = mal_symbol_new(&heap, a);
    MalSymbol *right_symbol = mal_symbol_new(&heap, b);
    MalKey keys[] = {
        {.kind = MAL_KEY_STRING, .value = mal_value_from_string(a)},
        {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(2)},
        {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(left_symbol)},
        {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)},
        {.kind = MAL_KEY_STRING, .value = mal_value_from_string(b)},
        {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(right_symbol)},
    };
    MalPropertyDesc desc = test_data_desc(mal_value_new_undefined(), MAL_PROPERTY_ENUMERABLE);

    for (usize i = 0; i < countof(keys); i++) {
        mal_property_define(object->properties, keys[i], &desc);
    }

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.kind == MAL_KEY_INDEX && mal_value_to_i32(key.value) == 1);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.kind == MAL_KEY_INDEX && mal_value_to_i32(key.value) == 2);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[0].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[4].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[2].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[5].value);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_property_iter_enumerable_own_property_order_skips_non_enumerable_entries(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *visible = mal_string_new_ascii(&heap, "visible", lengthof("visible"));
    MalString *hidden = mal_string_new_ascii(&heap, "hidden", lengthof("hidden"));
    MalKey visible_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(visible)};
    MalKey hidden_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(hidden)};
    MalPropertyDesc enumerable = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);
    MalPropertyDesc non_enumerable = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_NONE);

    mal_property_define(object->properties, hidden_key, &non_enumerable);
    mal_property_define(object->properties, visible_key, &enumerable);

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == visible_key.value);
    assert(mal_value_to_i32(out_desc.value) == 1);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_object_ops_manage_extensibility_and_prototype_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *root = mal_object_new(&heap, NULL);
    MalObject *child = mal_object_new(&heap, root);

    assert(mal_object_properties(child) == child->properties);
    assert(mal_object_is_extensible(child));
    assert(mal_object_get_prototype(child) == root);
    assert(mal_object_set_prototype(root, child) == false);

    mal_object_set_extensible(child, false);

    assert(!mal_object_is_extensible(child));
    assert(mal_object_set_prototype(child, NULL));
    assert(mal_object_get_prototype(child) == NULL);

    mal_heap_free(&heap);
}

static void test_object_define_own_rejects_new_properties_on_non_extensible_objects(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "name", lengthof("name"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);

    mal_object_set_extensible(object, false);

    assert(mal_object_define_own(object, key, &desc) == MAL_DEFINE_OWN_REJECTED);
    assert(!mal_object_get_own(object, key).present);

    mal_heap_free(&heap);
}

static void test_object_define_own_rejects_incompatible_non_configurable_changes(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc fixed = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_NONE);
    MalPropertyDesc changed = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_NONE);

    assert(mal_object_define_own(object, key, &fixed) == MAL_DEFINE_OWN_APPLIED);
    assert(mal_object_define_own(object, key, &changed) == MAL_DEFINE_OWN_REJECTED);
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 1);

    mal_heap_free(&heap);
}

static void test_object_delete_own_respects_configurable_flag(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *fixed_name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalString *loose_name = mal_string_new_ascii(&heap, "loose", lengthof("loose"));
    MalKey fixed_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(fixed_name)};
    MalKey loose_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(loose_name)};
    MalPropertyDesc fixed = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_NONE);
    MalPropertyDesc loose = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, fixed_key, &fixed);
    mal_object_define_own(object, loose_key, &loose);

    assert(!mal_object_delete_own(object, fixed_key));
    assert(mal_object_get_own(object, fixed_key).present);
    assert(mal_object_delete_own(object, loose_key));
    assert(!mal_object_get_own(object, loose_key).present);

    mal_heap_free(&heap);
}

static void test_object_resolve_property_walks_prototype_chain(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *root = mal_object_new(&heap, NULL);
    MalObject *child = mal_object_new(&heap, root);
    MalString *name = mal_string_new_ascii(&heap, "inherited", lengthof("inherited"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(7), MAL_PROPERTY_ENUMERABLE);

    mal_object_define_own(root, key, &desc);

    MalPropertyResolution resolution = mal_object_resolve_property(child, key);

    assert(resolution.found);
    assert(!resolution.own);
    assert(resolution.holder == root);
    assert(mal_value_to_i32(resolution.desc.value) == 7);

    mal_heap_free(&heap);
}

static void test_object_set_updates_writable_own_properties_and_creates_new_properties(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "value", lengthof("value"));
    MalString *new_name = mal_string_new_ascii(&heap, "new", lengthof("new"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalKey new_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(new_name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, key, &desc);

    assert(mal_object_set(object, key, mal_value_from_i32(2)));
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 2);
    assert(mal_object_set(object, new_key, mal_value_from_i32(3)));
    assert(mal_value_to_i32(mal_object_get_own(object, new_key).desc.value) == 3);

    mal_heap_free(&heap);
}

static void test_object_set_rejects_non_writable_data_properties(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, key, &desc);

    assert(!mal_object_set(object, key, mal_value_from_i32(2)));
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 1);

    mal_heap_free(&heap);
}

static void test_function_object_new_initializes_script_function_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalFunctionObject *function = mal_function_object_new(&heap, prototype, 12);

    assert(function != NULL);
    assert(function->object.header.type == MAL_HEAP_FUNCTION_OBJECT);
    assert(function->object.prototype == prototype);
    assert(function->object.extensible);
    assert(mal_function_object_function_index(function) == 12);
    assert(mal_value_is_function_object(mal_value_from_function_object(function)));
    assert(mal_value_is_callable(mal_value_from_function_object(function)));

    mal_heap_free(&heap);
}

static void test_native_function_object_new_initializes_native_function_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *name = mal_string_new_ascii(&heap, "native", lengthof("native"));
    MalNativeFunctionObject *function = mal_native_function_object_new(&heap, NULL, name, test_native_callback);
    MalNativeFunctionCallback callback = mal_native_function_object_callback(function);

    assert(function != NULL);
    assert(function->object.header.type == MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    assert(mal_native_function_object_name(function) == name);
    assert(callback == test_native_callback);
    assert(mal_value_to_i32(callback(NULL, mal_value_new_undefined(), NULL, 4)) == 4);
    assert(mal_value_is_native_function_object(mal_value_from_native_function_object(function)));
    assert(mal_value_is_callable(mal_value_from_native_function_object(function)));

    mal_heap_free(&heap);
}

static void test_array_object_new_initializes_array_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalArrayObject *array = mal_array_object_new(&heap, prototype);

    assert(array != NULL);
    assert(array->object.header.type == MAL_HEAP_ARRAY_OBJECT);
    assert(array->object.prototype == prototype);
    assert(array->object.extensible);
    assert(mal_array_object_length(array) == 0);

    mal_array_object_set_length(array, 10);

    assert(mal_array_object_length(array) == 10);
    assert(mal_value_is_array_object(mal_value_from_array_object(array)));
    assert(mal_value_is_object(mal_value_from_array_object(array)));

    mal_heap_free(&heap);
}

static MalValue test_builtin_get(MalVm *vm, MalValue owner, const byte *name) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(owner),
        mal_intrinsic_string_key(vm, name)
    );
    assert(resolution.found);
    return resolution.desc.value;
}

static MalValue test_builtin_call(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count) {
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    assert(completion.kind == MAL_COMPLETION_NORMAL);
    return completion.value;
}

static MalValue test_builtin_index(MalValue array, i32 index) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(array),
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)}
    );
    return resolution.found ? resolution.desc.value : mal_value_new_undefined();
}

static bool test_builtin_value_is_ascii(MalVm *vm, MalValue value, const byte *expected) {
    return mal_value_is_string(value) && mal_string_equals(mal_value_to_string(value), mal_intrinsic_ascii(vm, expected));
}

static MalValue test_builtin_double_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    return mal_value_from_i32(mal_value_to_i32(args[0]) * 2);
}

static MalValue test_builtin_is_even_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    return mal_value_new_boolean(mal_value_to_i32(args[0]) % 2 == 0);
}

static MalValue test_builtin_sum_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 4);
    return mal_value_from_i32(mal_value_to_i32(args[0]) + mal_value_to_i32(args[1]));
}

static i32 test_builtin_for_each_sum = 0;

static MalValue test_builtin_for_each_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    test_builtin_for_each_sum += mal_value_to_i32(args[0]);
    return mal_value_new_undefined();
}

static MalValue test_builtin_native_function(MalVm *vm, const byte *name, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        callback
    ));
}

static MalValue test_builtin_call_throws(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count, const byte *expected_name) {
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    assert(completion.kind == MAL_COMPLETION_THROW);
    assert(mal_value_is_object(completion.value));
    assert(test_builtin_value_is_ascii(vm, test_builtin_get(vm, completion.value, "name"), expected_name));

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return completion.value;
}

static void test_builtin_error_constructors_and_to_string(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue boom = mal_value_from_string(mal_intrinsic_ascii(&vm, "boom"));
    MalValue error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], mal_value_new_undefined(), &boom, 1);
    assert(mal_value_is_object(error));
    assert(mal_object_get_prototype(mal_value_to_object(error)) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, error, "message"), "boom"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, error, "name"), "Error"));

    MalValue to_string = test_builtin_get(&vm, error, "toString");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, error, NULL, 0), "Error: boom"));

    MalValue empty_error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, empty_error, NULL, 0), "Error"));

    MalValue type_error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR], mal_value_new_undefined(), &boom, 1);
    MalObject *type_error_prototype = mal_object_get_prototype(mal_value_to_object(type_error));
    assert(type_error_prototype == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE]));
    assert(mal_object_get_prototype(type_error_prototype) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, type_error, "name"), "TypeError"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, type_error, NULL, 0), "TypeError: boom"));

    mal_vm_free(&vm);
}

static void test_vm_throw_error_sets_completion_and_builtins_throw(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    mal_vm_throw_error(&vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "nope");
    assert(vm.completion.kind == MAL_COMPLETION_THROW);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.completion.value, "name"), "TypeError"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.completion.value, "message"), "nope"));
    vm.completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // Reduce of an empty array without an initial value throws a TypeError.
    MalValue empty = mal_value_from_array_object(mal_intrinsic_new_array(&vm, 0));
    MalValue sum = test_builtin_native_function(&vm, "sum", test_builtin_sum_callback);
    test_builtin_call_throws(
        &vm,
        test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], "reduce"),
        empty,
        &sum,
        1,
        "TypeError"
    );

    // Object.create with a non-object prototype throws a TypeError.
    MalValue bad_prototype = mal_value_from_i32(5);
    test_builtin_call_throws(
        &vm,
        test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], "create"),
        mal_value_new_undefined(),
        &bad_prototype,
        1,
        "TypeError"
    );

    mal_vm_free(&vm);
}

static void test_vm_try_catch_unwinds_to_handler(void) {
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 42}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 7}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 0, .end_ip = 4, .handler_ip = 5},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 2, .captured_count = 0, .instruction_count = 9,
            .instructions = instructions, .handler_count = 1, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 42);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_nested_try_picks_innermost_handler_and_rethrows(void) {
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 1}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 11}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 2}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 2}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 14}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    // The outer handler is listed first on purpose: innermost selection must
    // come from range width, not table order.
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 0, .end_ip = 10, .handler_ip = 12},
        {.start_ip = 1, .end_ip = 4, .handler_ip = 6},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 16,
            .instructions = instructions, .handler_count = 2, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 1);
    assert(mal_value_to_i32(vm.globals[1]) == 2);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_throw_unwinds_across_call_frames(void) {
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 1}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 2, .callee = 0, .this_value = 1, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 8}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        // Calling a non-function throws a TypeError.
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 5}},
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 1, .callee = 0, .this_value = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 15}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 2}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 9}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler caller_handlers[] = {
        {.start_ip = 0, .end_ip = 5, .handler_ip = 6},
        {.start_ip = 9, .end_ip = 12, .handler_ip = 13},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 17,
            .instructions = caller_instructions, .handler_count = 2, .handlers = caller_handlers
        },
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 4,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(vm.frame_count == 0);
    assert(mal_value_to_i32(vm.globals[0]) == 9);
    assert(mal_value_is_object(vm.globals[1]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.globals[1], "name"), "TypeError"));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_uncaught_throw_propagates_through_call_value(void) {
    static const MalInstruction throwing_instructions[] = {
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 9}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 4,
            .instructions = throwing_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 0
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);

    MalFunctionObject *function = mal_function_object_new(&vm.heap, NULL, 0);
    MalCompletion completion = mal_vm_call_value(&vm, mal_value_from_function_object(function), mal_value_new_undefined(), NULL, 0);

    assert(completion.kind == MAL_COMPLETION_THROW);
    assert(mal_value_to_i32(completion.value) == 9);
    assert(vm.frame_count == 0);

    mal_vm_free(&vm);
}

static void test_vm_construct_script_and_native_callees(void) {
    static const c16 prototype_code_units[] = {'p', 'r', 'o', 't', 'o', 't', 'y', 'p', 'e'};
    static const MalStringConstant string_constants[] = {
        {.length = 9, .code_units = prototype_code_units},
    };
    static const i32 construct_arguments[] = {2};
    static const i32 array_arguments[] = {1};
    static const MalInstruction entry_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 2, .string_index = 0}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 2, .value = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 7}},
        // Returns a number, so the constructed this is substituted.
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 3, .callee = 0, .argument_count = 1, .arguments = construct_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 2}},
        // Returns an object, which wins over the constructed this.
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 3, .callee = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 2}},
        {.opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = {.dst = 0, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 3}},
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 2, .callee = 0, .argument_count = 1, .arguments = array_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 3}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction return_param_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction return_object_instructions[] = {
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 17,
            .instructions = entry_instructions
        },
        {
            .parameter_count = 1, .register_count = 1, .captured_count = 0, .instruction_count = 1,
            .instructions = return_param_instructions
        },
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 2,
            .instructions = return_object_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 3, .functions = functions, .string_constant_count = 1, .string_constants = string_constants, .global_count = 4
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    // The substituted this uses the callee's prototype property.
    assert(mal_value_is_object(vm.globals[0]));
    assert(mal_object_get_prototype(mal_value_to_object(vm.globals[0])) == mal_value_to_object(vm.globals[1]));
    // The explicitly returned object is an ordinary object literal.
    assert(mal_value_is_object(vm.globals[2]));
    assert(mal_object_get_prototype(mal_value_to_object(vm.globals[2])) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    // new Array(3) constructs through the native constructor.
    assert(mal_value_is_array_object(vm.globals[3]));
    assert(mal_array_object_length(mal_value_to_array_object(vm.globals[3])) == 3);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_bound_function_resolution_and_calls(void) {
    static const MalInstruction add3_instructions[] = {
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 3, .left = 0, .right = 1, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 4, .left = 3, .right = 2, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 4}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 3, .register_count = 5, .captured_count = 0, .instruction_count = 3,
            .instructions = add3_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 0
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);

    MalFunctionObject *target = mal_function_object_new(&vm.heap, NULL, 0);

    MalValue inner_args[] = {mal_value_from_i32(1)};
    MalBoundFunctionObject *inner = mal_bound_function_object_new(
        &vm.heap, NULL, mal_value_from_function_object(target), mal_value_from_i32(42), inner_args, 1
    );
    MalValue outer_args[] = {mal_value_from_i32(2)};
    MalBoundFunctionObject *outer = mal_bound_function_object_new(
        &vm.heap, NULL, mal_value_from_bound_function_object(inner), mal_value_from_i32(99), outer_args, 1
    );

    assert(mal_value_is_callable(mal_value_from_bound_function_object(outer)));
    assert(mal_value_is_object(mal_value_from_bound_function_object(outer)));

    // Calling the nested bound function merges argument prefixes inner-first.
    MalValue call_args[] = {mal_value_from_i32(3)};
    MalCompletion completion = mal_vm_call_value(
        &vm, mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1
    );
    assert(completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(completion.value) == 6);
    assert(vm.frame_count == 0);

    // The innermost bound this wins for calls; construct ignores it.
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1, true
    );
    assert(resolution.callee == mal_value_from_function_object(target));
    assert(mal_value_to_i32(resolution.this_value) == 42);
    assert(resolution.arg_count == 3);
    assert(mal_value_to_i32(resolution.args[0]) == 1);
    assert(mal_value_to_i32(resolution.args[1]) == 2);
    assert(mal_value_to_i32(resolution.args[2]) == 3);
    free(resolution.owned_args);

    resolution = mal_bound_function_object_resolve(
        mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1, false
    );
    assert(mal_value_is_undefined(resolution.this_value));
    free(resolution.owned_args);

    mal_vm_free(&vm);
}

static MalValue test_builtin_pair_sum_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    assert(arg_count == 2);
    // The receiver is folded in when it is a number, to observe this-binding.
    i32 base = mal_value_is_int32(this_value) ? mal_value_to_i32(this_value) : 0;
    return mal_value_from_i32(base + mal_value_to_i32(args[0]) + mal_value_to_i32(args[1]));
}

static void test_builtin_function_call_apply_bind_and_to_string(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue function_prototype = vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE];
    MalValue target = test_builtin_native_function(&vm, "pairSum", test_builtin_pair_sum_callback);

    // call(thisArg, ...args)
    MalValue call_args[] = {mal_value_from_i32(100), mal_value_from_i32(1), mal_value_from_i32(2)};
    MalValue call_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "call"), target, call_args, 3);
    assert(mal_value_to_i32(call_result) == 103);

    // apply(thisArg, argsArray)
    MalArrayObject *apply_array = mal_intrinsic_new_array(&vm, 2);
    mal_object_set((MalObject *) apply_array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_i32(4));
    mal_object_set((MalObject *) apply_array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_from_i32(5));
    MalValue apply_args[] = {mal_value_from_i32(100), mal_value_from_array_object(apply_array)};
    MalValue apply_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "apply"), target, apply_args, 2);
    assert(mal_value_to_i32(apply_result) == 109);

    // bind(thisArg, ...partial) creates a callable bound function.
    MalValue bind_args[] = {mal_value_from_i32(100), mal_value_from_i32(10)};
    MalValue bound = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "bind"), target, bind_args, 2);
    assert(mal_value_is_bound_function_object(bound));
    MalValue remaining = mal_value_from_i32(7);
    MalValue bound_result = test_builtin_call(&vm, bound, mal_value_new_undefined(), &remaining, 1);
    assert(mal_value_to_i32(bound_result) == 117);

    // Bound functions inherit %Function.prototype%, so call() works on them.
    MalValue bound_call_args[] = {mal_value_new_undefined(), mal_value_from_i32(8)};
    MalValue bound_call_result = test_builtin_call(&vm, test_builtin_get(&vm, bound, "call"), bound, bound_call_args, 2);
    assert(mal_value_to_i32(bound_call_result) == 118);

    // toString stubs out the body.
    MalValue to_string_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "toString"), target, NULL, 0);
    assert(test_builtin_value_is_ascii(&vm, to_string_result, "function pairSum() { [native code] }"));

    // The Function constructor throws (no eval support).
    test_builtin_call_throws(&vm, vm.intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0, "TypeError");

    // call on a non-callable throws.
    MalValue non_callable_args[] = {mal_value_new_undefined()};
    test_builtin_call_throws(&vm, test_builtin_get(&vm, function_prototype, "call"), mal_value_from_i32(5), non_callable_args, 1, "TypeError");

    mal_vm_free(&vm);
}

static void test_vm_function_name_and_length_fast_path(void) {
    static const c16 name_code_units[] = {'n', 'a', 'm', 'e'};
    static const c16 length_code_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 my_fn_code_units[] = {'m', 'y', 'F', 'n'};
    static const MalStringConstant string_constants[] = {
        {.length = 4, .code_units = name_code_units},
        {.length = 6, .code_units = length_code_units},
        {.length = 4, .code_units = my_fn_code_units},
    };
    static const MalInstruction entry_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction named_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 3, .captured_count = 0, .instruction_count = 9,
            .instructions = entry_instructions
        },
        {
            .name_string_index = 2, .parameter_count = 2, .register_count = 2, .captured_count = 0,
            .instruction_count = 1, .instructions = named_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 3, .string_constants = string_constants, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(test_builtin_value_is_ascii(&vm, vm.globals[0], "myFn"));
    assert(mal_value_to_i32(vm.globals[1]) == 2);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_builtin_object_statics_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue object_constructor = vm.intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR];
    MalPropertyFlags default_flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    MalValue object = test_builtin_call(&vm, object_constructor, mal_value_new_undefined(), NULL, 0);
    assert(mal_value_is_object(object));
    assert(mal_object_get_prototype(mal_value_to_object(object)) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));

    MalObject *descriptor = mal_intrinsic_new_object(&vm);
    mal_intrinsic_define_data(&vm, descriptor, "value", mal_value_from_i32(7), default_flags);
    mal_intrinsic_define_data(&vm, descriptor, "writable", mal_value_new_boolean(true), default_flags);
    mal_intrinsic_define_data(&vm, descriptor, "enumerable", mal_value_new_boolean(true), default_flags);

    MalValue define_property_args[] = {
        object,
        mal_value_from_string(mal_intrinsic_ascii(&vm, "x")),
        mal_value_from_object(descriptor),
    };
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "defineProperty"), mal_value_new_undefined(), define_property_args, 3);
    assert(mal_value_to_i32(test_builtin_get(&vm, object, "x")) == 7);

    MalValue keys = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "keys"), mal_value_new_undefined(), &object, 1);
    assert(mal_array_object_length(mal_value_to_array_object(keys)) == 1);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(keys, 0), "x"));

    MalValue values = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "values"), mal_value_new_undefined(), &object, 1);
    assert(mal_value_to_i32(test_builtin_index(values, 0)) == 7);

    MalValue entries = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "entries"), mal_value_new_undefined(), &object, 1);
    MalValue entry = test_builtin_index(entries, 0);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(entry, 0), "x"));
    assert(mal_value_to_i32(test_builtin_index(entry, 1)) == 7);

    MalValue assign_target = mal_value_from_object(mal_intrinsic_new_object(&vm));
    MalValue assign_args[] = {assign_target, object};
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "assign"), mal_value_new_undefined(), assign_args, 2);
    assert(mal_value_to_i32(test_builtin_get(&vm, assign_target, "x")) == 7);

    MalValue descriptor_result = test_builtin_call(
        &vm,
        test_builtin_get(&vm, object_constructor, "getOwnPropertyDescriptor"),
        mal_value_new_undefined(),
        define_property_args,
        2
    );
    assert(mal_value_to_i32(test_builtin_get(&vm, descriptor_result, "value")) == 7);
    assert(mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "writable")));
    assert(mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "enumerable")));
    assert(!mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "configurable")));

    MalValue has_own_args[] = {object, mal_value_from_string(mal_intrinsic_ascii(&vm, "x"))};
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "hasOwn"), mal_value_new_undefined(), has_own_args, 2)));

    MalValue object_prototype = vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue has_own_property = test_builtin_get(&vm, object_prototype, "hasOwnProperty");
    MalValue x_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "x"));
    MalValue missing_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "missing"));
    assert(mal_value_to_boolean(test_builtin_call(&vm, has_own_property, object, &x_key, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, has_own_property, object, &missing_key, 1)));

    MalValue created = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "create"), mal_value_new_undefined(), &object, 1);
    MalValue created_prototype = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "getPrototypeOf"), mal_value_new_undefined(), &created, 1);
    assert(created_prototype == object);

    MalValue is_prototype_of = test_builtin_get(&vm, object_prototype, "isPrototypeOf");
    assert(mal_value_to_boolean(test_builtin_call(&vm, is_prototype_of, object, &created, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, is_prototype_of, created, &object, 1)));

    MalValue nan_args[] = {mal_value_new_nan(), mal_value_new_nan()};
    MalValue mixed_args[] = {mal_value_from_i32(1), mal_value_from_i32(2)};
    MalValue object_is = test_builtin_get(&vm, object_constructor, "is");
    assert(mal_value_to_boolean(test_builtin_call(&vm, object_is, mal_value_new_undefined(), nan_args, 2)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, object_is, mal_value_new_undefined(), mixed_args, 2)));

    MalValue to_string = test_builtin_get(&vm, object_prototype, "toString");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, object, NULL, 0), "[object Object]"));
    MalValue empty_array = mal_value_from_array_object(mal_intrinsic_new_array(&vm, 0));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, empty_array, NULL, 0), "[object Array]"));

    MalValue is_frozen = test_builtin_get(&vm, object_constructor, "isFrozen");
    assert(!mal_value_to_boolean(test_builtin_call(&vm, is_frozen, mal_value_new_undefined(), &object, 1)));
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "freeze"), mal_value_new_undefined(), &object, 1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, is_frozen, mal_value_new_undefined(), &object, 1)));
    assert(!mal_object_is_extensible(mal_value_to_object(object)));
    assert(!mal_object_set(mal_value_to_object(object), mal_intrinsic_string_key(&vm, "x"), mal_value_from_i32(9)));
    assert(mal_value_to_i32(test_builtin_get(&vm, object, "x")) == 7);

    mal_vm_free(&vm);
}

static void test_builtin_array_constructor_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue array_constructor = vm.intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];
    MalValue array_prototype = vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue one_two_three[] = {mal_value_from_i32(1), mal_value_from_i32(2), mal_value_from_i32(3)};

    MalValue array = test_builtin_call(&vm, array_constructor, mal_value_new_undefined(), one_two_three, 3);
    assert(mal_value_is_array_object(array));
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 3);
    assert(mal_value_to_i32(test_builtin_index(array, 2)) == 3);

    MalValue sized_arg = mal_value_from_i32(5);
    MalValue sized = test_builtin_call(&vm, array_constructor, mal_value_new_undefined(), &sized_arg, 1);
    assert(mal_array_object_length(mal_value_to_array_object(sized)) == 5);
    assert(mal_value_is_undefined(test_builtin_index(sized, 0)));

    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "isArray"), mal_value_new_undefined(), &array, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "isArray"), mal_value_new_undefined(), &sized_arg, 1)));

    MalValue of_result = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "of"), mal_value_new_undefined(), one_two_three, 3);
    assert(mal_array_object_length(mal_value_to_array_object(of_result)) == 3);

    MalValue from_result = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "from"), mal_value_new_undefined(), &array, 1);
    assert(mal_array_object_length(mal_value_to_array_object(from_result)) == 3);
    assert(mal_value_to_i32(test_builtin_index(from_result, 1)) == 2);

    MalValue double_value = test_builtin_native_function(&vm, "double", test_builtin_double_callback);
    MalValue mapped = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "map"), array, &double_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(mapped)) == 3);
    assert(mal_value_to_i32(test_builtin_index(mapped, 0)) == 2);
    assert(mal_value_to_i32(test_builtin_index(mapped, 2)) == 6);

    // Holes are skipped and preserved by map.
    MalValue sparse_mapped = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "map"), sized, &double_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(sparse_mapped)) == 5);
    assert(!mal_object_get_own(mal_value_to_object(sparse_mapped), (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}).present);

    MalValue is_even_value = test_builtin_native_function(&vm, "isEven", test_builtin_is_even_callback);
    MalValue filtered = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "filter"), array, &is_even_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(filtered)) == 1);
    assert(mal_value_to_i32(test_builtin_index(filtered, 0)) == 2);

    MalValue reduce_args[] = {test_builtin_native_function(&vm, "sum", test_builtin_sum_callback), mal_value_from_i32(10)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reduce"), array, reduce_args, 1)) == 6);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reduce"), array, reduce_args, 2)) == 16);

    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "find"), array, &is_even_value, 1)) == 2);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "findIndex"), array, &is_even_value, 1)) == 1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "some"), array, &is_even_value, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "every"), array, &is_even_value, 1)));

    test_builtin_for_each_sum = 0;
    MalValue for_each_value = test_builtin_native_function(&vm, "forEachSum", test_builtin_for_each_callback);
    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "forEach"), array, &for_each_value, 1);
    assert(test_builtin_for_each_sum == 6);

    MalValue two = mal_value_from_i32(2);
    MalValue nine = mal_value_from_i32(9);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "indexOf"), array, &two, 1)) == 1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "indexOf"), array, &nine, 1)) == -1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "includes"), array, &two, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "includes"), array, &nine, 1)));

    MalValue repeated_args[] = {mal_value_from_i32(1), mal_value_from_i32(2), mal_value_from_i32(1)};
    MalValue repeated = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "of"), mal_value_new_undefined(), repeated_args, 3);
    MalValue one = mal_value_from_i32(1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "lastIndexOf"), repeated, &one, 1)) == 2);

    MalValue push_args[] = {mal_value_from_i32(4), mal_value_from_i32(5)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "push"), array, push_args, 2)) == 5);
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "pop"), array, NULL, 0)) == 5);
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 4);

    MalValue slice_args[] = {mal_value_from_i32(1), mal_value_from_i32(3)};
    MalValue sliced = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "slice"), array, slice_args, 2);
    assert(mal_array_object_length(mal_value_to_array_object(sliced)) == 2);
    assert(mal_value_to_i32(test_builtin_index(sliced, 0)) == 2);
    assert(mal_value_to_i32(test_builtin_index(sliced, 1)) == 3);

    MalValue concatenated = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "concat"), array, &repeated, 1);
    assert(mal_array_object_length(mal_value_to_array_object(concatenated)) == 7);
    assert(mal_value_to_i32(test_builtin_index(concatenated, 4)) == 1);

    MalValue separator = mal_value_from_string(mal_intrinsic_ascii(&vm, "-"));
    MalValue joined = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "join"), of_result, &separator, 1);
    assert(test_builtin_value_is_ascii(&vm, joined, "1-2-3"));

    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reverse"), of_result, NULL, 0);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 2)) == 1);

    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "shift"), of_result, NULL, 0)) == 3);
    assert(mal_array_object_length(mal_value_to_array_object(of_result)) == 2);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 2);

    MalValue seven = mal_value_from_i32(7);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "unshift"), of_result, &seven, 1)) == 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 7);

    MalValue fill_args[] = {mal_value_from_i32(0), mal_value_from_i32(1), mal_value_from_i32(3)};
    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "fill"), of_result, fill_args, 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 7);
    assert(mal_value_to_i32(test_builtin_index(of_result, 1)) == 0);
    assert(mal_value_to_i32(test_builtin_index(of_result, 2)) == 0);

    MalValue negative_one = mal_value_from_i32(-1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "at"), array, &negative_one, 1)) == 4);

    mal_vm_free(&vm);
}

int main(void) {
    test_binary_value_ops_handle_int32_arithmetic();
    test_binary_value_ops_handle_bitwise_operations();
    test_string_values_use_utf16_code_unit_length();
    test_string_value_ops_concatenate_and_convert_values();
    test_string_value_ops_compare_strings_and_converted_numbers();
    test_vm_binary_op_dispatches_all_binary_operators();
    test_vm_call_frame_returns_to_caller();
    test_vm_call_frame_fills_missing_parameters_with_undefined();
    test_vm_create_string_uses_utf16_string_constants();
    test_vm_object_property_ops_create_read_and_write_properties();
    test_vm_array_property_ops_manage_indices_and_length();
    test_object_new_initializes_base_state();
    test_string_new_copy_owns_byte_storage();
    test_string_new_external_borrows_code_unit_storage();
    test_symbol_new_stores_optional_description();
    test_table_uses_structural_string_keys_and_identity_symbol_keys();
    test_property_define_lookup_and_entry_accessors();
    test_property_set_value_creates_default_data_descriptor();
    test_property_iter_storage_order_yields_insertion_order();
    test_property_iter_own_property_order_groups_index_string_and_symbol_keys();
    test_property_iter_enumerable_own_property_order_skips_non_enumerable_entries();
    test_object_ops_manage_extensibility_and_prototype_state();
    test_object_define_own_rejects_new_properties_on_non_extensible_objects();
    test_object_define_own_rejects_incompatible_non_configurable_changes();
    test_object_delete_own_respects_configurable_flag();
    test_object_resolve_property_walks_prototype_chain();
    test_object_set_updates_writable_own_properties_and_creates_new_properties();
    test_object_set_rejects_non_writable_data_properties();
    test_function_object_new_initializes_script_function_state();
    test_native_function_object_new_initializes_native_function_state();
    test_array_object_new_initializes_array_state();
    test_builtin_object_statics_and_prototype_methods();
    test_builtin_array_constructor_and_prototype_methods();
    test_builtin_error_constructors_and_to_string();
    test_vm_throw_error_sets_completion_and_builtins_throw();
    test_vm_try_catch_unwinds_to_handler();
    test_vm_nested_try_picks_innermost_handler_and_rethrows();
    test_vm_throw_unwinds_across_call_frames();
    test_vm_uncaught_throw_propagates_through_call_value();
    test_vm_construct_script_and_native_callees();
    test_bound_function_resolution_and_calls();
    test_builtin_function_call_apply_bind_and_to_string();
    test_vm_function_name_and_length_fast_path();

    MalVm vm;

    mal_vm_init(&vm, &mal_vm_definition);
    auto callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    assert(mal_value_to_i32(vm.globals[17]) == 102);
    mal_vm_free_callable(callable);
    mal_vm_free(&vm);

    printf("\n");

    return 0;
}
