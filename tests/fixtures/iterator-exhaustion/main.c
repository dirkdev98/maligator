#include <stdio.h>
#include "builtin_iterator.h"
#include "builtin_weak_ref.h"
#include "gc.h"
#include "intrinsics.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;
#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "line %d: %s\n", __LINE__, #condition); return 1; } } while (0)

static int check_cursor(MalVm *vm, MalIteratorKind kind, bool direct) {
    bool is_set = kind == MAL_ITERATOR_SET_VALUES || kind == MAL_ITERATOR_SET_ENTRIES;
    MalValue roots[4] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalObject *collection = is_set ? &mal_set_object_new(&vm->heap, nullptr)->object
        : &mal_map_object_new(&vm->heap, nullptr)->object;
    roots[0] = mal_value_from_object(collection);
    for (int i = 0; i < 1000; i++) {
        MalValue key = mal_value_from_i32(i);
        if (is_set) mal_set_object_add((MalSetObject *) collection, key);
        else mal_map_object_set((MalMapObject *) collection, key, key);
    }
    MalWeakRefObject *weak = mal_heap_alloc(&vm->heap, sizeof(*weak), MAL_HEAP_WEAK_REF_OBJECT);
    mal_object_init(&vm->heap, &weak->object, MAL_HEAP_WEAK_REF_OBJECT, nullptr);
    weak->target = roots[0];
    roots[1] = mal_value_from_weak_ref_object(weak);
    MalObject *prototype = mal_value_to_object(vm->intrinsics[is_set
        ? MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE : MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE]);
    MalIteratorObject *cursor = mal_iterator_object_new(&vm->heap, prototype, kind, roots[0]);
    roots[2] = mal_value_from_object(&cursor->object);
    CHECK(mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, "next"), &roots[3]));
    MalIteratorRecord record = {.iterator = roots[2], .next_method = roots[3]};
    roots[0] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(!mal_value_is_undefined(weak->target));
    bool done = false;
    int steps = 0;
    while (!done) {
        if (direct) {
            MalValue value;
            CHECK(mal_vm_iterator_step_protocol_cursor(vm, cursor, &record, &value, &done));
        } else {
            MalCompletion result = mal_vm_call_value(vm, roots[3], roots[2], nullptr, 0);
            CHECK(result.kind == MAL_COMPLETION_NORMAL);
            MalValue complete;
            CHECK(mal_vm_get_property(vm, result.value, mal_intrinsic_string_key(vm, "done"), &complete));
            done = mal_value_is_truthy(complete);
        }
        CHECK(++steps <= 1001);
    }
    CHECK(steps == 1001);
    MalValue added = mal_value_from_i32(1001);
    if (is_set) mal_set_object_add((MalSetObject *) collection, added);
    else mal_map_object_set((MalMapObject *) collection, added, added);
    mal_gc_collect(vm);
    CHECK(mal_value_is_undefined(weak->target));
    for (int i = 0; i < 3; i++) {
        MalValue value;
        CHECK(mal_vm_iterator_step(vm, &record, &value, &done));
        CHECK(done && mal_value_is_undefined(value));
    }
    mal_gc_unroot(&span);
    mal_gc_collect(vm);
    return 0;
}

int main(void) {
    mal_gc_test_precise_stack_roots = true;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    for (int kind = MAL_ITERATOR_MAP_KEYS; kind <= MAL_ITERATOR_SET_ENTRIES; kind++)
        for (int direct = 0; direct < 2; direct++)
            CHECK(check_cursor(&vm, (MalIteratorKind) kind, direct) == 0);
    mal_vm_free(&vm);
    puts("iterator-exhaustion PASS");
    return 0;
}
