#include "node_v8.h"

#if MAL_NODE

#include <unistd.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "shared_memory.h"
#include "vm_ops.h"

static MalValue node_v8_set_flags_from_string(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue flags = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(flags)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The flags argument must be a string");
        return mal_value_new_undefined();
    }
    MalString *string = mal_value_to_string(flags);
    if (mal_string_equals(string, mal_intrinsic_ascii(vm, "--expose_gc")) ||
        mal_string_equals(string, mal_intrinsic_ascii(vm, "--expose-gc"))) {
        vm->node_v8_expose_gc = true;
    }
    return mal_value_new_undefined();
}

#define V8_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

typedef struct NodeV8Field {
    const char *name;
    f64 value;
} NodeV8Field;

static MalValue node_v8_record(MalVm *vm, const NodeV8Field *fields, usize count) {
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (usize i = 0; i < count; i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) fields[i].name,
            mal_value_from_f64(fields[i].value), V8_VISIBLE);
    }
    mal_gc_unroot(&root);
    return result;
}

/* No configured heap cap exists, so physical memory is the effective limit. */
static f64 node_v8_heap_limit(void) {
    long pages = sysconf(_SC_PHYS_PAGES);
    long page_size = sysconf(_SC_PAGESIZE);
    return pages > 0 && page_size > 0 ? (f64) pages * (f64) page_size : 0;
}

static MalValue node_v8_get_heap_statistics(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    MalHeapCurrentUsage usage = mal_heap_current_usage(&vm->heap);
    f64 total = (f64) (usage.chunk_mapped_bytes + usage.managed_large_bytes);
    f64 used = (f64) usage.managed_owned_bytes;
    f64 limit = node_v8_heap_limit();
    f64 external = (f64) (usage.raw_owned_bytes + usage.array_buffer_bytes) + (f64) mal_shared_memory_live_bytes();
    const NodeV8Field fields[] = {
        {"total_heap_size", total},
        {"total_heap_size_executable", 0},
        {"total_physical_size", total},
        {"total_available_size", limit > used ? limit - used : 0},
        {"used_heap_size", used},
        {"heap_size_limit", limit},
        {"malloced_memory", (f64) usage.raw_owned_bytes},
        {"peak_malloced_memory", (f64) usage.raw_owned_bytes},
        {"does_zap_garbage", 0},
        {"number_of_native_contexts", 1},
        {"number_of_detached_contexts", 0},
        {"total_global_handles_size", 0},
        {"used_global_handles_size", 0},
        {"external_memory", external},
        {"total_allocated_bytes", total},
    };
    return node_v8_record(vm, fields, countof(fields));
}

/* The collector has one managed space; it is reported under V8's old_space name. */
static MalValue node_v8_get_heap_space_statistics(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    MalHeapCurrentUsage usage = mal_heap_current_usage(&vm->heap);
    f64 total = (f64) (usage.chunk_mapped_bytes + usage.managed_large_bytes);
    f64 used = (f64) usage.managed_owned_bytes;
    MalValue roots[] = {mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    const NodeV8Field fields[] = {
        {"space_size", total},
        {"space_used_size", used},
        {"space_available_size", total > used ? total - used : 0},
        {"physical_space_size", total},
    };
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "space_name",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "old_space")), V8_VISIBLE);
    for (usize i = 0; i < countof(fields); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) fields[i].name,
            mal_value_from_f64(fields[i].value), V8_VISIBLE);
    }
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(0), roots[1]);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue node_v8_get_heap_code_statistics(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    const NodeV8Field fields[] = {
        {"code_and_metadata_size", 0},
        {"bytecode_and_metadata_size", 0},
        {"external_script_source_size", 0},
        {"cpu_profiler_metadata_size", 0},
    };
    return node_v8_record(vm, fields, countof(fields));
}

static MalValue node_v8_cached_data_version_tag(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    // A stable FNV-1a hash of the reported Node release; no code cache exists to version.
    u32 hash = 2166136261u;
    for (const char *c = MAL_NODE_COMPAT_VERSION; *c != '\0'; c++) hash = (hash ^ (u8) *c) * 16777619u;
    return mal_value_from_u32(hash);
}

static MalValue node_v8_is_one_byte(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(value)) {
        mal_node_throw_invalid_arg_type(vm, "content", "of type string", value);
        return mal_value_new_undefined();
    }
    MalString *string = mal_value_to_string(value);
    MalStringSegment segment = mal_string_flat_segment(string);
    return mal_value_new_boolean(segment.latin1);
}

/* Coverage collection is off without NODE_V8_COVERAGE, where Node makes these no-ops too. */
static MalValue node_v8_noop(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return mal_value_new_undefined();
}

static MalValue node_v8_is_building_snapshot(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    // Node reads this from a Uint8Array flag, so it is the number 0, not false.
    return mal_value_from_i32(0);
}

static MalValue node_v8_not_building_snapshot(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Operation cannot be invoked when not building startup snapshot", "ERR_NOT_BUILDING_SNAPSHOT");
    return mal_value_new_undefined();
}

static MalValue node_v8_set_heap_snapshot_near_heap_limit(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    f64 limit;
    mal_node_validate_integer(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "limit", 1, 4294967295.0, &limit);
    return mal_value_new_undefined();
}

void mal_host_install_node_v8(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_V8_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "setFlagsFromString", 1, node_v8_set_flags_from_string);
        static const struct {
            const char *name;
            i32 length;
            MalNativeFunctionCallback callback;
        } methods[] = {
            {"getHeapStatistics", 0, node_v8_get_heap_statistics},
            {"getHeapSpaceStatistics", 0, node_v8_get_heap_space_statistics},
            {"getHeapCodeStatistics", 0, node_v8_get_heap_code_statistics},
            {"cachedDataVersionTag", 0, node_v8_cached_data_version_tag},
            {"isStringOneByteRepresentation", 1, node_v8_is_one_byte},
            {"takeCoverage", 0, node_v8_noop},
            {"stopCoverage", 0, node_v8_noop},
            {"setHeapSnapshotNearHeapLimit", 1, node_v8_set_heap_snapshot_near_heap_limit},
        };
        for (usize i = 0; i < countof(methods); i++) {
            mal_intrinsic_define_method_n(vm, mal_value_to_object(module), (const byte *) methods[i].name,
                methods[i].length, methods[i].callback);
        }
        MalValue snapshot = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan snapshot_root;
        mal_gc_root(&snapshot_root, &snapshot, 1);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(snapshot), (const byte *) "isBuildingSnapshot", 0,
            node_v8_is_building_snapshot);
        static const char *const snapshot_methods[] = {
            "addSerializeCallback", "addDeserializeCallback", "setDeserializeMainFunction"};
        for (usize i = 0; i < countof(snapshot_methods); i++) {
            mal_intrinsic_define_method_n(vm, mal_value_to_object(snapshot), (const byte *) snapshot_methods[i], 2,
                node_v8_not_building_snapshot);
        }
        mal_intrinsic_define_data(vm, mal_value_to_object(module), (const byte *) "startupSnapshot", snapshot,
            V8_VISIBLE);
        mal_gc_unroot(&snapshot_root);
        vm->intrinsics[MAL_INTRINSIC_NODE_V8_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:v8", slots, count, module);
}

#endif /* MAL_NODE */
