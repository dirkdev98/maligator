#include "builtin_iterator.h"

#include "builtin_array.h"
#include "heap_string.h"
#include "map_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

MalValue mal_vm_create_iter_result(MalVm *vm, MalValue value, bool done) {
    MalObject *result = mal_intrinsic_new_object(vm);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, result, "value", value, flags);
    mal_intrinsic_define_data(vm, result, "done", mal_value_new_boolean(done), flags);

    return mal_value_from_object(result);
}

static MalIntrinsic mal_vm_iterator_prototype_slot(MalIteratorKind kind) {
    switch (kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES:
        case MAL_ITERATOR_MAP_ENTRIES:
            return MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE;
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            return MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE;
        case MAL_ITERATOR_ARRAY_KEYS:
        case MAL_ITERATOR_ARRAY_VALUES:
        case MAL_ITERATOR_ARRAY_ENTRIES:
            return MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE;
        case MAL_ITERATOR_STRING_VALUES:
            return MAL_INTRINSIC_STRING_ITERATOR_PROTOTYPE;
    }

    return MAL_INTRINSIC_ITERATOR_PROTOTYPE;
}

MalValue mal_vm_new_builtin_iterator(MalVm *vm, MalIteratorKind kind, MalValue target) {
    MalIteratorObject *iterator = mal_iterator_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[mal_vm_iterator_prototype_slot(kind)]),
        kind,
        target
    );

    return mal_value_from_iterator_object(iterator);
}

static MalValue mal_builtin_iterator_pair(MalVm *vm, MalValue first, MalValue second) {
    MalArrayObject *pair = mal_intrinsic_new_array(vm, 2);
    mal_object_set((MalObject *) pair, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, first);
    mal_object_set((MalObject *) pair, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, second);

    return mal_value_from_array_object(pair);
}

static MalValue mal_builtin_iterator_map_next(MalVm *vm, MalIteratorObject *iterator) {
    MalMapObject *map = mal_value_to_map_object(iterator->target);

    MalTableIter table_iter;
    mal_table_iter_init(&table_iter, map->entries, MAL_TABLE_ITER_STORAGE);
    table_iter.index = (usize) iterator->index;

    MalKey key;
    void *entry;
    if (!mal_table_iter_next(&table_iter, &key, &entry)) {
        iterator->done = true;
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    iterator->index = (u64) table_iter.index;

    switch (iterator->kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_SET_VALUES:
            return mal_vm_create_iter_result(vm, key.value, false);
        case MAL_ITERATOR_MAP_VALUES:
            return mal_vm_create_iter_result(vm, mal_table_entry_value(map->entries, entry), false);
        case MAL_ITERATOR_MAP_ENTRIES:
            return mal_vm_create_iter_result(
                vm,
                mal_builtin_iterator_pair(vm, key.value, mal_table_entry_value(map->entries, entry)),
                false
            );
        case MAL_ITERATOR_SET_ENTRIES:
            return mal_vm_create_iter_result(vm, mal_builtin_iterator_pair(vm, key.value, key.value), false);
        default:
            return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
}

static MalValue mal_builtin_iterator_array_next(MalVm *vm, MalIteratorObject *iterator) {
    // Length reads live each step, so growth during iteration is visited.
    MalValue length_value;
    if (!mal_vm_get_property(vm, iterator->target, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return mal_value_new_undefined();
    }

    f64 length = mal_ops_to_number(length_value);
    if (!(length > 0)) {
        length = 0;
    }

    if ((f64) iterator->index >= length) {
        iterator->done = true;
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    u64 index = iterator->index;
    iterator->index++;

    if (iterator->kind == MAL_ITERATOR_ARRAY_KEYS) {
        return mal_vm_create_iter_result(vm, mal_value_from_i32((i32) index), false);
    }

    MalValue element;
    if (!mal_vm_get_property(
        vm,
        iterator->target,
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)},
        &element
    )) {
        return mal_value_new_undefined();
    }

    if (iterator->kind == MAL_ITERATOR_ARRAY_ENTRIES) {
        return mal_vm_create_iter_result(vm, mal_builtin_iterator_pair(vm, mal_value_from_i32((i32) index), element), false);
    }

    return mal_vm_create_iter_result(vm, element, false);
}

static MalValue mal_builtin_iterator_string_next(MalVm *vm, MalIteratorObject *iterator) {
    MalString *string = mal_value_to_string(iterator->target);
    usize length = mal_string_length(string);
    usize index = (usize) iterator->index;

    if (index >= length) {
        iterator->done = true;
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    const c16 *code_units = mal_string_code_units(string);
    usize count = 1;

    // Surrogate pairs advance as one code point.
    if (code_units[index] >= 0xD800 && code_units[index] <= 0xDBFF && index + 1 < length &&
        code_units[index + 1] >= 0xDC00 && code_units[index + 1] <= 0xDFFF) {
        count = 2;
    }

    iterator->index += count;

    // The borrowed code units stay alive with the source string.
    return mal_vm_create_iter_result(
        vm,
        mal_value_from_string(mal_string_new_external(&vm->heap, code_units + index, count)),
        false
    );
}

/**
 * Shared next() implementation. family_first/family_last bound the iterator
 * kinds each prototype's next accepts, so e.g. %MapIteratorPrototype%.next
 * rejects a Set iterator receiver.
 */
static MalValue mal_builtin_iterator_next(
    MalVm *vm,
    MalValue this_value,
    MalIteratorKind family_first,
    MalIteratorKind family_last,
    const byte *family_name
) {
    if (!mal_value_is_iterator_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, family_name);
        return mal_value_new_undefined();
    }

    MalIteratorObject *iterator = mal_value_to_iterator_object(this_value);
    if (iterator->kind < family_first || iterator->kind > family_last) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, family_name);
        return mal_value_new_undefined();
    }

    if (iterator->done) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    switch (iterator->kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES:
        case MAL_ITERATOR_MAP_ENTRIES:
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            return mal_builtin_iterator_map_next(vm, iterator);
        case MAL_ITERATOR_ARRAY_KEYS:
        case MAL_ITERATOR_ARRAY_VALUES:
        case MAL_ITERATOR_ARRAY_ENTRIES:
            return mal_builtin_iterator_array_next(vm, iterator);
        case MAL_ITERATOR_STRING_VALUES:
            return mal_builtin_iterator_string_next(vm, iterator);
    }

    return mal_value_new_undefined();
}

static MalValue mal_builtin_map_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_MAP_KEYS, MAL_ITERATOR_MAP_ENTRIES, "Receiver is not a Map iterator");
}

static MalValue mal_builtin_set_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_SET_VALUES, MAL_ITERATOR_SET_ENTRIES, "Receiver is not a Set iterator");
}

static MalValue mal_builtin_array_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_ARRAY_KEYS, MAL_ITERATOR_ARRAY_ENTRIES, "Receiver is not an Array iterator");
}

static MalValue mal_builtin_string_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_STRING_VALUES, MAL_ITERATOR_STRING_VALUES, "Receiver is not a String iterator");
}

static MalValue mal_builtin_iterator_prototype_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    return this_value;
}

bool mal_vm_get_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out) {
    MalValue method;
    if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        return false;
    }

    if (!mal_value_is_callable(method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not iterable");
        return false;
    }

    MalCompletion completion = mal_vm_call_value(vm, method, value, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator is not an object");
        return false;
    }

    MalValue next_method;
    if (!mal_vm_get_property(vm, completion.value, mal_intrinsic_string_key(vm, "next"), &next_method)) {
        return false;
    }

    record_out->iterator = completion.value;
    record_out->next_method = next_method;

    return true;
}

bool mal_vm_iterator_step(MalVm *vm, const MalIteratorRecord *record, MalValue *value_out, bool *done_out) {
    *value_out = mal_value_new_undefined();
    *done_out = false;

    MalCompletion completion = mal_vm_call_value(vm, record->next_method, record->iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object");
        return false;
    }

    MalValue done;
    if (!mal_vm_get_property(vm, completion.value, mal_intrinsic_string_key(vm, "done"), &done)) {
        return false;
    }

    if (mal_value_is_truthy(done)) {
        *done_out = true;
        return true;
    }

    return mal_vm_get_property(vm, completion.value, mal_intrinsic_string_key(vm, "value"), value_out);
}

void mal_vm_iterator_close(MalVm *vm, const MalIteratorRecord *record) {
    // The pending completion (usually a throw) must survive the return()
    // call, and the sticky-throw guard would refuse calls while it is set.
    MalCompletion pending = vm->completion;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    MalValue return_method;
    if (mal_vm_get_property(vm, record->iterator, mal_intrinsic_string_key(vm, "return"), &return_method) &&
        mal_value_is_callable(return_method)) {
        mal_vm_call_value(vm, return_method, record->iterator, nullptr, 0);
    }

    // Secondary errors from return() are swallowed in favor of the original.
    vm->completion = pending;
}

bool mal_vm_iterator_close_normal(MalVm *vm, const MalIteratorRecord *record) {
    MalValue return_method;
    if (!mal_vm_get_property(vm, record->iterator, mal_intrinsic_string_key(vm, "return"), &return_method)) {
        return false; // a throwing return getter propagates
    }

    // GetMethod: undefined/null means "no return", which is a no-op close.
    if (mal_value_is_nil(return_method)) {
        return true;
    }

    if (!mal_value_is_callable(return_method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator return is not a function");
        return false;
    }

    MalCompletion completion = mal_vm_call_value(vm, return_method, record->iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false; // a throwing return propagates
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator return result is not an object");
        return false;
    }

    return true;
}

static MalObject *mal_builtin_iterator_prototype_new(MalVm *vm, MalIntrinsic slot, MalObject *parent, const byte *tag) {
    MalObject *prototype = mal_object_new(&vm->heap, parent);
    vm->intrinsics[slot] = mal_value_from_object(prototype);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    return prototype;
}

void mal_builtin_iterator_install(MalVm *vm) {
    MalObject *iterator_prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE] = mal_value_from_object(iterator_prototype);
    mal_intrinsic_define_symbol_method(vm, iterator_prototype, MAL_INTRINSIC_SYMBOL_ITERATOR, "[Symbol.iterator]", mal_builtin_iterator_prototype_iterator);

    MalObject *map_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE, iterator_prototype, "Map Iterator");
    mal_intrinsic_define_method_n(vm, map_iterator, "next", 0, mal_builtin_map_iterator_next);

    MalObject *set_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE, iterator_prototype, "Set Iterator");
    mal_intrinsic_define_method_n(vm, set_iterator, "next", 0, mal_builtin_set_iterator_next);

    MalObject *array_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE, iterator_prototype, "Array Iterator");
    mal_intrinsic_define_method_n(vm, array_iterator, "next", 0, mal_builtin_array_iterator_next);

    MalObject *string_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_STRING_ITERATOR_PROTOTYPE, iterator_prototype, "String Iterator");
    mal_intrinsic_define_method_n(vm, string_iterator, "next", 0, mal_builtin_string_iterator_next);
}
