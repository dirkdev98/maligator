#include "builtin_iterator_helpers.h"

#include <math.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "heap.h"
#include "intrinsics.h"
#include "object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

static MalKey mal_ih_idx(i32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)};
}

/** GetIteratorDirect(this): require an object and cache its `next`. */
static bool mal_ih_get_direct(MalVm *vm, MalValue this_value, MalIteratorRecord *record_out) {
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator method called on non-object");
        return false;
    }
    MalValue next;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "next"), &next)) {
        return false;
    }
    record_out->iterator = this_value;
    record_out->next_method = next;
    return true;
}

static MalIteratorRecord mal_ih_underlying(const MalIteratorHelperObject *self) {
    return (MalIteratorRecord) {.iterator = self->iterator, .next_method = self->next_method};
}

static MalValue mal_ih_finish(MalIteratorHelperObject *self, MalVm *vm) {
    self->done = true;
    return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
}

// --- Per-kind lazy steps (read the helper's struct state) -------------------

static MalValue mal_ih_step_map(MalVm *vm, MalIteratorHelperObject *self) {
    MalIteratorRecord record = mal_ih_underlying(self);
    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
        return mal_value_new_undefined();
    }
    if (done) {
        return mal_ih_finish(self, vm);
    }
    MalValue callback_args[2] = {value, mal_value_from_i32(self->index++)};
    MalCompletion mapped = mal_vm_call_value(vm, self->callback, mal_value_new_undefined(), callback_args, 2);
    if (mapped.kind == MAL_COMPLETION_THROW) {
        self->done = true;
        mal_vm_iterator_close(vm, &record);
        return mal_value_new_undefined();
    }
    return mal_vm_create_iter_result(vm, mapped.value, false);
}

static MalValue mal_ih_step_filter(MalVm *vm, MalIteratorHelperObject *self) {
    MalIteratorRecord record = mal_ih_underlying(self);
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_ih_finish(self, vm);
        }
        MalValue callback_args[2] = {value, mal_value_from_i32(self->index++)};
        MalCompletion kept = mal_vm_call_value(vm, self->callback, mal_value_new_undefined(), callback_args, 2);
        if (kept.kind == MAL_COMPLETION_THROW) {
            self->done = true;
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }
        if (mal_value_is_truthy(kept.value)) {
            return mal_vm_create_iter_result(vm, value, false);
        }
    }
}

static MalValue mal_ih_step_take(MalVm *vm, MalIteratorHelperObject *self) {
    MalIteratorRecord record = mal_ih_underlying(self);
    if (self->counter <= 0.0) {
        mal_vm_iterator_close(vm, &record);
        return mal_ih_finish(self, vm);
    }
    self->counter -= 1.0;
    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
        return mal_value_new_undefined();
    }
    if (done) {
        return mal_ih_finish(self, vm);
    }
    return mal_vm_create_iter_result(vm, value, false);
}

static MalValue mal_ih_step_drop(MalVm *vm, MalIteratorHelperObject *self) {
    MalIteratorRecord record = mal_ih_underlying(self);
    while (self->counter > 0.0) {
        MalValue skipped;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &skipped, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_ih_finish(self, vm);
        }
        self->counter -= 1.0;
    }
    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
        return mal_value_new_undefined();
    }
    if (done) {
        return mal_ih_finish(self, vm);
    }
    return mal_vm_create_iter_result(vm, value, false);
}

static MalValue mal_ih_step_flatmap(MalVm *vm, MalIteratorHelperObject *self) {
    MalIteratorRecord outer = mal_ih_underlying(self);
    while (true) {
        if (!mal_value_is_undefined(self->inner_iterator)) {
            MalIteratorRecord inner = {.iterator = self->inner_iterator, .next_method = self->inner_next};
            MalValue value;
            bool done;
            if (!mal_vm_iterator_step(vm, &inner, &value, &done)) {
                return mal_value_new_undefined();
            }
            if (!done) {
                return mal_vm_create_iter_result(vm, value, false);
            }
            self->inner_iterator = mal_value_new_undefined();
        }

        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &outer, &value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_ih_finish(self, vm);
        }
        MalValue callback_args[2] = {value, mal_value_from_i32(self->index++)};
        MalCompletion mapped = mal_vm_call_value(vm, self->callback, mal_value_new_undefined(), callback_args, 2);
        if (mapped.kind == MAL_COMPLETION_THROW) {
            self->done = true;
            mal_vm_iterator_close(vm, &outer);
            return mal_value_new_undefined();
        }
        MalIteratorRecord inner;
        if (!mal_vm_get_iterator(vm, mapped.value, &inner)) {
            self->done = true;
            mal_vm_iterator_close(vm, &outer);
            return mal_value_new_undefined();
        }
        self->inner_iterator = inner.iterator;
        self->inner_next = inner.next_method;
    }
}

static MalValue mal_ih_step_wrap(MalVm *vm, MalIteratorHelperObject *self) {
    // Iterator.from wrapper: forward the underlying step result directly.
    MalCompletion result = mal_vm_call_value(vm, self->next_method, self->iterator, nullptr, 0);
    return result.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result.value;
}

// --- Shared %IteratorHelperPrototype% next / return -------------------------

static MalValue mal_ih_proto_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    if (!mal_value_is_iterator_helper_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an Iterator Helper");
        return mal_value_new_undefined();
    }
    MalIteratorHelperObject *self = mal_value_to_iterator_helper_object(this_value);
    if (self->done) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    switch (self->kind) {
        case MAL_ITERATOR_HELPER_MAP:
            return mal_ih_step_map(vm, self);
        case MAL_ITERATOR_HELPER_FILTER:
            return mal_ih_step_filter(vm, self);
        case MAL_ITERATOR_HELPER_TAKE:
            return mal_ih_step_take(vm, self);
        case MAL_ITERATOR_HELPER_DROP:
            return mal_ih_step_drop(vm, self);
        case MAL_ITERATOR_HELPER_FLATMAP:
            return mal_ih_step_flatmap(vm, self);
        case MAL_ITERATOR_HELPER_WRAP:
            return mal_ih_step_wrap(vm, self);
    }
    return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
}

static MalValue mal_ih_proto_return(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_iterator_helper_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an Iterator Helper");
        return mal_value_new_undefined();
    }
    MalIteratorHelperObject *self = mal_value_to_iterator_helper_object(this_value);
    self->done = true;

    MalIteratorRecord record = mal_ih_underlying(self);
    mal_vm_iterator_close(vm, &record);
    if (!mal_value_is_undefined(self->inner_iterator)) {
        MalIteratorRecord inner = {.iterator = self->inner_iterator, .next_method = self->inner_next};
        mal_vm_iterator_close(vm, &inner);
    }
    return mal_vm_create_iter_result(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), true);
}

// --- Helper construction -----------------------------------------------------

static MalValue mal_ih_new(MalVm *vm, MalIteratorHelperKind kind, const MalIteratorRecord *record, MalValue callback, f64 counter) {
    MalIteratorHelperObject *helper = mal_heap_alloc(&vm->heap, sizeof(MalIteratorHelperObject), MAL_HEAP_ITERATOR_HELPER_OBJECT);
    mal_object_init(&vm->heap, &helper->object, MAL_HEAP_ITERATOR_HELPER_OBJECT, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_HELPER_PROTOTYPE]));
    helper->kind = kind;
    helper->iterator = record->iterator;
    helper->next_method = record->next_method;
    helper->callback = callback;
    helper->counter = counter;
    helper->done = false;
    helper->index = 0;
    helper->inner_iterator = mal_value_new_undefined();
    helper->inner_next = mal_value_new_undefined();
    return mal_value_from_iterator_helper_object(helper);
}

/** take/drop ToIntegerOrInfinity-with-RangeError, atop a full vm ToNumber. */
static bool mal_ih_limit(MalVm *vm, MalValue value, f64 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false; // TypeError on BigInt/Symbol/bad @@toPrimitive
    }
    if (isnan(number)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Iterator limit must not be NaN");
        return false;
    }
    f64 integer = isinf(number) ? number : trunc(number);
    if (integer < 0.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Iterator limit must be non-negative");
        return false;
    }
    *out = integer;
    return true;
}

static MalValue mal_ih_lazy(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalIteratorHelperKind kind, bool wants_callback) {
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (wants_callback && !mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator helper callback is not a function");
        return mal_value_new_undefined();
    }
    f64 counter = 0.0;
    if (!wants_callback && !mal_ih_limit(vm, callback, &counter)) {
        return mal_value_new_undefined();
    }
    return mal_ih_new(vm, kind, &record, callback, counter);
}

static MalValue mal_ih_method_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_MAP, true);
}
static MalValue mal_ih_method_filter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_FILTER, true);
}
static MalValue mal_ih_method_flatmap(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_FLATMAP, true);
}
static MalValue mal_ih_method_take(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_TAKE, false);
}
static MalValue mal_ih_method_drop(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_DROP, false);
}

// --- Eager helper methods ----------------------------------------------------

static MalValue mal_ih_method_to_array(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
    i32 index = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_value_from_array_object(array);
        }
        mal_array_object_store(array, mal_ih_idx(index++), value);
    }
}

static MalValue mal_ih_method_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.prototype.forEach callback is not a function");
        return mal_value_new_undefined();
    }
    i32 index = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_value_new_undefined();
        }
        MalValue callback_args[2] = {value, mal_value_from_i32(index++)};
        MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), callback_args, 2);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }
    }
}

static MalValue mal_ih_method_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.prototype.reduce callback is not a function");
        return mal_value_new_undefined();
    }

    MalValue accumulator;
    i32 index = 0;
    if (arg_count >= 2) {
        accumulator = args[1];
    } else {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &accumulator, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reduce of empty iterator with no initial value");
            return mal_value_new_undefined();
        }
        index = 1;
    }

    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return accumulator;
        }
        MalValue callback_args[3] = {accumulator, value, mal_value_from_i32(index++)};
        MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), callback_args, 3);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }
        accumulator = result.value;
    }
}

enum { MAL_IH_SOME, MAL_IH_EVERY, MAL_IH_FIND };

static MalValue mal_ih_predicate(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, i32 kind) {
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator helper predicate is not a function");
        return mal_value_new_undefined();
    }
    i32 index = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return kind == MAL_IH_EVERY ? mal_value_new_boolean(true)
                : kind == MAL_IH_SOME  ? mal_value_new_boolean(false)
                                       : mal_value_new_undefined();
        }
        MalValue callback_args[2] = {value, mal_value_from_i32(index++)};
        MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), callback_args, 2);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }
        bool truthy = mal_value_is_truthy(result.value);
        if (kind == MAL_IH_SOME && truthy) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_boolean(true);
        }
        if (kind == MAL_IH_EVERY && !truthy) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_boolean(false);
        }
        if (kind == MAL_IH_FIND && truthy) {
            mal_vm_iterator_close(vm, &record);
            return value;
        }
    }
}

static MalValue mal_ih_method_some(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_predicate(vm, this_value, args, arg_count, MAL_IH_SOME);
}
static MalValue mal_ih_method_every(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_predicate(vm, this_value, args, arg_count, MAL_IH_EVERY);
}
static MalValue mal_ih_method_find(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_predicate(vm, this_value, args, arg_count, MAL_IH_FIND);
}

// --- Iterator constructor + Iterator.from + accessors ------------------------

static MalValue mal_iterator_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) callee;
    if (mal_value_is_undefined(new_target) || new_target == vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR]) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Abstract class Iterator not directly constructable");
        return mal_value_new_undefined();
    }
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]);
    MalValue prototype_value;
    if (mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype_value) &&
        mal_value_is_object(prototype_value)) {
        prototype = mal_value_to_object(prototype_value);
    }
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

/** Whether value's [[Prototype]] chain includes %IteratorPrototype% (≈ instanceof %Iterator%). */
static bool mal_ih_is_iterator_instance(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) {
        return false;
    }
    MalObject *target = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]);
    for (MalObject *proto = mal_value_to_object(value)->prototype; proto != nullptr; proto = proto->prototype) {
        if (proto == target) {
            return true;
        }
    }
    return false;
}

static MalValue mal_iterator_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    MalIteratorRecord record;
    MalValue iterator_method;
    if (!mal_vm_get_property(vm, source, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_method)) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_callable(iterator_method)) {
        if (!mal_vm_get_iterator(vm, source, &record)) {
            return mal_value_new_undefined();
        }
    } else {
        if (!mal_ih_get_direct(vm, source, &record)) {
            return mal_value_new_undefined();
        }
    }

    // Already an Iterator instance (has the helpers): hand it back as-is.
    if (mal_ih_is_iterator_instance(vm, record.iterator)) {
        return record.iterator;
    }
    // Otherwise wrap so the result has %IteratorPrototype% in its chain.
    return mal_ih_new(vm, MAL_ITERATOR_HELPER_WRAP, &record, mal_value_new_undefined(), 0.0);
}

static MalValue mal_iterator_tag_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_value_from_string(mal_intrinsic_ascii(vm, "Iterator"));
}

static MalValue mal_iterator_ctor_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR];
}

/** Shared setter: define an own data property on the receiver (unless it is the prototype itself). */
static MalValue mal_iterator_proto_setter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalKey key) {
    if (mal_value_is_object(this_value) && this_value != vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]) {
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            arg_count >= 1 ? args[0] : mal_value_new_undefined(),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(mal_value_to_object(this_value), key, &desc);
    }
    return mal_value_new_undefined();
}
static MalValue mal_iterator_tag_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_iterator_proto_setter(vm, this_value, args, arg_count, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG));
}
static MalValue mal_iterator_ctor_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_iterator_proto_setter(vm, this_value, args, arg_count, mal_intrinsic_string_key(vm, "constructor"));
}

static void mal_iterator_define_accessor(MalVm *vm, MalObject *object, MalKey key, MalNativeFunctionCallback getter, MalNativeFunctionCallback setter, const byte *get_name, const byte *set_name) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(&vm->heap, function_prototype, mal_intrinsic_ascii(vm, get_name), getter)),
        .setter = mal_value_from_native_function_object(mal_native_function_object_new(&vm->heap, function_prototype, mal_intrinsic_ascii(vm, set_name), setter)),
    };
    mal_object_define_own(object, key, &desc);
}

void mal_builtin_iterator_helpers_install(MalVm *vm) {
    MalObject *iterator_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]);

    mal_intrinsic_define_method_n(vm, iterator_prototype, "map", 1, mal_ih_method_map);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "filter", 1, mal_ih_method_filter);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "take", 1, mal_ih_method_take);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "drop", 1, mal_ih_method_drop);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "flatMap", 1, mal_ih_method_flatmap);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "reduce", 1, mal_ih_method_reduce);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "toArray", 0, mal_ih_method_to_array);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "forEach", 1, mal_ih_method_for_each);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "some", 1, mal_ih_method_some);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "every", 1, mal_ih_method_every);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "find", 1, mal_ih_method_find);

    mal_iterator_define_accessor(vm, iterator_prototype, mal_intrinsic_string_key(vm, "constructor"), mal_iterator_ctor_get, mal_iterator_ctor_set, "get constructor", "set constructor");
    mal_iterator_define_accessor(vm, iterator_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), mal_iterator_tag_get, mal_iterator_tag_set, "get [Symbol.toStringTag]", "set [Symbol.toStringTag]");

    // %IteratorHelperPrototype%: shared next/return, inherits %IteratorPrototype%.
    MalObject *helper_prototype = mal_object_new(&vm->heap, iterator_prototype);
    vm->intrinsics[MAL_INTRINSIC_ITERATOR_HELPER_PROTOTYPE] = mal_value_from_object(helper_prototype);
    mal_intrinsic_define_method_n(vm, helper_prototype, "next", 0, mal_ih_proto_next);
    mal_intrinsic_define_method_n(vm, helper_prototype, "return", 0, mal_ih_proto_return);
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Iterator Helper")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(helper_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Iterator"),
        0,
        mal_iterator_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1, mal_iterator_from);
}
