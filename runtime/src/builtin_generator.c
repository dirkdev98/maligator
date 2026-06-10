#include "./builtin_generator.h"

#include "builtin_iterator.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "object.h"
#include "value.h"
#include "vm.h"

static MalGeneratorObject *mal_generator_this(MalVm *vm, MalValue this_value, const byte *message) {
    if (!mal_value_is_generator_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }

    return (MalGeneratorObject *) mal_value_to_object(this_value);
}

/**
 * Resume a suspended-yield generator and package the outcome as an iterator
 * result (or leave a pending throw for the body's escaping exception).
 */
static MalValue mal_generator_resume_result(MalVm *vm, MalGeneratorObject *generator, MalValue value, i32 mode) {
    mal_vm_resume_generator(vm, generator, value, mode);

    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    if (generator->state == MAL_GENERATOR_SUSPENDED_YIELD) {
        return mal_vm_create_iter_result(vm, generator->yielded_value, false);
    }

    // Completed via return: the return value is the final result value.
    return mal_vm_create_iter_result(vm, vm->completion.value, true);
}

static MalValue mal_builtin_generator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;

    MalGeneratorObject *generator = mal_generator_this(vm, this_value, "Generator.prototype.next called on incompatible receiver");
    if (generator == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue sent = arg_count > 0 ? args[0] : mal_value_new_undefined();

    if (generator->state == MAL_GENERATOR_EXECUTING) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Generator is already running");
        return mal_value_new_undefined();
    }

    if (generator->state == MAL_GENERATOR_COMPLETED) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    // suspended-start discards the sent value (recorded registers are unset).
    return mal_generator_resume_result(vm, generator, sent, MAL_GENERATOR_RESUME_NEXT);
}

static MalValue mal_builtin_generator_throw(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;

    MalGeneratorObject *generator = mal_generator_this(vm, this_value, "Generator.prototype.throw called on incompatible receiver");
    if (generator == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue exception = arg_count > 0 ? args[0] : mal_value_new_undefined();

    if (generator->state == MAL_GENERATOR_EXECUTING) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Generator is already running");
        return mal_value_new_undefined();
    }

    // Throwing into a not-yet-started or finished generator throws the value
    // back at the caller without running any body code.
    if (generator->state == MAL_GENERATOR_SUSPENDED_START) {
        generator->state = MAL_GENERATOR_COMPLETED;
    }
    if (generator->state == MAL_GENERATOR_COMPLETED) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = exception};
        return mal_value_new_undefined();
    }

    return mal_generator_resume_result(vm, generator, exception, MAL_GENERATOR_RESUME_THROW);
}

static MalValue mal_builtin_generator_return(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;

    MalGeneratorObject *generator = mal_generator_this(vm, this_value, "Generator.prototype.return called on incompatible receiver");
    if (generator == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue value = arg_count > 0 ? args[0] : mal_value_new_undefined();

    if (generator->state == MAL_GENERATOR_EXECUTING) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Generator is already running");
        return mal_value_new_undefined();
    }

    // Returning into a not-yet-started or finished generator completes it with
    // the given value, running no body code (no finalizers to honor).
    if (generator->state == MAL_GENERATOR_SUSPENDED_START) {
        generator->state = MAL_GENERATOR_COMPLETED;
    }
    if (generator->state == MAL_GENERATOR_COMPLETED) {
        return mal_vm_create_iter_result(vm, value, true);
    }

    // Resume so any enclosing finally blocks run before completing.
    return mal_generator_resume_result(vm, generator, value, MAL_GENERATOR_RESUME_RETURN);
}

/**
 * The GeneratorFunction constructor would dynamically compile source, which is
 * unsupported; it exists for the intrinsic hierarchy but throws when invoked.
 */
static MalValue mal_builtin_generator_function_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "GeneratorFunction does not support dynamic compilation");
    return mal_value_new_undefined();
}

static void mal_generator_define_string_tag(MalVm *vm, MalObject *object, const byte *tag) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &desc);
}

void mal_builtin_generator_install(MalVm *vm) {
    // %GeneratorPrototype%: the instance prototype, inheriting %IteratorPrototype%.
    MalObject *prototype = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE])
    );
    vm->intrinsics[MAL_INTRINSIC_GENERATOR_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_method_n(vm, prototype, "next", 1, mal_builtin_generator_next);
    mal_intrinsic_define_method_n(vm, prototype, "throw", 1, mal_builtin_generator_throw);
    mal_intrinsic_define_method_n(vm, prototype, "return", 1, mal_builtin_generator_return);
    mal_generator_define_string_tag(vm, prototype, "Generator");

    // %Generator% (%GeneratorFunction.prototype%): the [[Prototype]] of generator
    // function objects, inheriting %Function.prototype%.
    MalObject *generator = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE])
    );
    vm->intrinsics[MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE] = mal_value_from_object(generator);
    mal_generator_define_string_tag(vm, generator, "GeneratorFunction");
    mal_intrinsic_define_data(vm, generator, "prototype", mal_value_from_object(prototype), MAL_PROPERTY_CONFIGURABLE);
    // %GeneratorPrototype%.constructor === %Generator%.
    mal_intrinsic_define_data(vm, prototype, "constructor", mal_value_from_object(generator), MAL_PROPERTY_CONFIGURABLE);

    // GeneratorFunction constructor: inherits %Function%, throws when invoked.
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR]),
        mal_intrinsic_ascii(vm, "GeneratorFunction"),
        mal_builtin_generator_function_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_GENERATOR_FUNCTION_CONSTRUCTOR] = mal_value_from_object((MalObject *) constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", mal_value_from_object(generator), MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, generator, "constructor", mal_value_from_object((MalObject *) constructor), MAL_PROPERTY_CONFIGURABLE);
}
