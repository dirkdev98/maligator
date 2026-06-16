#include "vm.h"

#include <stdio.h>
#include <stdlib.h>

#include "async_function.h"
#include "builtin_async_generator.h"
#include "bound_function_object.h"
#include "function_object.h"
#include "generator_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "object_ops.h"
#include "promise_object.h"
#include "proxy_object.h"
#include "value_ops.h"
#include "vm_ops.h"

/**
 * Capacity of the contiguous value stack, in MalValue slots. Recursion deeper
 * than this throws a RangeError, matching engines that cap the call stack. A
 * frame consumes register_count + arg_count slots, so this bounds call depth.
 */
#define MAL_VALUE_STACK_CAPACITY (256 * 1024)

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition) {
    vm->definition = definition;
    vm->globals = malloc(sizeof(MalValue) * definition->global_count);
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;

    vm->value_stack_capacity = MAL_VALUE_STACK_CAPACITY;
    vm->value_stack = malloc(sizeof(MalValue) * (usize) vm->value_stack_capacity);
    vm->value_stack_size = 0;
    vm->native_call_depth = 0;

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    vm->job_head = nullptr;
    vm->job_tail = nullptr;
    vm->unhandled_rejections = nullptr;
    vm->unhandled_count = 0;
    vm->unhandled_capacity = 0;
    vm->entry_async_promise = mal_value_new_undefined();

    mal_heap_init(&vm->heap, 0);
    for (i32 i = 0; i < definition->global_count; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
    for (i32 i = 0; i < MAL_INTRINSIC_COUNT; i++) {
        vm->intrinsics[i] = mal_value_new_undefined();
    }
    vm->symbol_registry = mal_table_new(MAL_TABLE_MODE_GENERAL);
    // Must exist before mal_intrinsics_init, which interns keys through it.
    vm->atoms = mal_table_new(MAL_TABLE_MODE_GENERAL);

    // Baked string constants ship with a zero hash (a static initializer cannot
    // run the hash function); fill them once here so every later use compares
    // and hashes without recomputing. Idempotent across re-inits.
    for (i32 i = 0; i < definition->string_constant_count; i++) {
        MalString *string = &definition->string_constants[i];
        string->hash = mal_string_hash_code_units(mal_string_code_units(string), mal_string_length(string));
    }

    mal_intrinsics_init(vm);

    // CommonJS module registry: one lazily-loaded slot per CJS module.
    if (definition->cjs_module_count > 0) {
        vm->cjs_registry = malloc(sizeof(MalCjsModuleSlot) * (usize) definition->cjs_module_count);
        for (i32 i = 0; i < definition->cjs_module_count; i++) {
            vm->cjs_registry[i] = (MalCjsModuleSlot) {
                .module_object = mal_value_new_undefined(),
                .loaded = false,
            };
        }
    } else {
        vm->cjs_registry = nullptr;
    }
}

MalValue mal_vm_cjs_require(MalVm *vm, i32 id) {
    if (id < 0 || id >= vm->definition->cjs_module_count) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "invalid CommonJS module id");
        return mal_value_new_undefined();
    }

    MalCjsModuleSlot *slot = &vm->cjs_registry[id];
    MalKey exports_key = mal_intrinsic_string_key(vm, (const byte *) "exports");

    // Already loaded (or mid-load, for a circular require): hand back the live
    // module.exports.
    if (slot->loaded) {
        MalValue exports;
        mal_vm_get_property(vm, slot->module_object, exports_key, &exports);
        return exports;
    }

    // module = { exports: {} }. Cache it before running the wrapper so a circular
    // require sees the partial exports object rather than re-entering.
    MalObject *exports_object = mal_intrinsic_new_object(vm);
    MalValue exports_value = mal_value_from_object(exports_object);
    MalObject *module_object = mal_intrinsic_new_object(vm);
    MalValue module_value = mal_value_from_object(module_object);
    mal_object_set(module_object, exports_key, exports_value);
    slot->module_object = module_value;
    slot->loaded = true;

    // Run the wrapper: (module, exports, require, __filename, __dirname), this = exports.
    // __filename/__dirname are undefined for now (TODO: bake the module path).
    MalValue args[5] = {
        module_value,
        exports_value,
        vm->intrinsics[MAL_INTRINSIC_CJS_REQUIRE],
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    i32 function_index = vm->definition->cjs_module_function_indices[id];
    mal_vm_interpret_function(
        vm, function_index, mal_value_new_undefined(), exports_value, args, 5,
        mal_value_new_undefined(), nullptr
    );
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    // module.exports read live: the wrapper may have reassigned `module.exports`.
    MalValue exports;
    mal_vm_get_property(vm, slot->module_object, exports_key, &exports);
    return exports;
}

void mal_vm_free(MalVm *vm) {
    // Only heap-resident (generator/async) leftover frames own their buffers;
    // value-stack frames live in vm->value_stack, freed below.
    for (i32 i = 0; i < vm->frame_count; i++) {
        if (vm->frames[i].stack_base < 0) {
            free(vm->frames[i].registers);
            free(vm->frames[i].arguments);
        }
    }

    free(vm->frames);
    free(vm->value_stack);
    free(vm->globals);
    free(vm->cjs_registry);

    // Free any microtasks left queued (e.g. the program exited with pending
    // jobs). The MalValues they hold live in the heap, freed below.
    MalJob *job = vm->job_head;
    while (job != nullptr) {
        MalJob *next = job->next;
        free(job);
        job = next;
    }
    vm->job_head = nullptr;
    vm->job_tail = nullptr;

    free(vm->unhandled_rejections);
    vm->unhandled_rejections = nullptr;
    vm->unhandled_count = 0;
    vm->unhandled_capacity = 0;

    mal_table_free(vm->symbol_registry);
    mal_table_free(vm->atoms);
    mal_heap_free(&vm->heap);

    vm->definition = nullptr;
    vm->globals = nullptr;
    vm->value_stack = nullptr;
    vm->value_stack_size = 0;
    vm->value_stack_capacity = 0;
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;
}

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index) {
    MalCallable *callable = malloc(sizeof(MalCallable));

    callable->vm = vm;
    callable->function = &vm->definition->functions[function_index];
    // mal_vm_run pushes a fresh activation; this handle only carries the
    // function pointer, so it needs no register/argument storage of its own.
    callable->registers = nullptr;
    callable->env = nullptr;
    callable->arguments = nullptr;
    callable->argument_count = 0;
    callable->stack_base = -1;
    callable->this_value = mal_value_new_undefined();
    callable->arguments_object = mal_value_new_undefined();
    callable->callee = mal_value_new_undefined();
    callable->generator = nullptr;
    callable->is_construct = false;
    callable->instruction_pointer = 0;
    callable->return_register = -1;
    callable->caller_frame_index = -1;
    callable->with_objects = nullptr;
    callable->with_count = 0;
    callable->with_capacity = 0;

    return callable;
}

void mal_vm_free_callable(MalCallable *callable) {
    free(callable->registers);
    free(callable->arguments);
    free(callable->with_objects);
    free(callable);
}

/**
 * Release a frame's register/argument storage. A value-stack frame pops its
 * window by restoring the bump pointer; a heap-resident activation frees its
 * owned buffers. When unwinding several frames, apply this top-down: heap frames
 * carve no value-stack space, so popping the stack frames lands the bump pointer
 * at the correct level regardless of how the two kinds interleave. Generator
 * suspension does NOT use this — it transfers the heap buffers to the generator.
 */
static void mal_vm_pop_frame_storage(MalVm *vm, MalVmFrame *frame) {
    // The with-object stack is heap-allocated independent of the register window,
    // so release it on every teardown (it is null unless the frame entered a with).
    free(frame->with_objects);
    frame->with_objects = nullptr;
    frame->with_count = 0;
    frame->with_capacity = 0;

    if (frame->stack_base >= 0) {
        vm->value_stack_size = frame->stack_base;
    } else {
        free(frame->registers);
        free(frame->arguments);
    }
}

/**
 * The `this` value a callee actually sees. A non-strict (sloppy) function called
 * with `undefined`/`null` this substitutes the global object (OrdinaryCallBindThis
 * step 5). Strict functions, and any object/primitive this, pass through.
 * Primitive-this boxing (ToObject) is not done yet — there are no wrapper objects.
 */
MalValue mal_vm_callee_this(MalVm *vm, const MalFunction *function, MalValue this_value) {
    if (
        !function->strict &&
        (mal_value_is_undefined(this_value) || mal_value_is_null(this_value))
    ) {
        return vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    }
    return this_value;
}

bool mal_vm_push_function_frame(
    MalVm *vm,
    i32 function_index,
    MalEnv *creation_env,
    MalValue this_value,
    i32 arg_count,
    i32 return_register,
    i32 caller_frame_index
) {
    const MalFunction *function = &vm->definition->functions[function_index];
    i32 register_count = function->register_count;
    i32 param_count = function->parameter_count;
    bool wants_args = function->needs_arguments;

    // Calling convention: the caller has placed the arguments in the top
    // arg_count slots of the value stack, so the callee can adopt that region
    // as the base of its register window — parameters need no copy in the
    // common case. base points at the first argument.
    i32 base = vm->value_stack_size - arg_count;
    i32 params_present = param_count < arg_count ? param_count : arg_count;

    // Generators (and async, later) keep their activation on the heap: it
    // outlives the synchronous call stack across suspends. Everything else
    // carves a window from the value stack.
    bool heap_resident = function->kind != MAL_FUNCTION_KIND_NORMAL;

    MalValue *registers;
    MalValue *arguments;
    i32 stack_base;

    if (heap_resident) {
        // Copy parameters (and arguments, if read) out of the marshaling area
        // into owned heap storage, then release the area.
        registers = malloc(sizeof(MalValue) * register_count);
        arguments = (wants_args && arg_count > 0) ? malloc(sizeof(MalValue) * arg_count) : nullptr;
        for (i32 i = 0; i < register_count; i++) {
            registers[i] = mal_value_new_undefined();
        }
        for (i32 i = 0; i < params_present; i++) {
            registers[i] = vm->value_stack[base + i];
        }
        for (i32 i = 0; wants_args && i < arg_count; i++) {
            arguments[i] = vm->value_stack[base + i];
        }
        vm->value_stack_size = base;
        stack_base = -1;
    } else if (wants_args) {
        // Keep the marshaling area as the arguments slice; the register window
        // sits above it with parameters copied down.
        i32 register_base = vm->value_stack_size;
        if (register_base + register_count > vm->value_stack_capacity) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
            return false;
        }
        arguments = &vm->value_stack[base];
        registers = &vm->value_stack[register_base];
        for (i32 i = 0; i < register_count; i++) {
            registers[i] = mal_value_new_undefined();
        }
        for (i32 i = 0; i < params_present; i++) {
            registers[i] = arguments[i];
        }
        vm->value_stack_size = register_base + register_count;
        stack_base = base;
    } else {
        // Common case: the register window IS the marshaling area, so the
        // parameters already hold the arguments. Only the rest of the window
        // (unfilled parameters and locals) needs clearing.
        if (base + register_count > vm->value_stack_capacity) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
            return false;
        }
        registers = &vm->value_stack[base];
        arguments = nullptr;
        for (i32 i = params_present; i < register_count; i++) {
            registers[i] = mal_value_new_undefined();
        }
        vm->value_stack_size = base + register_count;
        stack_base = base;
    }

    // The frame metadata array may reallocate here; registers/arguments point
    // into the (non-reallocating) value stack or the heap, so they stay valid.
    if (vm->frame_count == vm->frame_capacity) {
        vm->frame_capacity = vm->frame_capacity == 0 ? 8 : vm->frame_capacity * 2;
        vm->frames = realloc(vm->frames, sizeof(MalVmFrame) * vm->frame_capacity);
    }

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

    MalVmFrame *frame = &vm->frames[vm->frame_count++];
    frame->vm = vm;
    frame->function = function;
    frame->env = env;
    frame->registers = registers;
    frame->arguments = arguments;
    frame->argument_count = arg_count;
    frame->stack_base = stack_base;
    frame->this_value = mal_vm_callee_this(vm, function, this_value);
    frame->arguments_object = mal_value_new_undefined();
    frame->callee = mal_value_new_undefined();
    frame->generator = nullptr;
    frame->is_construct = false;
    frame->new_target = mal_value_new_undefined();
    frame->instruction_pointer = 0;
    frame->return_register = return_register;
    frame->caller_frame_index = caller_frame_index;
    frame->with_objects = nullptr;
    frame->with_count = 0;
    frame->with_capacity = 0;

    return true;
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
            mal_vm_pop_frame_storage(vm, &vm->frames[i]);
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
            case MAL_OP_CREATE_BIGINT:
                mal_op_create_bigint(frame, &instruction);
                break;
            case MAL_OP_CREATE_OBJECT:
                mal_op_create_object(frame, &instruction);
                break;
            case MAL_OP_CREATE_ARRAY:
                mal_op_create_array(frame, &instruction);
                break;
            case MAL_OP_CREATE_MODULE_NAMESPACE:
                mal_op_create_module_namespace(frame, &instruction);
                break;
            case MAL_OP_CREATE_TEMPLATE_OBJECT:
                mal_op_create_template_object(frame, &instruction);
                break;
            case MAL_OP_WITH_ENTER:
                mal_op_with_enter(frame, &instruction);
                break;
            case MAL_OP_WITH_EXIT:
                mal_op_with_exit(frame, &instruction);
                break;
            case MAL_OP_WITH_GET:
                mal_op_with_get(frame, &instruction);
                break;
            case MAL_OP_WITH_SET:
                mal_op_with_set(frame, &instruction);
                break;
            case MAL_OP_IS_EMPTY:
                mal_op_is_empty(frame, &instruction);
                break;
            case MAL_OP_CREATE_UNDEFINED:
                mal_op_create_undefined(frame, &instruction);
                break;
            case MAL_OP_CREATE_EMPTY:
                mal_op_create_empty(frame, &instruction);
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
            case MAL_OP_LOAD_NEW_TARGET:
                mal_op_load_new_target(frame, &instruction);
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
            case MAL_OP_TO_PROPERTY_KEY:
                mal_op_to_property_key(frame, &instruction);
                break;
            case MAL_OP_CALL_SPREAD:
                mal_op_call_spread(frame, &instruction);
                break;
            case MAL_OP_CONSTRUCT_SPREAD:
                mal_op_construct_spread(frame, &instruction);
                break;
            case MAL_OP_CONSTRUCT_SUPER:
                mal_op_construct_super(frame, &instruction);
                break;
            case MAL_OP_STORE_SUPER_PROPERTY:
                mal_op_store_super_property(frame, &instruction);
                break;
            case MAL_OP_LOAD_PROTOTYPE:
                mal_op_load_prototype(frame, &instruction);
                break;
            case MAL_OP_MERGE_DATA_PROPERTIES:
                mal_op_merge_data_properties(frame, &instruction);
                break;
            case MAL_OP_GET_ITERATOR:
                mal_op_get_iterator(frame, &instruction);
                break;
            case MAL_OP_GET_ASYNC_ITERATOR:
                mal_op_get_async_iterator(frame, &instruction);
                break;
            case MAL_OP_ITERATOR_NEXT:
                mal_op_iterator_next(frame, &instruction);
                break;
            case MAL_OP_ITERATOR_STEP:
                mal_op_iterator_step(frame, &instruction);
                break;
            case MAL_OP_ITERATOR_CLOSE:
                mal_op_iterator_close(frame, &instruction);
                break;
            case MAL_OP_FOR_IN_KEYS:
                mal_op_for_in_keys(frame, &instruction);
                break;

            case MAL_OP_GENERATOR_START: {
                // The parameter prologue has run; capture this activation into a
                // generator object, suspend it, and hand the generator back to
                // the caller like a return. The instance inherits the generator
                // function's own .prototype (which inherits %GeneratorPrototype%
                // or %AsyncGeneratorPrototype%).
                bool start_is_async_generator = frame->function->kind == MAL_FUNCTION_KIND_ASYNC_GENERATOR;
                MalObject *generator_prototype = mal_value_to_object(vm->intrinsics[
                    start_is_async_generator ? MAL_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE : MAL_INTRINSIC_GENERATOR_PROTOTYPE
                ]);
                MalValue prototype_value;
                if (mal_value_is_object(frame->callee) &&
                    mal_vm_get_property(vm, frame->callee, mal_intrinsic_string_key(vm, "prototype"), &prototype_value) &&
                    mal_value_is_object(prototype_value)) {
                    generator_prototype = mal_value_to_object(prototype_value);
                }

                MalGeneratorObject *generator = mal_generator_object_new(&vm->heap, generator_prototype);
                if (start_is_async_generator) {
                    // Async generators await in their body and settle request
                    // promises; mark both so the await and yield ops route right.
                    generator->is_async = true;
                    generator->is_async_generator = true;
                }

                i32 return_register = frame->return_register;
                i32 caller_frame_index = frame->caller_frame_index;

                generator->frame = *frame;
                generator->frame.generator = generator;
                generator->frame.return_register = -1;
                generator->frame.caller_frame_index = -1;
                generator->state = MAL_GENERATOR_SUSPENDED_START;

                // Pop without freeing: the storage now belongs to the generator.
                vm->frame_count--;

                MalValue generator_value = mal_value_from_object((MalObject *) generator);
                if (caller_frame_index >= 0) {
                    vm->frames[caller_frame_index].registers[return_register] = generator_value;
                }
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = generator_value};
                break;
            }

            case MAL_OP_YIELD: {
                // Suspend the generator frame, leaving the yielded value on the
                // generator and recording where the resume value/mode land. The
                // instruction pointer was already advanced past the yield, so a
                // resume continues with the dispatch that follows it.
                MalGeneratorObject *generator = frame->generator;
                generator->yielded_value = frame->registers[instruction.as.yield.yielded_src];
                generator->resume_value_register = instruction.as.yield.value_dst;
                generator->resume_mode_register = instruction.as.yield.mode_dst;
                generator->state = MAL_GENERATOR_SUSPENDED_YIELD;

                generator->frame = *frame;

                // Pop without freeing: the storage belongs to the generator.
                vm->frame_count--;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

                // An async generator's yield settles the front request promise
                // with { value, done: false } and drives the next request (the
                // yielded value was already awaited by the compiler-inserted
                // await preceding this yield).
                if (generator->is_async_generator) {
                    mal_async_generator_yield(vm, generator);
                }
                break;
            }

            case MAL_OP_ASYNC_START: {
                // Set up the async function's result promise + hidden state and
                // hand the promise to the caller, then keep running this frame
                // synchronously until its first await / return / throw.
                mal_async_function_start(vm, frame);
                break;
            }

            case MAL_OP_AWAIT: {
                // Suspend the async frame on the awaited value (mirrors YIELD),
                // then schedule its resumption when the value settles. The
                // instruction pointer already points past the await, so a resume
                // continues with the compiler-emitted resume dispatch.
                MalGeneratorObject *state = frame->generator;
                MalValue awaited = frame->registers[instruction.as.await.awaited_src];
                state->resume_value_register = instruction.as.await.value_dst;
                state->resume_mode_register = instruction.as.await.mode_dst;
                state->state = MAL_GENERATOR_SUSPENDED_YIELD;

                state->frame = *frame;

                vm->frame_count--;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
                mal_async_function_await(vm, state, awaited);
                break;
            }
            case MAL_OP_DELETE_PROPERTY:
                mal_op_delete_property(frame, &instruction);
                break;
            case MAL_OP_DEFINE_ACCESSOR:
                mal_op_define_accessor(frame, &instruction);
                break;
            case MAL_OP_DEFINE_PROPERTY:
                mal_op_define_property(frame, &instruction);
                break;
            case MAL_OP_CREATE_PRIVATE_NAME:
                mal_op_create_private_name(frame, &instruction);
                break;
            case MAL_OP_DEFINE_PRIVATE:
                mal_op_define_private(frame, &instruction);
                break;
            case MAL_OP_LOAD_PRIVATE:
                mal_op_load_private(frame, &instruction);
                break;
            case MAL_OP_STORE_PRIVATE:
                mal_op_store_private(frame, &instruction);
                break;
            case MAL_OP_HAS_PRIVATE:
                mal_op_has_private(frame, &instruction);
                break;
            case MAL_OP_SET_PROTOTYPE:
                mal_op_set_prototype(frame, &instruction);
                break;
            case MAL_OP_LOAD_UNDECLARED:
                mal_op_load_undeclared(frame, &instruction);
                break;
            case MAL_OP_LOAD_GLOBAL_PROPERTY:
                mal_op_load_global_property(frame, &instruction);
                break;
            case MAL_OP_STORE_GLOBAL_PROPERTY:
                mal_op_store_global_property(frame, &instruction);
                break;
            case MAL_OP_THROW_IF_TDZ:
                mal_op_throw_if_tdz(frame, &instruction);
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

                // A generator/async body returning completes the activation. Its
                // storage is freed here; for a plain generator the value travels
                // to the resume caller via the NORMAL completion below (the frame
                // was reattached with no caller register).
                MalGeneratorObject *coroutine = frame->generator;
                if (coroutine != nullptr) {
                    coroutine->state = MAL_GENERATOR_COMPLETED;
                }

                i32 return_register = frame->return_register;
                i32 caller_frame_index = frame->caller_frame_index;

                mal_vm_pop_frame_storage(vm, frame);
                vm->frame_count--;

                if (coroutine != nullptr && coroutine->is_async_generator) {
                    // An async generator's return completes it and settles the
                    // front request with { value, done: true }.
                    mal_async_generator_return(vm, coroutine, return_value);
                } else if (coroutine != nullptr && coroutine->is_async) {
                    // Resolving the result promise is the async function's return.
                    mal_async_function_settle_return(vm, coroutine, return_value);
                } else if (caller_frame_index >= 0) {
                    vm->frames[caller_frame_index].registers[return_register] = return_value;
                    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = return_value};
                } else {
                    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = return_value};
                }
                break;
            }
        }

        if (vm->completion.kind == MAL_COMPLETION_THROW && !mal_vm_unwind_to_handler(vm, target_frame_count)) {
            // An async function frame catches an otherwise-uncaught throw as a
            // rejection of its result promise, stopping propagation there (its
            // synchronous callees above it are unwound first). This is the async
            // body's implicit try/catch.
            i32 async_index = -1;
            for (i32 i = vm->frame_count - 1; i >= target_frame_count; i--) {
                if (vm->frames[i].generator != nullptr && vm->frames[i].generator->is_async) {
                    async_index = i;
                    break;
                }
            }

            if (async_index >= 0) {
                MalValue reason = vm->completion.value;
                MalGeneratorObject *state = vm->frames[async_index].generator;
                for (i32 i = vm->frame_count - 1; i >= async_index; i--) {
                    mal_vm_pop_frame_storage(vm, &vm->frames[i]);
                }
                vm->frame_count = async_index;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
                if (state->is_async_generator) {
                    // An uncaught throw completes the async generator and rejects
                    // the front request.
                    mal_async_generator_throw_done(vm, state, reason);
                } else {
                    state->state = MAL_GENERATOR_COMPLETED;
                    mal_async_function_settle_throw(vm, state, reason);
                }
                continue;
            }

            // No handler within this run loop; eagerly pop the frames it owns
            // and let the throw completion propagate to the caller.
            for (i32 i = vm->frame_count - 1; i >= target_frame_count; i--) {
                mal_vm_pop_frame_storage(vm, &vm->frames[i]);
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

/**
 * Print a thrown/rejected value to stderr after `prefix`, preferring the
 * value's own toString (so Error objects render "Name: message").
 */
static void mal_vm_print_thrown(MalVm *vm, MalValue value, const byte *prefix) {
    fprintf(stderr, "%s", prefix);

    if (mal_value_is_object(value)) {
        // Invoke the thrown value's own toString (Error.prototype.toString
        // yields "Name: message"; the test262 harness's Test262Error has a
        // custom toString but no `name` property, so the previous name/message
        // path fell back to the useless "[object Object]"). The mal_ops string
        // coercion can't run a method, so call it directly. Clear the pending
        // throw first or the sticky-throw guard poisons the call; restore after.
        MalCompletion saved = vm->completion;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

        MalValue to_string;
        if (mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, "toString"), &to_string) &&
            mal_value_is_callable(to_string)) {
            MalCompletion result = mal_vm_call_value(vm, to_string, value, nullptr, 0);
            if (result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value)) {
                vm->completion = saved;
                mal_vm_print_display(stderr, result.value);
                fprintf(stderr, "\n");
                return;
            }
        }
        vm->completion = saved;
    }

    // ToString keeps the report on a single stream for any thrown value.
    mal_vm_print_display(stderr, mal_value_from_string(mal_ops_to_string(&vm->heap, value)));
    fprintf(stderr, "\n");
}

static void mal_vm_report_uncaught(MalVm *vm) {
    mal_vm_print_thrown(vm, vm->completion.value, "Uncaught ");
}

void mal_vm_note_unhandled_rejection(MalVm *vm, MalValue promise) {
    if (vm->unhandled_count == vm->unhandled_capacity) {
        vm->unhandled_capacity = vm->unhandled_capacity == 0 ? 8 : vm->unhandled_capacity * 2;
        vm->unhandled_rejections = realloc(vm->unhandled_rejections, sizeof(MalValue) * (usize) vm->unhandled_capacity);
    }
    vm->unhandled_rejections[vm->unhandled_count++] = promise;
}

void mal_vm_report_unhandled_rejections(MalVm *vm) {
    for (i32 i = 0; i < vm->unhandled_count; i++) {
        MalValue promise_value = vm->unhandled_rejections[i];
        if (!mal_value_is_promise_object(promise_value)) {
            continue;
        }
        MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
        // A handler attached between rejection and the checkpoint clears it.
        if (promise->state == MAL_PROMISE_REJECTED && !promise->is_handled) {
            mal_vm_print_thrown(vm, promise->result, "Uncaught (in promise) ");
        }
    }
    vm->unhandled_count = 0;
}

void mal_vm_run(MalVm *vm, MalCallable *callable) {
    // The entry function takes no arguments, so the marshaling region is empty.
    mal_vm_push_function_frame(
        vm,
        (i32) (callable->function - vm->definition->functions),
        nullptr,
        mal_value_new_undefined(),
        0,
        -1,
        -1
    );
    mal_vm_run_until_frame_count(vm, 0);

    // The top-level script has run to completion; capture its result, then run
    // the microtask queue to empty (promise reactions, await resumptions). The
    // drain happens at a baseline frame count so reaction handlers re-enter the
    // interpreter without nesting on a partial activation.
    MalCompletion script_completion = vm->completion;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    mal_vm_drain_microtasks(vm);

    if (script_completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = script_completion;
        mal_vm_report_uncaught(vm);
        return;
    }

    // An async entry (a top-level-await module) records its result promise at
    // ASYNC_START. If that promise rejected, the module failed to evaluate;
    // surface it as a throw so the process exits non-zero (the checkpoint
    // already printed it). Stray unhandled rejections from *other* promises do
    // not fail the run.
    if (mal_value_is_promise_object(vm->entry_async_promise)) {
        MalPromiseObject *result = mal_value_to_promise_object(vm->entry_async_promise);
        if (result->state == MAL_PROMISE_REJECTED) {
            vm->completion =
                (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = result->result};
        }
    }
}

void mal_vm_resume_generator(MalVm *vm, MalGeneratorObject *generator, MalValue sent_value, i32 resume_mode) {
    if (vm->frame_count == vm->frame_capacity) {
        vm->frame_capacity = vm->frame_capacity == 0 ? 8 : vm->frame_capacity * 2;
        vm->frames = realloc(vm->frames, sizeof(MalVmFrame) * vm->frame_capacity);
    }

    i32 target_frame_count = vm->frame_count;
    MalVmFrame *frame = &vm->frames[vm->frame_count++];
    *frame = generator->frame;
    frame->vm = vm;
    frame->generator = generator;
    frame->return_register = -1;
    frame->caller_frame_index = -1;

    // Deliver the sent value and resume mode to the suspended yield expression,
    // which the compiler-emitted dispatch following the yield consults. (A
    // suspended-start resume has no recorded registers and ignores both.)
    if (generator->resume_value_register >= 0) {
        frame->registers[generator->resume_value_register] = sent_value;
    }
    if (generator->resume_mode_register >= 0) {
        frame->registers[generator->resume_mode_register] = mal_value_from_i32(resume_mode);
    }

    generator->state = MAL_GENERATOR_EXECUTING;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    mal_vm_run_until_frame_count(vm, target_frame_count);

    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        // The body threw past its own handlers; the run loop already popped and
        // freed the frame, so the generator is finished.
        generator->state = MAL_GENERATOR_COMPLETED;
    }
}

bool mal_vm_enter_compiled(MalVm *vm) {
    if (vm->native_call_depth >= MAL_NATIVE_CALL_DEPTH_LIMIT) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return false;
    }
    vm->native_call_depth++;
    return true;
}

void mal_vm_leave_compiled(MalVm *vm) {
    vm->native_call_depth--;
}

MalValue mal_vm_interpret_function(
    MalVm *vm,
    i32 function_index,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalEnv *env
) {
    if (vm->value_stack_size + arg_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return mal_value_new_undefined();
    }

    // Marshal the arguments onto the top of the value stack: push adopts that
    // region as the callee's incoming window. `args` may alias the caller's
    // window lower on the stack (the in-VM call dispatch passes it from there),
    // but never the region being written, so this copy is safe.
    i32 base = vm->value_stack_size;
    for (i32 i = 0; i < arg_count; i++) {
        vm->value_stack[base + i] = args[i];
    }
    vm->value_stack_size = base + arg_count;

    // An async function's result is the promise its ASYNC_START prologue builds,
    // not its body completion. With no caller frame to receive it (this is a
    // native -> JS call), the prologue stashes that promise in entry_async_promise
    // (the same slot a top-level-await entry uses). Capture and restore it so the
    // promise — not the body's undefined — is returned, and the real entry promise
    // is preserved across the call.
    const MalFunction *function = &vm->definition->functions[function_index];
    bool returns_promise = function->kind == MAL_FUNCTION_KIND_ASYNC;
    MalValue saved_entry_async_promise = vm->entry_async_promise;

    i32 target_frame_count = vm->frame_count;
    if (mal_vm_push_function_frame(vm, function_index, env, this_value, arg_count, -1, -1)) {
        MalVmFrame *frame = &vm->frames[vm->frame_count - 1];
        frame->callee = callee;
        // A construct bail allocates `this` and passes new_target through; the
        // RETURN handler then substitutes `this` for a non-object result.
        if (mal_value_is_object(new_target)) {
            frame->is_construct = true;
            frame->new_target = new_target;
        }
        mal_vm_run_until_frame_count(vm, target_frame_count);
    } else {
        vm->value_stack_size = base;
    }

    if (returns_promise) {
        MalValue result_promise = vm->entry_async_promise;
        vm->entry_async_promise = saved_entry_async_promise;
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            // Callers read the result through vm->completion (mal_vm_call_value's
            // interpreted branch ignores this function's return value), so the
            // promise must land there too — the async body left it undefined.
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = result_promise};
            return result_promise;
        }
    }
    return vm->completion.value;
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

    // A callable proxy routes [[Call]] through its apply trap.
    if (mal_value_is_proxy_object(callee)) {
        return mal_proxy_apply(vm, mal_value_to_proxy_object(callee), this_value, args, arg_count);
    }

    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, args, arg_count, true);
    MalCompletion completion = {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(mal_value_to_native_function_object(resolution.callee));
        MalValue value = callback(vm, resolution.this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), resolution.callee);
        completion = vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    } else if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        const MalFunction *function = &vm->definition->functions[function_index];
        MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

        if (function->compiled != nullptr) {
            // Native-backend function: invoke directly (no stack marshaling). The
            // C stack, not the value stack, bounds this recursion.
            if (!mal_vm_enter_compiled(vm)) {
                completion = vm->completion;
            } else {
                MalValue this_value = mal_vm_callee_this(vm, function, resolution.this_value);
                MalValue value = function->compiled(vm, this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), env);
                mal_vm_leave_compiled(vm);
                completion = vm->completion.kind == MAL_COMPLETION_THROW
                    ? vm->completion
                    : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
            }
        } else {
            // Interpreted function: marshal args, push a bytecode frame, run.
            mal_vm_interpret_function(
                vm,
                function_index,
                resolution.callee,
                resolution.this_value,
                resolution.args,
                resolution.arg_count,
                mal_value_new_undefined(),
                env
            );
            completion = vm->completion;
        }
    } else {
        // A non-callable callee is a TypeError. Internal callers pre-check
        // IsCallable, but the native backend dispatches user calls straight
        // through here, so the throw must live in this shared entry point too
        // (mirroring mal_vm_call_dispatch).
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a function");
        completion = vm->completion;
    }

    free(resolution.owned_args);
    return completion;
}

MalCompletion mal_vm_construct_value(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count) {
    return mal_vm_construct_value_with_target(vm, callee, args, arg_count, callee);
}

MalCompletion mal_vm_construct_value_with_target(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }

    // A constructable proxy routes [[Construct]] through its construct trap.
    if (mal_value_is_proxy_object(callee)) {
        return mal_proxy_construct(vm, mal_value_to_proxy_object(callee), args, arg_count, new_target);
    }

    // [[Construct]] ignores the bound this.
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, mal_value_new_undefined(), args, arg_count, false);
    MalCompletion completion = {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // BoundFunctionCreate [[Construct]]: a new.target that is the bound function
    // itself becomes the (unwrapped) target. This also yields new.target = the
    // resolved constructor for the default `new callee()` case.
    MalValue effective_new_target = new_target == callee ? resolution.callee : new_target;

    if (mal_value_is_native_function_object(resolution.callee)) {
        // A native that does not implement [[Construct]] is not new-able.
        if (!mal_native_function_object_is_constructor(mal_value_to_native_function_object(resolution.callee))) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            free(resolution.owned_args);
            return vm->completion;
        }
        // Native constructors allocate their own this; new_target signals construct.
        MalNativeFunctionCallback callback = mal_native_function_object_callback(mal_value_to_native_function_object(resolution.callee));
        MalValue value = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count, effective_new_target, resolution.callee);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(resolution.owned_args);
            return vm->completion;
        }

        // OrdinaryCreateFromConstructor: when subclassing a native (new.target is
        // a derived class, not the native itself), the instance's [[Prototype]]
        // is new.target.prototype. Native constructors build with their own
        // prototype, so reparent here for `class X extends <native>`.
        if (mal_value_is_object(value) && effective_new_target != resolution.callee &&
            mal_value_is_object(effective_new_target)) {
            MalValue derived_prototype;
            if (!mal_vm_get_property(vm, effective_new_target, mal_intrinsic_string_key(vm, "prototype"), &derived_prototype)) {
                free(resolution.owned_args);
                return vm->completion;
            }
            if (mal_value_is_object(derived_prototype)) {
                mal_object_set_prototype(mal_value_to_object(value), mal_value_to_object(derived_prototype));
            }
        }
        completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    } else if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        const MalFunction *function = &vm->definition->functions[function_index];
        if (function->kind != MAL_FUNCTION_KIND_NORMAL) {
            // Generators and other non-normal kinds are not constructors.
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            completion = vm->completion;
        } else {
            MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

            // OrdinaryCreateFromConstructor: allocate `this` from new.target's
            // `.prototype` (falling back to %Object.prototype% when absent).
            MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
            if (mal_value_is_object(effective_new_target)) {
                MalValue prototype_value;
                if (!mal_vm_get_property(vm, effective_new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype_value)) {
                    free(resolution.owned_args);
                    return vm->completion;
                }
                if (mal_value_is_object(prototype_value)) {
                    prototype = mal_value_to_object(prototype_value);
                }
            }
            MalValue this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));

            if (function->compiled != nullptr) {
                // Native-backend constructor: the compiled body applies the
                // non-object→this substitution at its RETURN, so use the result.
                if (!mal_vm_enter_compiled(vm)) {
                    completion = vm->completion;
                } else {
                    MalValue value = function->compiled(vm, this_value, resolution.args, resolution.arg_count, effective_new_target, env);
                    mal_vm_leave_compiled(vm);
                    completion = vm->completion.kind == MAL_COMPLETION_THROW
                        ? vm->completion
                        : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
                }
            } else if (vm->value_stack_size + resolution.arg_count > vm->value_stack_capacity) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
                completion = vm->completion;
            } else {
                // Interpreted: marshal args, push a construct frame, run. The
                // RETURN handler performs the non-object→this substitution.
                i32 base = vm->value_stack_size;
                for (i32 i = 0; i < resolution.arg_count; i++) {
                    vm->value_stack[base + i] = resolution.args[i];
                }
                vm->value_stack_size = base + resolution.arg_count;

                i32 target_frame_count = vm->frame_count;
                if (mal_vm_push_function_frame(vm, function_index, env, this_value, resolution.arg_count, -1, -1)) {
                    vm->frames[vm->frame_count - 1].is_construct = true;
                    vm->frames[vm->frame_count - 1].new_target = effective_new_target;
                    mal_vm_run_until_frame_count(vm, target_frame_count);
                } else {
                    vm->value_stack_size = base;
                }
                completion = vm->completion;
            }
        }
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
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
            // The baked constant is already an immortal MalString; hand it back.
            return &vm->definition->string_constants[name_index];
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
