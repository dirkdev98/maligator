#include "vm_ops.h"

#include <stdlib.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "builtin_array.h"
#include "builtin_async_iterator.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "object_ops.h"
#include "property_iter.h"
#include "typed_array_object.h"
#include "value_ops.h"

MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value);

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
    // The string constant is an immortal, pre-hashed static; hand back a
    // pointer instead of allocating a fresh MalString per execution.
    MalString *string = &callable->vm->definition->string_constants[instruction->as.create_string.string_index];
    callable->registers[instruction->as.create_string.dst] = mal_value_from_string(string);
}

void mal_op_create_bigint(MalCallable *callable, MalInstruction *instruction) {
    // The bigint constant is an immortal static with its value baked at compile
    // time; hand back a pointer instead of parsing and allocating per execution.
    MalBigInt *bigint = &callable->vm->definition->bigint_constants[instruction->as.create_bigint.bigint_index];
    callable->registers[instruction->as.create_bigint.dst] = mal_value_from_bigint(bigint);
}

MalValue mal_vm_op_create_object(MalVm *vm) {
    MalObject *object = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );
    return mal_value_from_object(object);
}

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_object.dst] = mal_vm_op_create_object(callable->vm);
}

MalValue mal_vm_op_create_array(MalVm *vm, i32 length) {
    MalArrayObject *array = mal_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(array, (u32) length);
    return mal_value_from_array_object(array);
}

void mal_op_create_array(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_array.dst] =
        mal_vm_op_create_array(callable->vm, instruction->as.create_array.length);
}

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_undefined.dst] = mal_value_new_undefined();
}

void mal_op_create_null(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_null.dst] = mal_value_new_null();
}

MalValue mal_vm_op_create_function(MalVm *vm, i32 function_index, MalEnv *creation_env) {
    // Generator/async-generator function objects inherit their respective
    // %GeneratorFunction.prototype% / %AsyncGenerator%.
    MalIntrinsic prototype_slot;
    switch (vm->definition->functions[function_index].kind) {
        case MAL_FUNCTION_KIND_GENERATOR:
            prototype_slot = MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE;
            break;
        case MAL_FUNCTION_KIND_ASYNC_GENERATOR:
            prototype_slot = MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE;
            break;
        case MAL_FUNCTION_KIND_ASYNC:
            prototype_slot = MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE;
            break;
        default:
            prototype_slot = MAL_INTRINSIC_FUNCTION_PROTOTYPE;
            break;
    }

    MalFunctionObject *function = mal_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[prototype_slot]),
        function_index
    );
    // The closure captures the creating frame's environment chain so its body
    // resolves captured bindings by owner function index.
    function->creation_env = creation_env;

    // Materialize `length` and `name` as real { writable: false, enumerable:
    // false, configurable: true } own data properties (not synthetic) so the
    // reflective machinery and delete observe them with the right attributes.
    const MalFunction *definition = &vm->definition->functions[function_index];
    MalPropertyDesc length_desc = mal_intrinsic_data_desc(mal_value_from_i32(definition->length), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(&function->object, mal_intrinsic_string_key(vm, "length"), &length_desc);

    MalValue name_value = definition->name_string_index >= 0 && definition->name_string_index < vm->definition->string_constant_count
        ? mal_value_from_string(&vm->definition->string_constants[definition->name_string_index])
        : mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    MalPropertyDesc name_desc = mal_intrinsic_data_desc(name_value, MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(&function->object, mal_intrinsic_string_key(vm, "name"), &name_desc);

    return mal_value_from_function_object(function);
}

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_function.dst] = mal_vm_op_create_function(
        callable->vm,
        instruction->as.create_function.function_index,
        callable->env
    );
}

// Walk the environment chain to the activation that owns the captured binding
// and read its slot. Shared by the interpreter op and the native-C backend.
MalValue mal_vm_load_captured(MalEnv *env, i32 owner_function_index, i32 index) {
    for (; env != nullptr; env = env->parent) {
        if (env->function_index == owner_function_index) {
            return env->slots[index];
        }
    }

    return mal_value_new_undefined();
}

void mal_vm_store_captured(MalEnv *env, i32 owner_function_index, i32 index, MalValue value) {
    for (; env != nullptr; env = env->parent) {
        if (env->function_index == owner_function_index) {
            env->slots[index] = value;
            return;
        }
    }
}

void mal_op_load_captured(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_captured.dst] = mal_vm_load_captured(
        callable->env,
        instruction->as.load_captured.owner_function_index,
        instruction->as.load_captured.index
    );
}

void mal_op_store_captured(MalCallable *callable, MalInstruction *instruction) {
    mal_vm_store_captured(
        callable->env,
        instruction->as.store_captured.owner_function_index,
        instruction->as.store_captured.index,
        callable->registers[instruction->as.store_captured.src]
    );
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

void mal_op_load_new_target(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_new_target.dst] = callable->new_target;
}

/**
 * A bound function's combined arguments aren't the region the caller marshaled
 * at `base`, so replace that region with them in place — restoring the calling
 * convention (args are the top arg_count slots) before the frame is pushed.
 * Leaves a pending RangeError (and the stack reset to base) on overflow.
 */
static void mal_vm_remarshal_bound_args(MalVm *vm, i32 base, const MalBoundResolution *resolution) {
    if (resolution->owned_args == nullptr) {
        return;
    }

    vm->value_stack_size = base;
    if (base + resolution->arg_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    for (i32 i = 0; i < resolution->arg_count; i++) {
        vm->value_stack[base + i] = resolution->args[i];
    }
    vm->value_stack_size = base + resolution->arg_count;
}

/**
 * Shared call dispatch: bound resolution, then script frame push or native
 * invocation. The arguments occupy the top `argument_count` value-stack slots
 * starting at `base`. The result register lives on the frame that was current
 * when the dispatch started.
 */
static void mal_vm_call_dispatch(MalVm *vm, MalValue callee, MalValue this_value, i32 base, i32 argument_count, i32 dst) {
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, &vm->value_stack[base], argument_count, true);

    if (mal_value_is_function_object(resolution.callee)) {
        mal_vm_remarshal_bound_args(vm, base, &resolution);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
            const MalFunction *function = &vm->definition->functions[function_index];
            MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

            if (function->compiled != nullptr) {
                // Native-backend function: invoke directly, no bytecode frame.
                // The C stack, not the value stack, bounds this recursion.
                i32 caller_frame_index = vm->frame_count - 1;
                MalValue result = mal_value_new_undefined();
                if (mal_vm_enter_compiled(vm)) {
                    result = function->compiled(vm, resolution.this_value, &vm->value_stack[base], resolution.arg_count, mal_value_new_undefined(), env);
                    mal_vm_leave_compiled(vm);
                }
                vm->frames[caller_frame_index].registers[dst] = result;
                vm->value_stack_size = base;
            } else if (mal_vm_push_function_frame(vm, function_index, env, resolution.this_value, resolution.arg_count, dst, vm->frame_count - 1)) {
                vm->frames[vm->frame_count - 1].callee = resolution.callee;
            } else {
                vm->value_stack_size = base;
            }
        }
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        // The callback may push frames and realloc the frame array, which
        // invalidates any frame pointers. Snapshot what we need and
        // re-resolve the frame afterwards.
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, resolution.this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), resolution.callee);
        vm->frames[caller_frame_index].registers[dst] = result;
        vm->value_stack_size = base;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a function");
        vm->value_stack_size = base;
    }

    free(resolution.owned_args);
}

/**
 * Shared construct dispatch, mirroring mal_vm_call_dispatch.
 */
static void mal_vm_construct_dispatch(MalVm *vm, MalValue callee, i32 base, i32 argument_count, i32 dst) {
    // The bound this is ignored when constructing.
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, mal_value_new_undefined(), &vm->value_stack[base], argument_count, false);

    if (mal_value_is_function_object(resolution.callee)) {
        i32 callee_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        if (vm->definition->functions[callee_index].kind != MAL_FUNCTION_KIND_NORMAL) {
            // Generators (and other non-normal kinds) are not constructors.
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            vm->value_stack_size = base;
            free(resolution.owned_args);
            return;
        }

        mal_vm_remarshal_bound_args(vm, base, &resolution);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(resolution.owned_args);
            return;
        }

        // Create this from the callee's prototype property.
        MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
        MalValue prototype_value = mal_vm_function_prototype(vm, resolution.callee);
        if (mal_value_is_object(prototype_value)) {
            prototype = mal_value_to_object(prototype_value);
        }

        MalValue this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
        const MalFunction *function = &vm->definition->functions[callee_index];
        MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

        if (function->compiled != nullptr) {
            // Native-backend constructor: invoke directly with the allocated
            // `this` and new_target = the constructor. The compiled body applies
            // the [[Construct]] "non-object completion → this" substitution at its
            // RETURN (mal_ops_construct_result), so the result is used as-is. A
            // promoted-param guard that bails reaches mal_vm_interpret_function,
            // which re-runs as a construct because new_target is an object.
            i32 caller_frame_index = vm->frame_count - 1;
            MalValue result = mal_value_new_undefined();
            if (mal_vm_enter_compiled(vm)) {
                result = function->compiled(vm, this_value, &vm->value_stack[base], resolution.arg_count, resolution.callee, env);
                mal_vm_leave_compiled(vm);
            }
            vm->frames[caller_frame_index].registers[dst] = result;
            vm->value_stack_size = base;
        } else if (mal_vm_push_function_frame(vm, callee_index, env, this_value, resolution.arg_count, dst, vm->frame_count - 1)) {
            vm->frames[vm->frame_count - 1].is_construct = true;
            // new.target is the constructor being invoked through `new`.
            vm->frames[vm->frame_count - 1].new_target = resolution.callee;
        } else {
            vm->value_stack_size = base;
        }
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        // Native constructors allocate their own this; new_target carries the
        // construct-ness signal. A native that does not implement [[Construct]]
        // (a prototype method, accessor, parseInt, …) is not new-able.
        if (!mal_native_function_object_is_constructor(mal_value_to_native_function_object(resolution.callee))) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            vm->value_stack_size = base;
            free(resolution.owned_args);
            return;
        }
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count, resolution.callee, resolution.callee);
        vm->frames[caller_frame_index].registers[dst] = result;
        vm->value_stack_size = base;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
        vm->value_stack_size = base;
    }

    free(resolution.owned_args);
}

/**
 * Marshal a spread-call array's elements onto the top of the value stack,
 * returning their count (the new top region for the call to adopt). Returns -1
 * with a pending RangeError on overflow.
 */
static i32 mal_vm_marshal_spread(MalVm *vm, MalValue array_value) {
    if (!mal_value_is_array_object(array_value)) {
        return 0;
    }

    u32 length = mal_array_object_length(mal_value_to_array_object(array_value));
    if (vm->value_stack_size + (i32) length > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return -1;
    }

    i32 base = vm->value_stack_size;
    for (u32 i = 0; i < length; i++) {
        MalValue element = mal_value_new_undefined();
        mal_builtin_array_try_get(vm, array_value, i, &element);
        vm->value_stack[base + (i32) i] = element;
    }
    vm->value_stack_size = base + (i32) length;
    return (i32) length;
}

void mal_op_call(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call.callee];
    MalValue this_value = callable->registers[instruction->as.call.this_value];
    i32 dst = instruction->as.call.dst;
    i32 argument_count = instruction->as.call.argument_count;

    // Marshal the arguments onto the top of the value stack; the callee adopts
    // that region as its register window (no temp allocation, no param copy).
    if (vm->value_stack_size + argument_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    i32 base = vm->value_stack_size;
    for (i32 i = 0; i < argument_count; i++) {
        vm->value_stack[base + i] = callable->registers[instruction->as.call.arguments[i]];
    }
    vm->value_stack_size = base + argument_count;

    mal_vm_call_dispatch(vm, callee, this_value, base, argument_count, dst);
}

void mal_op_call_spread(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call_spread.callee];
    MalValue this_value = callable->registers[instruction->as.call_spread.this_value];
    MalValue arguments_array = callable->registers[instruction->as.call_spread.arguments_array];
    i32 dst = instruction->as.call_spread.dst;

    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return;
    }

    mal_vm_call_dispatch(vm, callee, this_value, base, argument_count, dst);
}

void mal_op_construct(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.construct.callee];
    i32 dst = instruction->as.construct.dst;
    i32 argument_count = instruction->as.construct.argument_count;

    if (vm->value_stack_size + argument_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    i32 base = vm->value_stack_size;
    for (i32 i = 0; i < argument_count; i++) {
        vm->value_stack[base + i] = callable->registers[instruction->as.construct.arguments[i]];
    }
    vm->value_stack_size = base + argument_count;

    mal_vm_construct_dispatch(vm, callee, base, argument_count, dst);
}

void mal_op_construct_spread(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.construct_spread.callee];
    MalValue arguments_array = callable->registers[instruction->as.construct_spread.arguments_array];
    i32 dst = instruction->as.construct_spread.dst;

    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return;
    }

    mal_vm_construct_dispatch(vm, callee, base, argument_count, dst);
}

void mal_op_construct_super(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue parent = callable->registers[instruction->as.construct_super.parent];
    MalValue arguments_array = callable->registers[instruction->as.construct_super.arguments_array];
    i32 dst = instruction->as.construct_super.dst;
    // The derived constructor's new.target is forwarded to the parent, so the
    // instance is built from the most-derived class's prototype. A super() with
    // no new.target means the derived class constructor was invoked without
    // `new` (a class constructor has no [[Call]]); that is a TypeError.
    MalValue new_target = callable->new_target;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Class constructor cannot be invoked without 'new'");
        return;
    }
    // Frames may relocate while the parent constructor runs; address the caller
    // by index for the post-construct writes rather than holding `callable`.
    i32 caller_frame_index = vm->frame_count - 1;

    // Marshal the super arguments onto the value stack (above the caller window).
    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return;
    }

    MalCompletion completion = mal_vm_construct_value_with_target(vm, parent, &vm->value_stack[base], argument_count, new_target);
    vm->value_stack_size = base;
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return;
    }

    // BindThisValue: the derived constructor's `this` is the object the super
    // constructor produced. A non-object result only arises from the deliberate
    // lack of primitive wrapper objects (super to Number/String/Boolean returns
    // a primitive); keep the eagerly-allocated `this` so the derived prototype
    // chain — and `instanceof` — are preserved.
    if (mal_value_is_object(completion.value)) {
        vm->frames[caller_frame_index].this_value = completion.value;
    }
    vm->frames[caller_frame_index].registers[dst] = vm->frames[caller_frame_index].this_value;
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

// BigInt `<<` semantics: a positive count shifts left (a * 2^count), a negative
// count is an arithmetic right shift. Beyond the 128-bit backing width the value
// saturates (TODO(bigint): arbitrary precision).
static i128 mal_vm_bigint_shift_left(i128 value, i128 count) {
    if (count >= 0) {
        return count >= 128 ? 0 : value << count;
    }
    i128 right = -count;
    if (right >= 128) {
        return value < 0 ? -1 : 0;
    }
    return value >> right;
}

static bool mal_vm_op_is_bigint_arith(MalBinaryOp op) {
    switch (op) {
        case MAL_BIN_ADD:
        case MAL_BIN_SUB:
        case MAL_BIN_MUL:
        case MAL_BIN_DIV:
        case MAL_BIN_REM:
        case MAL_BIN_POW:
        case MAL_BIN_BIT_AND:
        case MAL_BIN_BIT_OR:
        case MAL_BIN_BIT_XOR:
        case MAL_BIN_SHL:
        case MAL_BIN_SHR:
        case MAL_BIN_USHR:
            return true;
        default:
            return false;
    }
}

// Arithmetic/bitwise/shift over BigInt operands. Mixing BigInt with any non-
// BigInt (other than string concatenation via `+`) throws TypeError, matching
// the spec's refusal to implicitly convert.
static MalValue mal_vm_bigint_arith(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right) {
    if (op == MAL_BIN_ADD && (mal_value_is_string(left) || mal_value_is_string(right))) {
        return mal_ops_add(&vm->heap, left, right);
    }

    if (!mal_value_is_bigint(left) || !mal_value_is_bigint(right)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot mix BigInt and other types, use explicit conversions");
        return mal_value_new_undefined();
    }

    i128 a = mal_bigint_value(mal_value_to_bigint(left));
    i128 b = mal_bigint_value(mal_value_to_bigint(right));
    i128 result = 0;

    switch (op) {
        case MAL_BIN_ADD:
            result = a + b;
            break;
        case MAL_BIN_SUB:
            result = a - b;
            break;
        case MAL_BIN_MUL:
            result = a * b;
            break;
        case MAL_BIN_DIV:
        case MAL_BIN_REM:
            if (b == 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Division by zero");
                return mal_value_new_undefined();
            }
            result = op == MAL_BIN_DIV ? a / b : a % b;
            break;
        case MAL_BIN_POW: {
            if (b < 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Exponent must be non-negative");
                return mal_value_new_undefined();
            }
            // Square-and-multiply so a huge exponent can't spin (wraps at 128 bits).
            i128 base = a;
            i128 exponent = b;
            result = 1;
            while (exponent > 0) {
                if (exponent & 1) {
                    result *= base;
                }
                base *= base;
                exponent >>= 1;
            }
            break;
        }
        case MAL_BIN_BIT_AND:
            result = a & b;
            break;
        case MAL_BIN_BIT_OR:
            result = a | b;
            break;
        case MAL_BIN_BIT_XOR:
            result = a ^ b;
            break;
        case MAL_BIN_SHL:
            result = mal_vm_bigint_shift_left(a, b);
            break;
        case MAL_BIN_SHR:
            result = mal_vm_bigint_shift_left(a, -b);
            break;
        case MAL_BIN_USHR:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "BigInts have no unsigned right shift, use >> instead");
            return mal_value_new_undefined();
        default:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unsupported BigInt operation");
            return mal_value_new_undefined();
    }

    return mal_value_from_bigint(mal_bigint_new(&vm->heap, result));
}

// The value-returning core of a binary operator, shared by the interpreter op
// (mal_op_binary) and the compiled-function backend. On a throwing operator
// (`in`/`instanceof` on bad operands, BigInt domain errors) it sets the pending
// completion and returns undefined; callers observe the throw via vm->completion.
MalValue mal_vm_binary_op(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right) {
    // BigInt arithmetic/bitwise/shift is a separate domain (equality and
    // relational comparison stay in the shared mal_ops_* path below).
    if ((mal_value_is_bigint(left) || mal_value_is_bigint(right)) && mal_vm_op_is_bigint_arith(op)) {
        return mal_vm_bigint_arith(vm, op, left, right);
    }

    switch (op) {
        case MAL_BIN_ADD:
            return mal_ops_add(&vm->heap, left, right);
        case MAL_BIN_SUB:
            return mal_ops_subtract(left, right);
        case MAL_BIN_MUL:
            return mal_ops_multiply(left, right);
        case MAL_BIN_DIV:
            return mal_ops_divide(left, right);
        case MAL_BIN_REM:
            return mal_ops_remainder(left, right);
        case MAL_BIN_POW:
            return mal_ops_exponentiate(left, right);
        case MAL_BIN_BIT_AND:
            return mal_ops_bit_and(left, right);
        case MAL_BIN_BIT_OR:
            return mal_ops_bit_or(left, right);
        case MAL_BIN_BIT_XOR:
            return mal_ops_bit_xor(left, right);
        case MAL_BIN_SHL:
            return mal_ops_shift_left(left, right);
        case MAL_BIN_SHR:
            return mal_ops_shift_right(left, right);
        case MAL_BIN_USHR:
            return mal_ops_shift_right_unsigned(left, right);
        case MAL_BIN_LT:
            return mal_ops_less_than(left, right);
        case MAL_BIN_LTE:
            return mal_ops_less_equal(left, right);
        case MAL_BIN_GT:
            return mal_ops_greater_than(left, right);
        case MAL_BIN_GTE:
            return mal_ops_greater_equal(left, right);
        case MAL_BIN_EQ:
            return mal_ops_equal(left, right);
        case MAL_BIN_NEQ:
            return mal_ops_not_equal(left, right);
        case MAL_BIN_STRICT_EQ:
            return mal_ops_strict_equal(left, right);
        case MAL_BIN_STRICT_NEQ:
            return mal_ops_strict_not_equal(left, right);
        case MAL_BIN_IN: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot use 'in' operator on a non-object");
                return mal_value_new_undefined();
            }

            MalKey key;
            if (!mal_vm_value_to_property_key(vm, left, &key)) {
                return mal_value_new_boolean(false);
            }

            return mal_value_new_boolean(mal_vm_has_property(vm, right, key));
        }
        case MAL_BIN_INSTANCEOF: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not an object");
                return mal_value_new_undefined();
            }

            // Spec InstanceofOperator: a callable @@hasInstance method takes
            // the decision (the default lives on Function.prototype).
            MalValue method;
            if (!mal_vm_get_property(vm, right, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_HAS_INSTANCE), &method)) {
                return mal_value_new_undefined();
            }

            if (mal_value_is_callable(method)) {
                MalCompletion completion = mal_vm_call_value(vm, method, right, &left, 1);
                return completion.kind == MAL_COMPLETION_NORMAL
                    ? mal_value_new_boolean(mal_value_is_truthy(completion.value))
                    : mal_value_new_undefined();
            }

            if (!mal_value_is_callable(right)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not callable");
                return mal_value_new_undefined();
            }

            return mal_value_new_boolean(mal_vm_ordinary_has_instance(vm, right, left));
        }
    }

    return mal_value_new_undefined();
}

void mal_op_binary(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.binary.dst] = mal_vm_binary_op(
        callable->vm,
        instruction->as.binary.op,
        callable->registers[instruction->as.binary.left],
        callable->registers[instruction->as.binary.right]
    );
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
    if (mal_value_is_bigint(value)) {
        return "bigint";
    }
    if (mal_value_is_callable(value)) {
        return "function";
    }
    if (mal_value_is_object(value)) {
        return "object";
    }

    return "number";
}

// Value-returning core of a unary operator, shared by mal_op_unary and the
// compiled backend. Unary `+` on a BigInt throws (via vm->completion).
MalValue mal_vm_unary_op(MalVm *vm, MalUnaryOp op, MalValue value) {
    switch (op) {
        case MAL_UNARY_NOT:
            return mal_value_new_boolean(!mal_value_is_truthy(value));
        case MAL_UNARY_NEGATE:
            if (mal_value_is_bigint(value)) {
                return mal_value_from_bigint(mal_bigint_new(&vm->heap, -mal_bigint_value(mal_value_to_bigint(value))));
            }
            if (mal_value_is_int32(value) && mal_value_to_i32(value) != 0 && mal_value_to_i32(value) != INT32_MIN) {
                return mal_value_from_i32(-mal_value_to_i32(value));
            }
            // Keeps -0 and -INT32_MIN exact by going through f64.
            return mal_value_from_f64_convert_nan(-mal_ops_to_number(value));
        case MAL_UNARY_PLUS:
            if (mal_value_is_bigint(value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Cannot convert a BigInt value to a number");
                return mal_value_new_undefined();
            }
            return mal_ops_number_value(mal_ops_to_number(value));
        case MAL_UNARY_BIT_NOT:
            if (mal_value_is_bigint(value)) {
                return mal_value_from_bigint(mal_bigint_new(&vm->heap, ~mal_bigint_value(mal_value_to_bigint(value))));
            }
            return mal_ops_bit_xor(value, mal_value_from_i32(-1));
        case MAL_UNARY_TYPEOF: {
            const byte *tag = mal_vm_typeof_tag(value);
            usize length = 0;
            while (tag[length] != '\0') {
                length++;
            }
            return mal_value_from_string(mal_string_new_ascii(&vm->heap, tag, length));
        }
    }

    return mal_value_new_undefined();
}

void mal_op_unary(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.unary.dst] = mal_vm_unary_op(
        callable->vm,
        instruction->as.unary.op,
        callable->registers[instruction->as.unary.src]
    );
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
 * Whether a function object is a generator (its definition's kind).
 */
static bool mal_vm_function_is_generator(MalVm *vm, MalValue function_value) {
    if (!mal_value_is_function_object(function_value)) {
        return false;
    }

    i32 index = mal_function_object_function_index(mal_value_to_function_object(function_value));
    return vm->definition->functions[index].kind == MAL_FUNCTION_KIND_GENERATOR;
}

/**
 * Script functions get their prototype property created lazily on first use.
 * Ordinary functions get the spec-mandated constructor back reference and an
 * %Object.prototype%-backed object; generator functions get a
 * %GeneratorPrototype%-backed object with no constructor.
 */
MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value) {
    MalObject *function = mal_value_to_object(function_value);
    MalKey key = mal_intrinsic_string_key(vm, "prototype");

    MalPropertyLookup lookup = mal_object_get_own(function, key);
    if (lookup.present) {
        return lookup.desc.value;
    }

    MalFunctionKind kind = MAL_FUNCTION_KIND_NORMAL;
    if (mal_value_is_function_object(function_value)) {
        i32 index = mal_function_object_function_index(mal_value_to_function_object(function_value));
        kind = vm->definition->functions[index].kind;
    }
    bool is_generator_kind = kind == MAL_FUNCTION_KIND_GENERATOR || kind == MAL_FUNCTION_KIND_ASYNC_GENERATOR;

    MalIntrinsic parent_slot = kind == MAL_FUNCTION_KIND_ASYNC_GENERATOR ? MAL_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE
        : kind == MAL_FUNCTION_KIND_GENERATOR                            ? MAL_INTRINSIC_GENERATOR_PROTOTYPE
                                                                         : MAL_INTRINSIC_OBJECT_PROTOTYPE;
    MalObject *parent = mal_value_to_object(vm->intrinsics[parent_slot]);
    MalObject *prototype = mal_object_new(&vm->heap, parent);
    if (!is_generator_kind) {
        mal_intrinsic_define_data(vm, prototype, "constructor", function_value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_from_object(prototype), MAL_PROPERTY_WRITABLE);
    mal_object_define_own(function, key, &desc);
    return desc.value;
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

    // Integer-indexed TypedArray reads bypass the property table. Only in-bounds
    // indices resolve here; an out-of-bounds index is not an own property, so it
    // falls through to the ordinary (empty) lookup, yielding undefined and a
    // correct `in` result.
    if (mal_value_is_typed_array_object(object_value) && key.kind == MAL_KEY_INDEX) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(object_value);
        i32 index = mal_value_to_i32(key.value);
        if (index >= 0 && (u32) index < mal_typed_array_object_length(array)) {
            *value_out = mal_typed_array_object_get(vm, array, (u32) index);
            return true;
        }
    }

    if (mal_value_is_callable(object_value)) {
        // length and name are materialized as real own data properties at
        // function creation (function_object.c / mal_vm_op_create_function /
        // Function.prototype.bind), so the reflective machinery and delete see
        // them; they are deliberately NOT resolved synthetically here.
        if (mal_value_is_function_object(object_value) && mal_vm_key_is_prototype(key)) {
            // Async (non-generator) functions have no `prototype` property; fall
            // through to the empty lookup (undefined value, false `in`).
            i32 function_index = mal_function_object_function_index(mal_value_to_function_object(object_value));
            if (vm->definition->functions[function_index].kind != MAL_FUNCTION_KIND_ASYNC) {
                *value_out = mal_vm_function_prototype(vm, object_value);
                return true;
            }
        }
    }

    return false;
}

static bool mal_vm_get_from_prototype_slot(MalVm *vm, MalIntrinsic prototype_slot, MalValue receiver, MalKey key, MalValue *out) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(vm->intrinsics[prototype_slot]),
        key
    );
    if (!resolution.found) {
        *out = mal_value_new_undefined();
        return true;
    }

    return mal_vm_desc_read(vm, resolution.desc, receiver, out);
}

bool mal_vm_to_number(MalVm *vm, MalValue value, f64 *out) {
    // Objects first go through ToPrimitive(number): @@toPrimitive, else the
    // OrdinaryToPrimitive order valueOf → toString.
    if (mal_value_is_object(value)) {
        MalValue exotic;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &exotic)) {
            return false;
        }
        if (!mal_value_is_nil(exotic)) {
            if (!mal_value_is_callable(exotic)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.toPrimitive is not a function");
                return false;
            }
            MalValue hint = mal_value_from_string(mal_intrinsic_ascii(vm, "number"));
            MalCompletion result = mal_vm_call_value(vm, exotic, value, &hint, 1);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                return false;
            }
            if (mal_value_is_object(result.value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return false;
            }
            value = result.value;
        } else {
            const byte *methods[2] = {"valueOf", "toString"};
            bool converted = false;
            for (i32 i = 0; i < 2 && !converted; i++) {
                MalValue method;
                if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
                    return false;
                }
                if (mal_value_is_callable(method)) {
                    MalCompletion result = mal_vm_call_value(vm, method, value, nullptr, 0);
                    if (result.kind != MAL_COMPLETION_NORMAL) {
                        return false;
                    }
                    if (!mal_value_is_object(result.value)) {
                        value = result.value;
                        converted = true;
                    }
                }
            }
            if (!converted) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return false;
            }
        }
    }

    // ToNumber proper: BigInt and Symbol are not convertible.
    if (mal_value_is_bigint(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a BigInt value to a number");
        return false;
    }
    if (mal_value_is_symbol(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a number");
        return false;
    }

    *out = mal_ops_to_number(value);
    return true;
}

bool mal_vm_get_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *out) {
    return mal_vm_get_property_with_receiver(vm, object_value, key, object_value, out);
}

bool mal_vm_get_property_with_receiver(MalVm *vm, MalValue object_value, MalKey key, MalValue receiver, MalValue *out) {
    *out = mal_value_new_undefined();

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return false;
    }

    // Primitive receivers resolve against their prototype intrinsic, with
    // string length and index reads answered by the string itself.
    if (!mal_value_is_object(object_value)) {
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key)) {
                *out = mal_value_from_i32((i32) mal_string_length(string));
                return true;
            }

            if (key.kind == MAL_KEY_INDEX) {
                i32 index = mal_value_to_i32(key.value);
                if (index >= 0 && (usize) index < mal_string_length(string)) {
                    // The borrowed code units stay alive with the source string.
                    *out = mal_value_from_string(
                        mal_string_new_external(&vm->heap, mal_string_code_units(string) + index, 1)
                    );
                }
                return true;
            }

            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_STRING_PROTOTYPE, receiver, key, out);
        }

        if (mal_vm_value_is_number(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_NUMBER_PROTOTYPE, receiver, key, out);
        }

        if (mal_value_is_boolean(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_BOOLEAN_PROTOTYPE, receiver, key, out);
        }

        if (mal_value_is_symbol(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_SYMBOL_PROTOTYPE, receiver, key, out);
        }

        if (mal_value_is_bigint(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_BIGINT_PROTOTYPE, receiver, key, out);
        }

        return true;
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        *out = synthetic;
        return true;
    }

    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (!resolution.found) {
        return true;
    }

    return mal_vm_desc_read(vm, resolution.desc, receiver, out);
}

/**
 * Spec HasProperty(O, P): consults synthetic properties (array length, callable
 * prototype, in-bounds typed-array indices) and the ordinary prototype chain.
 * The caller has already verified O is an object.
 */
bool mal_vm_has_property(MalVm *vm, MalValue object_value, MalKey key) {
    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        return true;
    }

    return mal_object_resolve_property(mal_value_to_object(object_value), key).found;
}

/**
 * Spec [[Set]] returning the boolean success (never throwing on a plain
 * rejection) used by Reflect.set: an accessor invokes its setter with the
 * receiver, a writable data property (or absent property) is created/updated on
 * the receiver. A throwing user setter propagates through vm->completion.
 */
bool mal_vm_set_property(MalVm *vm, MalValue target, MalKey key, MalValue value, MalValue receiver) {
    MalObject *object = mal_value_to_object(target);
    MalPropertyResolution resolution = mal_object_resolve_property(object, key);

    if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        if (!mal_value_is_callable(resolution.desc.setter)) {
            return false;
        }
        MalCompletion completion = mal_vm_call_value(vm, resolution.desc.setter, receiver, &value, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return false;
        }
        return true;
    }

    // Data (or absent) property. When the receiver is the target, defer to the
    // pragmatic ordinary set (which honors array/exotic storage and the
    // non-writable / non-extensible checks).
    if (target == receiver) {
        if (mal_value_is_array_object(target)) {
            return mal_array_object_store(mal_value_to_array_object(target), key, value);
        }
        return mal_object_set(object, key, value);
    }

    // Distinct receiver: OrdinarySetWithOwnDescriptor writes the data value onto
    // the receiver, respecting its own descriptor.
    if (resolution.found && !(resolution.desc.flags & MAL_PROPERTY_WRITABLE)) {
        return false;
    }
    if (!mal_value_is_object(receiver)) {
        return false;
    }
    MalObject *receiver_object = mal_value_to_object(receiver);
    MalPropertyLookup own = mal_object_get_own(receiver_object, key);
    if (own.present) {
        if ((own.desc.flags & MAL_PROPERTY_ACCESSOR) || !(own.desc.flags & MAL_PROPERTY_WRITABLE)) {
            return false;
        }
        own.desc.value = value;
        return mal_object_define_own(receiver_object, key, &own.desc) == MAL_DEFINE_OWN_APPLIED;
    }
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    return mal_object_define_own(receiver_object, key, &desc) == MAL_DEFINE_OWN_APPLIED;
}

/**
 * Spec [[Delete]] returning the boolean success used by Reflect.deleteProperty
 * and the delete operator: a real own property is removed honoring
 * configurable; a non-configurable synthetic property (array length, callable
 * prototype) cannot be deleted. The caller has verified O is an object.
 */
bool mal_vm_delete_property(MalVm *vm, MalValue object_value, MalKey key) {
    MalObject *object = mal_value_to_object(object_value);

    if (mal_object_get_own(object, key).present) {
        return mal_object_delete_own(object, key);
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        return false;
    }

    return mal_object_delete_own(object, key);
}

bool mal_vm_ordinary_has_instance(MalVm *vm, MalValue target, MalValue value) {
    // Bound functions defer to their wrapped target.
    while (mal_value_is_bound_function_object(target)) {
        target = mal_value_to_bound_function_object(target)->target;
    }

    if (!mal_value_is_callable(target)) {
        return false;
    }

    // Non-object values answer false before the prototype read.
    if (!mal_value_is_object(value)) {
        return false;
    }

    MalKey key = mal_intrinsic_string_key(vm, "prototype");
    MalValue prototype_value = mal_value_new_undefined();
    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, target, key, &synthetic)) {
        prototype_value = synthetic;
    } else if (mal_value_is_object(target)) {
        MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(target), key);
        if (resolution.found) {
            prototype_value = resolution.desc.value;
        }
    }

    if (!mal_value_is_object(prototype_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function has non-object prototype in instanceof check");
        return false;
    }

    MalObject *prototype = mal_value_to_object(prototype_value);
    for (MalObject *walk = mal_object_get_prototype(mal_value_to_object(value));
         walk != nullptr;
         walk = mal_object_get_prototype(walk)) {
        if (walk == prototype) {
            return true;
        }
    }

    return false;
}

// Spec Get over a value with an already-evaluated key value, returning the
// result (undefined on a non-coercible key or a throw — the caller propagates
// vm->completion). Shared by the interpreter op and the native-C backend.
MalValue mal_vm_op_load_property(MalVm *vm, MalValue object_value, MalValue key_value) {
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return mal_value_new_undefined();
    }

    MalValue value;
    if (mal_vm_get_property(vm, object_value, key, &value)) {
        return value;
    }

    return mal_value_new_undefined();
}

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_property.dst] = mal_vm_op_load_property(
        callable->vm,
        callable->registers[instruction->as.load_property.object],
        callable->registers[instruction->as.load_property.key]
    );
}

// Spec Set over a value with an already-evaluated key value, signalling a throw
// through vm->completion. Shared by the interpreter op and the native-C backend
// (which passes its statically-known strictness).
void mal_vm_op_store_property(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict) {
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return;
    }

    if (!mal_value_is_object(object_value)) {
        // Primitives never grow own properties; strict assignments throw.
        if (strict) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        }
        return;
    }

    // Integer-indexed TypedArray writes go through IntegerIndexedElementSet
    // (coerce, then write in-bounds; out-of-bounds is silently dropped) and
    // never define an ordinary property.
    if (mal_value_is_typed_array_object(object_value) && key.kind == MAL_KEY_INDEX) {
        i32 index = mal_value_to_i32(key.value);
        if (index >= 0) {
            mal_typed_array_object_set(vm, mal_value_to_typed_array_object(object_value), (u32) index, value);
            return;
        }
    }

    // Accessor properties anywhere on the prototype chain take the write.
    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        if (!mal_value_is_callable(resolution.desc.setter)) {
            if (strict) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set property which has only a getter");
            }
            return;
        }

        MalCompletion completion = mal_vm_call_value(vm, resolution.desc.setter, object_value, &value, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
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
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
    }
}

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction) {
    mal_vm_op_store_property(
        callable->vm,
        callable->registers[instruction->as.store_property.object],
        callable->registers[instruction->as.store_property.key],
        callable->registers[instruction->as.store_property.value],
        callable->function->strict
    );
}

void mal_op_store_super_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.store_super_property.object];
    MalValue key_value = callable->registers[instruction->as.store_super_property.key];
    MalValue value = callable->registers[instruction->as.store_super_property.value];
    MalValue receiver = callable->registers[instruction->as.store_super_property.receiver];
    bool strict = callable->function->strict;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    // OrdinarySetWithOwnDescriptor: the super base chain provides the
    // controlling descriptor, the write applies to the receiver.
    if (mal_value_is_object(object_value)) {
        MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);

        if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
            if (!mal_value_is_callable(resolution.desc.setter)) {
                if (strict) {
                    mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set property which has only a getter");
                }
                return;
            }

            MalCompletion completion = mal_vm_call_value(callable->vm, resolution.desc.setter, receiver, &value, 1);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                callable->vm->completion = completion;
            }
            return;
        }

        if (resolution.found && !(resolution.desc.flags & MAL_PROPERTY_WRITABLE)) {
            if (strict) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
            }
            return;
        }
    }

    if (!mal_value_is_object(receiver)) {
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        }
        return;
    }

    MalObject *receiver_object = mal_value_to_object(receiver);
    MalPropertyLookup own = mal_object_get_own(receiver_object, key);
    if (own.present) {
        bool rejected = (own.desc.flags & MAL_PROPERTY_ACCESSOR) ||
            !(own.desc.flags & MAL_PROPERTY_WRITABLE);
        if (rejected) {
            if (strict) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
            }
            return;
        }

        own.desc.value = value;
        mal_object_define_own(receiver_object, key, &own.desc);
        return;
    }

    if (!mal_object_is_extensible(receiver_object)) {
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot add property to a non-extensible object");
        }
        return;
    }

    // CreateDataProperty on the receiver, ignoring its inherited properties.
    mal_property_set_value(mal_object_properties(receiver_object), key, value);
}

void mal_op_get_iterator(MalCallable *callable, MalInstruction *instruction) {
    MalValue source = callable->registers[instruction->as.get_iterator.source];

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(callable->vm, source, &record)) {
        return;
    }

    callable->registers[instruction->as.get_iterator.iterator_dst] = record.iterator;
    callable->registers[instruction->as.get_iterator.next_dst] = record.next_method;
}

void mal_op_get_async_iterator(MalCallable *callable, MalInstruction *instruction) {
    MalValue source = callable->registers[instruction->as.get_async_iterator.source];

    MalIteratorRecord record;
    if (!mal_vm_get_async_iterator(callable->vm, source, &record)) {
        return;
    }

    callable->registers[instruction->as.get_async_iterator.iterator_dst] = record.iterator;
    callable->registers[instruction->as.get_async_iterator.next_dst] = record.next_method;
}

void mal_op_iterator_next(MalCallable *callable, MalInstruction *instruction) {
    MalValue iterator = callable->registers[instruction->as.iterator_next.iterator];
    MalValue next = callable->registers[instruction->as.iterator_next.next];

    MalCompletion completion = mal_vm_call_value(callable->vm, next, iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return; // throw left pending; the run loop unwinds
    }
    callable->registers[instruction->as.iterator_next.result_dst] = completion.value;
}

void mal_op_iterator_step(MalCallable *callable, MalInstruction *instruction) {
    MalIteratorRecord record = {
        .iterator = callable->registers[instruction->as.iterator_step.iterator],
        .next_method = callable->registers[instruction->as.iterator_step.next],
    };

    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(callable->vm, &record, &value, &done)) {
        return;
    }

    callable->registers[instruction->as.iterator_step.value_dst] = value;
    callable->registers[instruction->as.iterator_step.done_dst] = mal_value_new_boolean(done);
}

void mal_op_iterator_close(MalCallable *callable, MalInstruction *instruction) {
    MalIteratorRecord record = {
        .iterator = callable->registers[instruction->as.iterator_close.iterator],
        .next_method = mal_value_new_undefined(),
    };

    mal_vm_iterator_close(callable->vm, &record);
}

static MalValue mal_vm_for_in_key_string(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }

    return key.value;
}

void mal_op_for_in_keys(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue source = callable->registers[instruction->as.for_in_keys.source];

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;

    // for-in over null/undefined performs no iteration.
    if (mal_value_is_nil(source)) {
        callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
        return;
    }

    // Strings expose their characters as enumerable index properties; without a
    // wrapper object we synthesize the index keys directly.
    if (mal_value_is_string(source)) {
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)},
                mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) i)))
            );
            count++;
        }
        callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
        return;
    }

    // Numbers, booleans, and symbols have no enumerable own properties.
    if (!mal_value_is_object(source)) {
        callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
        return;
    }

    // EnumerateObjectProperties: walk the prototype chain visiting each string
    // key once. A key seen on a nearer object shadows the same key further up,
    // even when the nearer one is non-enumerable, so the shadow set records
    // every own key regardless of enumerability. A throwaway object reuses the
    // table's key equality for the set.
    MalObject *seen = mal_intrinsic_new_object(vm);
    MalPropertyDesc marker = mal_intrinsic_data_desc(mal_value_new_undefined(), 0);

    for (MalObject *current = mal_value_to_object(source); current != nullptr;
         current = mal_object_get_prototype(current)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, current, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            // Symbol keys are not enumerated by for-in.
            if (key.kind == MAL_KEY_SYMBOL) {
                continue;
            }

            if (mal_object_get_own(seen, key).present) {
                continue;
            }
            mal_object_define_own(seen, key, &marker);

            if (!(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }

            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)},
                mal_vm_for_in_key_string(vm, key)
            );
            count++;
        }
    }

    callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
}

void mal_op_load_prototype(MalCallable *callable, MalInstruction *instruction) {
    MalValue value = callable->registers[instruction->as.load_prototype.object];
    MalValue result = mal_value_new_null();

    if (mal_value_is_object(value)) {
        MalObject *prototype = mal_object_get_prototype(mal_value_to_object(value));
        if (prototype != nullptr) {
            result = mal_value_from_object(prototype);
        }
    }

    callable->registers[instruction->as.load_prototype.dst] = result;
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

    mal_vm_finish_delete(callable, dst, mal_vm_delete_property(callable->vm, object_value, key));
}

void mal_vm_op_load_undeclared(MalVm *vm, i32 name_string_index) {
    MalString *constant = &vm->definition->string_constants[name_string_index];
    MalValue name = mal_value_from_string(constant);
    MalValue message = mal_ops_add(
        &vm->heap,
        name,
        mal_value_from_string(mal_intrinsic_ascii(vm, " is not defined"))
    );
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, message);
}

void mal_op_load_undeclared(MalCallable *callable, MalInstruction *instruction) {
    mal_vm_op_load_undeclared(callable->vm, instruction->as.load_undeclared.name_string_index);
}

void mal_op_require_coercible(MalCallable *callable, MalInstruction *instruction) {
    if (mal_value_is_nil(callable->registers[instruction->as.require_coercible.src])) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
    }
}

void mal_op_create_rest_arguments(MalCallable *callable, MalInstruction *instruction) {
    i32 start = instruction->as.create_rest_arguments.start_index;
    i32 count = callable->argument_count > start ? callable->argument_count - start : 0;

    MalArrayObject *rest = mal_array_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(rest, (u32) count);

    for (i32 i = 0; i < count; i++) {
        mal_object_set(
            (MalObject *) rest,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)},
            callable->arguments[start + i]
        );
    }

    callable->registers[instruction->as.create_rest_arguments.dst] = mal_value_from_array_object(rest);
}

void mal_op_array_rest(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue source = callable->registers[instruction->as.array_rest.src];
    u32 start = (u32) instruction->as.array_rest.start_index;

    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
        return;
    }

    // Index-read approximation of the spec's iterator protocol, mirroring the
    // pattern's positional element reads (TODO(iterators)).
    u32 length;
    if (!mal_builtin_array_this_length(vm, source, &length)) {
        return;
    }

    u32 count = length > start ? length - start : 0;
    MalArrayObject *rest = mal_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(rest, count);

    for (u32 i = 0; i < count; i++) {
        // Holes read as dense undefined elements, like the array iterator
        // yields them.
        MalValue element = mal_value_new_undefined();
        if (!mal_builtin_array_try_get(vm, source, start + i, &element) &&
            vm->completion.kind == MAL_COMPLETION_THROW) {
            return;
        }

        mal_object_set(
            (MalObject *) rest,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)},
            element
        );
    }

    callable->registers[instruction->as.array_rest.dst] = mal_value_from_array_object(rest);
}

void mal_op_copy_data_properties(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue source = callable->registers[instruction->as.copy_data_properties.src];

    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
        return;
    }

    // The excluded keys land in a throwaway object so the membership checks
    // reuse the property table's key equality.
    MalObject *excluded = nullptr;
    i32 excluded_count = instruction->as.copy_data_properties.excluded_count;
    if (excluded_count > 0) {
        excluded = mal_object_new(&vm->heap, nullptr);
        for (i32 i = 0; i < excluded_count; i++) {
            MalValue key_value = callable->registers[instruction->as.copy_data_properties.excluded[i]];

            MalKey key;
            if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
                return;
            }

            mal_object_set(excluded, key, mal_value_new_boolean(true));
        }
    }

    MalObject *copy = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );

    if (mal_value_is_string(source)) {
        // String sources expose their code units as own enumerable index
        // properties.
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
            if (excluded != nullptr && mal_object_get_own(excluded, key).present) {
                continue;
            }

            mal_object_set(
                copy,
                key,
                mal_value_from_string(mal_string_new_external(&vm->heap, mal_string_code_units(string) + i, 1))
            );
        }
    } else if (mal_value_is_object(source)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (excluded != nullptr && mal_object_get_own(excluded, key).present) {
                continue;
            }

            MalValue value;
            if (!mal_vm_desc_read(vm, desc, source, &value)) {
                return;
            }

            mal_object_set(copy, key, value);
        }
    }
    // Other primitives carry no own enumerable properties.

    callable->registers[instruction->as.copy_data_properties.dst] = mal_value_from_object(copy);
}

void mal_op_merge_data_properties(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue target_value = callable->registers[instruction->as.merge_data_properties.target];
    MalValue source = callable->registers[instruction->as.merge_data_properties.src];

    // Spreading null/undefined contributes nothing.
    if (mal_value_is_nil(source)) {
        return;
    }

    MalObject *target = mal_value_to_object(target_value);

    if (mal_value_is_string(source)) {
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            MalPropertyDesc desc = mal_intrinsic_data_desc(
                mal_value_from_string(mal_string_new_external(&vm->heap, mal_string_code_units(string) + i, 1)),
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
            );
            mal_object_define_own(target, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &desc);
        }
        return;
    }

    if (!mal_value_is_object(source)) {
        return;
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        MalValue value;
        if (!mal_vm_desc_read(vm, desc, source, &value)) {
            return;
        }

        // CreateDataProperty: own enumerable data property, no inherited setters.
        MalPropertyDesc data = mal_intrinsic_data_desc(
            value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(target, key, &data);
    }
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

void mal_vm_op_define_property(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool enumerable) {
    MalKey key;
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(vm, key_value, &key)) {
        return;
    }

    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    if (enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    mal_object_define_own(mal_value_to_object(object_value), key, &desc);
}

void mal_op_define_property(MalCallable *callable, MalInstruction *instruction) {
    mal_vm_op_define_property(
        callable->vm,
        callable->registers[instruction->as.define_property.object],
        callable->registers[instruction->as.define_property.key],
        callable->registers[instruction->as.define_property.value],
        instruction->as.define_property.enumerable
    );
}

/**
 * The shared error for reading or writing a private member on a receiver that
 * was not branded by the declaring class (PrivateElementFind returned empty).
 */
static const byte *const mal_private_absent_message =
    "Cannot access private member on an object whose class did not declare it";

void mal_op_create_private_name(MalCallable *callable, MalInstruction *instruction) {
    MalSymbol *symbol = mal_symbol_new_private(&callable->vm->heap);
    callable->registers[instruction->as.create_private_name.dst] = mal_value_from_symbol(symbol);
}

void mal_op_define_private(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.define_private.object];
    MalValue key_value = callable->registers[instruction->as.define_private.key];
    MalValue value = callable->registers[instruction->as.define_private.value];

    // The receiver is always a freshly built instance or the class object.
    if (!mal_value_is_object(object_value)) {
        return;
    }

    MalObject *object = mal_value_to_object(object_value);
    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};

    if (mal_object_get_own(object, key).present) {
        // AddPrivateName rejects installing the same private element twice on
        // one object (re-entrant construction of the same this).
        mal_vm_throw_error(
            callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot initialize the same private member twice on an object"
        );
        return;
    }

    // Private fields are writable but never enumerable or configurable, and
    // the backing symbol is hidden from reflection.
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, MAL_PROPERTY_WRITABLE);
    mal_object_define_own(object, key, &desc);
}

void mal_op_load_private(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.load_private.object];
    MalValue key_value = callable->registers[instruction->as.load_private.key];
    i32 dst = instruction->as.load_private.dst;

    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return;
    }

    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(object_value), key);
    if (!lookup.present) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return;
    }

    // Private fields and the brand marker are always data descriptors;
    // private accessors are dispatched by the compiler, never stored here.
    callable->registers[dst] = lookup.desc.value;
}

void mal_op_store_private(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.store_private.object];
    MalValue key_value = callable->registers[instruction->as.store_private.key];
    MalValue value = callable->registers[instruction->as.store_private.value];

    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return;
    }

    MalObject *object = mal_value_to_object(object_value);
    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};
    if (!mal_object_get_own(object, key).present) {
        // PrivateSet requires the private name to already be installed.
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return;
    }

    mal_property_set_value(mal_object_properties(object), key, value);
}

void mal_op_has_private(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.has_private.object];
    MalValue key_value = callable->registers[instruction->as.has_private.key];
    i32 dst = instruction->as.has_private.dst;

    if (!mal_value_is_object(object_value)) {
        // `#x in <non-object>` throws (ergonomic brand check step 6).
        mal_vm_throw_error(
            callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot use 'in' to check for a private member of a non-object"
        );
        return;
    }

    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};
    bool present = mal_object_get_own(mal_value_to_object(object_value), key).present;
    callable->registers[dst] = mal_value_new_boolean(present);
}

void mal_op_set_prototype(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.set_prototype.object];
    MalValue prototype_value = callable->registers[instruction->as.set_prototype.prototype];

    if (!mal_value_is_object(object_value)) {
        return;
    }

    if (instruction->as.set_prototype.literal &&
        !mal_value_is_object(prototype_value) && !mal_value_is_null(prototype_value)) {
        // B.3.1: object literal `__proto__:` members ignore other values.
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
