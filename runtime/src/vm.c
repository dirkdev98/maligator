#include "vm.h"

#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__) || defined(__linux__)
#include <pthread.h>
#endif

#include "async_function.h"
#include "builtin_async_generator.h"
#include "builtin_math.h"
#include "bound_function_object.h"
#include "builtin_object.h"
#include "fiber.h"
#include "function_object.h"
#include "gc.h"
#include "generator_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "object_ops.h"
#include "promise_object.h"
#include "perf_stats.h"
#include "profile.h"
#include "proxy_object.h"
#include "u16_buffer.h"
#include "value_ops.h"
#include "vm_load.h"
#include "vm_ops.h"

static u64 g_coroutine_buffer_requests = 0;
static u64 g_coroutine_buffer_allocations = 0;
static u64 g_coroutine_buffer_reuses = 0;
static u64 g_coroutine_buffer_releases = 0;
static u64 g_coroutine_buffer_pooled = 0;
static u64 g_coroutine_buffer_dropped = 0;
static u64 g_coroutine_buffer_peak_retained_bytes = 0;
static u64 g_loaded_instruction_count = 0;
static u64 g_loaded_instruction_data_count = 0;

static MalShape **mal_vm_ensure_literal_shape_cache(
    MalVm *vm, i32 function_index
) {
    const MalFunction *function = &vm->definition->functions[function_index];
    if (function->literal_shape_count > 0
        && vm->literal_shape_cache[function_index] == nullptr) {
        vm->literal_shape_cache[function_index] = calloc(
            (usize) function->literal_shape_count, sizeof(MalShape *));
        MAL_PERF_COUNT(function_literal_cache_allocations);
        MAL_PERF_ADD(
            function_literal_cache_bytes,
            (u64) function->literal_shape_count * sizeof(MalShape *));
    }
    return vm->literal_shape_cache[function_index];
}

void mal_vm_ensure_function_caches(MalVm *vm, i32 function_index) {
    MalPropertyCachePool *pool = &vm->property_cache[function_index];
    const MalFunction *function = &vm->definition->functions[function_index];
    i32 property_count = function->property_ic_count;
    if (property_count > 0 && pool->sites == nullptr) {
        pool->sites = calloc((usize) property_count, sizeof(MalInlineCache));
        MAL_PERF_COUNT(function_property_cache_allocations);
        MAL_PERF_ADD(
            function_property_cache_bytes,
            (u64) property_count * sizeof(MalInlineCache));
    }
    mal_vm_ensure_literal_shape_cache(vm, function_index);
}

static void mal_vm_materialize_precompiled_literal_shapes(
    MalVm *vm, const MalVmDefinition *definition, i32 function_base, i32 string_base);

#define MAL_COROUTINE_POOL_MAX_BYTES ((usize) 1024 * 1024)
#define MAL_COROUTINE_POOL_MAX_BUFFER_BYTES ((usize) 64 * 1024)
#define MAL_COROUTINE_POOL_POWER_CLASS_COUNT 13

typedef struct MalCoroutineBuffer {
    struct MalCoroutineBuffer *next;
    usize capacity;
    u32 used;
    u32 initialized;
    MalValue values[];
} MalCoroutineBuffer;

static_assert(
    MAL_COROUTINE_POOL_CLASS_COUNT == MAL_COROUTINE_POOL_POWER_CLASS_COUNT + 1,
    "coroutine pool class count mismatch"
);
static_assert(
    MAL_COROUTINE_POOL_CLASS_COUNT * MAL_COROUTINE_POOL_MAX_BUFFER_BYTES <=
        MAL_COROUTINE_POOL_MAX_BYTES,
    "coroutine pool must fit one maximum-size buffer per class"
);
static_assert(
    offsetof(MalCoroutineBuffer, values) + sizeof(MalValue) * 4096 <
        MAL_COROUTINE_POOL_MAX_BUFFER_BYTES,
    "coroutine power classes must fit the per-buffer limit"
);

u64 mal_vm_loaded_instruction_count(void) {
    return g_loaded_instruction_count;
}

u64 mal_vm_loaded_instruction_data_count(void) {
    return g_loaded_instruction_data_count;
}

u64 mal_coroutine_buffer_request_count(void) {
    return g_coroutine_buffer_requests;
}

u64 mal_coroutine_buffer_allocation_count(void) {
    return g_coroutine_buffer_allocations;
}

u64 mal_coroutine_buffer_reuse_count(void) {
    return g_coroutine_buffer_reuses;
}

u64 mal_coroutine_buffer_release_count(void) {
    return g_coroutine_buffer_releases;
}

u64 mal_coroutine_buffer_pooled_count(void) {
    return g_coroutine_buffer_pooled;
}

u64 mal_coroutine_buffer_dropped_count(void) {
    return g_coroutine_buffer_dropped;
}

u64 mal_coroutine_buffer_peak_retained_bytes(void) {
    return g_coroutine_buffer_peak_retained_bytes;
}

static usize mal_coroutine_buffer_bytes(usize capacity) {
    return offsetof(MalCoroutineBuffer, values) + sizeof(MalValue) * capacity;
}

static MalCoroutineBuffer *mal_coroutine_buffer_from_values(MalValue *values) {
    return (MalCoroutineBuffer *) ((byte *) values - offsetof(MalCoroutineBuffer, values));
}

/**
 * Map a requested slot count to one directly-indexed retention class. Power-of-two
 * classes cover the common register/argument buffers; the final exact class uses
 * every slot that still fits the 64 KiB per-buffer policy. An out-of-range return
 * means the allocation remains exact-sized and will not be retained.
 */
static u32 mal_coroutine_buffer_class(usize required, usize *capacity_out) {
    usize capacity = 1;
    for (u32 index = 0; index < MAL_COROUTINE_POOL_POWER_CLASS_COUNT; index++) {
        if (required <= capacity) {
            *capacity_out = capacity;
            return index;
        }
        capacity *= 2;
    }

    usize max_capacity =
        (MAL_COROUTINE_POOL_MAX_BUFFER_BYTES - offsetof(MalCoroutineBuffer, values)) /
        sizeof(MalValue);
    if (required <= max_capacity) {
        *capacity_out = max_capacity;
        return MAL_COROUTINE_POOL_POWER_CLASS_COUNT;
    }
    *capacity_out = required;
    return MAL_COROUTINE_POOL_CLASS_COUNT;
}

MalValue *mal_vm_alloc_coroutine_buffer(MalVm *vm, i32 slot_count) {
    usize required = (usize) slot_count;
    usize capacity;
    u32 class_index = mal_coroutine_buffer_class(required, &capacity);
    MalCoroutineBuffer *buffer = class_index < MAL_COROUTINE_POOL_CLASS_COUNT
        ? vm->coroutine_buffer_pools[class_index]
        : nullptr;
    g_coroutine_buffer_requests++;

    if (buffer != nullptr) {
        usize bytes = mal_coroutine_buffer_bytes(buffer->capacity);
        vm->coroutine_buffer_pools[class_index] = buffer->next;
        vm->coroutine_buffer_pool_class_bytes[class_index] -= bytes;
        vm->coroutine_buffer_pool_bytes -= bytes;
        vm->coroutine_buffer_pool_count--;
        g_coroutine_buffer_reuses++;
    }

    if (buffer == nullptr) {
        buffer = malloc(mal_coroutine_buffer_bytes(capacity));
        buffer->capacity = capacity;
        buffer->initialized = 0;
        g_coroutine_buffer_allocations++;
    }
    buffer->next = nullptr;
    buffer->used = (u32) required;
    // Release leaves every previously exposed slot undefined. Preserve that cleared
    // prefix across smaller/equal reuses and initialize only a newly exposed suffix.
    MAL_PERF_ADD(
        coroutine_buffer_allocation_init_slots,
        required > buffer->initialized ? required - buffer->initialized : 0
    );
    for (usize i = buffer->initialized; i < required; i++) {
        buffer->values[i] = mal_value_new_undefined();
    }
    if (required > buffer->initialized) {
        buffer->initialized = (u32) required;
    }
    return buffer->values;
}

/**
 * Reclaim overrepresented classes only when the global byte cap is contended.
 * Donors remain at or above the incoming class's post-admission byte total, so
 * one class cannot fill the pool and permanently exclude another reusable class.
 */
static bool mal_coroutine_buffer_make_room(MalVm *vm, u32 class_index, usize bytes) {
    usize needed = vm->coroutine_buffer_pool_bytes - (MAL_COROUTINE_POOL_MAX_BYTES - bytes);
    usize target = vm->coroutine_buffer_pool_class_bytes[class_index] + bytes;
    usize available = 0;

    for (u32 index = 0; index < MAL_COROUTINE_POOL_CLASS_COUNT; index++) {
        MalCoroutineBuffer *buffer = vm->coroutine_buffer_pools[index];
        if (index == class_index || buffer == nullptr ||
            vm->coroutine_buffer_pool_class_bytes[index] <= target) {
            continue;
        }
        usize unit = mal_coroutine_buffer_bytes(buffer->capacity);
        available +=
            ((vm->coroutine_buffer_pool_class_bytes[index] - target) / unit) * unit;
    }
    if (available < needed) {
        return false;
    }

    for (u32 index = 0; index < MAL_COROUTINE_POOL_CLASS_COUNT && needed > 0; index++) {
        MalCoroutineBuffer *buffer = vm->coroutine_buffer_pools[index];
        if (index == class_index || buffer == nullptr ||
            vm->coroutine_buffer_pool_class_bytes[index] <= target) {
            continue;
        }
        usize unit = mal_coroutine_buffer_bytes(buffer->capacity);
        usize count = (vm->coroutine_buffer_pool_class_bytes[index] - target) / unit;
        while (count > 0 && needed > 0) {
            buffer = vm->coroutine_buffer_pools[index];
            vm->coroutine_buffer_pools[index] = buffer->next;
            vm->coroutine_buffer_pool_class_bytes[index] -= unit;
            vm->coroutine_buffer_pool_bytes -= unit;
            vm->coroutine_buffer_pool_count--;
            free(buffer);
            needed = needed > unit ? needed - unit : 0;
            count--;
        }
    }
    return true;
}

void mal_vm_release_coroutine_buffer(MalVm *vm, MalValue *values) {
    if (values == nullptr) {
        return;
    }
    MalCoroutineBuffer *buffer = mal_coroutine_buffer_from_values(values);
    g_coroutine_buffer_releases++;
    MAL_PERF_ADD(coroutine_buffer_release_clear_slots, buffer->used);
    for (usize i = 0; i < buffer->used; i++) {
        mal_gc_write_barrier(buffer->values[i]);
        buffer->values[i] = mal_value_new_undefined();
    }
    buffer->used = 0;

    usize bytes = mal_coroutine_buffer_bytes(buffer->capacity);
    usize class_capacity;
    u32 class_index = mal_coroutine_buffer_class(buffer->capacity, &class_capacity);
    if (class_index >= MAL_COROUTINE_POOL_CLASS_COUNT ||
        class_capacity != buffer->capacity) {
        g_coroutine_buffer_dropped++;
        free(buffer);
        return;
    }
    if (vm->coroutine_buffer_pool_bytes > MAL_COROUTINE_POOL_MAX_BYTES - bytes &&
        !mal_coroutine_buffer_make_room(vm, class_index, bytes)) {
        g_coroutine_buffer_dropped++;
        free(buffer);
        return;
    }
    buffer->next = vm->coroutine_buffer_pools[class_index];
    vm->coroutine_buffer_pools[class_index] = buffer;
    vm->coroutine_buffer_pool_class_bytes[class_index] += bytes;
    vm->coroutine_buffer_pool_bytes += bytes;
    vm->coroutine_buffer_pool_count++;
    g_coroutine_buffer_pooled++;
    if (vm->coroutine_buffer_pool_bytes > g_coroutine_buffer_peak_retained_bytes) {
        g_coroutine_buffer_peak_retained_bytes = vm->coroutine_buffer_pool_bytes;
    }
}

void mal_vm_free_coroutine_buffer_pool(MalVm *vm) {
    for (u32 index = 0; index < MAL_COROUTINE_POOL_CLASS_COUNT; index++) {
        MalCoroutineBuffer *buffer = vm->coroutine_buffer_pools[index];
        while (buffer != nullptr) {
            MalCoroutineBuffer *next = buffer->next;
            free(buffer);
            buffer = next;
        }
        vm->coroutine_buffer_pools[index] = nullptr;
        vm->coroutine_buffer_pool_class_bytes[index] = 0;
    }
    vm->coroutine_buffer_pool_bytes = 0;
    vm->coroutine_buffer_pool_count = 0;
}

/**
 * Capacity of the contiguous value stack, in MalValue slots. Recursion deeper
 * than this throws a RangeError, matching engines that cap the call stack. A
 * frame consumes register_count + arg_count slots, so this bounds call depth.
 */
#define MAL_VALUE_STACK_CAPACITY (256 * 1024)

/*
 * The interpreter's frame array is allocated once at this fixed capacity and
 * never reallocated, so a frame pointer (`callable` in the op handlers) stays
 * valid across a re-entrant call that pushes more frames — e.g. a property
 * getter or `valueOf` invoked mid-instruction, which would otherwise move the
 * array out from under the handler's pending register write-back. Call depth is
 * already bounded by the value stack (a RangeError on overflow); this is a
 * second, higher backstop (deep recursion overflows the value stack first for
 * any function with a non-trivial register window). Lazily committed, so the
 * resident cost tracks actual depth, not the reservation.
 */
#define MAL_MAX_CALL_FRAMES (64 * 1024)

/*
 * String and BigInt constant cells live in these arrays, and runtime values
 * point AT the cells (mal_value_from_string/bigint take a cell address; property
 * keys and stored string values hold that pointer). So the cells must never move
 * — a realloc that relocated them would dangle every outstanding reference (and
 * silently drop global properties whose key string moved). Functions and globals
 * are referenced by index, not address, so they stay growable; only these two
 * tables are fixed-capacity. A runtime-eval splice appends here without moving,
 * and overflows cleanly (RangeError) instead of relocating. Lazily committed, so
 * the resident cost tracks the constants actually materialized. The compiler
 * baked for eval alone contributes ~6k strings, so the ceilings sit well above
 * it while leaving generous headroom for eval'd code.
 */
#define MAL_MAX_STRING_CONSTANTS (128 * 1024)
#define MAL_MAX_BIGINT_CONSTANTS (16 * 1024)

MalEnv *mal_env_new(MalVm *vm, MalEnv *parent, i32 function_index, i32 count) {
    MalEnv *env = mal_heap_alloc(
        &vm->heap, sizeof(MalEnv) + sizeof(MalValue) * (usize) count, MAL_HEAP_ENV
    );
    env->parent = parent;
    env->function_index = function_index;
    env->slot_count = count;
    for (i32 i = 0; i < count; i++) {
        env->slots[i] = mal_value_new_undefined();
    }
    return env;
}

MalEnv *mal_env_new_with_object(MalVm *vm, MalEnv *parent, MalValue object) {
    MalEnv *env = mal_env_new(vm, parent, MAL_ENV_WITH_OBJECT, 1);
    env->slots[0] = object;
    return env;
}

// Bytes of C stack kept in reserve below the limit: a single compiled frame (its
// MalValue registers) plus the runtime helpers it may call before the next
// compiled-entry check. Generous — the stack is megabytes, so reserving this much
// costs nothing but prevents the deepest single level from overrunning.
#define MAL_NATIVE_STACK_MARGIN (512u * 1024u)

/**
 * The lowest C-stack address a compiled-function entry may sit at before recursion is
 * refused (see MalVm.stack_limit). Queries the current thread's stack bounds; returns
 * 0 (check disabled, the depth counter is the only guard) if they are unavailable.
 * The stack grows down, so the limit is the stack's low end plus the safety margin.
 */
static uptr mal_vm_compute_stack_limit(void) {
#if defined(__APPLE__)
    pthread_t self = pthread_self();
    void *top = pthread_get_stackaddr_np(self); // highest address (stack base)
    size_t size = pthread_get_stacksize_np(self);
    if (top == nullptr || size == 0) {
        return 0;
    }
    return (uptr) top - (uptr) size + MAL_NATIVE_STACK_MARGIN;
#elif defined(__linux__)
    pthread_attr_t attr;
    if (pthread_getattr_np(pthread_self(), &attr) != 0) {
        return 0;
    }
    void *low = nullptr;
    size_t size = 0;
    int ok = pthread_attr_getstack(&attr, &low, &size);
    pthread_attr_destroy(&attr);
    if (ok != 0 || low == nullptr || size == 0) {
        return 0;
    }
    return (uptr) low + MAL_NATIVE_STACK_MARGIN; // getstack returns the low end
#else
    return 0;
#endif
}

void mal_vm_invalidate_map_get_set_cache(MalVm *vm) {
    vm->map_get_set_cache = (MalMapGetSetCacheEntry) {
        .collection = mal_value_new_undefined(),
        .canonical_key = mal_value_new_undefined(),
    };
}

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition) {
#if MAL_REALMS
    vm->error_data_marker = mal_value_new_undefined();
    vm->error_stack_marker = mal_value_new_undefined();
#endif
    vm->allocation_error = mal_value_new_undefined();
    vm->tiny_string_cache = nullptr;
    vm->small_uint_string_cache = nullptr;
    vm->small_uint_string_cache_scan_limit = 0;
    vm->semantic_epochs = (MalSemanticEpochs) {
        .activity = 1,
        .array_elements = 1,
        .watched_methods = 1,
    };
    mal_gc_init(vm);

    if (definition->initialize_generated_data != nullptr) {
        definition->initialize_generated_data();
    }

    // Relocate the program's function / string / bigint / literal-template tables into
    // VM-owned growable storage behind a mutable `live_definition` (see vm.h), so
    // runtime eval can splice more in later while the const access paths keep
    // working. The instruction/handler/code-unit data the rows point at is left
    // in place (static, or the loader arena). Counts of 0 use a capacity of 1 so
    // a later splice always has a real array to grow.
    vm->live_definition = *definition;
    for (i32 i = 0; i < definition->function_count; i++) {
        g_loaded_instruction_count += (u64) definition->functions[i].instruction_count;
        g_loaded_instruction_data_count +=
            (u64) definition->functions[i].instruction_data_count;
    }
    vm->definition = &vm->live_definition;

    i32 function_count = definition->function_count;
    vm->function_capacity = function_count > 0 ? function_count : 1;
    MalFunction *functions = malloc(sizeof(MalFunction) * (usize) vm->function_capacity);
    if (function_count > 0) {
        memcpy(functions, definition->functions, sizeof(MalFunction) * (usize) function_count);
    }
    vm->live_definition.functions = functions;

    i32 string_count = definition->string_constant_count;
    vm->initial_string_constants = definition->string_constants;
    vm->initial_string_constant_count = string_count;
    // Fixed capacity, never reallocated (see MAL_MAX_STRING_CONSTANTS): string
    // cells must keep stable addresses because values point at them.
    vm->string_capacity = string_count > MAL_MAX_STRING_CONSTANTS ? string_count : MAL_MAX_STRING_CONSTANTS;
    MalString *strings = malloc(sizeof(MalString) * (usize) vm->string_capacity);
    if (string_count > 0) {
        memcpy(strings, definition->string_constants, sizeof(MalString) * (usize) string_count);
    }
    vm->live_definition.string_constants = strings;
    vm->string_constant_atoms =
        calloc((usize) vm->string_capacity, sizeof(MalString *));

    // Fixed capacity, never reallocated (see MAL_MAX_BIGINT_CONSTANTS): like
    // strings, BigInt values point at their cells.
    i32 bigint_count = definition->bigint_constant_count;
    vm->bigint_capacity = bigint_count > MAL_MAX_BIGINT_CONSTANTS ? bigint_count : MAL_MAX_BIGINT_CONSTANTS;
    MalBigInt *bigints = malloc(sizeof(MalBigInt) * (usize) vm->bigint_capacity);
    if (bigint_count > 0) {
        memcpy(bigints, definition->bigint_constants, sizeof(MalBigInt) * (usize) bigint_count);
    }
    vm->live_definition.bigint_constants = bigints;

    i32 literal_template_count = definition->literal_template_data_count;
    vm->literal_template_capacity = literal_template_count > 0 ? literal_template_count : 1;
    u32 *literal_templates = malloc(sizeof(u32) * (usize) vm->literal_template_capacity);
    if (literal_template_count > 0) {
        memcpy(literal_templates, definition->literal_template_data,
               sizeof(u32) * (usize) literal_template_count);
    }
    vm->live_definition.literal_template_data = literal_templates;

    i32 cjs_module_count = definition->cjs_module_count;
    vm->cjs_module_capacity = cjs_module_count > 0 ? cjs_module_count : 1;
    i32 *cjs_module_function_indices =
        malloc(sizeof(i32) * (usize) vm->cjs_module_capacity);
    if (cjs_module_count > 0) {
        memcpy(
            cjs_module_function_indices,
            definition->cjs_module_function_indices,
            sizeof(i32) * (usize) cjs_module_count);
    }
    vm->live_definition.cjs_module_function_indices =
        cjs_module_function_indices;
    i32 file_count = definition->file_count;
    vm->file_capacity = file_count > 0 ? file_count : 1;
    const char **files = malloc(sizeof(char *) * (usize) vm->file_capacity);
    if (file_count > 0) {
        memcpy(files, definition->files, sizeof(char *) * (usize) file_count);
    }
    vm->live_definition.files = files;

    i32 source_position_count = definition->source_position_count;
    vm->source_position_capacity =
        source_position_count > 0 ? source_position_count : 1;
    MalSourcePos *source_positions = malloc(
        sizeof(MalSourcePos) * (usize) vm->source_position_capacity);
    if (source_position_count > 0) {
        memcpy(source_positions, definition->source_positions,
               sizeof(MalSourcePos) * (usize) source_position_count);
    }
    vm->live_definition.source_positions = source_positions;
    vm->function_cjs_module_bases =
        calloc((usize) vm->function_capacity, sizeof(i32));

    vm->property_cache =
        calloc((usize) vm->function_capacity, sizeof(MalPropertyCachePool));
    vm->literal_shape_cache =
        calloc((usize) vm->function_capacity, sizeof(MalShape **));
    vm->property_stub = nullptr;
    vm->launch = (MalHostLaunchContext) {0};
    vm->iterator_result_shape = nullptr;
    vm->regexp_instance_shape = nullptr;
    vm->regexp_result_shape = nullptr;
    vm->regexp_result_indices_shape = nullptr;
    vm->regexp_indices_shape = nullptr;
    vm->node_http_socket_append_plan = (MalShapeAppendPlan) {0};
    vm->node_http_readable_state_append_plan = (MalShapeAppendPlan) {0};
    vm->node_http_incoming_message_source_append_plan = (MalShapeAppendPlan) {0};
    vm->node_http_incoming_message_dispatch_append_plan = (MalShapeAppendPlan) {0};
    vm->node_http_object_prototype_shape = nullptr;
    vm->node_http_event_emitter_prototype_shape = nullptr;
    vm->node_http_stream_prototype_shape = nullptr;
    vm->node_http_readable_prototype_shape = nullptr;
    vm->node_http_incoming_message_prototype_shape = nullptr;
    vm->node_http_server_response_prototype_shape = nullptr;
    vm->node_http_object_prototype_properties = 0;
    vm->node_http_event_emitter_prototype_properties = 0;
    vm->node_http_stream_prototype_properties = 0;
    vm->node_http_readable_prototype_properties = 0;
    vm->node_http_incoming_message_prototype_properties = 0;
    vm->node_http_server_response_prototype_properties = 0;
    vm->node_http_server_response_root_append_plan = (MalShapeAppendPlan) {0};
    vm->node_http_server_response_constructor_append_plan = (MalShapeAppendPlan) {0};
    vm->node_http_server_response_dispatch_append_plan = (MalShapeAppendPlan) {0};
    vm->node_sqlite_run_result_shape = nullptr;
    vm->interp_call_cache = nullptr;
    vm->global_property_cache = nullptr;
    mal_vm_invalidate_map_get_set_cache(vm);
    vm->global_capacity = definition->global_count > 0 ? definition->global_count : 1;
#if !MAL_REALMS
    vm->globals = malloc(sizeof(MalValue) * (usize) vm->global_capacity);
#endif
    // Fixed-capacity, never reallocated (see MAL_MAX_CALL_FRAMES): keeps every
    // live frame pointer stable across re-entrant calls.
    vm->frame_capacity = MAL_MAX_CALL_FRAMES;
    vm->frames = malloc(sizeof(MalVmFrame) * (usize) vm->frame_capacity);
    vm->frame_count = 0;

    vm->value_stack_capacity = MAL_VALUE_STACK_CAPACITY;
    vm->value_stack = malloc(sizeof(MalValue) * (usize) vm->value_stack_capacity);
    vm->value_stack_size = 0;
    vm->native_call_depth = 0;
    vm->proxy_dispatch_depth = 0;
    vm->stack_limit = mal_vm_compute_stack_limit();
    vm->gc_native_frames = 0;
    // Fibers: the main fiber is created at the end of init (once every exec field
    // it adopts is finalized). Null the list heads first so init_main can link on.
    vm->current_fiber = nullptr;
    vm->fibers_head = nullptr;
    // Host context (reactor/timers) is attached by the host layer, not the engine.
    vm->host = nullptr;
    vm->runtime_cleanup_count = 0;
    vm->active_job = nullptr;
    vm->kept_objects = nullptr;
    vm->kept_count = 0;
    vm->kept_capacity = 0;

    vm->compiler_fn = mal_value_new_undefined();
    vm->compiler_installed = false;
    vm->loaded_defs = nullptr;
    vm->loaded_def_count = 0;
    vm->loaded_def_capacity = 0;

    vm->native_frames = nullptr;
    vm->native_frame_count = 0;
    vm->native_frame_capacity = 0;
#if MAL_PROFILE
    vm->profile_current_site_id = -1;
#endif
    vm->frame_seq = 0;
    vm->captured_traces = nullptr;
    vm->captured_trace_free_next = nullptr;
    vm->captured_trace_count = 0;
    vm->captured_trace_capacity = 0;
    vm->captured_trace_free_head = -1;
    vm->captured_trace_live_count = 0;

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
#if MAL_NODE
    vm->async_context = nullptr;
    vm->node_v8_expose_gc = false;
#endif

    vm->job_head = nullptr;
    vm->job_tail = nullptr;
    vm->job_blocks = nullptr;
    vm->job_active_block = nullptr;
    vm->job_idle_block_count = 0;
    vm->reaction_pool = nullptr;
    vm->reaction_pool_count = 0;
    vm->reaction_blocks = nullptr;
    vm->reaction_active_block = nullptr;
    for (u32 i = 0; i < MAL_COROUTINE_POOL_CLASS_COUNT; i++) {
        vm->coroutine_buffer_pools[i] = nullptr;
        vm->coroutine_buffer_pool_class_bytes[i] = 0;
    }
    vm->coroutine_buffer_pool_bytes = 0;
    vm->coroutine_buffer_pool_count = 0;
    vm->async_generator_request_pool = nullptr;
    vm->async_generator_request_pool_count = 0;
    vm->unhandled_rejections = nullptr;
    vm->unhandled_count = 0;
    vm->unhandled_capacity = 0;
    vm->entry_async_promise = mal_value_new_undefined();

    mal_heap_init(&vm->heap, 0);
#if MAL_REALMS
    // global_capacity is already established above, so the initial realm can own
    // both its absolute globals array and intrinsics before intrinsic initialization.
    // mal_realm_new links only after all active root slots are safe to scan.
    vm->realms = nullptr;
    vm->initial_realm = mal_realm_new(vm);
    // Enter the initial realm: sets both VM aliases and primes heap.current_realm.
    mal_realm_switch(vm, vm->initial_realm);
#else
    for (i32 i = 0; i < definition->global_count; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
#endif
    for (i32 i = 0; i < MAL_INTRINSIC_COUNT; i++) {
        vm->intrinsics[i] = mal_value_new_undefined();
    }
    vm->symbol_registry = mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_SYMBOL_REGISTRY);
    // Must exist before mal_intrinsics_init, which interns keys through it.
    vm->atoms = mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_ATOMS);
    for (i32 i = 0; i < definition->string_constant_count; i++) {
        vm->string_constant_atoms[i] = mal_property_atomize_string(
            vm, (MalString *) &vm->definition->string_constants[i]);
    }
    // A guarded own-slot load may execute before its source allocation site.
    // Build only those named literal shapes now, after their canonical atoms
    // exist, so both compiled and interpreted guards can hit on first use.
    mal_vm_materialize_precompiled_literal_shapes(vm, definition, 0, 0);
    for (u32 i = 0; i < MAL_HOT_KEY_COUNT; i++) {
        vm->hot_intrinsic_keys[i] = nullptr;
    }
    for (u32 i = 0; i < MAL_ASCII_ATOM_CACHE_CAPACITY; i++) {
        vm->ascii_atom_cache[i] = (MalAsciiAtomCacheEntry) {0};
    }
    for (u32 i = 0; i < 256; i++) {
        vm->code_unit_strings[i] = nullptr;
    }

    mal_intrinsics_init(vm);

    // Build the emergency exception while allocation is healthy, without normal
    // stack capture. Its throw path later only copies this rooted value.
    vm->allocation_error = mal_vm_create_allocation_error(vm);

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

    // Main fiber: adopts the OS stack and the VM's now-finalized exec buffers, and
    // becomes the running fiber. Every subsequent spawned fiber gets its own stack
    // + exec slice, swapped in/out of these same MalVm fields on a context switch.
	MalFiber *main_fiber = malloc(sizeof(MalFiber));
	mal_fiber_init_main(main_fiber, vm);
	mal_profile_init(vm);
}

MalValue mal_vm_cjs_require(MalVm *vm, i32 id) {
    if (vm->frame_count > 0) {
        i32 caller_function_index =
            vm->frames[vm->frame_count - 1].function_index;
        id += vm->function_cjs_module_bases[caller_function_index];
    }
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
    // __filename/__dirname are undefined until module paths are baked.
    MalValue args[5] = {
        module_value,
        exports_value,
        vm->intrinsics[MAL_INTRINSIC_CJS_REQUIRE],
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    i32 function_index = vm->definition->cjs_module_function_indices[id];
    const MalFunction *function = &vm->definition->functions[function_index];
    if (function->compiled != nullptr) {
        if (mal_vm_enter_compiled(vm, function_index)) {
            function->compiled(
                vm, exports_value, args, 5, mal_value_new_undefined(), nullptr,
                mal_value_new_undefined(), nullptr
            );
            mal_vm_leave_compiled(vm);
        }
    } else {
        mal_vm_interpret_function(
            vm, function_index, mal_value_new_undefined(), exports_value, args, 5,
            mal_value_new_undefined(), nullptr
        );
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        // Node removes a module whose evaluation failed. A later require must run
        // a fresh module object rather than return this attempt's partial exports.
        slot->module_object = mal_value_new_undefined();
        slot->loaded = false;
        return mal_value_new_undefined();
    }

    // module.exports read live: the wrapper may have reassigned `module.exports`.
    MalValue exports;
    mal_vm_get_property(vm, slot->module_object, exports_key, &exports);
    return exports;
}

void mal_vm_add_kept_object(MalVm *vm, MalValue value) {
    if (vm->kept_count == vm->kept_capacity) {
        vm->kept_capacity = vm->kept_capacity == 0 ? 8 : vm->kept_capacity * 2;
        vm->kept_objects = realloc(vm->kept_objects, sizeof(MalValue) * (usize) vm->kept_capacity);
    }
    vm->kept_objects[vm->kept_count++] = value;
}

void mal_vm_clear_kept_objects(MalVm *vm) {
    vm->kept_count = 0;
}

bool mal_vm_register_runtime_cleanup(MalVm *vm, void (*cleanup)(MalVm *vm)) {
    if (cleanup == nullptr) return false;
    for (usize i = 0; i < vm->runtime_cleanup_count; i++) {
        if (vm->runtime_cleanups[i] == cleanup) return true;
    }
    if (vm->runtime_cleanup_count == countof(vm->runtime_cleanups)) return false;
    vm->runtime_cleanups[vm->runtime_cleanup_count++] = cleanup;
    return true;
}

void mal_vm_free(MalVm *vm) {
	mal_profile_finish(vm);
    for (usize i = vm->runtime_cleanup_count; i > 0; i--) {
        vm->runtime_cleanups[i - 1](vm);
    }
    vm->runtime_cleanup_count = 0;
    // Tear down fibers. Spawned fibers own their stack + exec buffers (freed by
    // mal_fiber_destroy); the main fiber adopted vm->value_stack / vm->frames, so
    // it only gets unlinked here and its struct freed — those buffers are released
    // below with the rest of the VM. At normal teardown only the main fiber is left
    // (workers were reaped by the scheduler), but reap defensively.
    MalFiber *main_fiber = nullptr;
    MalFiber *fiber = vm->fibers_head;
    while (fiber != nullptr) {
        MalFiber *next = fiber->next;
        if (fiber->is_main) {
            main_fiber = fiber;
        } else {
            mal_fiber_destroy(vm, fiber);
        }
        fiber = next;
    }
    if (main_fiber != nullptr) {
        mal_fiber_destroy(vm, main_fiber); // unlink only (is_main: no buffer/struct free)
        free(main_fiber);
    }
    vm->fibers_head = nullptr;
    vm->current_fiber = nullptr;
    // The host context (reactor/timers) is torn down by the host layer
    // (mal_host_detach), before mal_vm_free — not here.

    free(vm->kept_objects);

    // Definitions spliced at runtime for eval: their arenas back the spliced
    // functions' instruction data, so they are released only now, at teardown.
    for (i32 i = 0; i < vm->loaded_def_count; i++) {
        mal_vm_loaded_definition_free(vm->loaded_defs[i]);
    }
    free(vm->loaded_defs);
    if (vm->property_cache != nullptr) {
        for (i32 i = 0; i < vm->definition->function_count; i++) {
            MalPropertyCachePool *pool = &vm->property_cache[i];
            if (pool->sites != nullptr) {
                for (i32 j = 0; j < vm->definition->functions[i].property_ic_count; j++) {
                    mal_object_unregister_prototype_cache(&pool->sites[j]);
                }
            }
            free(pool->sites);
        }
        free(vm->property_cache);
    }
    mal_object_release_idle_prototype_dependencies();
    if (vm->literal_shape_cache != nullptr) {
        for (i32 i = 0; i < vm->definition->function_count; i++) {
            free(vm->literal_shape_cache[i]);
        }
        free(vm->literal_shape_cache);
    }
    free(vm->property_stub);
    free(vm->interp_call_cache);
    free(vm->global_property_cache);
    // Only heap-resident (generator/async) leftover frames own their buffers;
    // value-stack frames live in vm->value_stack, freed below.
    for (i32 i = 0; i < vm->frame_count; i++) {
        if (vm->frames[i].stack_base < 0) {
            mal_vm_release_coroutine_buffer(vm, vm->frames[i].registers);
            mal_vm_release_coroutine_buffer(vm, vm->frames[i].arguments);
        }
    }

    free(vm->frames);
    free(vm->value_stack);
#if !MAL_REALMS
    free(vm->globals);
#endif
    free(vm->cjs_registry);
    free(vm->function_cjs_module_bases);

    // The VM-owned constant/template tables (the instruction/code-unit data their
    // rows point at is owned elsewhere — static, or the caller's loaded definition).
    free((MalFunction *) vm->live_definition.functions);
    free(vm->string_constant_atoms);
    free((MalString *) vm->live_definition.string_constants);
    free((MalBigInt *) vm->live_definition.bigint_constants);
    free((u32 *) vm->live_definition.literal_template_data);
    free((i32 *) vm->live_definition.cjs_module_function_indices);
    free((char **) vm->live_definition.files);
    free((MalSourcePos *) vm->live_definition.source_positions);

    // Free any microtasks left queued (e.g. the program exited with pending
    // jobs). The MalValues they hold live in the heap, freed below.
    // Jobs are slab-owned; the block teardown below releases queued and pooled
    // nodes together after their heap values no longer need tracing.
    vm->job_head = nullptr;
    vm->job_tail = nullptr;

    free(vm->unhandled_rejections);
    vm->unhandled_rejections = nullptr;
    vm->unhandled_count = 0;
    vm->unhandled_capacity = 0;

    free(vm->native_frames);
    vm->native_frames = nullptr;
    vm->native_frame_count = 0;
    vm->native_frame_capacity = 0;

    for (i32 i = 0; i < vm->captured_trace_count; i++) {
        mal_vm_free_stack_trace(vm->captured_traces[i]);
    }
    free(vm->captured_traces);
    free(vm->captured_trace_free_next);
    vm->captured_traces = nullptr;
    vm->captured_trace_free_next = nullptr;
    vm->captured_trace_count = 0;
    vm->captured_trace_capacity = 0;
    vm->captured_trace_free_head = -1;
    vm->captured_trace_live_count = 0;

    // These VM-global tables (unlike cell-owned tables, freed by finalizers) are
    // torn down here. Their buffers live in the heap's RAW space, so mal_table_free
    // now reaches the allocator (gc_free_raw): both frees MUST precede mal_heap_free.
    mal_table_free(vm->symbol_registry);
    mal_table_free(vm->atoms);
    // Free every live cell's owned side allocations before releasing the heap,
    // so a teardown leaves no shutdown leak (mal_heap_free only munmaps the
    // chunks + frees LOS records; it does not run per-cell finalizers).
    mal_gc_finalize_all(vm);
    mal_vm_free_job_pool(vm);
    mal_promise_free_reaction_pool(vm);
    mal_vm_free_coroutine_buffer_pool(vm);
    mal_async_generator_free_request_pool(vm);
    free(vm->tiny_string_cache);
    vm->tiny_string_cache = nullptr;
    free(vm->small_uint_string_cache);
    vm->small_uint_string_cache = nullptr;
    vm->small_uint_string_cache_scan_limit = 0;
    // Snapshot allocation statistics while the heap counters are still intact.
    mal_gc_state_free(vm);
    mal_heap_free(&vm->heap);

#if MAL_REALMS
    // Realm globals and metadata are malloc-owned. Free the list now that the
    // collector is gone, then null the pointers that aliased its current member.
    mal_realm_free_all(vm);
    vm->initial_realm = nullptr;
    vm->current_realm = nullptr;
    vm->intrinsics = nullptr;
#endif

    vm->definition = nullptr;
    vm->globals = nullptr;
    vm->value_stack = nullptr;
    vm->value_stack_size = 0;
    vm->value_stack_capacity = 0;
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;
}

// Rebase a spliced instruction's references into the merged tables. Function
// indices, global slots, and string/bigint constant indices shift by the base
// table sizes; register operands and IP-relative fields are function-local and
// untouched. Side data lives in the loaded arena (mutable); static definitions
// never pass through this splice path. Mirrors the reference list in
// src/compiler/target/serialize-vm.ts.
static i32 mal_vm_rebase_value_operand(i32 operand, i32 string_base) {
    if (operand >= 0) return operand;
    if (operand > MAL_VALUE_OPERAND_STRING_BASE || operand < MAL_VALUE_OPERAND_STRING_MIN) {
        return operand;
    }
    i32 index = MAL_VALUE_OPERAND_STRING_BASE - operand;
    return MAL_VALUE_OPERAND_STRING_BASE - (index + string_base);
}

static void mal_vm_rebase_instruction(
    MalInstruction *in, i32 *instruction_data, i32 fn_base, i32 global_base,
    i32 string_base, i32 bigint_base, i32 template_base
) {
    switch (in->opcode) {
        case MAL_OP_CREATE_FUNCTION:
            in->as.create_function.function_index += fn_base;
            break;
        case MAL_OP_GUARD_FUNCTION_INDEX:
            in->as.guard_function_index.function_index += fn_base;
            break;
        // owner_function_index is either a real function index (>= 0, rebased
        // like every other) or a synthetic per-iteration loop-scope id (< 0,
        // assigned by nextLoopScopeId--). The negative ids are matched within a
        // single module's env chain (closures never cross module boundaries), so
        // they are stable across a splice and must NOT be shifted — adding
        // fn_base would desync them from their ENV_PUSH/COPY envs (whose scopeId
        // is likewise left untouched).
        case MAL_OP_LOAD_CAPTURED:
            if (in->as.load_captured.owner_function_index >= 0) {
                in->as.load_captured.owner_function_index += fn_base;
            }
            break;
        case MAL_OP_STORE_CAPTURED:
            if (in->as.store_captured.owner_function_index >= 0) {
                in->as.store_captured.owner_function_index += fn_base;
            }
            break;
        case MAL_OP_CREATE_PRIVATE_NAMES:
            if (in->as.create_private_names.owner_function_index >= 0) {
                in->as.create_private_names.owner_function_index += fn_base;
            }
            break;
        case MAL_OP_LOAD_GLOBAL:
            in->as.load_global.index += global_base;
            break;
        case MAL_OP_STORE_GLOBAL:
            in->as.store_global.index += global_base;
            break;
        case MAL_OP_CREATE_STRING:
            in->as.create_string.string_index += string_base;
            break;
        case MAL_OP_LOAD_PROPERTY_STATIC:
            in->as.load_property_static.string_index += string_base;
            break;
        case MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT: {
            i32 *data = instruction_data +
                in->as.load_property_static_known_own_slot.data_offset;
            data[0] += string_base;
            i32 candidate_count = data[1];
            for (i32 index = 0; index < candidate_count; index++) {
                data[2 + index * 3] += fn_base;
            }
            break;
        }
        case MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT: {
            i32 *data = instruction_data +
                in->as.store_property_static_known_own_slot.data_offset;
            data[0] += string_base;
            i32 candidate_count = data[1];
            for (i32 index = 0; index < candidate_count; index++) {
                data[2 + index * 3] += fn_base;
            }
            break;
        }
        case MAL_OP_STORE_PROPERTY_STATIC:
            in->as.store_property_static.string_index += string_base;
            break;
        case MAL_OP_CREATE_BIGINT:
            in->as.create_bigint.bigint_index += bigint_base;
            break;
        case MAL_OP_INSTANTIATE_LITERAL_TEMPLATE:
            in->as.instantiate_literal_template.template_offset += template_base;
            break;
        case MAL_OP_LOAD_UNDECLARED:
            in->as.load_undeclared.name_string_index += string_base;
            break;
        case MAL_OP_LOAD_GLOBAL_PROPERTY:
            in->as.load_global_property.name_string_index += string_base;
            break;
        case MAL_OP_STORE_GLOBAL_PROPERTY:
            in->as.store_global_property.name_string_index += string_base;
            break;
        case MAL_OP_INIT_GLOBAL_VARS: {
            i32 *data = instruction_data + in->as.init_global_vars.data_offset;
            for (i32 i = 0; i < data[0]; i++) {
                data[i + 1] += string_base;
            }
            break;
        }
        case MAL_OP_THROW_IF_TDZ:
            in->as.throw_if_tdz.name_string_index += string_base;
            break;
        case MAL_OP_WITH_GET:
            in->as.with_get.name_string_index += string_base;
            break;
        case MAL_OP_WITH_RESOLVE_BASE:
            in->as.with_resolve_base.name_string_index += string_base;
            break;
        case MAL_OP_WITH_SET:
            in->as.with_set.name_string_index += string_base;
            break;
        case MAL_OP_CREATE_OBJECT_SHAPED: {
            i32 *data = instruction_data + in->as.create_object_shaped.data_offset;
            i32 count = data[0];
            i32 *keys = &data[1];
            for (i32 i = 0; i < count; i++) {
                keys[i] += string_base; // value_registers are registers — untouched
            }
            break;
        }
        case MAL_OP_CREATE_TEMPLATE_OBJECT: {
            in->as.create_template_object.cache_slot += global_base;
            i32 *data = instruction_data + in->as.create_template_object.data_offset;
            i32 count = data[0];
            i32 *cooked = &data[1];
            i32 *raw = &data[1 + count];
            for (i32 i = 0; i < count; i++) {
                if (cooked[i] >= 0) { // -1 = undefined cooked (invalid escape)
                    cooked[i] += string_base;
                }
                raw[i] += string_base;
            }
            break;
        }
        case MAL_OP_CREATE_MODULE_NAMESPACE: {
            i32 *data = instruction_data + in->as.create_module_namespace.data_offset;
            i32 count = data[0];
            i32 *names = &data[1];
            i32 *slots = &data[1 + count];
            for (i32 i = 0; i < count; i++) {
                names[i] += string_base;
                slots[i] += global_base;
            }
            break;
        }
        case MAL_OP_CALL: {
            in->as.call.callee = mal_vm_rebase_value_operand(in->as.call.callee, string_base);
            in->as.call.this_value = mal_vm_rebase_value_operand(in->as.call.this_value, string_base);
            i32 *data = instruction_data + in->as.call.data_offset;
            for (i32 i = 0; i < data[0]; i++) {
                data[i + 1] = mal_vm_rebase_value_operand(data[i + 1], string_base);
            }
            break;
        }
        case MAL_OP_CALL_BUILTIN: {
            in->as.call_builtin.this_value = mal_vm_rebase_value_operand(
                in->as.call_builtin.this_value, string_base);
            i32 *data = instruction_data + in->as.call_builtin.data_offset;
            for (i32 i = 0; i < data[0]; i++) {
                data[i + 1] = mal_vm_rebase_value_operand(data[i + 1], string_base);
            }
            break;
        }
        case MAL_OP_CONSTRUCT: {
            in->as.construct.callee = mal_vm_rebase_value_operand(in->as.construct.callee, string_base);
            i32 *data = instruction_data + in->as.construct.data_offset;
            for (i32 i = 0; i < data[0]; i++) {
                data[i + 1] = mal_vm_rebase_value_operand(data[i + 1], string_base);
            }
            break;
        }
        default:
            break;
    }
}

static bool mal_vm_rebase_literal_templates(
    u32 *data, i32 count, i32 string_base, i32 bigint_base
) {
    i32 pos = 0;
    while (pos < count) {
        u32 tag = data[pos++];
        switch ((MalLiteralTemplateTag) tag) {
            case MAL_LITERAL_NULL:
            case MAL_LITERAL_FALSE:
            case MAL_LITERAL_TRUE:
            case MAL_LITERAL_HOLE:
                break;
            case MAL_LITERAL_I32:
            case MAL_LITERAL_ARRAY:
            case MAL_LITERAL_OBJECT:
                if (pos >= count) return false;
                pos++;
                break;
            case MAL_LITERAL_F64:
                if (pos + 1 >= count) return false;
                pos += 2;
                break;
            case MAL_LITERAL_STRING:
            case MAL_LITERAL_KEY:
                if (pos >= count) return false;
                data[pos++] += (u32) string_base;
                break;
            case MAL_LITERAL_BIGINT:
                if (pos >= count) return false;
                data[pos++] += (u32) bigint_base;
                break;
            default:
                return false;
        }
    }
    return true;
}

i32 mal_vm_splice_definition(MalVm *vm, const MalVmDefinition *loaded) {
    MalVmDefinition *live = &vm->live_definition;
    i32 fn_base = live->function_count;
    i32 global_base = live->global_count;
    i32 string_base = live->string_constant_count;
    i32 bigint_base = live->bigint_constant_count;
    i32 template_base = live->literal_template_data_count;
    i32 cjs_module_base = live->cjs_module_count;
    i32 file_base = live->file_count;
    i32 source_position_base = live->source_position_count;

    // String/BigInt constant cells must not move (values point at them), so their
    // arrays are fixed-capacity and never reallocated. Refuse a splice that would
    // overflow them up front — before mutating anything — so the failure is clean
    // (the caller sees -1 with a pending RangeError). Functions/globals below are
    // index-referenced and may still grow.
    i32 new_strings = string_base + loaded->string_constant_count;
    i32 new_bigints = bigint_base + loaded->bigint_constant_count;
    if (new_strings > vm->string_capacity || new_bigints > vm->bigint_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "eval: too many string/BigInt constants");
        return -1;
    }

    // String constants: append the loaded cells (immortal, code units in the
    // loader arena). Constants, so no rebase.
    if (loaded->string_constant_count > 0) {
        memcpy((MalString *) live->string_constants + string_base, loaded->string_constants,
               sizeof(MalString) * (usize) loaded->string_constant_count);
        for (i32 i = string_base; i < new_strings; i++) {
            vm->string_constant_atoms[i] = mal_property_atomize_string(
                vm, (MalString *) &live->string_constants[i]);
        }
    }
    live->string_constant_count = new_strings;

    // BigInt constants: append (self-contained — the value is inline).
    if (loaded->bigint_constant_count > 0) {
        memcpy((MalBigInt *) live->bigint_constants + bigint_base, loaded->bigint_constants,
               sizeof(MalBigInt) * (usize) loaded->bigint_constant_count);
    }
    live->bigint_constant_count = new_bigints;

    // Literal templates are index-addressed immutable words. Append a rebased
    // copy so spliced instructions can use one merged definition table.
    i32 new_template_count = template_base + loaded->literal_template_data_count;
    if (new_template_count > vm->literal_template_capacity) {
        vm->literal_template_capacity = new_template_count;
        live->literal_template_data = realloc(
            (u32 *) live->literal_template_data, sizeof(u32) * (usize) new_template_count);
    }
    u32 *templates = (u32 *) live->literal_template_data;
    if (loaded->literal_template_data_count > 0) {
        memcpy(templates + template_base, loaded->literal_template_data,
               sizeof(u32) * (usize) loaded->literal_template_data_count);
        if (!mal_vm_rebase_literal_templates(
                templates + template_base, loaded->literal_template_data_count,
                string_base, bigint_base)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "eval: invalid literal template");
            return -1;
        }
    }
    live->literal_template_data_count = new_template_count;

    // Globals: grow and undefined-initialize the same absolute range in every realm.
    i32 new_globals = global_base + loaded->global_count;
#if MAL_REALMS
    if (new_globals > vm->global_capacity) {
        for (MalRealm *realm = vm->realms; realm != nullptr; realm = realm->next) {
            realm->globals = realloc(realm->globals, sizeof(MalValue) * (usize) new_globals);
        }
        vm->global_capacity = new_globals;
    }
    for (MalRealm *realm = vm->realms; realm != nullptr; realm = realm->next) {
        for (i32 i = global_base; i < new_globals; i++) {
            realm->globals[i] = mal_value_new_undefined();
        }
    }
    vm->globals = vm->current_realm->globals;
#else
    if (new_globals > vm->global_capacity) {
        vm->global_capacity = new_globals;
        vm->globals = realloc(vm->globals, sizeof(MalValue) * (usize) new_globals);
    }
    for (i32 i = global_base; i < new_globals; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
#endif
    live->global_count = new_globals;

    // Portable host exports are definition-local global slots. Rebase their
    // loader-owned slot tables so the embedding can install them after splice.
    for (i32 i = 0; i < loaded->host_install_count; i++) {
        MalHostInstall *install = (MalHostInstall *) &loaded->host_installs[i];
        MalHostInstallSlot *slots = (MalHostInstallSlot *) install->slots;
        for (i32 slot = 0; slot < install->slot_count; slot++) {
            slots[slot].slot += global_base;
        }
    }

    // Debug tables: append definition-local paths and source positions. Inline
    // chains refer to function/source-position indices and must be rebased just
    // like bytecode operands.
    i32 new_file_count = file_base + loaded->file_count;
    if (new_file_count > vm->file_capacity) {
        vm->file_capacity = new_file_count;
        live->files = realloc(
            (char **) live->files, sizeof(char *) * (usize) new_file_count);
    }
    const char **files = (const char **) live->files;
    for (i32 i = 0; i < loaded->file_count; i++) {
        files[file_base + i] = loaded->files[i];
    }
    live->file_count = new_file_count;

    i32 new_source_position_count =
        source_position_base + loaded->source_position_count;
    if (new_source_position_count > vm->source_position_capacity) {
        vm->source_position_capacity = new_source_position_count;
        live->source_positions = realloc(
            (MalSourcePos *) live->source_positions,
            sizeof(MalSourcePos) * (usize) new_source_position_count);
    }
    MalSourcePos *source_positions = (MalSourcePos *) live->source_positions;
    for (i32 i = 0; i < loaded->source_position_count; i++) {
        MalSourcePos position = loaded->source_positions[i];
        if (position.inlined_function_index >= 0) {
            position.inlined_function_index += fn_base;
        }
        if (position.caller_pos_id >= 0) {
            position.caller_pos_id += source_position_base;
        }
        source_positions[source_position_base + i] = position;
    }
    live->source_position_count = new_source_position_count;

    // Functions: append rebased copies. Instruction/handler/position runs remain
    // owned by the loaded arena and are safely mutated once during this splice.
    i32 new_functions = fn_base + loaded->function_count;
    if (new_functions > vm->function_capacity) {
        vm->function_capacity = new_functions;
        live->functions =
            realloc((MalFunction *) live->functions, sizeof(MalFunction) * (usize) new_functions);
    }
    MalFunction *functions = (MalFunction *) live->functions;
    for (i32 f = 0; f < loaded->function_count; f++) {
        MalFunction fn = loaded->functions[f];
        g_loaded_instruction_count += (u64) fn.instruction_count;
        g_loaded_instruction_data_count += (u64) fn.instruction_data_count;
        fn.compiled = nullptr;
        if (fn.position_count > 0) {
            fn.file_index += file_base;
            MalLineEntry *positions = (MalLineEntry *) fn.positions;
            for (i32 p = 0; p < fn.position_count; p++) {
                positions[p].pos_id += source_position_base;
            }
        }
        if (fn.name_string_index >= 0) {
            fn.name_string_index += string_base;
        }
        for (i32 k = 0; k < fn.instruction_count; k++) {
            mal_vm_rebase_instruction(
                (MalInstruction *) &fn.instructions[k], (i32 *) fn.instruction_data,
                fn_base, global_base, string_base, bigint_base, template_base);
        }
        functions[fn_base + f] = fn;
    }
    live->function_count = new_functions;

    // CommonJS module ids are definition-local numeric values. Append the
    // module-to-function rows here; the caller function's segment base is
    // applied by mal_vm_cjs_require so no instruction data needs rewriting.
    i32 new_cjs_module_count =
        cjs_module_base + loaded->cjs_module_count;
    if (new_cjs_module_count > vm->cjs_module_capacity) {
        vm->cjs_module_capacity = new_cjs_module_count;
        live->cjs_module_function_indices = realloc(
            (i32 *) live->cjs_module_function_indices,
            sizeof(i32) * (usize) new_cjs_module_count);
    }
    i32 *cjs_module_function_indices =
        (i32 *) live->cjs_module_function_indices;
    for (i32 i = 0; i < loaded->cjs_module_count; i++) {
        cjs_module_function_indices[cjs_module_base + i] =
            loaded->cjs_module_function_indices[i] + fn_base;
    }
    if (new_cjs_module_count > cjs_module_base) {
        vm->cjs_registry = realloc(
            vm->cjs_registry,
            sizeof(MalCjsModuleSlot) * (usize) new_cjs_module_count);
        for (i32 i = cjs_module_base; i < new_cjs_module_count; i++) {
            vm->cjs_registry[i] = (MalCjsModuleSlot) {
                .module_object = mal_value_new_undefined(),
                .loaded = false,
            };
        }
    }
    live->cjs_module_count = new_cjs_module_count;

    // The realloc above may have moved the function table out from under any
    // frame that is live across this splice (the eval'ing frame itself, plus
    // its callers). Re-resolve each from its `function_index` source of truth so
    // the hot loop's cached `function` pointer stays valid. Suspended frames
    // (generators / async awaiters) re-resolve on resume, not here.
    for (i32 i = 0; i < vm->frame_count; i++) {
        vm->frames[i].function = &functions[vm->frames[i].function_index];
    }

    // Per-function caches grow with the function table.
    vm->property_cache =
        realloc(vm->property_cache, sizeof(MalPropertyCachePool) * (usize) new_functions);
    vm->literal_shape_cache = realloc(
        vm->literal_shape_cache, sizeof(MalShape **) * (usize) new_functions);
    vm->function_cjs_module_bases = realloc(
        vm->function_cjs_module_bases, sizeof(i32) * (usize) new_functions);
    for (i32 i = fn_base; i < new_functions; i++) {
        vm->property_cache[i] = (MalPropertyCachePool){0};
        vm->literal_shape_cache[i] = nullptr;
        vm->function_cjs_module_bases[i] = cjs_module_base;
    }

    // Spliced functions may execute guarded loads before their own literal
    // origins. Their strings and function rows are now fully rebased and live.
    mal_vm_materialize_precompiled_literal_shapes(vm, loaded, fn_base, string_base);

    return fn_base;
}

void mal_vm_retain_loaded_definition(MalVm *vm, MalLoadedDefinition *loaded) {
    if (vm->loaded_def_count == vm->loaded_def_capacity) {
        vm->loaded_def_capacity =
            vm->loaded_def_capacity == 0 ? 4 : vm->loaded_def_capacity * 2;
        vm->loaded_defs = realloc(
            vm->loaded_defs,
            sizeof(MalLoadedDefinition *) * (usize) vm->loaded_def_capacity);
    }
    vm->loaded_defs[vm->loaded_def_count++] = loaded;
}

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index) {
    MalCallable *callable = malloc(sizeof(MalCallable));

    callable->vm = vm;
    callable->function = &vm->definition->functions[function_index];
    callable->function_index = function_index;
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
    return callable;
}

void mal_vm_free_callable(MalCallable *callable) {
    free(callable->registers);
    free(callable->arguments);
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
    // SATB: a heap-resident (coroutine) activation frees its register/argument/with
    // buffers here — they leave both the heap trace (a COMPLETED coroutine's frame
    // is skipped) and the root set (frame pop), so shade the live edges first. A
    // value-stack frame keeps its window on the (root, re-scanned) value stack, so
    // it needs no shade. Folds out off-cycle.
    if (mal_gc_marking_active && frame->stack_base < 0) {
        mal_gc_satb_shade_frame(frame);
    }
    if (frame->stack_base >= 0) {
        vm->value_stack_size = frame->stack_base;
    } else {
        mal_vm_release_coroutine_buffer(vm, frame->registers);
        mal_vm_release_coroutine_buffer(vm, frame->arguments);
    }
}

#if MAL_REALMS
/** Restore the realm of the frame exposed by a pop, or the enclosing C seam. */
static void mal_vm_restore_surviving_realm(MalVm *vm, MalRealm *outer_realm) {
    MalRealm *realm = vm->frame_count > 0
        ? vm->frames[vm->frame_count - 1].realm
        : outer_realm;
    mal_vm_realm_switch_to(vm, realm);
}
#endif

/**
 * The `this` value a callee actually sees. A non-strict (sloppy) function called
 * with `undefined`/`null` this substitutes the global object (OrdinaryCallBindThis
 * step 5). Strict functions, and any object/primitive this, pass through.
 * Primitive-this boxing (ToObject) is not done yet — there are no wrapper objects.
 */
MalValue mal_vm_callee_this(MalVm *vm, const MalFunction *function, MalValue this_value) {
    if (function->strict) {
        return this_value;
    }
    // OrdinaryCallBindThis (sloppy): undefined/null this becomes globalThis; a
    // primitive this is boxed via ToObject; an object this is used as-is.
    if (mal_value_is_undefined(this_value) || mal_value_is_null(this_value)) {
        return vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    }
    if (!mal_value_is_object(this_value)) {
        return mal_builtin_object_box_primitive(vm, this_value);
    }
    return this_value;
}

#if MAL_REALMS
MalRealm *mal_vm_callee_realm(MalVm *vm, MalValue callee) {
    if (mal_value_is_function_object(callee)) {
        MalRealm *realm = mal_value_to_function_object(callee)->realm;
        return realm != nullptr ? realm : vm->current_realm;
    }
    if (mal_value_is_native_function_object(callee)) {
        MalRealm *realm = mal_value_to_native_function_object(callee)->realm;
        return realm != nullptr ? realm : vm->current_realm;
    }
    return vm->current_realm;
}

bool mal_vm_get_function_realm(MalVm *vm, MalValue callable, MalRealm **realm_out) {
    while (true) {
        if (mal_value_is_function_object(callable)) {
            MalRealm *realm = mal_value_to_function_object(callable)->realm;
            *realm_out = realm != nullptr ? realm : vm->current_realm;
            return true;
        }
        if (mal_value_is_native_function_object(callable)) {
            MalRealm *realm = mal_value_to_native_function_object(callable)->realm;
            *realm_out = realm != nullptr ? realm : vm->current_realm;
            return true;
        }
        if (mal_value_is_bound_function_object(callable)) {
            callable = mal_value_to_bound_function_object(callable)->target;
            continue;
        }
        if (mal_value_is_proxy_object(callable)) {
            MalProxyObject *proxy = mal_value_to_proxy_object(callable);
            if (proxy->revoked || mal_value_is_null(proxy->handler)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Cannot get the realm of a revoked proxy");
                return false;
            }
            callable = proxy->target;
            continue;
        }

        *realm_out = vm->current_realm;
        return true;
    }
}
#endif

bool mal_vm_get_prototype_from_constructor(
    MalVm *vm,
    MalValue constructor,
    MalIntrinsic intrinsic_default_proto,
    MalObject **prototype_out
) {
    MalValue prototype;
    if (!mal_vm_get_property(
            vm, constructor, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE), &prototype)) {
        return false;
    }
    if (mal_value_is_object(prototype)) {
        *prototype_out = mal_value_to_object(prototype);
        return true;
    }

#if MAL_REALMS
    MalRealm *realm;
    if (!mal_vm_get_function_realm(vm, constructor, &realm)) {
        return false;
    }
    *prototype_out = mal_value_to_object(realm->intrinsics[intrinsic_default_proto]);
#else
    *prototype_out = mal_value_to_object(vm->intrinsics[intrinsic_default_proto]);
#endif
    return true;
}

static void mal_vm_execute_argument_snapshot_plan(
    MalVm *vm,
    const MalFunction *function,
    i32 argument_base,
    i32 argument_count,
    MalValue *registers,
    bool aliases_arguments
) {
    MalValue scratch = mal_value_new_undefined();
    MAL_PERF_ADD(argument_snapshot_logical_values, function->argument_snapshot_count);
    for (i32 i = 0; i < function->argument_snapshot_plan_count; i++) {
        const MalArgumentSnapshotMove *move = &function->argument_snapshot_plan[i];
        if (move->destination < 0) {
            scratch = move->source < argument_count
                ? vm->value_stack[argument_base + move->source]
                : mal_value_new_undefined();
            MAL_PERF_COUNT(argument_snapshot_temporary_copies);
            continue;
        }

        MalValue value;
        if (move->source == MAL_ARGUMENT_SNAPSHOT_SOURCE_COUNT) {
            value = mal_value_from_i32(argument_count);
        } else if (move->source == MAL_ARGUMENT_SNAPSHOT_SOURCE_SCRATCH) {
            value = scratch;
        } else if (move->source < argument_count) {
            // A present aliased self-move is already in its final register.
            if (aliases_arguments && move->source == move->destination) {
                continue;
            }
            value = vm->value_stack[argument_base + move->source];
        } else {
            value = mal_value_new_undefined();
        }
        registers[move->destination] = value;
        MAL_PERF_COUNT(argument_snapshot_destination_writes);
    }
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
    bool wants_args = arg_count > 0 && arg_count <= function->argument_retention_limit;

    // The frame array is fixed-capacity (never moves); refuse to overflow it
    // before mutating any value-stack state, so the bail is clean. In practice
    // the value-stack window check below trips first for any real call depth.
    if (vm->frame_count >= vm->frame_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return false;
    }

    // Calling convention: the caller has placed the arguments in the top
    // arg_count slots of the value stack, so the callee can adopt that region
    // as the base of its register window — parameters need no copy in the
    // common case. base points at the first argument.
    i32 base = vm->value_stack_size - arg_count;
    i32 params_present = param_count < arg_count ? param_count : arg_count;

    i32 argument_snapshot_count = function->argument_snapshot_count;

    // Generators (and async, later) keep their activation on the heap: it
    // outlives the synchronous call stack across suspends. Everything else
    // carves a window from the value stack.
    bool heap_resident = function->kind != MAL_FUNCTION_KIND_NORMAL;

    // Allocate the captured-slot env now, while the incoming arguments are still
    // on the value stack (so a collection mal_env_new may trigger finds them as
    // roots). The heap-resident path below releases that marshaling area before
    // the frame is published, so the env must be built first. Functions without
    // captured slots pass the creation chain through so grandchild closures still
    // find their owners. (creation_env is rooted via the callee function object.)
    MalEnv *env = creation_env;
    if (function->captured_count > 0) {
        env = mal_env_new(vm, creation_env, function_index, function->captured_count);
    }

    MalValue *registers;
    MalValue *arguments;
    i32 stack_base;

    if (heap_resident) {
        // Copy parameters (and arguments, if read) out of the marshaling area
        // into owned heap storage, then release the area.
        registers = mal_vm_alloc_coroutine_buffer(vm, register_count);
        arguments = (wants_args && arg_count > 0)
            ? mal_vm_alloc_coroutine_buffer(vm, arg_count)
            : nullptr;
        for (i32 i = 0; i < params_present; i++) {
            registers[i] = vm->value_stack[base + i];
        }
        for (i32 i = 0; wants_args && i < arg_count; i++) {
            arguments[i] = vm->value_stack[base + i];
        }
        mal_vm_execute_argument_snapshot_plan(
            vm, function, base, arg_count, registers, false);
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
        mal_vm_execute_argument_snapshot_plan(
            vm, function, base, arg_count, registers, false);
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
        // Execute before clearing locals: extra marshaled arguments can overlap
        // snapshot destinations, including cycles. The persisted plan preserves
        // those sources with one scalar scratch only when required.
        mal_vm_execute_argument_snapshot_plan(
            vm, function, base, arg_count, registers, true);
        for (i32 i = params_present; i < param_count; i++) {
            registers[i] = mal_value_new_undefined();
        }
        for (i32 i = param_count + argument_snapshot_count; i < register_count; i++) {
            registers[i] = mal_value_new_undefined();
        }
        vm->value_stack_size = base + register_count;
        stack_base = base;
    }

    // Capacity was checked up front; the frame array never moves, so existing
    // frame pointers held by re-entrant op handlers stay valid.
    MalVmFrame *frame = &vm->frames[vm->frame_count++];
    frame->vm = vm;
    frame->function = function;
    frame->function_index = function_index;
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
    frame->instruction_pointer = argument_snapshot_count;
    frame->return_register = return_register;
    frame->caller_frame_index = caller_frame_index;
    frame->enter_seq = vm->frame_seq++;
#if MAL_REALMS
    // Default stamp: the realm current at push time. Call/construct seams that cross
    // into a callee's realm switch to it BEFORE pushing (so this captures the callee
    // realm); same-realm pushes capture the caller realm unchanged.
    frame->realm = vm->current_realm;
#endif

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
#if MAL_REALMS
        // The handler can belong to a caller realm after the frames above it were
        // discarded. Enter it before the catch body performs any work.
        mal_vm_realm_switch_to(vm, frame->realm);
#endif
        return true;
    }

    return false;
}

typedef struct MalVmInterpreterActivation {
    MalFiber *fiber;
    i32 frame_index;
    u64 enter_seq;
#if MAL_REALMS
    MalRealm *realm;
#endif
} MalVmInterpreterActivation;

static MalVmInterpreterActivation mal_vm_interpreter_activation(
    MalVm *vm,
    const MalVmFrame *frame
) {
    return (MalVmInterpreterActivation) {
        .fiber = vm->current_fiber,
        .frame_index = vm->frame_count - 1,
        .enter_seq = frame->enter_seq,
#if MAL_REALMS
        .realm = frame->realm,
#endif
    };
}

static bool mal_vm_interpreter_activation_is_current(
    const MalVm *vm,
    MalVmInterpreterActivation activation
) {
    return vm->completion.kind == MAL_COMPLETION_NORMAL &&
        vm->current_fiber == activation.fiber &&
        vm->frame_count == activation.frame_index + 1 &&
        vm->frames[activation.frame_index].enter_seq == activation.enter_seq
#if MAL_REALMS
        && vm->current_realm == activation.realm
        && vm->frames[activation.frame_index].realm == activation.realm
#endif
        ;
}

// Direct leaves write through the frame's published register buffer, so only the
// shadow instruction pointer needs publishing before a helper, throw, or GC seam.
#define MAL_VM_INTERPRETER_DIRECT_LEAF() \
    MAL_PERF_COUNT(interpreter_direct_leaf_executions)

#define MAL_VM_INTERPRETER_ACTIVATION_BOUNDARY(call) \
    do { \
        frame->instruction_pointer = instruction_pointer; \
        MAL_PERF_COUNT(interpreter_state_syncs); \
        MAL_PERF_COUNT(interpreter_boundary_dispatches); \
        call; \
    } while (0)

#define MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE(activation) \
    do { \
        frame = &vm->frames[(activation).frame_index]; \
        instructions = frame->function->instructions; \
        registers = frame->registers; \
        instruction_pointer = frame->instruction_pointer; \
        MAL_PERF_COUNT(interpreter_normal_helper_continuations); \
        goto mal_vm_interpreter_dispatch; \
    } while (0)

#define MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(call) \
    do { \
        MalVmInterpreterActivation activation = mal_vm_interpreter_activation(vm, frame); \
        frame->instruction_pointer = instruction_pointer; \
        MAL_PERF_COUNT(interpreter_state_syncs); \
        MAL_PERF_COUNT(interpreter_boundary_dispatches); \
        call; \
        if (mal_vm_interpreter_activation_is_current(vm, activation)) { \
            MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE(activation); \
        } \
    } while (0)

// Calls and iterator callbacks are safepoints after a synchronous return. Recheck
// the activation after polling because a fiber switch may have swapped VM state.
#define MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(call) \
    do { \
        MalVmInterpreterActivation activation = mal_vm_interpreter_activation(vm, frame); \
        frame->instruction_pointer = instruction_pointer; \
        MAL_PERF_COUNT(interpreter_state_syncs); \
        MAL_PERF_COUNT(interpreter_boundary_dispatches); \
        call; \
        if (mal_vm_interpreter_activation_is_current(vm, activation) && mal_gc_poll) { \
            mal_gc_safepoint(vm); \
        } \
        if (mal_vm_interpreter_activation_is_current(vm, activation)) { \
            MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE(activation); \
        } \
    } while (0)

#define MAL_VM_INTERPRETER_SYNC() \
    do { \
        frame->instruction_pointer = instruction_pointer; \
        MAL_PERF_COUNT(interpreter_state_syncs); \
    } while (0)

static void mal_vm_run_until_frame_count(
    MalVm *vm,
    i32 target_frame_count
#if MAL_REALMS
    , MalRealm *outer_realm
#endif
) {
    while (vm->frame_count > target_frame_count) {
        MalVmFrame *frame = &vm->frames[vm->frame_count - 1];
        const MalInstruction *instructions = frame->function->instructions;
        MalValue *registers = frame->registers;
        i32 instruction_pointer = frame->instruction_pointer;
        MAL_PERF_COUNT(interpreter_state_reloads);

        while (true) {
        mal_vm_interpreter_dispatch:
#if MAL_PROFILE && MAL_PERF_STATS
            i32 profile_site_id = frame->function->profile_site_ids == nullptr
                ? -1
                : frame->function->profile_site_ids[instruction_pointer];
            vm->profile_current_site_id = profile_site_id;
            MAL_PROFILE_SITE_EVENT(
                vm, profile_site_id, MAL_PROFILE_SITE_EXECUTION, 1);
#endif
            const MalInstruction *instruction = &instructions[instruction_pointer++];

        switch (instruction->opcode) {
            case MAL_OP_MOVE:
                registers[instruction->as.move.dst] = registers[instruction->as.move.src];
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;

            case MAL_OP_CREATE_NUMBER:
                registers[instruction->as.create_number.dst] =
                    mal_value_from_i32(instruction->as.create_number.value);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_F64: {
                u64 bits = (u64) instruction->as.create_f64.bits_low |
                    ((u64) instruction->as.create_f64.bits_high << 32);
                f64 value;
                memcpy(&value, &bits, sizeof(value));
                registers[instruction->as.create_f64.dst] = mal_value_from_f64_convert_nan(value);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_CREATE_BOOLEAN:
                registers[instruction->as.create_boolean.dst] =
                    mal_value_new_boolean(instruction->as.create_boolean.value != 0);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_STRING:
                registers[instruction->as.create_string.dst] = mal_value_from_string(
                    &vm->definition->string_constants[instruction->as.create_string.string_index]);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_BIGINT:
                registers[instruction->as.create_bigint.dst] = mal_value_from_bigint(
                    &vm->definition->bigint_constants[instruction->as.create_bigint.bigint_index]);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_OBJECT:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_object(frame, instruction));
                break;
            case MAL_OP_CREATE_OBJECT_SHAPED:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_object_shaped(frame, instruction));
                break;
            case MAL_OP_CREATE_ARRAY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_array(frame, instruction));
                break;
            case MAL_OP_INSTANTIATE_LITERAL_TEMPLATE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_instantiate_literal_template(frame, instruction));
                break;
            case MAL_OP_CREATE_MODULE_NAMESPACE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_module_namespace(frame, instruction));
                break;
            case MAL_OP_CREATE_TEMPLATE_OBJECT:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_template_object(frame, instruction));
                break;
            case MAL_OP_WITH_ENTER:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_with_enter(frame, instruction));
                break;
            case MAL_OP_WITH_EXIT:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_with_exit(frame, instruction));
                break;
            case MAL_OP_WITH_GET:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_with_get(frame, instruction));
                break;
            case MAL_OP_WITH_RESOLVE_BASE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_with_resolve_base(frame, instruction));
                break;
            case MAL_OP_WITH_SET:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_with_set(frame, instruction));
                break;
            case MAL_OP_IS_EMPTY:
                registers[instruction->as.is_empty.dst] = mal_value_new_boolean(
                    mal_value_is_empty(registers[instruction->as.is_empty.src]));
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_UNDEFINED:
                registers[instruction->as.create_undefined.dst] = mal_value_new_undefined();
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_EMPTY:
                registers[instruction->as.create_empty.dst] = mal_value_new_empty();
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_NULL:
                registers[instruction->as.create_null.dst] = mal_value_new_null();
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_FUNCTION:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_function(frame, instruction));
                break;
            case MAL_OP_CREATE_ARGUMENTS_OBJECT:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_arguments_object(frame, instruction));
                break;
            case MAL_OP_LOAD_ARGUMENT_COUNT:
                registers[instruction->as.load_argument_count.dst] =
                    mal_value_from_i32(frame->argument_count);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_LOAD_ARGUMENT: {
                i32 index = instruction->as.load_argument.index;
                registers[instruction->as.load_argument.dst] =
                    index >= 0 && index < frame->argument_count
                    ? frame->arguments[index]
                    : mal_value_new_undefined();
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_LOAD_STATIC_ARGUMENT: {
                i32 index = instruction->as.load_static_argument.index;
                if (index < frame->argument_count) {
                    i32 direct = instruction->as.load_static_argument.direct;
                    registers[instruction->as.load_static_argument.dst] = direct >= 0
                        ? registers[direct]
                        : frame->arguments[index];
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_load_static_argument(frame, instruction)
                );
                break;
            }
            case MAL_OP_LOAD_THIS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_this(frame, instruction));
                break;
            case MAL_OP_LOAD_CALLEE:
                registers[instruction->as.load_callee.dst] = frame->callee;
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_LOAD_NEW_TARGET:
                registers[instruction->as.load_new_target.dst] = frame->new_target;
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_BINARY: {
                MalValue left = registers[instruction->as.binary.left];
                MalValue right = registers[instruction->as.binary.right];
                MalValue result;
                if (!mal_vm_try_binary_number_fast(instruction->as.binary.op, left, right, &result) &&
                    !mal_vm_try_binary_strict_fast(instruction->as.binary.op, left, right, &result)) {
                    mal_perf_binary_number_fallback(instruction->as.binary.op);
                    MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                        result = mal_vm_binary_op(frame->vm, instruction->as.binary.op, left, right);
                        frame->registers[instruction->as.binary.dst] = result);
                    break;
                }
                registers[instruction->as.binary.dst] = result;
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_UNARY: {
                MalUnaryOp op = instruction->as.unary.op;
                MalValue value = registers[instruction->as.unary.src];
                if (op == MAL_UNARY_NOT) {
                    registers[instruction->as.unary.dst] = mal_value_new_boolean(
                        !mal_value_is_truthy(value));
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                if (mal_ops_is_number(value)) {
                    if (op == MAL_UNARY_TO_NUMERIC) {
                        registers[instruction->as.unary.dst] = value;
                        MAL_VM_INTERPRETER_DIRECT_LEAF();
                        continue;
                    }
                    if (op == MAL_UNARY_INCREMENT || op == MAL_UNARY_DECREMENT) {
                        f64 unit = op == MAL_UNARY_INCREMENT ? 1.0 : -1.0;
                        registers[instruction->as.unary.dst] = mal_ops_number_value(
                            mal_ops_number_as_f64(value) + unit);
                        MAL_VM_INTERPRETER_DIRECT_LEAF();
                        continue;
                    }
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_unary(frame, instruction));
                break;
            }
            case MAL_OP_MATH_UNARY_NUMBER: {
                MalValue value = registers[instruction->as.math_unary_number.src];
                registers[instruction->as.math_unary_number.dst] = mal_ops_number_value(
                    mal_builtin_math_unary_number_known(
                        (MalMathUnaryOp) instruction->as.math_unary_number.operation,
                        mal_ops_number_as_f64(value)));
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_MATH_BINARY_NUMBER: {
                MalValue left = registers[instruction->as.math_binary_number.left];
                MalValue right = registers[instruction->as.math_binary_number.right];
                registers[instruction->as.math_binary_number.dst] = mal_ops_number_value(
                    mal_builtin_math_binary_number_known(
                        (MalMathBinaryOp) instruction->as.math_binary_number.operation,
                        mal_ops_number_as_f64(left),
                        mal_ops_number_as_f64(right)));
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_TYPEOF_COMPARE: {
                bool result = mal_vm_typeof_compare(
                    registers[instruction->as.typeof_compare.src],
                    instruction->as.typeof_compare.expected);
                registers[instruction->as.typeof_compare.dst] = mal_value_new_boolean(
                    instruction->as.typeof_compare.negated ? !result : result);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }

            case MAL_OP_STORE_GLOBAL:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_global(frame, instruction));
                break;
            case MAL_OP_LOAD_GLOBAL:
                registers[instruction->as.load_global.dst] =
                    vm->globals[instruction->as.load_global.index];
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_LOAD_INTRINSIC:
                registers[instruction->as.load_intrinsic.dst] =
                    vm->intrinsics[instruction->as.load_intrinsic.intrinsic];
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_LOAD_PROPERTY: {
                MalValue object = registers[instruction->as.load_property.object];
                MalValue key = registers[instruction->as.load_property.key];
                MalValue result;
                if ((mal_value_is_int32(key) || mal_value_is_f64(key)) &&
                    mal_value_is_heap_type(object, MAL_HEAP_ARRAY_OBJECT) &&
                    mal_vm_array_try_load(
                        (const MalArrayObject *) mal_value_to_heap(object),
                        mal_value_is_int32(key) ? (f64) mal_value_to_i32(key) : mal_value_to_f64(key),
                        &result)) {
                    registers[instruction->as.load_property.dst] = result;
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MalInlineCache *ic = mal_vm_property_ic_at(
                    frame, instruction->as.load_property.ic_index);
                MalObject *plain_object = mal_vm_as_object(object);
                bool cache_hit = plain_object != nullptr &&
                    mal_vm_object_try_load(plain_object, key, ic, &result);
                if (!cache_hit) {
                    cache_hit = mal_vm_property_try_load(vm, object, key, ic, &result);
                }
                if (cache_hit) {
                    registers[instruction->as.load_property.dst] = result;
                    MAL_PERF_COUNT(interpreter_local_load_ic_hits);
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_PERF_COUNT(interpreter_load_ic_sync_fallbacks);
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_property(frame, instruction));
                break;
            }
            case MAL_OP_LOAD_PROPERTY_STATIC: {
                MalValue object = registers[instruction->as.load_property_static.object];
                MalValue result;
                MalInlineCache *ic = mal_vm_property_ic_at(
                    frame, instruction->as.load_property_static.ic_index);
                bool cache_hit = mal_vm_property_try_load_static(vm, object, ic, &result);
                if (cache_hit) {
                    registers[instruction->as.load_property_static.dst] = result;
                    MAL_PERF_COUNT(interpreter_local_load_ic_hits);
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_PERF_COUNT(interpreter_load_ic_sync_fallbacks);
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_property_static(frame, instruction));
                break;
            }
            case MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT: {
                const i32 *data = frame->function->instruction_data +
                    instruction->as.load_property_static_known_own_slot.data_offset;
                MalValue object = registers[
                    instruction->as.load_property_static_known_own_slot.object];
                MalValue result;
                if (mal_vm_try_load_known_own_slots(
                        vm, object, data[1], &data[2], &result)) {
                    registers[instruction->as.load_property_static_known_own_slot.dst] = result;
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_load_property_static_known_own_slot_fallback(frame, instruction));
                break;
            }
            case MAL_OP_STORE_PROPERTY: {
                MalValue object = registers[instruction->as.store_property.object];
                MalValue key = registers[instruction->as.store_property.key];
                MalValue value = registers[instruction->as.store_property.value];
                if ((mal_value_is_int32(key) || mal_value_is_f64(key)) &&
                    mal_value_is_heap_type(object, MAL_HEAP_ARRAY_OBJECT) &&
                    mal_vm_array_try_store(
                        (MalArrayObject *) mal_value_to_heap(object),
                        mal_value_is_int32(key) ? (f64) mal_value_to_i32(key) : mal_value_to_f64(key),
                        value)) {
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MalInlineCache *ic = mal_vm_property_ic_at(
                    frame, instruction->as.store_property.ic_index);
                if (mal_vm_property_try_store(object, key, value, ic)) {
                    MAL_PERF_COUNT(interpreter_local_store_ic_hits);
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_PERF_COUNT(interpreter_store_ic_sync_fallbacks);
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_property(frame, instruction));
                break;
            }
            case MAL_OP_STORE_PROPERTY_STATIC: {
                MalValue object = registers[instruction->as.store_property_static.object];
                MalValue value = registers[instruction->as.store_property_static.value];
                MalInlineCache *ic = mal_vm_property_ic_at(
                    frame, instruction->as.store_property_static.ic_index);
                if (mal_vm_property_try_store_static(object, value, ic)) {
                    MAL_PERF_COUNT(interpreter_local_store_ic_hits);
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_PERF_COUNT(interpreter_store_ic_sync_fallbacks);
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_property_static(frame, instruction));
                break;
            }
            case MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT: {
                const i32 *data = frame->function->instruction_data +
                    instruction->as.store_property_static_known_own_slot.data_offset;
                MalValue object = registers[
                    instruction->as.store_property_static_known_own_slot.object];
                MalValue value = registers[
                    instruction->as.store_property_static_known_own_slot.value];
                if (mal_vm_try_store_known_own_slots(
                        vm, object, value, data[1], &data[2])) {
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_store_property_static_known_own_slot_fallback(
                        frame, instruction));
                break;
            }
            case MAL_OP_TO_PROPERTY_KEY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_to_property_key(frame, instruction));
                break;
            case MAL_OP_CALL_SPREAD: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_call_spread(frame, instruction));
                break;
            }
            case MAL_OP_CALL_SPREAD_ITERABLE: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(
                    mal_op_call_spread_iterable(frame, instruction));
                break;
            }
            case MAL_OP_CONSTRUCT_SPREAD: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_construct_spread(frame, instruction));
                break;
            }
            case MAL_OP_CONSTRUCT_SUPER: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_construct_super(frame, instruction));
                break;
            }
            case MAL_OP_CONSTRUCT_SUPER_EXPLICIT: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_construct_super_explicit(frame, instruction));
                break;
            }
            case MAL_OP_SET_THIS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_set_this(frame, instruction));
                break;
            case MAL_OP_STORE_SUPER_PROPERTY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_super_property(frame, instruction));
                break;
            case MAL_OP_LOAD_SUPER_PROPERTY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_super_property(frame, instruction));
                break;
            case MAL_OP_LOAD_PROTOTYPE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_prototype(frame, instruction));
                break;
            case MAL_OP_MERGE_DATA_PROPERTIES:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_merge_data_properties(frame, instruction));
                break;
            case MAL_OP_GET_ITERATOR:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_get_iterator(frame, instruction));
                break;
            case MAL_OP_GET_ASYNC_ITERATOR:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_get_async_iterator(frame, instruction));
                break;
            case MAL_OP_ITERATOR_NEXT:
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_iterator_next(frame, instruction));
                break;
            case MAL_OP_ITERATOR_STEP: {
                MalIteratorRecord record = {
                    .iterator = registers[instruction->as.iterator_step.iterator],
                    .next_method = registers[instruction->as.iterator_step.next],
                };
                MalValue value;
                bool done;
                if (mal_vm_iterator_try_dense_array_step(&record, &value, &done)) {
                    registers[instruction->as.iterator_step.value_dst] = value;
                    registers[instruction->as.iterator_step.done_dst] = mal_value_new_boolean(done);
                    MAL_PERF_COUNT(interpreter_iterator_dense_hits);
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_PERF_COUNT(interpreter_iterator_sync_fallbacks);
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_iterator_step(frame, instruction));
                break;
            }
            case MAL_OP_ITERATOR_CLOSE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_iterator_close(frame, instruction));
                break;
            case MAL_OP_FOR_IN_KEYS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_for_in_keys(frame, instruction));
                break;

            case MAL_OP_GENERATOR_START: {
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
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
                    mal_vm_get_property(vm, frame->callee, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE), &prototype_value) &&
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
                // The generator now owns a frame of (possibly young) register values;
                // if it is old, remember it so a minor collection traces that frame.
                mal_gc_remember_if_old(&generator->object.header);

                // Pop without freeing: the storage now belongs to the generator.
                vm->frame_count--;
#if MAL_REALMS
                mal_vm_restore_surviving_realm(vm, outer_realm);
#endif

                MalValue generator_value = mal_value_from_object((MalObject *) generator);
                if (caller_frame_index >= 0) {
                    vm->frames[caller_frame_index].registers[return_register] = generator_value;
                }
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = generator_value};
                break;
            }

            case MAL_OP_YIELD: {
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
                // Suspend the generator frame, leaving the yielded value on the
                // generator and recording where the resume value/mode land. The
                // instruction pointer was already advanced past the yield, so a
                // resume continues with the dispatch that follows it.
                MalGeneratorObject *generator = frame->generator;
                // SATB: yielded_value + frame.env are traced heap fields overwritten
                // here; shade the previous contents (a re-suspend replaces the env
                // from the last suspend). The register buffer is mutated in place
                // (root state until this suspend), so its slots need no shade.
                mal_gc_write_barrier(generator->yielded_value);
                generator->yielded_value = frame->registers[instruction->as.yield.yielded_src];
                generator->resume_value_register = instruction->as.yield.value_dst;
                generator->resume_mode_register = instruction->as.yield.mode_dst;
                generator->state = MAL_GENERATOR_SUSPENDED_YIELD;

                if (generator->frame.env != nullptr) {
                    mal_gc_write_barrier(mal_value_from_heap(&generator->frame.env->header));
                }
                generator->frame = *frame;
                // Re-suspend: an old generator re-acquires its frame + yielded value,
                // both potentially holding young objects produced since it last ran.
                mal_gc_remember_if_old(&generator->object.header);

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
#if MAL_REALMS
                // Yield settlement and any queued-request drain are part of the
                // suspended generator execution; leave its realm only afterwards.
                mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                break;
            }

            case MAL_OP_TERMINAL_YIELD: {
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
                MalGeneratorObject *generator = frame->generator;
                mal_gc_write_barrier(generator->yielded_value);
                generator->yielded_value = frame->registers[instruction->as.terminal_yield.yielded_src];
                generator->state = MAL_GENERATOR_COMPLETED;
                generator->terminal_yield_pending = true;
                generator->frame = *frame;
                mal_gc_remember_if_old(&generator->object.header);

                // The result remains { done: false }, but no later call can resume
                // this activation. Pop before returning its storage to the pool.
                vm->frame_count--;
                mal_generator_release_frame(vm, generator);
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
#if MAL_REALMS
                mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                break;
            }

            case MAL_OP_ASYNC_START: {
                // Set up the async function's result promise + hidden state and
                // hand the promise to the caller, then keep running this frame
                // synchronously until its first await / return / throw.
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_async_function_start(vm, frame));
                break;
            }

            case MAL_OP_AWAIT: {
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
                // Suspend the async frame on the awaited value (mirrors YIELD),
                // then schedule its resumption when the value settles. The
                // instruction pointer already points past the await, so a resume
                // continues with the compiler-emitted resume dispatch.
                MalGeneratorObject *state = frame->generator;
                MalValue awaited = frame->registers[instruction->as.await.awaited_src];
                state->resume_value_register = instruction->as.await.value_dst;
                state->resume_mode_register = instruction->as.await.mode_dst;
                state->state = MAL_GENERATOR_SUSPENDED_YIELD;

                // SATB: frame.env is a traced heap field overwritten by the re-suspend.
                if (state->frame.env != nullptr) {
                    mal_gc_write_barrier(mal_value_from_heap(&state->frame.env->header));
                }
                state->frame = *frame;
                // Re-suspend at await: old async state re-acquires its frame.
                mal_gc_remember_if_old(&state->object.header);

                vm->frame_count--;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
                mal_async_function_await(vm, state, awaited);
#if MAL_REALMS
                // PromiseResolve and the await reactions belong to the suspended
                // async execution; restore the resumer only after they are installed.
                mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                break;
            }
            case MAL_OP_DELETE_PROPERTY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_delete_property(frame, instruction));
                break;
            case MAL_OP_DEFINE_ACCESSOR:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_define_accessor(frame, instruction));
                break;
            case MAL_OP_DEFINE_PROPERTY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_define_property(frame, instruction));
                break;
            case MAL_OP_SET_FUNCTION_NAME:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_set_function_name(frame, instruction));
                break;
            case MAL_OP_CREATE_PRIVATE_NAME:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_private_name(frame, instruction));
                break;
            case MAL_OP_CREATE_PRIVATE_NAMES:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_private_names(frame, instruction));
                break;
            case MAL_OP_DEFINE_PRIVATE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_define_private(frame, instruction));
                break;
            case MAL_OP_INIT_PRIVATE_FIELDS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_init_private_fields(frame, instruction));
                break;
            case MAL_OP_LOAD_PRIVATE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_private(frame, instruction));
                break;
            case MAL_OP_STORE_PRIVATE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_private(frame, instruction));
                break;
            case MAL_OP_HAS_PRIVATE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_has_private(frame, instruction));
                break;
            case MAL_OP_SET_PROTOTYPE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_set_prototype(frame, instruction));
                break;
            case MAL_OP_LOAD_UNDECLARED:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_undeclared(frame, instruction));
                break;
            case MAL_OP_LOAD_GLOBAL_PROPERTY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_load_global_property(frame, instruction));
                break;
            case MAL_OP_STORE_GLOBAL_PROPERTY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_global_property(frame, instruction));
                break;
            case MAL_OP_INIT_GLOBAL_VARS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_init_global_vars(frame, instruction));
                break;
            case MAL_OP_THROW_IF_TDZ:
                if (!mal_value_is_empty(
                        registers[instruction->as.throw_if_tdz.src])) {
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_throw_if_tdz(frame, instruction));
                break;
            case MAL_OP_REQUIRE_COERCIBLE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_require_coercible(frame, instruction));
                break;
            case MAL_OP_CHECK_SUPER_CLASS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_check_super_class(frame, instruction));
                break;
            case MAL_OP_CREATE_REST_ARGUMENTS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_rest_arguments(frame, instruction));
                break;
            case MAL_OP_ARRAY_REST:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_array_rest(frame, instruction));
                break;
            case MAL_OP_COPY_DATA_PROPERTIES:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_copy_data_properties(frame, instruction));
                break;

            case MAL_OP_LOAD_CAPTURED:
                registers[instruction->as.load_captured.dst] = mal_vm_load_captured(
                    frame->env,
                    instruction->as.load_captured.owner_function_index,
                    instruction->as.load_captured.index);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_GUARD_FUNCTION_INDEX:
                registers[instruction->as.guard_function_index.dst] = mal_value_new_boolean(
                    mal_vm_callee_has_index(
                        vm,
                        registers[instruction->as.guard_function_index.callee],
                        instruction->as.guard_function_index.function_index));
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_STORE_CAPTURED:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_store_captured(frame, instruction));
                break;
            case MAL_OP_ENV_PUSH:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_env_push(frame, instruction));
                break;
            case MAL_OP_ENV_COPY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_env_copy(frame, instruction));
                break;
            case MAL_OP_ENV_POP:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_env_pop(frame));
                break;

            case MAL_OP_CALL: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_call(frame, instruction));
                break;
            }
            case MAL_OP_CALL_BUILTIN: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_call_builtin(frame, instruction));
                break;
            }
            case MAL_OP_CONSTRUCT: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_construct(frame, instruction));
                break;
            }

            case MAL_OP_THROW:
                MAL_VM_INTERPRETER_ACTIVATION_BOUNDARY(mal_op_throw(frame, instruction));
                break;
            case MAL_OP_CATCH:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_catch(frame, instruction));
                break;
            case MAL_OP_TRY_BEGIN:
            case MAL_OP_TRY_END:
                // Markers only; protected ranges live in the handler table.
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;

            case MAL_OP_JUMP: {
                bool backedge = instruction->as.jump.target_ip < instruction_pointer;
                instruction_pointer = instruction->as.jump.target_ip;
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                if (backedge && mal_gc_poll) {
                    MAL_VM_INTERPRETER_SYNC();
                    mal_gc_safepoint(vm);
                    frame = &vm->frames[vm->frame_count - 1];
                    instructions = frame->function->instructions;
                    registers = frame->registers;
                    instruction_pointer = frame->instruction_pointer;
                    MAL_PERF_COUNT(interpreter_state_reloads);
                }
                continue;
            }
            case MAL_OP_JUMP_IF: {
                MalValue condition = registers[instruction->as.jump_if.cond];
                bool truthy = mal_value_is_boolean(condition)
                    ? mal_value_to_boolean(condition)
                    : mal_value_is_truthy(condition);
                bool backedge = truthy &&
                    instruction->as.jump_if.target_ip < instruction_pointer;
                if (truthy) {
                    instruction_pointer = instruction->as.jump_if.target_ip;
                }
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                if (backedge && mal_gc_poll) {
                    MAL_VM_INTERPRETER_SYNC();
                    mal_gc_safepoint(vm);
                    frame = &vm->frames[vm->frame_count - 1];
                    instructions = frame->function->instructions;
                    registers = frame->registers;
                    instruction_pointer = frame->instruction_pointer;
                    MAL_PERF_COUNT(interpreter_state_reloads);
                }
                continue;
            }

            case MAL_OP_RETURN: {
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
                MalValue return_value = frame->registers[instruction->as.ret.value];
                if (frame->is_construct && !mal_value_is_object(return_value)) {
                    // ECMA-262 [[Construct]] step 13: a return statement whose value
                    // is not an Object is governed by the constructor kind.
                    if (frame->function->is_derived_constructor) {
                        // Derived: a non-undefined value is a TypeError (13.c); an
                        // undefined value falls through to GetThisBinding (15), which
                        // is a ReferenceError if super() has not bound `this`.
                        MalIntrinsic error_prototype = MAL_INTRINSIC_COUNT;
                        const byte *error_message = nullptr;
                        if (!mal_value_is_undefined(return_value)) {
                            error_prototype = MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE;
                            error_message = "Derived constructors may only return an object or undefined";
                        } else if (mal_value_is_empty(frame->this_value)) {
                            error_prototype = MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE;
                            error_message = "Must call super constructor in derived class before returning from derived constructor";
                        }
                        if (error_message != nullptr) {
#if MAL_REALMS
                            // [[Construct]] performs these checks after removing the
                            // constructor execution context. Allocate the error from
                            // the surviving caller/C-seam realm, then restore the
                            // frame realm for the existing unwind path.
                            MalRealm *frame_realm = vm->current_realm;
                            MalRealm *error_realm = frame->caller_frame_index >= 0
                                ? vm->frames[frame->caller_frame_index].realm
                                : outer_realm;
                            mal_vm_realm_switch_to(vm, error_realm);
#endif
                            mal_vm_throw_error(vm, error_prototype, error_message);
#if MAL_REALMS
                            mal_vm_realm_switch_to(vm, frame_realm);
#endif
                            break;
                        }
                    }
                    // Base (13.b) or derived-returning-undefined: substitute `this`.
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
#if MAL_REALMS
                    mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                } else if (coroutine != nullptr && coroutine->is_async) {
                    // Resolving the result promise is the async function's return.
                    mal_async_function_settle_return(vm, coroutine, return_value);
#if MAL_REALMS
                    mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                } else {
#if MAL_REALMS
                    // Ordinary returns expose the caller before writing its register.
                    mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                    if (caller_frame_index >= 0) {
                        vm->frames[caller_frame_index].registers[return_register] = return_value;
                        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = return_value};
                    } else {
                        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = return_value};
                    }
                }
                if (vm->completion.kind == MAL_COMPLETION_NORMAL && mal_gc_poll) {
                    mal_gc_safepoint(vm);
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
#if MAL_REALMS
                MalRealm *async_realm = vm->frames[async_index].realm;
#endif
                for (i32 i = vm->frame_count - 1; i >= async_index; i--) {
                    mal_vm_pop_frame_storage(vm, &vm->frames[i]);
                }
                vm->frame_count = async_index;
#if MAL_REALMS
                // A synchronous callee may have thrown from another realm. Reject in
                // the completing async execution's realm, matching compiled bodies.
                mal_vm_realm_switch_to(vm, async_realm);
#endif
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
                if (state->is_async_generator) {
                    // An uncaught throw completes the async generator and rejects
                    // the front request.
                    mal_async_generator_throw_done(vm, state, reason);
                } else {
                    state->state = MAL_GENERATOR_COMPLETED;
                    mal_async_function_settle_throw(vm, state, reason);
                }
#if MAL_REALMS
                mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
                break;
            }

            // No handler within this run loop; eagerly pop the frames it owns
            // and let the throw completion propagate to the caller.
            for (i32 i = vm->frame_count - 1; i >= target_frame_count; i--) {
                mal_vm_pop_frame_storage(vm, &vm->frames[i]);
            }

            vm->frame_count = target_frame_count;
#if MAL_REALMS
            mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
            return;
        }
        break;
        }
    }
#if MAL_REALMS
    // Also cover a normal loop exit at a C seam with no surviving interpreter frame.
    mal_vm_restore_surviving_realm(vm, outer_realm);
#endif
}

#undef MAL_VM_INTERPRETER_SYNC
#undef MAL_VM_INTERPRETER_SYNCHRONIZED_CALL
#undef MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER
#undef MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE
#undef MAL_VM_INTERPRETER_ACTIVATION_BOUNDARY
#undef MAL_VM_INTERPRETER_DIRECT_LEAF

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

        MalValue stack;
        if (mal_vm_get_property(vm, value,
                mal_intrinsic_string_key(vm, "stack"), &stack) &&
            mal_value_is_string(stack)) {
            vm->completion = saved;
            mal_vm_print_display(stderr, stack);
            fprintf(stderr, "\n");
            return;
        }

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
    i32 entry_index = callable->function_index;
    const MalFunction *entry = &vm->definition->functions[entry_index];
    MalCompletion script_completion;

    if (entry->compiled != nullptr) {
        // Native-backend entry: invoke directly (no interpreter frame). It returns
        // the module completion value; a throw surfaces via vm->completion. Calls
        // it makes to interpreted functions push their own frames, so the value
        // stack needs no entry activation. The entry takes no args and no creation
        // environment; `this` is OrdinaryCallBindThis'd like the interpreter frame
        // (mal_vm_callee_this in push_function_frame) — globalThis for a sloppy
        // script, undefined for a strict script / module — so LOAD_THIS in the entry
        // (e.g. a `this` inside a `with`, which lowers to LOAD_THIS not GLOBAL_THIS)
        // sees the same value as the interpreter.
        MalValue entry_this = mal_vm_callee_this(vm, entry, mal_value_new_undefined());
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        if (!mal_vm_enter_compiled(vm, entry_index)) {
            script_completion = vm->completion;
        } else {
            MalValue value = entry->compiled(
                vm, entry_this, nullptr, 0, mal_value_new_undefined(), nullptr,
                mal_value_new_undefined(), nullptr
            );
            mal_vm_leave_compiled(vm);
            // A compiled async entry (a top-level-await module) returns its result
            // promise; record it so a rejected module evaluation fails the run,
            // mirroring mal_async_function_start's caller-less branch.
            if (entry->kind == MAL_FUNCTION_KIND_ASYNC) {
                vm->entry_async_promise = value;
            }
            script_completion = vm->completion.kind == MAL_COMPLETION_THROW
                ? vm->completion
                : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
        }
    } else {
        // The entry function takes no arguments, so the marshaling region is empty.
        mal_vm_push_function_frame(vm, entry_index, nullptr, mal_value_new_undefined(), 0, -1, -1);
        mal_vm_run_until_frame_count(
            vm,
            0
#if MAL_REALMS
            , vm->current_realm
#endif
        );
        script_completion = vm->completion;
    }

    // The top-level script has run to completion; capture its result, then run
    // the microtask queue to empty (promise reactions, await resumptions). The
    // drain happens at a baseline frame count so reaction handlers re-enter the
    // interpreter without nesting on a partial activation.
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
    // Re-resolve in case a runtime-eval splice moved the function table while
    // this generator was suspended (function_index is the source of truth).
    const MalFunction *function = &vm->live_definition.functions[generator->frame.function_index];

    // SATB resume seam (concurrent cycle): a suspended coroutine's frame is heap
    // state (traced via the generator cell); resuming migrates it to root state.
    // Shade its current register/arg values into the snapshot BEFORE the resume
    // delivers the sent value / runs the body, or a value published from a
    // coroutine register into an already-black object would be lost (the
    // root-migration window; gc_todo §1). Mirrors the tracer: null-check the frame
    // function before re-resolving (splice-safe) so register_count is read fresh.
    // Folds out off-cycle (mal_gc_marking_active is compile-time 0 non-concurrent).
    if (mal_gc_marking_active && generator->frame.function != nullptr) {
        generator->frame.function = function;
        mal_gc_satb_shade_frame(&generator->frame);
    }

#if MAL_REALMS
    // A resume has no caller seam to cross into the coroutine's realm, so enter it
    // here from the frame's stamped realm. The compiled body never passes through the
    // interpreter's per-dispatch realm re-entry, and the interpreted path must still
    // restore the resumer's realm once the body suspends or completes. Every early
    // return/throw below restores `saved_realm`, so control returns to the driver
    // (a .next() caller, an awaiting microtask) in the realm it drove from.
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, generator->frame.realm);
#endif

    if (function->compiled != nullptr) {
        // Compiled coroutine: no interpreter frame is pushed and no dispatch loop
        // runs. Deliver the sent value + resume mode into the heap register buffer
        // (indexed by register number, as the yield/await recorded), then re-enter
        // the compiled body with resume_state set; its entry dispatch jumps to the
        // saved resume label and the front-end's inline post-suspend dispatch reads
        // the mode. The C-stack / depth guard lives in mal_vm_enter_compiled.
        if (!mal_vm_enter_compiled(vm, generator->frame.function_index)) {
            mal_vm_op_coroutine_throw_compiled(vm, generator, generator->frame.registers);
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            return;
        }
        generator->frame.function = function;
        if (generator->resume_value_register >= 0) {
            generator->frame.registers[generator->resume_value_register] = sent_value;
        }
        if (generator->resume_mode_register >= 0) {
            generator->frame.registers[generator->resume_mode_register] = mal_value_from_i32(resume_mode);
        }
        generator->state = MAL_GENERATOR_EXECUTING;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        // this/env/callee are re-read from generator->frame by the resume path; the
        // args/new_target params are unused on resume (the prologue is skipped).
        function->compiled(vm, generator->frame.this_value, nullptr, 0,
            mal_value_new_undefined(), generator->frame.env, generator->frame.callee, generator);
        mal_vm_leave_compiled(vm);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            generator->state = MAL_GENERATOR_COMPLETED;
        }
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
        return;
    }

    if (vm->frame_count >= vm->frame_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
        return;
    }

    i32 target_frame_count = vm->frame_count;
    MalVmFrame *frame = &vm->frames[vm->frame_count++];
    *frame = generator->frame;
    frame->vm = vm;
    frame->function = function;
    frame->generator = generator;
    frame->return_register = -1;
    frame->caller_frame_index = -1;
    // A resumption is a fresh entry on the logical call stack, so it sorts above
    // whatever drove the resume (a microtask, .next() caller) in a capture.
    frame->enter_seq = vm->frame_seq++;

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

    mal_vm_run_until_frame_count(
        vm,
        target_frame_count
#if MAL_REALMS
        , saved_realm
#endif
    );

    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        // The body threw past its own handlers; the run loop already popped and
        // freed the frame, so the generator is finished.
        generator->state = MAL_GENERATOR_COMPLETED;
    }
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
}

bool mal_vm_enter_compiled(MalVm *vm, i32 function_index) {
    MAL_PERF_COUNT(compiled_enter_calls);
    // Real C-stack guard (robust to per-frame size): refuse when this entry's frame
    // has descended past the reserved margin. Falls back to the fixed depth counter
    // (also a backstop when stack bounds are unavailable). Both throw the same
    // RangeError, so deep compiled recursion unwinds cleanly instead of segfaulting.
    if ((vm->stack_limit != 0 && (uptr) __builtin_frame_address(0) < vm->stack_limit) ||
        vm->native_call_depth >= MAL_NATIVE_CALL_DEPTH_LIMIT) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return false;
    }
    vm->native_call_depth++;

    // Record a native frame for stack traces. The compiled function writes its
    // current source position into pos_id as it runs. Skipped when debug info is
    // stripped (no file table) — keeping the compiled call path overhead-free, in
    // lockstep with the backend, which emits no pos writes in that mode.
    if (vm->definition->file_count == 0) {
        return true;
    }
    MAL_PERF_COUNT(compiled_debug_frame_entries);
    if (vm->native_frame_count == vm->native_frame_capacity) {
        vm->native_frame_capacity = vm->native_frame_capacity == 0 ? 16 : vm->native_frame_capacity * 2;
        vm->native_frames = realloc(vm->native_frames, sizeof(MalNativeFrame) * (usize) vm->native_frame_capacity);
    }
    vm->native_frames[vm->native_frame_count++] = (MalNativeFrame) {
        .function_index = function_index,
        .pos_id = -1,
#if MAL_PROFILE
        .site_id = -1,
#endif
        .enter_seq = vm->frame_seq++,
        .hidden = false,
    };
    return true;
}

void mal_vm_leave_compiled(MalVm *vm) {
    vm->native_call_depth--;
    if (vm->native_frame_count > 0) {
        vm->native_frame_count--;
    }
}

/**
 * Mark the top native frame hidden: the compiled function is bailing to the
 * interpreter, whose pushed frame will represent it instead, so a capture must
 * not show it twice. Called from compiled code at the speculative-unbox bail.
 */
void mal_vm_compiled_bailed(MalVm *vm) {
    if (vm->native_frame_count > 0) {
        vm->native_frames[vm->native_frame_count - 1].hidden = true;
    }
}

/** Source position id for an instruction pointer in a function, or -1. */
static i32 mal_vm_position_for(const MalFunction *function, i32 instruction_pointer) {
    i32 found = -1;
    for (i32 i = 0; i < function->position_count; i++) {
        if (function->positions[i].start_ip <= instruction_pointer) {
            found = function->positions[i].pos_id;
        } else {
            break;
        }
    }
    return found;
}

MalStackTrace *mal_vm_capture_stack(MalVm *vm) {
    // Collect every live frame — interpreted (vm->frames, source of truth: a
    // suspended generator/async frame is naturally absent) and native (skipping
    // bailed duplicates) — then order by enter_seq descending (top first).
    i32 max = vm->frame_count + vm->native_frame_count;
    MalStackFrameRecord *records = malloc(sizeof(MalStackFrameRecord) * (usize) (max > 0 ? max : 1));
    u64 *seqs = malloc(sizeof(u64) * (usize) (max > 0 ? max : 1));
    i32 count = 0;

    for (i32 i = 0; i < vm->frame_count; i++) {
        MalVmFrame *frame = &vm->frames[i];
        // The instruction pointer was advanced past the executing/call
        // instruction, so ip - 1 is the responsible site (as in unwinding).
        i32 ip = frame->instruction_pointer - 1;
        i32 function_index = frame->function_index;
        records[count] = (MalStackFrameRecord) {
            .function_index = function_index,
            .pos_id = mal_vm_position_for(frame->function, ip),
        };
        seqs[count] = frame->enter_seq;
        count++;
    }
    for (i32 i = 0; i < vm->native_frame_count; i++) {
        MalNativeFrame *native = &vm->native_frames[i];
        if (native->hidden) {
            continue;
        }
        records[count] = (MalStackFrameRecord) {
            .function_index = native->function_index,
            .pos_id = native->pos_id,
        };
        seqs[count] = native->enter_seq;
        count++;
    }

    // Insertion sort by seq descending (small, slow-path only).
    for (i32 i = 1; i < count; i++) {
        MalStackFrameRecord record = records[i];
        u64 seq = seqs[i];
        i32 j = i - 1;
        while (j >= 0 && seqs[j] < seq) {
            records[j + 1] = records[j];
            seqs[j + 1] = seqs[j];
            j--;
        }
        records[j + 1] = record;
        seqs[j + 1] = seq;
    }
    free(seqs);

    MalStackTrace *trace = malloc(sizeof(MalStackTrace));
    trace->frame_count = count;
    trace->frames = records;
    trace->async_parent = nullptr;
    trace->frame_skip = 0;
    trace->frame_limit = -1;

    // Async stack stitching (v2): if execution is inside a resumed async
    // function, follow the awaited_by chain to splice the awaiting ancestors'
    // suspended frames in as async-parent segments. The running async function
    // is the first async frame on the live stack; its awaiter (and theirs) is
    // suspended and so absent from vm->frames — reconstructed here from the
    // links recorded at await time. Near-zero cost: it only walks pointers that
    // already exist, and only on this slow capture path.
    MalGeneratorObject *async_state = nullptr;
    for (i32 i = 0; i < vm->frame_count; i++) {
        if (vm->frames[i].generator != nullptr && vm->frames[i].generator->is_async) {
            async_state = vm->frames[i].generator;
            break;
        }
    }
    MalStackTrace **link = &trace->async_parent;
    i32 guard = 0;
    while (async_state != nullptr && async_state->awaited_by != nullptr && guard++ < 100000) {
        MalGeneratorObject *parent = async_state->awaited_by;
        const MalFunction *function = parent->frame.function;
        MalStackTrace *segment = malloc(sizeof(MalStackTrace));
        segment->frame_count = 1;
        segment->frames = malloc(sizeof(MalStackFrameRecord));
        // The awaiter is suspended at its `await`; ip - 1 is that await's site.
        segment->frames[0] = (MalStackFrameRecord) {
            .function_index = parent->frame.function_index,
            .pos_id = mal_vm_position_for(function, parent->frame.instruction_pointer - 1),
        };
        segment->async_parent = nullptr;
        segment->frame_skip = 0;
        segment->frame_limit = -1;
        *link = segment;
        link = &segment->async_parent;
        async_state = parent;
    }

    return trace;
}

void mal_vm_free_stack_trace(MalStackTrace *trace) {
    while (trace != nullptr) {
        MalStackTrace *parent = trace->async_parent;
        free(trace->frames);
        free(trace);
        trace = parent;
    }
}

i32 mal_vm_store_stack_trace(MalVm *vm, MalStackTrace *trace) {
    i32 id;
    if (vm->captured_trace_free_head >= 0) {
        id = vm->captured_trace_free_head;
        vm->captured_trace_free_head = vm->captured_trace_free_next[id];
    } else {
        if (vm->captured_trace_count == vm->captured_trace_capacity) {
            vm->captured_trace_capacity = vm->captured_trace_capacity == 0
                ? 16 : vm->captured_trace_capacity * 2;
            vm->captured_traces = realloc(
                vm->captured_traces,
                sizeof(MalStackTrace *) * (usize) vm->captured_trace_capacity);
            vm->captured_trace_free_next = realloc(
                vm->captured_trace_free_next,
                sizeof(i32) * (usize) vm->captured_trace_capacity);
        }
        id = vm->captured_trace_count++;
    }
    vm->captured_traces[id] = trace;
    vm->captured_trace_free_next[id] = -1;
    vm->captured_trace_live_count++;
    MAL_PERF_COUNT(error_stack_trace_stores);
    if (mal_perf_stats_enabled
        && (u64) vm->captured_trace_live_count
            > mal_perf_stats.error_stack_trace_peak_live) {
        mal_perf_stats.error_stack_trace_peak_live =
            (u64) vm->captured_trace_live_count;
    }
    return id;
}

MalStackTrace *mal_vm_stored_stack_trace(MalVm *vm, i32 id) {
    if (id < 0 || id >= vm->captured_trace_count) {
        return nullptr;
    }
    return vm->captured_traces[id];
}

void mal_vm_release_stack_trace(MalVm *vm, i32 id) {
    if (id < 0 || id >= vm->captured_trace_count
        || vm->captured_traces[id] == nullptr) {
        return;
    }
    mal_vm_free_stack_trace(vm->captured_traces[id]);
    vm->captured_traces[id] = nullptr;
    vm->captured_trace_free_next[id] = vm->captured_trace_free_head;
    vm->captured_trace_free_head = id;
    vm->captured_trace_live_count--;
    MAL_PERF_COUNT(error_stack_trace_releases);
}

typedef MalU16Buffer MalStackBuf;

static void mal_stack_buf_require(MalU16BufferStatus status) {
    // Stack formatting has no completion channel; preserve its infallible contract.
    if (status != MAL_U16_BUFFER_OK) {
        abort();
    }
}

static void mal_stack_buf_push_ascii(MalStackBuf *buf, const char *text) {
    mal_stack_buf_require(mal_u16_buffer_append_ascii(buf, (const byte *) text));
}

static void mal_stack_buf_push_string(MalStackBuf *buf, const MalString *string) {
    mal_stack_buf_require(mal_u16_buffer_append_string(buf, string));
}

static void mal_stack_buf_push_i32(MalStackBuf *buf, i32 value) {
    char digits[16];
    snprintf(digits, sizeof(digits), "%d", value);
    mal_stack_buf_push_ascii(buf, digits);
}

MalString *mal_vm_format_stack_frames(MalVm *vm, const MalStackTrace *trace) {
    MalStackBuf buf = {0};
    i32 logical_index = 0;
    i32 emitted = 0;

    for (const MalStackTrace *segment = trace; segment != nullptr; segment = segment->async_parent) {
        bool emitted_segment = false;
        if (segment != trace && emitted > 0) {
            // Async-boundary separator (v2): frames below were the awaiting context.
            emitted_segment = true;
        }
        for (i32 i = 0; i < segment->frame_count; i++) {
            const MalStackFrameRecord *record = &segment->frames[i];

            // Expand the inline chain: a position copied in by the inliner carries
            // the inlined function's identity and the caller position where it was
            // inlined, so one physical frame prints as several logical frames
            // (innermost inlined function first, physical function last). A
            // physical position (inlined_function_index < 0) prints exactly one.
            i32 pos_id = record->pos_id;
            i32 guard = 0;
            while (guard++ < 100000) {
                bool have_pos = pos_id >= 0 && pos_id < vm->definition->source_position_count;
                const MalSourcePos *pos = have_pos ? &vm->definition->source_positions[pos_id] : nullptr;
                bool inlined = pos != nullptr && pos->inlined_function_index >= 0 &&
                    pos->inlined_function_index < vm->definition->function_count;
                i32 function_index = inlined ? pos->inlined_function_index : record->function_index;
                const MalFunction *function = &vm->definition->functions[function_index];

                if (logical_index++ < trace->frame_skip) {
                    if (!inlined) {
                        break;
                    }
                    pos_id = pos->caller_pos_id;
                    continue;
                }
                if (trace->frame_limit >= 0 && emitted >= trace->frame_limit) {
                    goto done;
                }
                if (emitted_segment) {
                    mal_stack_buf_push_ascii(&buf, "\n    --- await ---");
                    emitted_segment = false;
                }
                emitted++;

                mal_stack_buf_push_ascii(&buf, "\n    at ");

                const MalString *name = &vm->definition->string_constants[function->name_string_index];
                if (mal_string_length(name) > 0) {
                    mal_stack_buf_push_string(&buf, name);
                } else {
                    mal_stack_buf_push_ascii(&buf, "<anonymous>");
                }

                bool have_file = function->file_index >= 0 && function->file_index < vm->definition->file_count;
                if (have_file || have_pos) {
                    mal_stack_buf_push_ascii(&buf, " (");
                    if (have_file) {
                        mal_stack_buf_push_ascii(&buf, vm->definition->files[function->file_index]);
                    }
                    if (have_pos) {
                        mal_stack_buf_push_ascii(&buf, ":");
                        mal_stack_buf_push_i32(&buf, pos->line);
                        mal_stack_buf_push_ascii(&buf, ":");
                        // Meriyah columns are 0-based; stack traces report 1-based.
                        mal_stack_buf_push_i32(&buf, pos->column + 1);
                    }
                    mal_stack_buf_push_ascii(&buf, ")");
                }

                if (!inlined) {
                    break;
                }
                pos_id = pos->caller_pos_id;
            }
        }
    }

done:

    return mal_u16_buffer_finish(&vm->heap, &buf);
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

#if MAL_REALMS
    // Re-entrant / native->JS entry: this run loop has no caller frame to restore
    // from, so bracket the callee's realm at this outer C seam. Entering before the
    // push stamps the frame with the callee realm; restoring after the nested loop
    // drains covers both the normal return and a throw that propagated out of it.
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
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
        mal_vm_run_until_frame_count(
            vm,
            target_frame_count
#if MAL_REALMS
            , saved_realm
#endif
        );
    } else {
        vm->value_stack_size = base;
    }
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif

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

MalValue mal_vm_run_entry_with_scope(MalVm *vm, i32 function_index, MalValue scope_object,
                                     MalValue this_value, MalValue new_target,
                                     MalValue dirty_tracker, MalValue persistent_scope) {
    // Push the (spliced) eval entry, then inject the caller scope object into the
    // fresh frame's with-stack BEFORE running its body, so direct-eval free
    // identifiers (compiled as with-dynamic reads) resolve against it. Mirrors
    // mal_vm_interpret_function's push + run, but with the injection in between —
    // hence not routed through mal_vm_call_value.
    i32 baseline = vm->frame_count;
    if (!mal_vm_push_function_frame(vm, function_index, nullptr, this_value, 0, -1, -1)) {
        return mal_value_new_undefined(); // pending RangeError (call stack)
    }
    MalVmFrame *frame = &vm->frames[vm->frame_count - 1];
    // Direct eval runs in the caller's `this`/new.target (GetThisEnvironment /
    // GetNewTarget resolve against the calling context).
    frame->this_value = this_value;
    frame->new_target = new_target;
    // The caller's scope object resolves free names in the eval'd code: expose it as
    // a with object environment record on the frame's env chain (WITH_GET walks it).
    // The second slot carries the caller's dirty tracker (mal_vm_op_with_set marks
    // it on a real Set) — a plain with-enter (mal_env_new_with_object) never has one.
    MalEnv *scope_env = mal_env_new(vm, frame->env, MAL_ENV_WITH_OBJECT, 2);
    scope_env->slots[0] = scope_object;
    scope_env->slots[1] = dirty_tracker;
    frame->env = scope_env;
    if (mal_value_is_object(persistent_scope)) {
        MalEnv *persistent_env = mal_env_new(vm, frame->env, MAL_ENV_WITH_OBJECT, 1);
        persistent_env->slots[0] = persistent_scope;
        frame->env = persistent_env;
    }

    mal_vm_run_until_frame_count(
        vm,
        baseline
#if MAL_REALMS
        , vm->current_realm
#endif
    );
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
                                                       : vm->completion.value;
}

/**
 * ECMAScript class constructors have [[Construct]] but no [[Call]]. Keep this at
 * the shared script-function entry seam so generic dispatch and compiler-proven
 * runtime calls reject the body before it can run. Ordinary-call caches refuse
 * to admit classes at fill time, leaving their hit paths unchanged. Callers
 * invoke this after entering (or proving they are already in) the callee Realm,
 * which gives the TypeError the same intrinsic provenance as every other
 * script-call failure.
 */
bool mal_vm_require_ordinary_call_target(
    MalVm *vm,
    const MalFunction *function
) {
    if (!function->is_class_constructor) {
        return true;
    }
    mal_vm_throw_error(
        vm,
        MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Class constructor cannot be invoked without 'new'");
    return false;
}

MalCompletion mal_vm_call_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        // A pending throw poisons further calls, so iterating natives without
        // explicit bail-outs cannot clobber the original error.
        return vm->completion;
    }

    // A callable proxy routes [[Call]] through its apply trap.
    if (mal_value_is_proxy_object(callee)) {
        MalCompletion proxy_completion =
            mal_proxy_apply(vm, mal_value_to_proxy_object(callee), this_value, args, arg_count);
#if MAL_PROFILE && MAL_PERF_STATS
        vm->profile_current_site_id = saved_profile_site;
#endif
        return proxy_completion;
    }

    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, args, arg_count, true);
    MalCompletion completion = {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

#if MAL_REALMS
    // Enter the resolved callee's realm for the whole body invocation — the native
    // callback, the compiled body, or the nested interpreter loop below — and restore
    // it before returning on both normal completion and a pending throw. Bound
    // resolution above ran in the caller's realm (the proxy path returned earlier, so
    // a proxy stays in the caller realm until its trap runs). Same-realm calls skip
    // the switch entirely.
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, resolution.callee));
#endif

    if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionObject *native_function =
            mal_value_to_native_function_object(resolution.callee);
        MAL_PROFILE_NATIVE_CALL(vm, native_function);
        MalNativeFunctionCallback callback = mal_native_function_object_callback(native_function);
        // A native builtin holds its MalValue scratch (receiver, partial results)
        // in C locals the root scan cannot see, and many re-enter JS for callbacks
        // (where a safepoint could otherwise collect). Count it as a live C frame
        // so the collector stays off until it returns. A builtin that has rooted
        // its scratch lifts that suppression itself; the receiver/args/new.target
        // are rooted here so they survive such a collection.
        MalCalleeRoots ncr;
        mal_gc_callee_roots_begin(&ncr, resolution.this_value, mal_value_new_undefined(),
                                  resolution.callee, resolution.args, resolution.arg_count);
        vm->gc_native_frames++;
        MalValue value = callback(vm, resolution.this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), resolution.callee);
        vm->gc_native_frames--;
        mal_gc_callee_roots_end(&ncr);
        completion = vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    } else if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        const MalFunction *function = &vm->definition->functions[function_index];
        MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

        if (!mal_vm_require_ordinary_call_target(vm, function)) {
            completion = vm->completion;
        } else if (function->compiled != nullptr) {
            // Native-backend function: invoke directly (no stack marshaling). The
            // C stack, not the value stack, bounds this recursion.
            if (!mal_vm_enter_compiled(vm, function_index)) {
                completion = vm->completion;
            } else {
                MalValue this_value = mal_vm_callee_this(vm, function, resolution.this_value);
                MalValue value = function->compiled(vm, this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), env, resolution.callee, nullptr);
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

#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
    vm->profile_current_site_id = saved_profile_site;
#endif
    return completion;
}

MalCompletion mal_vm_call_cached(
    MalVm *vm,
    MalCallCache *cc,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }
    MAL_PERF_COUNT(call_cache_probes);

    MalFunctionObject *function_object = nullptr;
    const MalFunction *function = nullptr;
    i32 function_index = -1;

    bool exact_identities_valid =
        cc->heap_identity == vm->heap.identity && cc->epoch == vm->heap.epoch;

    // Compiled closures are a function-index family: each live closure supplies
    // its own environment, realm, identity, and `this`, so the cached pointer is
    // only useful for attributing an exact hit. Resolve the current index once
    // and scan the ways once instead of first failing an identity scan for every
    // fresh closure and then repeating the scan by function index.
    if (mal_value_is_function_object(callee)) {
        function_object = mal_value_to_function_object(callee);
        function_index = mal_function_object_function_index(function_object);
        if (function_index >= 0 && function_index < vm->definition->function_count) {
            const MalFunction *candidate = &vm->definition->functions[function_index];
            if (candidate->compiled != nullptr) {
                function = candidate;
                for (u32 v = 0; v < cc->count; v++) {
                    MAL_PERF_COUNT(call_cache_way_checks);
                    if (cc->kind[v] != MAL_CALL_CACHE_COMPILED ||
                        cc->function_index[v] != function_index) {
                        continue;
                    }
                    if (exact_identities_valid && cc->callee[v] == callee) {
                        MAL_PERF_COUNT(call_cache_exact_identity_hits);
                        MAL_PERF_COUNT(call_cache_compiled_exact_hits);
                    } else {
                        MAL_PERF_COUNT(call_cache_compiled_family_hits);
                    }
                    goto call_compiled;
                }
            }
        }
    } else if (exact_identities_valid && mal_value_is_native_function_object(callee)) {
        // Native callbacks are cacheable only by exact object identity. The
        // cached pointer must never be reused outside its heap lifetime/epoch.
        for (u32 v = 0; v < cc->count; v++) {
            MAL_PERF_COUNT(call_cache_way_checks);
            if (cc->kind[v] != MAL_CALL_CACHE_NATIVE || cc->callee[v] != callee) {
                continue;
            }
            MalNativeFunctionObject *native_function =
                mal_value_to_native_function_object(callee);
            MAL_PROFILE_NATIVE_CALL(vm, native_function);
            MalNativeFunctionCallback callback =
                mal_native_function_object_callback(native_function);
            MAL_PERF_COUNT(call_cache_exact_identity_hits);
            MAL_PERF_COUNT(call_cache_native_exact_hits);
            MalString *native_name = mal_native_function_object_name(
                mal_value_to_native_function_object(callee));
            if (native_name != nullptr) {
                mal_perf_native_call_name(
                    mal_string_code_units(native_name), mal_string_length(native_name));
            }
#if MAL_REALMS
            MalRealm *saved_realm = vm->current_realm;
            mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
            MalCalleeRoots ncr;
            mal_gc_callee_roots_begin(&ncr, this_value, mal_value_new_undefined(),
                                      callee, args, arg_count);
            vm->gc_native_frames++;
#if MAL_PROFILE && MAL_PERF_STATS
            i32 saved_profile_site = vm->profile_current_site_id;
#endif
            MalValue value = callback(
                vm, this_value, args, arg_count, mal_value_new_undefined(), callee);
#if MAL_PROFILE && MAL_PERF_STATS
            vm->profile_current_site_id = saved_profile_site;
#endif
            vm->gc_native_frames--;
            mal_gc_callee_roots_end(&ncr);
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            return vm->completion.kind == MAL_COMPLETION_THROW
                ? vm->completion
                : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
        }
    }

    MAL_PERF_COUNT(call_cache_dispatch_misses);
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    // Bound/proxy/interpreted callees and class constructors stay on the dispatch
    // path. Re-read the definition row after the call because eval/new Function may
    // have realloc'd it.
    if (mal_value_is_function_object(callee)) {
        i32 index = mal_function_object_function_index(mal_value_to_function_object(callee));
        if (index >= 0 && index < vm->definition->function_count &&
            vm->definition->functions[index].compiled != nullptr &&
            !vm->definition->functions[index].is_class_constructor) {
            if (cc->heap_identity != vm->heap.identity || cc->epoch != vm->heap.epoch) {
                cc->count = 0;
                cc->heap_identity = vm->heap.identity;
                cc->epoch = vm->heap.epoch;
            }
            bool present = false;
            for (u32 v = 0; v < cc->count; v++) {
                present = present ||
                    (cc->kind[v] == MAL_CALL_CACHE_COMPILED && cc->function_index[v] == index);
            }
            if (!present && cc->count < MAL_CALL_CACHE_WAYS) {
                u32 v = cc->count++;
                cc->callee[v] = callee;
                cc->function_index[v] = index;
                cc->kind[v] = MAL_CALL_CACHE_COMPILED;
                MAL_PERF_COUNT(call_cache_compiled_fills);
            }
        }
    } else if (mal_value_is_native_function_object(callee)) {
        if (cc->heap_identity != vm->heap.identity || cc->epoch != vm->heap.epoch) {
            cc->count = 0;
            cc->heap_identity = vm->heap.identity;
            cc->epoch = vm->heap.epoch;
        }
        bool present = false;
        for (u32 v = 0; v < cc->count; v++) {
            present = present ||
                (cc->kind[v] == MAL_CALL_CACHE_NATIVE && cc->callee[v] == callee);
        }
        if (!present && cc->count < MAL_CALL_CACHE_WAYS) {
            u32 v = cc->count++;
            cc->callee[v] = callee;
            cc->function_index[v] = -1;
            cc->kind[v] = MAL_CALL_CACHE_NATIVE;
            MAL_PERF_COUNT(call_cache_native_fills);
        }
    }
    return completion;

call_compiled:
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
    if (!mal_vm_enter_compiled(vm, function_index)) {
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
#if MAL_PROFILE && MAL_PERF_STATS
        vm->profile_current_site_id = saved_profile_site;
#endif
        return vm->completion;
    }
    MalValue tv = mal_vm_callee_this(vm, function, this_value);
    MalValue value = function->compiled(
        vm, tv, args, arg_count, mal_value_new_undefined(), function_object->creation_env,
        callee, nullptr
    );
    mal_vm_leave_compiled(vm);
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
#if MAL_PROFILE && MAL_PERF_STATS
    vm->profile_current_site_id = saved_profile_site;
#endif
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? vm->completion
        : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
}

MalCompletion mal_vm_call_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    i32 expected_function_index,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }
    if (!mal_value_is_function_object(callee) ||
        expected_function_index < 0 ||
        expected_function_index >= vm->definition->function_count) {
        return mal_vm_call_cached(
            vm, fallback_cache, callee, this_value, args, arg_count);
    }

    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    i32 function_index = mal_function_object_function_index(function_object);
    if (function_index != expected_function_index) {
        return mal_vm_call_cached(
            vm, fallback_cache, callee, this_value, args, arg_count);
    }

    const MalFunction *function = &vm->definition->functions[function_index];
    MalEnv *env = function_object->creation_env;
    MalCompletion completion;

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif

    if (!mal_vm_require_ordinary_call_target(vm, function)) {
        completion = vm->completion;
    } else if (function->compiled != nullptr) {
        if (!mal_vm_enter_compiled(vm, function_index)) {
            completion = vm->completion;
        } else {
            MalValue callee_this = mal_vm_callee_this(vm, function, this_value);
            MalValue value = function->compiled(
                vm, callee_this, args, arg_count, mal_value_new_undefined(),
                env, callee, nullptr);
            mal_vm_leave_compiled(vm);
            completion = vm->completion.kind == MAL_COMPLETION_THROW
                ? vm->completion
                : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
        }
    } else {
        mal_vm_interpret_function(
            vm, function_index, callee, this_value, args, arg_count,
            mal_value_new_undefined(), env);
        completion = vm->completion;
    }

#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    return completion;
}

MalCompletion mal_vm_call_function_call_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    i32 expected_function_index,
    MalValue call_method,
    MalValue target,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }
    if (call_method != vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL] ||
        !mal_value_is_native_function_object(call_method)) {
        return mal_vm_call_cached(
            vm, fallback_cache, call_method, target, args, arg_count);
    }

    MalValue this_value = arg_count > 0 ? args[0] : mal_value_new_undefined();
    const MalValue *target_args = arg_count > 1 ? args + 1 : nullptr;
    i32 target_arg_count = arg_count > 1 ? arg_count - 1 : 0;
    if (expected_function_index >= 0) {
        return mal_vm_call_direct(
            vm, fallback_cache, expected_function_index, target, this_value,
            target_args, target_arg_count);
    }
    return mal_vm_call_cached(
        vm, fallback_cache, target, this_value, target_args, target_arg_count);
}

MalCompletion mal_vm_construct_value(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count) {
    return mal_vm_construct_value_with_target(vm, callee, args, arg_count, callee);
}

MalCompletion mal_vm_construct_direct(
    MalVm *vm,
    i32 expected_function_index,
    MalValue callee,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }
    if (!mal_value_is_function_object(callee) ||
        expected_function_index < 0 ||
        expected_function_index >= vm->definition->function_count) {
        return mal_vm_construct_value(vm, callee, args, arg_count);
    }

    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    i32 function_index = mal_function_object_function_index(function_object);
    if (function_index != expected_function_index) {
        return mal_vm_construct_value(vm, callee, args, arg_count);
    }

    const MalFunction *function = &vm->definition->functions[function_index];
    if (function->kind != MAL_FUNCTION_KIND_NORMAL || !function->has_prototype) {
        return mal_vm_construct_value(vm, callee, args, arg_count);
    }

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif

    MalValue this_value;
    if (function->is_derived_constructor) {
        this_value = mal_value_new_empty();
    } else {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, callee, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            return vm->completion;
        }
        this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }

    MalEnv *env = function_object->creation_env;
    MalCompletion completion;
    if (function->compiled != nullptr) {
        if (!mal_vm_enter_compiled(vm, function_index)) {
            completion = vm->completion;
        } else {
            MalCalleeRoots ncr;
            mal_gc_callee_roots_begin(
                &ncr, this_value, callee, callee, args, arg_count);
            MalValue value = function->compiled(
                vm, this_value, args, arg_count, callee, env, callee, nullptr);
            mal_gc_callee_roots_end(&ncr);
            mal_vm_leave_compiled(vm);
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                completion = vm->completion;
            } else if (function->is_derived_constructor && mal_value_is_empty(value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
                    "Must call super constructor in derived class before returning from derived constructor");
                completion = vm->completion;
            } else if (function->is_derived_constructor && !mal_value_is_object(value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Derived constructors may only return an object or undefined");
                completion = vm->completion;
            } else {
                completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
            }
        }
    } else if (vm->value_stack_size + arg_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Maximum call stack size exceeded");
        completion = vm->completion;
    } else {
        i32 base = vm->value_stack_size;
        for (i32 i = 0; i < arg_count; i++) {
            vm->value_stack[base + i] = args[i];
        }
        vm->value_stack_size = base + arg_count;

        i32 target_frame_count = vm->frame_count;
        if (mal_vm_push_function_frame(
                vm, function_index, env, this_value, arg_count, -1, -1)) {
            vm->frames[vm->frame_count - 1].is_construct = true;
            vm->frames[vm->frame_count - 1].callee = callee;
            vm->frames[vm->frame_count - 1].new_target = callee;
            mal_vm_run_until_frame_count(
                vm,
                target_frame_count
#if MAL_REALMS
                , saved_realm
#endif
            );
        } else {
            vm->value_stack_size = base;
        }
        completion = vm->completion;
    }

#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    return completion;
}

MalCompletion mal_vm_construct_value_with_target(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target) {
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }

    // A constructable proxy routes [[Construct]] through its construct trap.
    if (mal_value_is_proxy_object(callee)) {
        MalCompletion proxy_completion =
            mal_proxy_construct(vm, mal_value_to_proxy_object(callee), args, arg_count, new_target);
#if MAL_PROFILE && MAL_PERF_STATS
        vm->profile_current_site_id = saved_profile_site;
#endif
        return proxy_completion;
    }

    // [[Construct]] ignores the bound this.
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, mal_value_new_undefined(), args, arg_count, false);
    MalCompletion completion = {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // BoundFunctionCreate [[Construct]]: a new.target that is the bound function
    // itself becomes the (unwrapped) target. This also yields new.target = the
    // resolved constructor for the default `new callee()` case.
    MalValue effective_new_target = new_target == callee ? resolution.callee : new_target;

    // EvaluateNew's IsConstructor failure belongs to the caller's running
    // execution context. Validate before crossing into a stamped callee realm.
    if (!mal_vm_is_constructor(vm, resolution.callee)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
        free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
        vm->profile_current_site_id = saved_profile_site;
#endif
        return vm->completion;
    }

#if MAL_REALMS
    // Enter the target constructor's realm before any default allocation (the `this`
    // object built from %Object.prototype%, or a native's own instance) or body
    // invocation, so the instance and the intrinsics it draws on come from the
    // constructor's realm. Restored at every exit below. Bound resolution and the
    // proxy path (returned earlier) ran in the caller realm; a non-constructor callee
    // resolves to the current realm here, making this a no-op on the throwing paths.
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, resolution.callee));
#endif

    if (mal_value_is_native_function_object(resolution.callee)) {
        // Native constructors allocate their own this; new_target signals construct.
        MalNativeFunctionObject *native_function =
            mal_value_to_native_function_object(resolution.callee);
        MAL_PROFILE_NATIVE_CALL(vm, native_function);
        MalNativeFunctionCallback callback =
            mal_native_function_object_callback(native_function);
        MalCalleeRoots ncr;
        mal_gc_callee_roots_begin(&ncr, mal_value_new_undefined(), effective_new_target,
                                  resolution.callee, resolution.args, resolution.arg_count);
        vm->gc_native_frames++;
        MalValue value = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count, effective_new_target, resolution.callee);
        vm->gc_native_frames--;
        mal_gc_callee_roots_end(&ncr);
        MalValue native_roots[] = {value, effective_new_target, resolution.callee};
        MalRootSpan native_root;
        mal_gc_root(&native_root, native_roots, countof(native_roots));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&native_root);
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
            vm->profile_current_site_id = saved_profile_site;
#endif
            return vm->completion;
        }

        // Native constructors allocate internally. If one returned an object with
        // an intrinsic prototype, reapply OrdinaryCreateFromConstructor when
        // new.target differs. A non-intrinsic prototype was already selected by
        // the native and must not trigger a second observable prototype lookup.
        bool dynamic_function_constructor =
            resolution.callee == vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR] ||
            resolution.callee == vm->intrinsics[MAL_INTRINSIC_GENERATOR_FUNCTION_CONSTRUCTOR] ||
            resolution.callee == vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_CONSTRUCTOR] ||
            resolution.callee == vm->intrinsics[MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR];
        if (!dynamic_function_constructor && mal_value_is_object(value) &&
            effective_new_target != resolution.callee &&
            mal_value_is_object(effective_new_target)) {
            MalObject *value_object = mal_value_to_object(value);
            MalObject *native_prototype = mal_object_get_prototype(value_object);
            MalIntrinsic default_proto = MAL_INTRINSIC_OBJECT_PROTOTYPE;
            bool found_default = false;
            if (native_prototype != nullptr) {
                MalValue native_prototype_value = mal_value_from_object(native_prototype);
                for (i32 slot = 0; slot < MAL_INTRINSIC_COUNT; slot++) {
                    if (vm->intrinsics[slot] == native_prototype_value) {
                        default_proto = (MalIntrinsic) slot;
                        found_default = true;
                        break;
                    }
                }
            }

            MalObject *derived_prototype;
            if (found_default) {
                if (!mal_vm_get_prototype_from_constructor(
                        vm, effective_new_target, default_proto, &derived_prototype)) {
                    mal_gc_unroot(&native_root);
#if MAL_REALMS
                    mal_vm_realm_switch_to(vm, saved_realm);
#endif
                    free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
                    vm->profile_current_site_id = saved_profile_site;
#endif
                    return vm->completion;
                }
                mal_object_set_prototype(value_object, derived_prototype);
            }
        }
        completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
        mal_gc_unroot(&native_root);
    } else if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        const MalFunction *function = &vm->definition->functions[function_index];
        if (function->kind != MAL_FUNCTION_KIND_NORMAL || !function->has_prototype) {
            // Not a constructor: generators/async (non-normal kind) and, among
            // normal-kind functions, methods/getters/setters/arrows (which own no
            // `prototype`, unlike normal functions and class constructors).
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            completion = vm->completion;
        } else {
            MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

            // A derived constructor's `this` is uninitialized until super() binds
            // it (ECMA-262 [[ThisBindingStatus]] = uninitialized): allocate no
            // eager instance and hand the frame the EMPTY sentinel, so any `this`
            // read before super() throws ReferenceError.
            MalValue this_value;
            if (function->is_derived_constructor) {
                this_value = mal_value_new_empty();
            } else {
                // OrdinaryCreateFromConstructor: allocate `this` from new.target's
                // `.prototype`, with the fallback taken from new.target's realm.
                MalObject *prototype;
                if (!mal_vm_get_prototype_from_constructor(
                        vm, effective_new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
#if MAL_REALMS
                    mal_vm_realm_switch_to(vm, saved_realm);
#endif
                    free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
                    vm->profile_current_site_id = saved_profile_site;
#endif
                    return vm->completion;
                }
                this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
            }

            if (function->compiled != nullptr) {
                // Native-backend constructor: the compiled body returns enough raw
                // state for the post-body derived-result checks below.
                if (!mal_vm_enter_compiled(vm, function_index)) {
                    completion = vm->completion;
                } else {
                    // The instance exists only as this_value until the body stores
                    // it, so root it (plus new.target/args) for the call: a
                    // collection inside the constructor would otherwise sweep it.
                    MalCalleeRoots ncr;
                    mal_gc_callee_roots_begin(&ncr, this_value, effective_new_target,
                                              resolution.callee, resolution.args,
                                              resolution.arg_count);
                    MalValue value = function->compiled(vm, this_value, resolution.args, resolution.arg_count, effective_new_target, env, resolution.callee, nullptr);
                    mal_gc_callee_roots_end(&ncr);
                    mal_vm_leave_compiled(vm);
                    // Direct eval may splice a definition and reallocate the function table
                    // while the compiled constructor runs. The stable index survives; the
                    // pre-call pointer does not.
                    function = &vm->definition->functions[function_index];
#if MAL_REALMS
                    mal_vm_realm_switch_to(vm, saved_realm);
#endif
                    if (vm->completion.kind == MAL_COMPLETION_THROW) {
                        completion = vm->completion;
                    } else if (function->is_derived_constructor && mal_value_is_empty(value)) {
                        mal_vm_throw_error(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
                            "Must call super constructor in derived class before returning from derived constructor");
                        completion = vm->completion;
                    } else if (function->is_derived_constructor && !mal_value_is_object(value)) {
                        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                            "Derived constructors may only return an object or undefined");
                        completion = vm->completion;
                    } else {
                        completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
                    }
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
                    mal_vm_run_until_frame_count(
                        vm,
                        target_frame_count
#if MAL_REALMS
                        , saved_realm
#endif
                    );
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

#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
    vm->profile_current_site_id = saved_profile_site;
#endif
    return completion;
}

MalString *mal_vm_callable_name(MalVm *vm, MalValue callee) {
    if (mal_value_is_native_function_object(callee)) {
        return mal_native_function_object_name(mal_value_to_native_function_object(callee));
    }

    if (mal_value_is_bound_function_object(callee)) {
        // The bound function's initial display name is not preserved separately;
        // the configurable public `name` property is not a stable substitute.
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

/**
 * Intern portable literal-shape descriptors into this VM's dense cache. Static
 * compiled output and the wire format carry the same portable table directly.
 * Keep this startup/splice-only path after the runtime's hot call machinery so
 * it does not perturb that code's layout.
 */
static void mal_vm_materialize_precompiled_literal_shapes(
    MalVm *vm, const MalVmDefinition *definition, i32 function_base, i32 string_base
) {
    for (i32 index = 0; index < definition->precompiled_literal_shape_count; index++) {
        const MalPrecompiledLiteralShape *descriptor =
            &definition->precompiled_literal_shapes[index];
        i32 function_index = descriptor->function_index + function_base;
        if (function_index < 0
            || function_index >= vm->definition->function_count
            || descriptor->shape_cache_index < 0
            || descriptor->key_count < 1
            || descriptor->key_count > MAL_SHAPE_MAX_INLINE_SLOTS) {
            continue;
        }
        const MalFunction *function = &vm->definition->functions[function_index];
        if (descriptor->shape_cache_index >= function->literal_shape_count) continue;
        MalShape **row = vm->literal_shape_cache[function_index];
        if (row != nullptr && row[descriptor->shape_cache_index] != nullptr) continue;

        MalString *keys[MAL_SHAPE_MAX_INLINE_SLOTS];
        bool valid = true;
        for (i32 key = 0; key < descriptor->key_count; key++) {
            i32 string_index = descriptor->key_string_indices[key] + string_base;
            if (string_index < 0
                || string_index >= vm->definition->string_constant_count
                || vm->string_constant_atoms[string_index] == nullptr) {
                valid = false;
                break;
            }
            keys[key] = vm->string_constant_atoms[string_index];
        }
        if (!valid) continue;
        row = mal_vm_ensure_literal_shape_cache(vm, function_index);
        if (row != nullptr && row[descriptor->shape_cache_index] == nullptr) {
            row[descriptor->shape_cache_index] = mal_shape_from_string_keys(
                &vm->heap, keys, (u32) descriptor->key_count);
        }
    }
}
