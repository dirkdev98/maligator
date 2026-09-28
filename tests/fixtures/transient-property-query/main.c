#include <stdio.h>
#include <string.h>

#include "ascii.h"
#include "builtin_map.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "map_object.h"
#include "table.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: %s\n", __func__, __LINE__, #condition); \
        return false; \
    } \
} while (0)

static usize live_strings;

static void count_strings(MalHeapHeader *cell) {
    if (!(cell->mark & MAL_MARK_FREE) && cell->type == MAL_HEAP_STRING) live_strings++;
}

static usize quiescent_strings(MalVm *vm) {
    mal_gc_collect(vm);
    mal_gc_collect(vm);
    live_strings = 0;
    mal_heap_walk_cells(&vm->heap, count_strings);
    return live_strings;
}

static bool stringify_query(MalVm *vm, MalValue target, MalValue list, MalValue stringify, MalValue query) {
    CHECK(mal_array_object_store(mal_value_to_array_object(list), mal_key_index(0), query));
    MalValue args[] = {target, list};
    MalCompletion result = mal_vm_call_value(
        vm, stringify, vm->intrinsics[MAL_INTRINSIC_JSON], args, countof(args));
    CHECK(result.kind == MAL_COMPLETION_NORMAL);
    CHECK(mal_value_is_string(result.value));
    CHECK(mal_string_equals_ascii(mal_value_to_string(result.value), "{}"));
    return true;
}

static bool missing_queries_release_storage(MalVm *vm) {
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    roots[2] = mal_value_from_array_object(mal_array_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])));
    CHECK(mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_JSON],
        mal_intrinsic_string_key(vm, "stringify"), &roots[3]));
    // Warm the fixed output's bounded tiny-string cache before measuring.
    CHECK(stringify_query(vm, roots[0], roots[2], roots[3],
        mal_value_from_string(mal_intrinsic_ascii(vm, "length"))));
    MalInlineCache ic = {0};
    usize strings_before = quiescent_strings(vm);
    usize atoms_before = mal_table_size(vm->atoms);
    usize raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    char name[96];
    for (usize i = 0; i < 2048; i++) {
        int length = snprintf(name, sizeof(name), "transient-property-missing-name-%zu", i);
        MalString *query = mal_string_new_ascii(&vm->heap, name, (usize) length);
        roots[1] = mal_value_from_string(query);
        CHECK(mal_vm_op_load_property(vm, roots[0], roots[1]) == MAL_VALUE_UNDEFINED);
        CHECK(mal_vm_op_load_property_ic(vm, roots[0], roots[1], &ic) == MAL_VALUE_UNDEFINED);
        CHECK(mal_vm_binary_op(vm, MAL_BIN_IN, roots[1], roots[0]) == MAL_VALUE_FALSE);
        CHECK(mal_vm_op_delete_property(vm, roots[0], roots[1], false) == MAL_VALUE_TRUE);
        CHECK(stringify_query(vm, roots[0], roots[2], roots[3], roots[1]));
        CHECK(!query->property_atom);
        // Computed destructuring prepares a key before the load and rest copy.
        roots[1] = mal_vm_op_to_property_key(
            vm, roots[0], mal_value_from_i32(-1000000000 - (i32) i));
        CHECK(mal_value_is_string(roots[1]));
        CHECK(!mal_value_to_string(roots[1])->property_atom);
        CHECK(mal_vm_op_load_property(vm, roots[0], roots[1]) == MAL_VALUE_UNDEFINED);
        CHECK(mal_value_is_object(mal_vm_op_copy_data_properties(vm, roots[0], &roots[1], 1)));
        CHECK(!mal_value_to_string(roots[1])->property_atom);
    }
    roots[1] = MAL_VALUE_UNDEFINED;
    CHECK(mal_array_object_store(mal_value_to_array_object(roots[2]), mal_key_index(0), MAL_VALUE_UNDEFINED));
    usize strings_after_flat = quiescent_strings(vm);
    CHECK(mal_table_size(vm->atoms) == atoms_before);
    CHECK(strings_after_flat == strings_before);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == raw_before);

    roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "transient-rope-query-prefix", 27));
    for (usize i = 0; i < 1024; i++) {
        int length = snprintf(name, sizeof(name), "/long-query-leaf-%zu-abcdefghijklmnop", i);
        MalString *leaf = mal_string_new_ascii(&vm->heap, name, (usize) length);
        MalString *query;
        CHECK(mal_string_new_cons_checked(&vm->heap, mal_value_to_string(roots[1]), leaf, &query));
        roots[1] = mal_value_from_string(query);
        CHECK(mal_vm_op_load_property_ic(vm, roots[0], roots[1], &ic) == MAL_VALUE_UNDEFINED);
        CHECK(!query->property_atom);
    }
    roots[1] = MAL_VALUE_UNDEFINED;
    usize strings_after_rope = quiescent_strings(vm);
    CHECK(mal_table_size(vm->atoms) == atoms_before);
    CHECK(strings_after_rope == strings_before);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == raw_before);
    CHECK(ic.key == 0);
    printf("transient query retention: atoms=%zu->%zu strings=%zu->%zu->%zu raw=%zu->%zu\n",
        atoms_before, mal_table_size(vm->atoms), strings_before, strings_after_flat,
        strings_after_rope, raw_before, mal_heap_usage(&vm->heap).raw_owned_bytes);
    mal_gc_unroot(&span);
    return true;
}

static bool stored_names_remain_stable(MalVm *vm) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, nullptr)), MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    const char *name = "persisted-dynamic-property-name";
    usize length = strlen(name);
    roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, name, length));
    mal_vm_op_store_property(vm, roots[0], roots[1], mal_value_from_i32(73), false);
    CHECK(mal_value_to_string(roots[1])->property_atom);
    roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, name, length));
    MalInlineCache ic = {0};
    CHECK(mal_vm_op_load_property_ic(vm, roots[0], roots[1], &ic) == mal_value_from_i32(73));
    CHECK(mal_value_is_string(ic.key));
    CHECK(mal_value_to_string(ic.key)->property_atom);
    CHECK(ic.key != roots[1]);
    roots[1] = MAL_VALUE_UNDEFINED;
    quiescent_strings(vm);
    CHECK(mal_vm_op_load_property_ic(vm, roots[0], ic.key, &ic) == mal_value_from_i32(73));
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool ok = missing_queries_release_storage(&vm) && stored_names_remain_stable(&vm);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL) ok = false;
    mal_vm_free(&vm);
    if (ok) puts("transient-property-query PASS");
    return ok ? 0 : 1;
}
