#include "vm_ops.h"

#include <stdlib.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "function_object.h"
#include "heap_string.h"
#include "object_ops.h"
#include "value_ops.h"

static MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value);

static bool mal_vm_resolve_synthetic_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *value_out);

static bool mal_vm_string_to_array_index(MalString *string, i32 *index_out) {
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);

    if (length == 0) {
        return false;
    }

    if (length > 1 && code_units[0] == '0') {
        return false;
    }

    u64 value = 0;
    for (usize i = 0; i < length; i++) {
        c16 code_unit = code_units[i];
        if (code_unit < '0' || code_unit > '9') {
            return false;
        }

        value = value * 10 + (u64) (code_unit - '0');
        if (value > INT32_MAX) {
            return false;
        }
    }

    *index_out = (i32) value;
    return true;
}

static bool mal_vm_string_to_property_key(MalValue value, MalKey *key_out) {
    i32 index = 0;
    if (mal_vm_string_to_array_index(mal_value_to_string(value), &index)) {
        *key_out = (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)};
        return true;
    }

    *key_out = (MalKey) {.kind = MAL_KEY_STRING, .value = value};
    return true;
}

bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out) {
    if (mal_value_is_int32(value) && mal_value_to_i32(value) >= 0) {
        *key_out = (MalKey) {.kind = MAL_KEY_INDEX, .value = value};
        return true;
    }

    if (mal_value_is_string(value)) {
        return mal_vm_string_to_property_key(value, key_out);
    }

    if (mal_value_is_symbol(value)) {
        *key_out = (MalKey) {.kind = MAL_KEY_SYMBOL, .value = value};
        return true;
    }

    return mal_vm_string_to_property_key(
        mal_value_from_string(mal_ops_to_string(&vm->heap, value)),
        key_out
    );
}

bool mal_vm_desc_read(MalVm *vm, MalPropertyDesc desc, MalValue receiver, MalValue *out) {
    if (!(desc.flags & MAL_PROPERTY_ACCESSOR)) {
        *out = desc.value;
        return true;
    }

    if (!mal_value_is_callable(desc.getter)) {
        // Set-only accessors read as undefined.
        *out = mal_value_new_undefined();
        return true;
    }

    MalCompletion completion = mal_vm_call_value(vm, desc.getter, receiver, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *out = completion.value;
    return true;
}

void mal_op_move(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.move.dst] = callable->registers[instruction->as.move.src];
}

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_from_i32(instruction->as.create_number.value);
}

void mal_op_create_f64(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_f64.dst] = mal_value_from_f64_convert_nan(instruction->as.create_f64.value);
}

void mal_op_create_boolean(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_boolean.dst] = mal_value_new_boolean(instruction->as.create_boolean.value != 0);
}

void mal_op_create_string(MalCallable *callable, MalInstruction *instruction) {
    const MalStringConstant *constant = &callable->vm->definition->string_constants[instruction->as.create_string.string_index];
    MalString *string = mal_string_new_external(&callable->vm->heap, constant->code_units, constant->length);
    callable->registers[instruction->as.create_string.dst] = mal_value_from_string(string);
}

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction) {
    MalObject *object = mal_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );
    callable->registers[instruction->as.create_object.dst] = mal_value_from_object(object);
}

void mal_op_create_array(MalCallable *callable, MalInstruction *instruction) {
    MalArrayObject *array = mal_array_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(array, (u32) instruction->as.create_array.length);
    callable->registers[instruction->as.create_array.dst] = mal_value_from_array_object(array);
}

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_undefined.dst] = mal_value_new_undefined();
}

void mal_op_create_null(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_null.dst] = mal_value_new_null();
}

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction) {
    MalFunctionObject *function = mal_function_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        instruction->as.create_function.function_index
    );
    function->creation_env = callable->env;

    callable->registers[instruction->as.create_function.dst] = mal_value_from_function_object(function);
}

void mal_op_load_captured(MalCallable *callable, MalInstruction *instruction) {
    MalValue value = mal_value_new_undefined();
    for (MalEnv *env = callable->env; env != nullptr; env = env->parent) {
        if (env->function_index == instruction->as.load_captured.owner_function_index) {
            value = env->slots[instruction->as.load_captured.index];
            break;
        }
    }

    callable->registers[instruction->as.load_captured.dst] = value;
}

void mal_op_store_captured(MalCallable *callable, MalInstruction *instruction) {
    for (MalEnv *env = callable->env; env != nullptr; env = env->parent) {
        if (env->function_index == instruction->as.store_captured.owner_function_index) {
            env->slots[instruction->as.store_captured.index] = callable->registers[instruction->as.store_captured.src];
            return;
        }
    }
}

void mal_op_create_arguments_object(MalCallable *callable, MalInstruction *instruction) {
    if (!mal_value_is_undefined(callable->arguments_object)) {
        callable->registers[instruction->as.create_arguments_object.dst] = callable->arguments_object;
        return;
    }

    MalArrayObject *arguments = mal_array_object_new(&callable->vm->heap, nullptr);
    mal_array_object_set_length(arguments, callable->argument_count);

    for (i32 i = 0; i < callable->argument_count; i++) {
        mal_object_set(
            (MalObject *) arguments,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)},
            callable->arguments[i]
        );
    }

    callable->arguments_object = mal_value_from_array_object(arguments);
    callable->registers[instruction->as.create_arguments_object.dst] = callable->arguments_object;
}

void mal_op_load_this(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_this.dst] = callable->this_value;
}

void mal_op_call(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call.callee];
    MalValue this_value = callable->registers[instruction->as.call.this_value];
    i32 dst = instruction->as.call.dst;
    i32 argument_count = instruction->as.call.argument_count;

    MalValue *arguments = malloc(sizeof(MalValue) * argument_count);
    for (i32 i = 0; i < argument_count; i++) {
        arguments[i] = callable->registers[instruction->as.call.arguments[i]];
    }

    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, arguments, argument_count, true);

    if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        mal_vm_push_function_frame(
            vm,
            function_index,
            mal_value_to_function_object(resolution.callee)->creation_env,
            resolution.this_value,
            resolution.args,
            resolution.arg_count,
            dst,
            vm->frame_count - 1
        );
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        // The callback may push frames and realloc the frame array, which
        // invalidates `callable`. Snapshot what we need and re-resolve the
        // frame afterwards.
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, resolution.this_value, resolution.args, resolution.arg_count);
        vm->frames[caller_frame_index].registers[dst] = result;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a function");
    }

    free(resolution.owned_args);
    free(arguments);
}

void mal_op_construct(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.construct.callee];
    i32 dst = instruction->as.construct.dst;
    i32 argument_count = instruction->as.construct.argument_count;

    MalValue *arguments = malloc(sizeof(MalValue) * argument_count);
    for (i32 i = 0; i < argument_count; i++) {
        arguments[i] = callable->registers[instruction->as.construct.arguments[i]];
    }

    // The bound this is ignored when constructing.
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, mal_value_new_undefined(), arguments, argument_count, false);

    if (mal_value_is_function_object(resolution.callee)) {
        // Create this from the callee's prototype property.
        MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
        MalValue prototype_value = mal_vm_function_prototype(vm, resolution.callee);
        if (mal_value_is_object(prototype_value)) {
            prototype = mal_value_to_object(prototype_value);
        }

        MalValue this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        mal_vm_push_function_frame(
            vm,
            function_index,
            mal_value_to_function_object(resolution.callee)->creation_env,
            this_value,
            resolution.args,
            resolution.arg_count,
            dst,
            vm->frame_count - 1
        );
        vm->frames[vm->frame_count - 1].is_construct = true;
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        // Construct and call behave the same for the native constructors.
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count);
        vm->frames[caller_frame_index].registers[dst] = result;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
    }

    free(resolution.owned_args);
    free(arguments);
}

void mal_op_throw(MalCallable *callable, MalInstruction *instruction) {
    callable->vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = callable->registers[instruction->as.thrown.value],
    };
}

void mal_op_catch(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.caught.dst] = callable->vm->completion.value;
    callable->vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

void mal_op_binary(MalCallable *callable, MalInstruction *instruction) {
    auto left = callable->registers[instruction->as.binary.left];
    auto right = callable->registers[instruction->as.binary.right];

    switch (instruction->as.binary.op) {
        case MAL_BIN_ADD:
            callable->registers[instruction->as.binary.dst] = mal_ops_add(&callable->vm->heap, left, right);
            break;
        case MAL_BIN_SUB:
            callable->registers[instruction->as.binary.dst] = mal_ops_subtract(left, right);
            break;
        case MAL_BIN_MUL:
            callable->registers[instruction->as.binary.dst] = mal_ops_multiply(left, right);
            break;
        case MAL_BIN_DIV:
            callable->registers[instruction->as.binary.dst] = mal_ops_divide(left, right);
            break;
        case MAL_BIN_REM:
            callable->registers[instruction->as.binary.dst] = mal_ops_remainder(left, right);
            break;
        case MAL_BIN_BIT_AND:
            callable->registers[instruction->as.binary.dst] = mal_ops_bit_and(left, right);
            break;
        case MAL_BIN_BIT_OR:
            callable->registers[instruction->as.binary.dst] = mal_ops_bit_or(left, right);
            break;
        case MAL_BIN_BIT_XOR:
            callable->registers[instruction->as.binary.dst] = mal_ops_bit_xor(left, right);
            break;
        case MAL_BIN_SHL:
            callable->registers[instruction->as.binary.dst] = mal_ops_shift_left(left, right);
            break;
        case MAL_BIN_SHR:
            callable->registers[instruction->as.binary.dst] = mal_ops_shift_right(left, right);
            break;
        case MAL_BIN_USHR:
            callable->registers[instruction->as.binary.dst] = mal_ops_shift_right_unsigned(left, right);
            break;
        case MAL_BIN_LT:
            callable->registers[instruction->as.binary.dst] = mal_ops_less_than(left, right);
            break;
        case MAL_BIN_LTE:
            callable->registers[instruction->as.binary.dst] = mal_ops_less_equal(left, right);
            break;
        case MAL_BIN_GT:
            callable->registers[instruction->as.binary.dst] = mal_ops_greater_than(left, right);
            break;
        case MAL_BIN_GTE:
            callable->registers[instruction->as.binary.dst] = mal_ops_greater_equal(left, right);
            break;
        case MAL_BIN_EQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_equal(left, right);
            break;
        case MAL_BIN_NEQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_not_equal(left, right);
            break;
        case MAL_BIN_STRICT_EQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_strict_equal(left, right);
            break;
        case MAL_BIN_STRICT_NEQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_strict_not_equal(left, right);
            break;
        case MAL_BIN_IN: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot use 'in' operator on a non-object");
                break;
            }

            MalKey key;
            if (!mal_vm_value_to_property_key(callable->vm, left, &key)) {
                callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(false);
                break;
            }

            MalValue synthetic;
            bool found = mal_vm_resolve_synthetic_property(callable->vm, right, key, &synthetic) ||
                mal_object_resolve_property(mal_value_to_object(right), key).found;
            callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(found);
            break;
        }
        case MAL_BIN_INSTANCEOF: {
            if (!mal_value_is_callable(right)) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not callable");
                break;
            }

            // OrdinaryHasInstance: walk the left prototype chain looking for
            // the constructor's prototype property.
            MalKey key = mal_intrinsic_string_key(callable->vm, "prototype");
            MalValue prototype_value = mal_value_new_undefined();
            MalValue synthetic;
            if (mal_vm_resolve_synthetic_property(callable->vm, right, key, &synthetic)) {
                prototype_value = synthetic;
            } else if (mal_value_is_object(right)) {
                MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(right), key);
                if (resolution.found) {
                    prototype_value = resolution.desc.value;
                }
            }

            bool matches = false;
            if (mal_value_is_object(left) && mal_value_is_object(prototype_value)) {
                MalObject *target = mal_value_to_object(prototype_value);
                for (MalObject *walk = mal_object_get_prototype(mal_value_to_object(left));
                     walk != nullptr;
                     walk = mal_object_get_prototype(walk)) {
                    if (walk == target) {
                        matches = true;
                        break;
                    }
                }
            }

            callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(matches);
            break;
        }
    }
}

static const byte *mal_vm_typeof_tag(MalValue value) {
    if (mal_value_is_undefined(value)) {
        return "undefined";
    }
    if (mal_value_is_null(value)) {
        return "object";
    }
    if (mal_value_is_boolean(value)) {
        return "boolean";
    }
    if (mal_value_is_string(value)) {
        return "string";
    }
    if (mal_value_is_symbol(value)) {
        return "symbol";
    }
    if (mal_value_is_callable(value)) {
        return "function";
    }
    if (mal_value_is_object(value)) {
        return "object";
    }

    return "number";
}

void mal_op_unary(MalCallable *callable, MalInstruction *instruction) {
    MalValue value = callable->registers[instruction->as.unary.src];
    i32 dst = instruction->as.unary.dst;

    switch (instruction->as.unary.op) {
        case MAL_UNARY_NOT:
            callable->registers[dst] = mal_value_new_boolean(!mal_value_is_truthy(value));
            break;
        case MAL_UNARY_NEGATE:
            if (mal_value_is_int32(value) && mal_value_to_i32(value) != 0 && mal_value_to_i32(value) != INT32_MIN) {
                callable->registers[dst] = mal_value_from_i32(-mal_value_to_i32(value));
            } else {
                // Keeps -0 and -INT32_MIN exact by going through f64.
                callable->registers[dst] = mal_value_from_f64_convert_nan(-mal_ops_to_number(value));
            }
            break;
        case MAL_UNARY_PLUS:
            callable->registers[dst] = mal_ops_number_value(mal_ops_to_number(value));
            break;
        case MAL_UNARY_BIT_NOT:
            callable->registers[dst] = mal_ops_bit_xor(value, mal_value_from_i32(-1));
            break;
        case MAL_UNARY_TYPEOF: {
            const byte *tag = mal_vm_typeof_tag(value);
            usize length = 0;
            while (tag[length] != '\0') {
                length++;
            }
            callable->registers[dst] = mal_value_from_string(mal_string_new_ascii(&callable->vm->heap, tag, length));
            break;
        }
    }
}

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction) {
    callable->vm->globals[instruction->as.store_global.index] = callable->registers[instruction->as.store_global.src];
}

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_global.dst] = callable->vm->globals[instruction->as.load_global.index];
}

void mal_op_load_intrinsic(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_intrinsic.dst] = callable->vm->intrinsics[instruction->as.load_intrinsic.intrinsic];
}

static bool mal_vm_key_is_prototype(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    static const byte expected[] = "prototype";
    if (mal_string_length(string) != lengthof(expected)) {
        return false;
    }

    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < lengthof(expected); i++) {
        if (code_units[i] != (c16) expected[i]) {
            return false;
        }
    }

    return true;
}

/**
 * Script functions get their prototype property created lazily on first use,
 * with the spec-mandated constructor back reference.
 */
static MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value) {
    MalObject *function = mal_value_to_object(function_value);
    MalKey key = mal_intrinsic_string_key(vm, "prototype");

    MalPropertyLookup lookup = mal_object_get_own(function, key);
    if (lookup.present) {
        return lookup.desc.value;
    }

    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    mal_intrinsic_define_data(vm, prototype, "constructor", function_value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_from_object(prototype), MAL_PROPERTY_WRITABLE);
    mal_object_define_own(function, key, &desc);
    return desc.value;
}

static bool mal_vm_key_is_name(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    const c16 *code_units = mal_string_code_units(string);
    return mal_string_length(string) == 4 &&
        code_units[0] == 'n' &&
        code_units[1] == 'a' &&
        code_units[2] == 'm' &&
        code_units[3] == 'e';
}

static void mal_vm_load_from_prototype_slot(MalCallable *callable, MalIntrinsic prototype_slot, MalValue receiver, MalKey key, i32 dst) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(callable->vm->intrinsics[prototype_slot]),
        key
    );
    if (!resolution.found) {
        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    MalValue value;
    if (mal_vm_desc_read(callable->vm, resolution.desc, receiver, &value)) {
        callable->registers[dst] = value;
    }
}

static bool mal_vm_value_is_number(MalValue value) {
    return mal_value_is_int32(value) || mal_value_is_f64_or_nan(value) || value == MAL_VALUE_NEGATIVE_ZERO;
}

/**
 * Resolve the synthetic properties that have no backing slot in the ordinary
 * property tables: array length, callable length/name, and the lazily
 * materialized script function prototype. Shared by load, `in`, and delete so
 * the three operators agree on what exists.
 */
static bool mal_vm_resolve_synthetic_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *value_out) {
    if (mal_value_is_array_object(object_value) && mal_array_key_is_length(key)) {
        *value_out = mal_value_from_i32((i32) mal_array_object_length(mal_value_to_array_object(object_value)));
        return true;
    }

    if (mal_value_is_callable(object_value)) {
        if (mal_array_key_is_length(key)) {
            *value_out = mal_value_from_i32(mal_vm_callable_length(vm, object_value));
            return true;
        }

        if (mal_vm_key_is_name(key)) {
            MalString *name = mal_vm_callable_name(vm, object_value);
            *value_out = name != nullptr ? mal_value_from_string(name) : mal_value_new_undefined();
            return true;
        }

        if (mal_value_is_function_object(object_value) && mal_vm_key_is_prototype(key)) {
            *value_out = mal_vm_function_prototype(vm, object_value);
            return true;
        }
    }

    return false;
}

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.load_property.object];
    MalValue key_value = callable->registers[instruction->as.load_property.key];
    i32 dst = instruction->as.load_property.dst;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    // Primitive receivers resolve against their prototype intrinsic, with
    // string length and index reads answered by the string itself.
    if (!mal_value_is_object(object_value)) {
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key)) {
                callable->registers[dst] = mal_value_from_i32((i32) mal_string_length(string));
                return;
            }

            if (key.kind == MAL_KEY_INDEX) {
                i32 index = mal_value_to_i32(key.value);
                if (index >= 0 && (usize) index < mal_string_length(string)) {
                    // The borrowed code units stay alive with the source string.
                    callable->registers[dst] = mal_value_from_string(
                        mal_string_new_external(&callable->vm->heap, mal_string_code_units(string) + index, 1)
                    );
                } else {
                    callable->registers[dst] = mal_value_new_undefined();
                }
                return;
            }

            mal_vm_load_from_prototype_slot(callable, MAL_INTRINSIC_STRING_PROTOTYPE, object_value, key, dst);
            return;
        }

        if (mal_vm_value_is_number(object_value)) {
            mal_vm_load_from_prototype_slot(callable, MAL_INTRINSIC_NUMBER_PROTOTYPE, object_value, key, dst);
            return;
        }

        if (mal_value_is_boolean(object_value)) {
            mal_vm_load_from_prototype_slot(callable, MAL_INTRINSIC_BOOLEAN_PROTOTYPE, object_value, key, dst);
            return;
        }

        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(callable->vm, object_value, key, &synthetic)) {
        callable->registers[dst] = synthetic;
        return;
    }

    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (!resolution.found) {
        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    MalValue value;
    if (mal_vm_desc_read(callable->vm, resolution.desc, object_value, &value)) {
        callable->registers[dst] = value;
    }
}

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.store_property.object];
    MalValue key_value = callable->registers[instruction->as.store_property.key];
    MalValue value = callable->registers[instruction->as.store_property.value];
    bool strict = callable->function->strict;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    if (!mal_value_is_object(object_value)) {
        // Primitives never grow own properties; strict assignments throw.
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        }
        return;
    }

    // Accessor properties anywhere on the prototype chain take the write.
    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        if (!mal_value_is_callable(resolution.desc.setter)) {
            if (strict) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set property which has only a getter");
            }
            return;
        }

        MalCompletion completion = mal_vm_call_value(callable->vm, resolution.desc.setter, object_value, &value, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            callable->vm->completion = completion;
        }
        return;
    }

    // Callable length and name are synthetic and non-writable; the prototype
    // slot stays writable through the ordinary set below.
    if (mal_value_is_callable(object_value) &&
        (mal_array_key_is_length(key) || mal_vm_key_is_name(key))) {
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        }
        return;
    }

    bool stored;
    if (mal_value_is_array_object(object_value)) {
        stored = mal_array_object_store(mal_value_to_array_object(object_value), key, value);
    } else {
        stored = mal_object_set(mal_value_to_object(object_value), key, value);
    }

    if (!stored && strict) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
    }
}

/**
 * Store a delete result, upgrading failures to the strict-mode TypeError.
 */
static void mal_vm_finish_delete(MalCallable *callable, i32 dst, bool deleted) {
    if (!deleted && callable->function->strict) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot delete property");
        return;
    }

    callable->registers[dst] = mal_value_new_boolean(deleted);
}

void mal_op_delete_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.delete_property.object];
    MalValue key_value = callable->registers[instruction->as.delete_property.key];
    i32 dst = instruction->as.delete_property.dst;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        callable->registers[dst] = mal_value_new_boolean(true);
        return;
    }

    if (!mal_value_is_object(object_value)) {
        // The only own properties a primitive can carry live on strings:
        // length and the in-range indices, all non-configurable.
        bool deleted = true;
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key) ||
                (key.kind == MAL_KEY_INDEX && (usize) mal_value_to_i32(key.value) < mal_string_length(string))) {
                deleted = false;
            }
        }

        mal_vm_finish_delete(callable, dst, deleted);
        return;
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(callable->vm, object_value, key, &synthetic)) {
        // Synthetic properties have no table slot to remove. Array length and
        // function prototype are non-configurable anyway; callable length and
        // name are approximated as non-deletable. TODO(delete): the spec marks
        // callable length and name configurable.
        mal_vm_finish_delete(callable, dst, false);
        return;
    }

    mal_vm_finish_delete(callable, dst, mal_object_delete_own(mal_value_to_object(object_value), key));
}

void mal_op_load_undeclared(MalCallable *callable, MalInstruction *instruction) {
    const MalStringConstant *constant = &callable->vm->definition->string_constants[instruction->as.load_undeclared.name_string_index];
    MalValue name = mal_value_from_string(mal_string_new_external(&callable->vm->heap, constant->code_units, constant->length));
    MalValue message = mal_ops_add(
        &callable->vm->heap,
        name,
        mal_value_from_string(mal_intrinsic_ascii(callable->vm, " is not defined"))
    );
    mal_vm_throw_error_value(callable->vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, message);
}

void mal_op_define_accessor(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.define_accessor.object];
    MalValue key_value = callable->registers[instruction->as.define_accessor.key];
    MalValue accessor = callable->registers[instruction->as.define_accessor.accessor];

    MalKey key;
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    MalObject *object = mal_value_to_object(object_value);

    // Merge into an existing own accessor so get/set pairs land in a single
    // descriptor; literal definitions are enumerable, class ones are not.
    MalPropertyFlags flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE;
    if (instruction->as.define_accessor.enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_new_undefined(), flags);
    MalPropertyLookup existing = mal_object_get_own(object, key);
    if (existing.present && (existing.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        desc = existing.desc;
    }

    if (instruction->as.define_accessor.is_setter) {
        desc.setter = accessor;
    } else {
        desc.getter = accessor;
    }

    mal_object_define_own(object, key, &desc);
}

void mal_op_define_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.define_property.object];
    MalValue key_value = callable->registers[instruction->as.define_property.key];
    MalValue value = callable->registers[instruction->as.define_property.value];

    MalKey key;
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    if (instruction->as.define_property.enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    mal_object_define_own(mal_value_to_object(object_value), key, &desc);
}

void mal_op_set_prototype(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.set_prototype.object];
    MalValue prototype_value = callable->registers[instruction->as.set_prototype.prototype];

    if (!mal_value_is_object(object_value)) {
        return;
    }

    MalObject *prototype = mal_value_is_object(prototype_value) ? mal_value_to_object(prototype_value) : nullptr;
    mal_object_set_prototype(mal_value_to_object(object_value), prototype);
}

void mal_op_jump(MalCallable *callable, MalInstruction *instruction) {
    callable->instruction_pointer = instruction->as.jump.target_ip;
}

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction) {
    if (mal_value_is_truthy(callable->registers[instruction->as.jump_if.cond])) {
        callable->instruction_pointer = instruction->as.jump_if.target_ip;
    }
}
