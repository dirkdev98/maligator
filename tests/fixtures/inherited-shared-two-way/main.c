#include <stdio.h>

#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "inherited-shared-two-way:%d: %s\n", __LINE__, #test); ok = false; goto cleanup; } } while (0)

enum {
    FAMILY_LIMIT = 2 * MAL_INHERITED_STUB_CACHE_SET_COUNT + 1,
    ROOT_COUNT = 2 * FAMILY_LIMIT + 1,
};

static bool set_value(MalObject *object, MalKey key, i32 value) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_from_i32(value),
        .getter = MAL_VALUE_UNDEFINED,
        .setter = MAL_VALUE_UNDEFINED,
    };
    return mal_object_define_own(object, key, &desc) == MAL_DEFINE_OWN_APPLIED;
}

static bool load_fresh(MalVm *vm, MalValue receiver, MalValue key, i32 expected) {
    MalInlineCache site = {0};
    MalValue actual = mal_vm_op_load_property_ic(vm, receiver, key, &site);
    mal_object_unregister_prototype_cache(&site);
    return vm->completion.kind != MAL_COMPLETION_THROW &&
        actual == mal_value_from_i32(expected);
}

static bool shared_value(
    MalVm *vm, MalValue receiver, const MalInlineCache *site, i32 expected
) {
    MalValue actual = MAL_VALUE_UNDEFINED;
    return mal_vm_inherited_stub_try_load_static(
        vm, receiver, mal_value_to_object(receiver), site, &actual) &&
        actual == mal_value_from_i32(expected);
}

static bool check_collisions(MalVm *vm) {
    MalValue roots[ROOT_COUNT];
    for (usize i = 0; i < ROOT_COUNT; i++) roots[i] = MAL_VALUE_UNDEFINED;
    MalRootSpan span;
    mal_gc_root(&span, roots, ROOT_COUNT);
    MalInlineCache primary = {0};
    MalInlineCache observer = {0};
    bool ok = true;
    i32 first[MAL_INHERITED_STUB_CACHE_SET_COUNT];
    i32 second[MAL_INHERITED_STUB_CACHE_SET_COUNT];
    for (usize i = 0; i < MAL_INHERITED_STUB_CACHE_SET_COUNT; i++) {
        first[i] = -1;
        second[i] = -1;
    }
    i32 chosen[3] = {-1, -1, -1};
    u32 bucket = 0;
    MalKey key = mal_intrinsic_string_key(vm, (const byte *) "quote");
    roots[0] = key.value;
    // The pigeonhole bound guarantees a three-family collision for the actual pointer hash.
    for (i32 i = 0; i < FAMILY_LIMIT; i++) {
        MalObject *prototype = mal_object_new(&vm->heap, nullptr);
        roots[1 + 2 * i] = mal_value_from_object(prototype);
        CHECK(set_value(prototype, key, i + 10));
        MalObject *receiver = mal_object_new(&vm->heap, prototype);
        roots[2 + 2 * i] = mal_value_from_object(receiver);
        u32 index = mal_inherited_stub_hash(receiver->shape, prototype, key.value);
        if (first[index] < 0) {
            first[index] = i;
        } else if (second[index] < 0) {
            second[index] = i;
        } else {
            chosen[0] = first[index];
            chosen[1] = second[index];
            chosen[2] = i;
            bucket = index;
            break;
        }
    }
    CHECK(chosen[2] >= 0);
    MalValue a = roots[2 + 2 * chosen[0]];
    MalValue b = roots[2 + 2 * chosen[1]];
    MalValue c = roots[2 + 2 * chosen[2]];
    i32 av = chosen[0] + 10;
    i32 bv = chosen[1] + 10;
    i32 cv = chosen[2] + 10;
    MalInlineCache *rows = mal_vm_inherited_property_stub_cache(vm);
    CHECK(rows != nullptr);
    for (u32 way = 0; way < 2; way++) {
        MalInlineCache *row = &rows[bucket + way * MAL_INHERITED_STUB_CACHE_SET_COUNT];
        mal_object_unregister_prototype_cache(row);
        *row = (MalInlineCache) {0};
    }
    CHECK(mal_vm_op_load_property_ic(vm, a, key.value, &primary) == mal_value_from_i32(av));
    CHECK(load_fresh(vm, b, key.value, bv));
    CHECK(shared_value(vm, a, &primary, av));
    CHECK(shared_value(vm, b, &primary, bv));
    MalValue actual = MAL_VALUE_UNDEFINED;
    CHECK(mal_vm_property_try_load_static(vm, b, &primary, &actual));
    CHECK(actual == mal_value_from_i32(bv));
    CHECK(load_fresh(vm, b, key.value, bv));
    CHECK(shared_value(vm, a, &primary, av));
    CHECK(shared_value(vm, b, &primary, bv));

    CHECK(mal_vm_op_load_property_ic(vm, c, key.value, &observer) == mal_value_from_i32(cv));
    CHECK(shared_value(vm, a, &observer, av));
    CHECK(shared_value(vm, c, &observer, cv));
    CHECK(!mal_vm_inherited_stub_try_load_static(
        vm, b, mal_value_to_object(b), &observer, &actual));
    CHECK(set_value(mal_value_to_object(roots[1 + 2 * chosen[1]]), key, bv + 100));
    CHECK(shared_value(vm, c, &observer, cv));
    CHECK(set_value(mal_value_to_object(roots[1 + 2 * chosen[0]]), key, av + 100));
    CHECK(rows[bucket].key == 0);
    CHECK(load_fresh(vm, b, key.value, bv + 100));
    CHECK(shared_value(vm, b, &observer, bv + 100));
    CHECK(shared_value(vm, c, &observer, cv));

    roots[1 + 2 * chosen[1]] = MAL_VALUE_UNDEFINED;
    roots[2 + 2 * chosen[1]] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(rows[bucket].key == 0);
    CHECK(shared_value(vm, c, &observer, cv));
cleanup:
    mal_object_unregister_prototype_cache(&primary);
    mal_object_unregister_prototype_cache(&observer);
    mal_gc_unroot(&span);
    return ok;
}

int main(void) {
    // Every value here is rooted explicitly; stale C locals must not retain cells.
    mal_gc_test_precise_stack_roots = true;
    for (i32 run = 0; run < 2; run++) {
        MalVm vm;
        mal_vm_init(&vm, &mal_runtime_image);
        bool ok = check_collisions(&vm);
        mal_vm_free(&vm);
        if (!ok) return 1;
    }
    puts("inherited-shared-two-way PASS");
    return 0;
}
