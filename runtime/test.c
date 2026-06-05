#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "array_object.h"
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

static const MalInstruction mal_function_0_instructions[] = {
    {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
    {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 0, .index = 0}},
    {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
    {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
};

static const MalInstruction mal_function_1_instructions[] = {
    {.opcode = MAL_OP_MOVE, .as.move = {.dst = 0, .src = 1}},
    {.opcode = MAL_OP_MOVE, .as.move = {.dst = 1, .src = 2}},
    {.opcode = MAL_OP_MOVE, .as.move = {.dst = 2, .src = 0}},
    {.opcode = MAL_OP_MOVE, .as.move = {.dst = 0, .src = 1}},
    {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 1, .left = 2, .right = 0, .op = MAL_BIN_ADD}},
    {.opcode = MAL_OP_RETURN, .as.ret = {.value = 1}},
};

static const MalFunction mal_functions[] = {
    {
        .parameter_count = 0,
        .register_count = 1,
        .captured_count = 0,
        .instruction_count = 4,
        .instructions = mal_function_0_instructions,
    },
    {
        .parameter_count = 2,
        .register_count = 3,
        .captured_count = 0,
        .instruction_count = 6,
        .instructions = mal_function_1_instructions,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 2,
    .functions = mal_functions,
    .global_count = 1,
};

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
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);

    assert(mal_value_to_i32(mal_ops_add(seven, two)) == 9);
    assert(mal_value_to_i32(mal_ops_subtract(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_multiply(seven, two)) == 14);
    assert(mal_value_to_i32(mal_ops_remainder(seven, two)) == 1);
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
    static const MalVmDefinition definition = {.function_count = 2, .functions = functions, .global_count = 1};

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
    static const MalVmDefinition definition = {.function_count = 2, .functions = functions, .global_count = 1};

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_is_undefined(vm.globals[0]));

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

    byte bytes[] = "abc";
    MalString *string = mal_string_new_copy(&heap, bytes, lengthof("abc"));
    bytes[0] = 'z';

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_OWNED);
    assert(mal_string_length(string) == lengthof("abc"));
    assert(mal_string_bytes(string) != bytes);
    assert(memcmp(mal_string_bytes(string), "abc", lengthof("abc")) == 0);
    assert(mal_value_is_string(mal_value_from_string(string)));

    mal_heap_free(&heap);
}

static void test_string_new_external_borrows_byte_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    byte bytes[] = "abc";
    MalString *string = mal_string_new_external(&heap, bytes, lengthof("abc"));

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_EXTERNAL);
    assert(mal_string_length(string) == lengthof("abc"));
    assert(mal_string_bytes(string) == bytes);

    mal_heap_free(&heap);
}

static void test_symbol_new_stores_optional_description(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *description = mal_string_new_external(&heap, "desc", lengthof("desc"));
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
    MalString *left = mal_string_new_copy(&heap, "key", lengthof("key"));
    MalString *right = mal_string_new_copy(&heap, "key", lengthof("key"));
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
    MalString *name = mal_string_new_external(&heap, "name", lengthof("name"));
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
    MalString *a = mal_string_new_external(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_external(&heap, "b", lengthof("b"));
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
    MalString *a = mal_string_new_external(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_external(&heap, "b", lengthof("b"));
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
    MalString *visible = mal_string_new_external(&heap, "visible", lengthof("visible"));
    MalString *hidden = mal_string_new_external(&heap, "hidden", lengthof("hidden"));
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
    MalString *name = mal_string_new_external(&heap, "name", lengthof("name"));
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
    MalString *name = mal_string_new_external(&heap, "fixed", lengthof("fixed"));
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
    MalString *fixed_name = mal_string_new_external(&heap, "fixed", lengthof("fixed"));
    MalString *loose_name = mal_string_new_external(&heap, "loose", lengthof("loose"));
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
    MalString *name = mal_string_new_external(&heap, "inherited", lengthof("inherited"));
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
    MalString *name = mal_string_new_external(&heap, "value", lengthof("value"));
    MalString *new_name = mal_string_new_external(&heap, "new", lengthof("new"));
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
    MalString *name = mal_string_new_external(&heap, "fixed", lengthof("fixed"));
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

    MalString *name = mal_string_new_external(&heap, "native", lengthof("native"));
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

int main(void) {
    test_binary_value_ops_handle_int32_arithmetic();
    test_binary_value_ops_handle_bitwise_operations();
    test_vm_binary_op_dispatches_all_binary_operators();
    test_vm_call_frame_returns_to_caller();
    test_vm_call_frame_fills_missing_parameters_with_undefined();
    test_object_new_initializes_base_state();
    test_string_new_copy_owns_byte_storage();
    test_string_new_external_borrows_byte_storage();
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

    MalVm vm;

    mal_vm_init(&vm, &mal_vm_definition);
    auto callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_vm_free_callable(callable);
    mal_vm_free(&vm);

    printf("\n");

    return 0;
}
