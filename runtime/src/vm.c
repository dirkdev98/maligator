#include "vm.h"

#include <stdio.h>
#include <stdlib.h>

#include "bound_function_object.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "value_ops.h"
#include "vm_ops.h"

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition) {
    vm->definition = definition;
    vm->globals = malloc(sizeof(MalValue) * definition->global_count);
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    mal_heap_init(&vm->heap, 0);
    for (i32 i = 0; i < definition->global_count; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
    for (i32 i = 0; i < MAL_INTRINSIC_COUNT; i++) {
        vm->intrinsics[i] = mal_value_new_undefined();
    }
    mal_intrinsics_init(vm);
}

void mal_vm_free(MalVm *vm) {
    for (i32 i = 0; i < vm->frame_count; i++) {
        free(vm->frames[i].registers);
        free(vm->frames[i].arguments);
    }

    free(vm->frames);
    free(vm->globals);
    mal_heap_free(&vm->heap);

    vm->definition = nullptr;
    vm->globals = nullptr;
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;
}

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index) {
    MalCallable *callable = malloc(sizeof(MalCallable));

    callable->vm = vm;
    callable->function = &vm->definition->functions[function_index];
    callable->registers = malloc(sizeof(MalValue) * callable->function->register_count);
    callable->env = nullptr;
    callable->arguments = nullptr;
    callable->argument_count = 0;
    callable->this_value = mal_value_new_undefined();
    callable->arguments_object = mal_value_new_undefined();
    callable->is_construct = false;
    callable->instruction_pointer = 0;
    callable->return_register = -1;
    callable->caller_frame_index = -1;

    return callable;
}

void mal_vm_free_callable(MalCallable *callable) {
    free(callable->registers);
    free(callable->arguments);
    free(callable);
}

void mal_vm_push_function_frame(
    MalVm *vm,
    i32 function_index,
    MalEnv *creation_env,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    i32 return_register,
    i32 caller_frame_index
) {
    if (vm->frame_count == vm->frame_capacity) {
        vm->frame_capacity = vm->frame_capacity == 0 ? 8 : vm->frame_capacity * 2;
        vm->frames = realloc(vm->frames, sizeof(MalVmFrame) * vm->frame_capacity);
    }

    const MalFunction *function = &vm->definition->functions[function_index];
    MalVmFrame *frame = &vm->frames[vm->frame_count++];

    // Functions without captured slots pass the creation chain through, so
    // grandchild closures still find their owners.
    MalEnv *env = creation_env;
    if (function->captured_count > 0) {
        env = malloc(sizeof(MalEnv) + sizeof(MalValue) * (usize) function->captured_count);
        env->parent = creation_env;
        env->function_index = function_index;
        for (i32 i = 0; i < function->captured_count; i++) {
            env->slots[i] = mal_value_new_undefined();
        }
    }

    frame->vm = vm;
    frame->function = function;
    frame->env = env;
    frame->registers = malloc(sizeof(MalValue) * function->register_count);
    frame->arguments = arg_count > 0 ? malloc(sizeof(MalValue) * arg_count) : nullptr;
    frame->argument_count = arg_count;
    frame->this_value = this_value;
    frame->arguments_object = mal_value_new_undefined();
    frame->is_construct = false;
    frame->instruction_pointer = 0;
    frame->return_register = return_register;
    frame->caller_frame_index = caller_frame_index;

    for (i32 i = 0; i < function->register_count; i++) {
        frame->registers[i] = mal_value_new_undefined();
    }

    for (i32 i = 0; i < function->parameter_count; i++) {
        frame->registers[i] = i < arg_count ? args[i] : mal_value_new_undefined();
    }

    for (i32 i = 0; i < arg_count; i++) {
        frame->arguments[i] = args[i];
    }
}

/**
 * Find the innermost handler covering the current instruction in the topmost
 * frame that has one, popping all frames above it.
 *
 * Only frames pushed within the current run loop (index >= target_frame_count)
 * are considered: frames below belong to an outer run loop, which performs its
 * own unwinding once the throw completion propagates to it.
 */
static bool mal_vm_unwind_to_handler(MalVm *vm, i32 target_frame_count) {
    for (i32 frame_index = vm->frame_count - 1; frame_index >= target_frame_count; frame_index--) {
        MalVmFrame *frame = &vm->frames[frame_index];
        // The instruction pointer was already advanced past the faulting
        // instruction (or past the call instruction for caller frames).
        i32 faulting_ip = frame->instruction_pointer - 1;

        const MalExceptionHandler *innermost = nullptr;
        for (i32 i = 0; i < frame->function->handler_count; i++) {
            const MalExceptionHandler *handler = &frame->function->handlers[i];
            if (faulting_ip < handler->start_ip || faulting_ip >= handler->end_ip) {
                continue;
            }

            if (innermost == nullptr ||
                handler->end_ip - handler->start_ip < innermost->end_ip - innermost->start_ip) {
                innermost = handler;
            }
        }

        if (innermost == nullptr) {
            continue;
        }

        for (i32 i = vm->frame_count - 1; i > frame_index; i--) {
            free(vm->frames[i].registers);
            free(vm->frames[i].arguments);
        }

        vm->frame_count = frame_index + 1;
        frame->instruction_pointer = innermost->handler_ip;
        return true;
    }

    return false;
}

static void mal_vm_run_until_frame_count(MalVm *vm, i32 target_frame_count) {
    while (vm->frame_count > target_frame_count) {
        MalVmFrame *frame = &vm->frames[vm->frame_count - 1];
        auto instruction = frame->function->instructions[frame->instruction_pointer++];

        switch (instruction.opcode) {
            case MAL_OP_MOVE:
                mal_op_move(frame, &instruction);
                break;

            case MAL_OP_CREATE_NUMBER:
                mal_op_create_number(frame, &instruction);
                break;
            case MAL_OP_CREATE_F64:
                mal_op_create_f64(frame, &instruction);
                break;
            case MAL_OP_CREATE_BOOLEAN:
                mal_op_create_boolean(frame, &instruction);
                break;
            case MAL_OP_CREATE_STRING:
                mal_op_create_string(frame, &instruction);
                break;
            case MAL_OP_CREATE_OBJECT:
                mal_op_create_object(frame, &instruction);
                break;
            case MAL_OP_CREATE_ARRAY:
                mal_op_create_array(frame, &instruction);
                break;
            case MAL_OP_CREATE_UNDEFINED:
                mal_op_create_undefined(frame, &instruction);
                break;
            case MAL_OP_CREATE_NULL:
                mal_op_create_null(frame, &instruction);
                break;
            case MAL_OP_CREATE_FUNCTION:
                mal_op_create_function(frame, &instruction);
                break;
            case MAL_OP_CREATE_ARGUMENTS_OBJECT:
                mal_op_create_arguments_object(frame, &instruction);
                break;
            case MAL_OP_LOAD_THIS:
                mal_op_load_this(frame, &instruction);
                break;
            case MAL_OP_BINARY:
                mal_op_binary(frame, &instruction);
                break;
            case MAL_OP_UNARY:
                mal_op_unary(frame, &instruction);
                break;

            case MAL_OP_STORE_GLOBAL:
                mal_op_store_global(frame, &instruction);
                break;
            case MAL_OP_LOAD_GLOBAL:
                mal_op_load_global(frame, &instruction);
                break;
            case MAL_OP_LOAD_INTRINSIC:
                mal_op_load_intrinsic(frame, &instruction);
                break;
            case MAL_OP_LOAD_PROPERTY:
                mal_op_load_property(frame, &instruction);
                break;
            case MAL_OP_STORE_PROPERTY:
                mal_op_store_property(frame, &instruction);
                break;
            case MAL_OP_DELETE_PROPERTY:
                mal_op_delete_property(frame, &instruction);
                break;
            case MAL_OP_DEFINE_ACCESSOR:
                mal_op_define_accessor(frame, &instruction);
                break;
            case MAL_OP_DEFINE_PROPERTY:
                mal_op_define_property(frame, &instruction);
                break;
            case MAL_OP_SET_PROTOTYPE:
                mal_op_set_prototype(frame, &instruction);
                break;
            case MAL_OP_LOAD_UNDECLARED:
                mal_op_load_undeclared(frame, &instruction);
                break;
            case MAL_OP_REQUIRE_COERCIBLE:
                mal_op_require_coercible(frame, &instruction);
                break;
            case MAL_OP_CREATE_REST_ARGUMENTS:
                mal_op_create_rest_arguments(frame, &instruction);
                break;
            case MAL_OP_ARRAY_REST:
                mal_op_array_rest(frame, &instruction);
                break;
            case MAL_OP_COPY_DATA_PROPERTIES:
                mal_op_copy_data_properties(frame, &instruction);
                break;

            case MAL_OP_LOAD_CAPTURED:
                mal_op_load_captured(frame, &instruction);
                break;
            case MAL_OP_STORE_CAPTURED:
                mal_op_store_captured(frame, &instruction);
                break;

            case MAL_OP_CALL:
                mal_op_call(frame, &instruction);
                break;
            case MAL_OP_CONSTRUCT:
                mal_op_construct(frame, &instruction);
                break;

            case MAL_OP_THROW:
                mal_op_throw(frame, &instruction);
                break;
            case MAL_OP_CATCH:
                mal_op_catch(frame, &instruction);
                break;
            case MAL_OP_TRY_BEGIN:
            case MAL_OP_TRY_END:
                // Markers only; protected ranges live in the handler table.
                break;

            case MAL_OP_JUMP:
                mal_op_jump(frame, &instruction);
                break;
            case MAL_OP_JUMP_IF:
                mal_op_jump_if(frame, &instruction);
                break;

            case MAL_OP_RETURN: {
                MalValue return_value = frame->registers[instruction.as.ret.value];
                if (frame->is_construct && !mal_value_is_object(return_value)) {
                    return_value = frame->this_value;
                }

                i32 return_register = frame->return_register;
                i32 caller_frame_index = frame->caller_frame_index;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_RETURN, .value = return_value};

                free(frame->registers);
                free(frame->arguments);
                vm->frame_count--;

                if (caller_frame_index >= 0) {
                    vm->frames[caller_frame_index].registers[return_register] = vm->completion.value;
                    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = vm->completion.value};
                } else {
                    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = vm->completion.value};
                }
                break;
            }
        }

        if (vm->completion.kind == MAL_COMPLETION_THROW && !mal_vm_unwind_to_handler(vm, target_frame_count)) {
            // No handler within this run loop; eagerly pop the frames it owns
            // and let the throw completion propagate to the caller.
            for (i32 i = vm->frame_count - 1; i >= target_frame_count; i--) {
                free(vm->frames[i].registers);
                free(vm->frames[i].arguments);
            }

            vm->frame_count = target_frame_count;
            return;
        }
    }
}

/**
 * Print strings as display text instead of the quoted debug representation.
 */
static void mal_vm_print_display(FILE *stream, MalValue value) {
    if (!mal_value_is_string(value)) {
        // The debug printer writes to stdout; only strings need streams here.
        mal_value_debug(value);
        return;
    }

    MalString *string = mal_value_to_string(value);
    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        c16 code_unit = code_units[i];
        if (code_unit <= 0x7F) {
            fputc((char) code_unit, stream);
        } else {
            fprintf(stream, "\\u%04x", code_unit);
        }
    }
}

static void mal_vm_report_uncaught(MalVm *vm) {
    fprintf(stderr, "Uncaught ");

    if (mal_value_is_object(vm->completion.value)) {
        MalObject *error = mal_value_to_object(vm->completion.value);
        MalPropertyResolution name = mal_object_resolve_property(error, mal_intrinsic_string_key(vm, "name"));
        MalPropertyResolution message = mal_object_resolve_property(error, mal_intrinsic_string_key(vm, "message"));

        if (name.found) {
            mal_vm_print_display(stderr, mal_value_from_string(mal_ops_to_string(&vm->heap, name.desc.value)));
            if (message.found) {
                fprintf(stderr, ": ");
                mal_vm_print_display(stderr, mal_value_from_string(mal_ops_to_string(&vm->heap, message.desc.value)));
            }
            fprintf(stderr, "\n");
            return;
        }
    }

    // ToString keeps the report on a single stream for any thrown value.
    mal_vm_print_display(stderr, mal_value_from_string(mal_ops_to_string(&vm->heap, vm->completion.value)));
    fprintf(stderr, "\n");
}

void mal_vm_run(MalVm *vm, MalCallable *callable) {
    mal_vm_push_function_frame(
        vm,
        (i32) (callable->function - vm->definition->functions),
        nullptr,
        mal_value_new_undefined(),
        nullptr,
        0,
        -1,
        -1
    );
    mal_vm_run_until_frame_count(vm, 0);

    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_vm_report_uncaught(vm);
        return;
    }
}

MalCompletion mal_vm_call_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        // A pending throw poisons further calls, so iterating natives without
        // explicit bail-outs cannot clobber the original error.
        return vm->completion;
    }

    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, args, arg_count, true);
    MalCompletion completion = {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(mal_value_to_native_function_object(resolution.callee));
        MalValue value = callback(vm, resolution.this_value, resolution.args, resolution.arg_count);
        completion = vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    } else if (mal_value_is_function_object(resolution.callee)) {
        i32 target_frame_count = vm->frame_count;
        mal_vm_push_function_frame(
            vm,
            mal_function_object_function_index(mal_value_to_function_object(resolution.callee)),
            mal_value_to_function_object(resolution.callee)->creation_env,
            resolution.this_value,
            resolution.args,
            resolution.arg_count,
            -1,
            -1
        );
        mal_vm_run_until_frame_count(vm, target_frame_count);
        completion = vm->completion;
    }

    free(resolution.owned_args);
    return completion;
}

MalString *mal_vm_callable_name(MalVm *vm, MalValue callee) {
    if (mal_value_is_native_function_object(callee)) {
        return mal_native_function_object_name(mal_value_to_native_function_object(callee));
    }

    if (mal_value_is_bound_function_object(callee)) {
        // TODO(functions): the spec prefixes bound function names with "bound ".
        return mal_vm_callable_name(vm, mal_value_to_bound_function_object(callee)->target);
    }

    if (mal_value_is_function_object(callee)) {
        i32 name_index = vm->definition->functions[
            mal_function_object_function_index(mal_value_to_function_object(callee))
        ].name_string_index;

        if (name_index >= 0 && name_index < vm->definition->string_constant_count) {
            const MalStringConstant *constant = &vm->definition->string_constants[name_index];
            return mal_string_new_external(&vm->heap, constant->code_units, constant->length);
        }

        return mal_string_new_ascii(&vm->heap, "", 0);
    }

    return nullptr;
}

i32 mal_vm_callable_length(MalVm *vm, MalValue callee) {
    if (mal_value_is_bound_function_object(callee)) {
        MalBoundFunctionObject *bound = mal_value_to_bound_function_object(callee);
        i32 target_length = mal_vm_callable_length(vm, bound->target);
        return target_length > bound->bound_count ? target_length - bound->bound_count : 0;
    }

    if (mal_value_is_function_object(callee)) {
        return vm->definition->functions[
            mal_function_object_function_index(mal_value_to_function_object(callee))
        ].length;
    }

    // TODO(functions): native functions don't carry an arity yet.
    return 0;
}
