#include <stdio.h>
#include <string.h>

#include "array_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "perf_stats.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: %s\n", __func__, __LINE__, #condition); \
        return false; \
    } \
} while (0)

static usize getter_calls;

static MalValue late_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 count,
    MalValue new_target, MalValue callee
) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) count;
    (void) new_target;
    (void) callee;
    getter_calls++;
    return mal_value_from_i32(7);
}

static bool retains_prefix_and_allocation(MalVm *vm) {
    MalValue roots[6];
    for (usize i = 0; i < countof(roots); i++) roots[i] = MAL_VALUE_UNDEFINED;
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    u8 bytes[65536];
    memset(bytes, 'x', sizeof(bytes));
    roots[0] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, bytes, countof(bytes)));
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "value", mal_value_from_i32(7),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_accessor_n(vm, mal_value_to_object(roots[2]),
        mal_intrinsic_string_key(vm, "value"), "get value", 0, late_getter,
        nullptr, 0, nullptr, MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[3] = mal_value_from_array_object(mal_array_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])));
    CHECK(mal_array_object_store(mal_value_to_array_object(roots[3]), mal_key_index(0), roots[0]));
    CHECK(mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_JSON],
        mal_intrinsic_string_key(vm, "stringify"), &roots[4]));

    usize charged[2];
    for (usize mode = 0; mode < 2; mode++) {
        CHECK(mal_array_object_store(mal_value_to_array_object(roots[3]), mal_key_index(1), roots[mode + 1]));
        getter_calls = 0;
        mal_perf_stats_reset();
        usize before = vm->heap.bytes_allocated;
        MalCompletion result = mal_vm_call_value(
            vm, roots[4], vm->intrinsics[MAL_INTRINSIC_JSON], &roots[3], 1);
        charged[mode] = vm->heap.bytes_allocated - before;
        CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
        roots[5] = result.value;
        MalString *output = mal_value_to_string(roots[5]);
        CHECK(output->latin1 && output->length == sizeof(bytes) + 16);
        CHECK(mal_string_code_unit_at(output, 0) == '[' && mal_string_code_unit_at(output, 1) == '"');
        for (usize i = 0; i < sizeof(bytes); i++) {
            CHECK(mal_string_code_unit_at(output, i + 2) == 'x');
        }
        const char suffix[] = "\",{\"value\":7}]";
        for (usize i = 0; i < sizeof(suffix) - 1; i++) {
            CHECK(mal_string_code_unit_at(output, sizeof(bytes) + 2 + i) == suffix[i]);
        }
        CHECK(getter_calls == mode);
#if MAL_PERF_STATS
        CHECK(mal_perf_stats.json_plain_fallbacks == mode);
        CHECK(mal_perf_stats.json_plain_discarded_code_units == 0);
        CHECK(mal_perf_stats.json_quote_latin1_code_units == sizeof(bytes) + 5);
#endif
    }
    // A late accessor can add small callback bookkeeping, but must not allocate
    // a second output buffer proportional to the already-serialized prefix.
    CHECK(charged[1] <= charged[0] + 4096);
    printf("json late fallback charged bytes: plain=%zu late=%zu\n", charged[0], charged[1]);
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    mal_perf_stats_init();
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = retains_prefix_and_allocation(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("json-late-fallback PASS");
    return 0;
}
