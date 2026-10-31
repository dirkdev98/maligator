#include "vm.h"

#include <limits.h>
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__) || defined(__linux__)
#include <pthread.h>
#endif

#include "async_function.h"
#include "builtin_async_generator.h"
#include "builtin_finalization_registry.h"
#include "builtin_function.h"
#include "builtin_math.h"
#include "bound_function_object.h"
#include "builtin_object.h"
#include "checked_size.h"
#include "fiber.h"
#include "function_object.h"
#include "gc.h"
#include "generator_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "module_links.h"
#include "object_ops.h"
#include "promise_object.h"
#include "perf_stats.h"
#include "profile.h"
#include "proxy_object.h"
#include "text_buffer.h"
#include "value_ops.h"
#include "vm_load.h"
#include "class_layout.h"

#if MAL_NATIVE_FRAME_WALK && defined(__APPLE__)
#include <dlfcn.h>
#include <mach-o/loader.h>
// Zig's macOS headers lack <mach-o/getsect.h>; libSystem still exports the function.
extern uint8_t *getsectiondata(
    const struct mach_header_64 *mhp, const char *segname, const char *sectname,
    unsigned long *size);
#endif
#include "vm_ops.h"

#define g_coroutine_buffer_requests (mal_isolate_locals()->coroutine_buffer_requests)
#define g_coroutine_buffer_allocations (mal_isolate_locals()->coroutine_buffer_allocations)
#define g_coroutine_buffer_reuses (mal_isolate_locals()->coroutine_buffer_reuses)
#define g_coroutine_buffer_releases (mal_isolate_locals()->coroutine_buffer_releases)
#define g_coroutine_buffer_pooled (mal_isolate_locals()->coroutine_buffer_pooled)
#define g_coroutine_buffer_dropped (mal_isolate_locals()->coroutine_buffer_dropped)
#define g_coroutine_buffer_peak_retained_bytes \
    (mal_isolate_locals()->coroutine_buffer_peak_retained_bytes)
static MAL_ISOLATE_LOCAL u64 g_loaded_instruction_count = 0;
static MAL_ISOLATE_LOCAL u64 g_loaded_instruction_data_count = 0;

static MalShape **mal_vm_ensure_literal_shape_cache(
    MalVm *vm, i32 function_index
) {
    const MalFunction *function = &vm->runtime_image->functions[function_index];
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

static void mal_vm_seed_function_known_own_slot_ics(
    MalVm *vm, const MalFunction *function, MalPropertyCachePool *pool
) {
    if (function->instructions != nullptr) {
        // Interpreted functions retain their ordinary bytecode and side table,
        // so discover the sparse certified sites once without another metadata
        // allocation in every MalFunction row.
        for (i32 ip = 0; ip < function->instruction_count; ip++) {
            const MalInstruction *instruction = &function->instructions[ip];
            i32 data_offset;
            i32 ic_index;
            if (instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT) {
                data_offset =
                    instruction->as.load_property_static_known_own_slot.data_offset;
                ic_index = instruction->as.load_property_static_known_own_slot.ic_index;
            } else if (instruction->opcode == MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT) {
                data_offset =
                    instruction->as.store_property_static_known_own_slot.data_offset;
                ic_index = instruction->as.store_property_static_known_own_slot.ic_index;
            } else {
                continue;
            }
            if (data_offset < 0 || data_offset > function->instruction_data_count - 2 ||
                ic_index < 0 || ic_index >= function->property_ic_count) {
                continue;
            }
            const i32 *data = &function->instruction_data[data_offset];
            i32 candidate_count = data[1];
            if (data[0] < 0 || data[0] >= vm->runtime_image->string_constant_count ||
                candidate_count <= 0 ||
                candidate_count > (function->instruction_data_count - data_offset - 2) / 3) {
                continue;
            }
            MalValue key = mal_value_from_string(vm->string_constant_atoms[data[0]]);
            mal_vm_seed_known_own_slot_ic(
                vm, &pool->sites[ic_index], key, candidate_count, &data[2]);
        }
        return;
    }

    // Native emission drops compiled bytecode. Its otherwise-unused instruction
    // data pointer carries a compact stream:
    //   seedCount, (icIndex, stringIndex, candidateCount, candidate triples...)*
    // This preserves one-time seeding without widening the hot MalFunction row.
    if (function->compiled == nullptr) return;
    const i32 *data = function->instruction_data;
    i32 count = function->instruction_data_count;
    if (data == nullptr || count < 1 || data[0] < 0) return;
    i32 seed_count = data[0];
    i32 offset = 1;
    for (i32 seed = 0; seed < seed_count; seed++) {
        if (offset > count - 3) return;
        i32 ic_index = data[offset++];
        i32 string_index = data[offset++];
        i32 candidate_count = data[offset++];
        if (string_index < 0 || string_index >= vm->runtime_image->string_constant_count ||
            candidate_count <= 0 || candidate_count > (count - offset) / 3 ||
            ic_index < 0 || ic_index >= function->property_ic_count) {
            return;
        }
        MalValue key = mal_value_from_string(vm->string_constant_atoms[string_index]);
        mal_vm_seed_known_own_slot_ic(
            vm, &pool->sites[ic_index], key, candidate_count, &data[offset]);
        offset += candidate_count * 3;
    }
}

void mal_vm_ensure_function_caches(MalVm *vm, i32 function_index) {
    MalPropertyCachePool *pool = &vm->property_cache[function_index];
    const MalFunction *function = &vm->runtime_image->functions[function_index];
    i32 property_count = function->property_ic_count;
    bool created_property_cache = false;
    if (property_count > 0 && pool->sites == nullptr) {
        pool->sites = calloc((usize) property_count, sizeof(MalInlineCache));
        created_property_cache = true;
        MAL_PERF_COUNT(function_property_cache_allocations);
        MAL_PERF_ADD(
            function_property_cache_bytes,
            (u64) property_count * sizeof(MalInlineCache));
    }
    mal_vm_ensure_literal_shape_cache(vm, function_index);
    if (!created_property_cache) return;

    // Compiler-certified own-slot sites already name every portable literal
    // shape that can hit. Seed their ordinary IC rows once, when the function's
    // dense cache pool is created, instead of rebuilding the key and checking
    // for an empty row on every dynamic access. Precompiled shape rows exist
    // before any function can execute, both at VM initialization and after a
    // program splice. A later generic fallback may replace the row; the
    // instruction's explicit bounded candidates remain its exact backup guard.
    mal_vm_seed_function_known_own_slot_ics(vm, function, pool);
}

static void mal_vm_materialize_precompiled_literal_shapes(
    MalVm *vm, const MalRuntimeImage *program, i32 function_base, i32 string_base);

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

static void mal_vm_release_coroutine_buffer_impl(
    MalVm *vm, MalValue *values, bool record_satb
) {
    if (values == nullptr) {
        return;
    }
    MalCoroutineBuffer *buffer = mal_coroutine_buffer_from_values(values);
    g_coroutine_buffer_releases++;
    MAL_PERF_ADD(coroutine_buffer_release_clear_slots, buffer->used);
    for (usize i = 0; i < buffer->used; i++) {
        if (record_satb) {
            mal_gc_write_barrier(buffer->values[i]);
        }
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

void mal_vm_release_coroutine_buffer(MalVm *vm, MalValue *values) {
    mal_vm_release_coroutine_buffer_impl(vm, values, true);
}

void mal_vm_release_shaded_coroutine_buffer(MalVm *vm, MalValue *values) {
    mal_vm_release_coroutine_buffer_impl(vm, values, false);
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

static MalEnv *mal_env_new_storage(
    MalVm *vm, MalEnv *parent, i32 function_index, i32 count, bool compact_parent, const MalValue *values
) {
    MalEnv *env = mal_heap_alloc(
        &vm->heap, sizeof(MalEnv) + sizeof(MalValue) * (usize) count, MAL_HEAP_ENV
    );
    env->parent = parent;
    env->function_index = function_index;
    env->slot_count = count;
    env->compact_parent = compact_parent;
    env->compact_chain_length = 0;
    if (compact_parent && function_index >= 0) {
        if (parent == nullptr) {
            env->compact_chain_length = 1;
        } else {
            bool terminal = mal_env_is_single_owner(parent);
            MalEnv *scope = terminal ? mal_env_untag_single_owner(parent) : parent;
            u16 length = terminal ? 1 : scope->compact_chain_length;
            if (scope->compact_parent && length > 0 && length < UINT16_MAX &&
                    scope->function_index == function_index - 1) {
                env->compact_chain_length = length + 1;
            }
        }
    }
    for (i32 i = 0; i < count; i++) {
        MalValue value = values == nullptr ? mal_value_new_undefined() : values[i];
#if defined(__wasi__)
        env->slots[i] = value;
#else
        atomic_init(&env->slots[i], value);
#endif
    }
    if (function_index >= 0) MAL_PERF_COUNT(capture_environments);
    if (values != nullptr) {
        MAL_PERF_COUNT(deferred_capture_environments);
        // A cell allocated black during marking is old and may now hold young values.
        mal_gc_remember_if_old(&env->header);
    }
    return env;
}

static bool mal_env_inherits_compact_parent(MalVm *vm, MalEnv *parent, i32 function_index) {
    return function_index >= 0
        ? function_index < vm->runtime_image->function_count &&
            vm->runtime_image->functions[function_index].closure_captures != nullptr
        : parent != nullptr && (mal_env_is_single_owner(parent) || parent->compact_parent ||
            mal_env_is_capture_display(parent));
}

MalEnv *mal_env_new(MalVm *vm, MalEnv *parent, i32 function_index, i32 count) {
    return mal_env_new_storage(
        vm, parent, function_index, count,
        mal_env_inherits_compact_parent(vm, parent, function_index), nullptr);
}

MalEnv *mal_env_new_compact(MalVm *vm, MalEnv *parent, i32 function_index, i32 count) {
    return mal_env_new_storage(vm, parent, function_index, count, true, nullptr);
}

MalEnv *mal_env_new_from_frame(
    MalVm *vm, MalEnv *parent, i32 function_index, i32 count, bool compact, const MalValue *values
) {
    return mal_env_new_storage(
        vm, parent, function_index, count,
        compact || mal_env_inherits_compact_parent(vm, parent, function_index), values);
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

static uptr mal_vm_compute_stack_top(void) {
#if defined(__APPLE__)
    return (uptr) pthread_get_stackaddr_np(pthread_self());
#elif defined(__linux__)
    pthread_attr_t attr;
    if (pthread_getattr_np(pthread_self(), &attr) != 0) {
        return 0;
    }
    void *low = nullptr;
    size_t size = 0;
    int ok = pthread_attr_getstack(&attr, &low, &size);
    pthread_attr_destroy(&attr);
    return ok != 0 || low == nullptr ? 0 : (uptr) low + size;
#else
    return 0;
#endif
}

/** Phase 1: establish allocation-safe engine state before adopting a program. */
static void mal_vm_init_engine_state(MalVm *vm) {
    vm->literal_cache_count = 0;
    vm->literal_cache_cursor = 0;
#if !MAL_REALMS
    memset(vm->known_primordial_values, 0, sizeof(vm->known_primordial_values));
#endif
    vm->error_stack_marker = mal_value_new_undefined();
    vm->allocation_error = mal_value_new_undefined();
    vm->tiny_string_cache = nullptr;
    memset(vm->regexp_protocol_methods, 0, sizeof(vm->regexp_protocol_methods));
    vm->small_uint_string_cache = nullptr;
    vm->small_uint_string_cache_scan_limit = 0;
    vm->small_bigint_cache = nullptr;
    vm->array_join_frames = nullptr;
    memset(vm->for_in_snapshots, 0, sizeof(vm->for_in_snapshots));
    vm->for_in_iterator_next = mal_value_new_undefined();
    memset(vm->private_append_cache, 0, sizeof(vm->private_append_cache));
    vm->key_atom_cache.string = nullptr;
    mal_module_link_registry_init(&vm->module_links);
    vm->semantic_epochs = (MalSemanticEpochs) {
        .activity = MAL_SEMANTIC_EPOCH_INITIAL,
        .array_elements = MAL_SEMANTIC_EPOCH_INITIAL,
        .watched_methods = MAL_SEMANTIC_EPOCH_INITIAL,
    };
	mal_gc_init(vm);
}

/** Phase 2: adopt immutable input tables into VM-owned, spliceable storage. */
static void mal_vm_adopt_program_image(MalVm *vm, const MalRuntimeImage *program) {
	if (program->initialize_generated_data != nullptr) {
        program->initialize_generated_data();
    }

    // Relocate the program's function / string / bigint / literal-template tables into
    // VM-owned growable storage behind a mutable `live_runtime_image` (see vm.h), so
    // runtime eval can splice more in later while the const access paths keep
    // working. The instruction/handler/code-unit data the rows point at is left
    // in place (static, or the loader arena). Counts of 0 use a capacity of 1 so
    // a later splice always has a real array to grow.
    vm->live_runtime_image = *program;
    // Links describe one image; the merged program spliced from them has none.
    vm->live_runtime_image.module_import_count = 0;
    vm->live_runtime_image.module_imports = nullptr;
    vm->live_runtime_image.module_export_count = 0;
    vm->live_runtime_image.module_exports = nullptr;
    for (i32 i = 0; i < program->function_count; i++) {
        g_loaded_instruction_count += (u64) program->functions[i].instruction_count;
        g_loaded_instruction_data_count +=
            (u64) program->functions[i].instruction_data_count;
    }
    vm->runtime_image = &vm->live_runtime_image;

    i32 function_count = program->function_count;
    vm->function_capacity = function_count > 0 ? function_count : 1;
    MalFunction *functions = malloc(sizeof(MalFunction) * (usize) vm->function_capacity);
    if (function_count > 0) {
        memcpy(functions, program->functions, sizeof(MalFunction) * (usize) function_count);
    }
    vm->live_runtime_image.functions = functions;

    i32 string_count = program->string_constant_count;
    vm->initial_string_constants = program->string_constants;
    vm->initial_string_constant_count = string_count;
    // Fixed capacity, never reallocated (see MAL_MAX_STRING_CONSTANTS): string
    // cells must keep stable addresses because values point at them.
    vm->string_capacity = string_count > MAL_MAX_STRING_CONSTANTS ? string_count : MAL_MAX_STRING_CONSTANTS;
    MalString *strings = malloc(sizeof(MalString) * (usize) vm->string_capacity);
    if (string_count > 0) {
        memcpy(strings, program->string_constants, sizeof(MalString) * (usize) string_count);
    }
    vm->live_runtime_image.string_constants = strings;
    vm->string_constant_atoms =
        calloc((usize) vm->string_capacity, sizeof(MalString *));

    // Fixed capacity, never reallocated (see MAL_MAX_BIGINT_CONSTANTS): like
    // strings, BigInt values point at their cells.
    i32 bigint_count = program->bigint_constant_count;
    vm->bigint_capacity = bigint_count > MAL_MAX_BIGINT_CONSTANTS ? bigint_count : MAL_MAX_BIGINT_CONSTANTS;
    MalBigInt *bigints = malloc(sizeof(MalBigInt) * (usize) vm->bigint_capacity);
    if (bigint_count > 0) {
        memcpy(bigints, program->bigint_constants, sizeof(MalBigInt) * (usize) bigint_count);
    }
    vm->live_runtime_image.bigint_constants = bigints;

    i32 literal_template_count = program->literal_template_data_count;
    vm->literal_template_capacity = literal_template_count > 0 ? literal_template_count : 1;
    u32 *literal_templates = malloc(sizeof(u32) * (usize) vm->literal_template_capacity);
    if (literal_template_count > 0) {
        memcpy(literal_templates, program->literal_template_data,
               sizeof(u32) * (usize) literal_template_count);
    }
    vm->live_runtime_image.literal_template_data = literal_templates;

    i32 cjs_module_count = program->cjs_module_count;
    vm->cjs_module_capacity = cjs_module_count > 0 ? cjs_module_count : 1;
    i32 *cjs_module_function_indices =
        malloc(sizeof(i32) * (usize) vm->cjs_module_capacity);
    if (cjs_module_count > 0) {
        memcpy(
            cjs_module_function_indices,
            program->cjs_module_function_indices,
            sizeof(i32) * (usize) cjs_module_count);
    }
    vm->live_runtime_image.cjs_module_function_indices =
        cjs_module_function_indices;
    i32 file_count = program->file_count;
    vm->file_capacity = file_count > 0 ? file_count : 1;
    const char **files = malloc(sizeof(char *) * (usize) vm->file_capacity);
    if (file_count > 0) {
        memcpy(files, program->files, sizeof(char *) * (usize) file_count);
    }
    vm->live_runtime_image.files = files;
    vm->file_string_atoms = calloc(
        (usize) vm->file_capacity, sizeof(MalString *));

    i32 source_position_count = program->source_position_count;
    vm->source_position_capacity =
        source_position_count > 0 ? source_position_count : 1;
    MalSourcePos *source_positions = malloc(
        sizeof(MalSourcePos) * (usize) vm->source_position_capacity);
    if (source_position_count > 0) {
        memcpy(source_positions, program->source_positions,
               sizeof(MalSourcePos) * (usize) source_position_count);
    }
    vm->live_runtime_image.source_positions = source_positions;
	vm->function_cjs_module_bases =
		calloc((usize) vm->function_capacity, sizeof(i32));
    vm->call_entries = calloc((usize) vm->function_capacity, sizeof(MalCompiledFunction));
    for (i32 i = 0; i < function_count; i++) mal_vm_refresh_call_entry(vm, i);
}

/** Phase 3: allocate execution stacks, caches, queues, and host-neutral state. */
static void mal_vm_init_execution_state(MalVm *vm, const MalRuntimeImage *program) {
	vm->property_cache =
        calloc((usize) vm->function_capacity, sizeof(MalPropertyCachePool));
    vm->literal_shape_cache =
        calloc((usize) vm->function_capacity, sizeof(MalShape **));
    mal_vm_class_cells_init(vm, program);
    vm->property_stub = nullptr;
    vm->inherited_property_stub = nullptr;
    vm->builtin_missing_rows = nullptr;
    vm->launch = (MalHostLaunchContext) {0};
    vm->iterator_result_shape = nullptr;
    vm->regexp_instance_shape = nullptr;
    vm->regexp_result_shape = nullptr;
    vm->regexp_result_indices_shape = nullptr;
    vm->regexp_indices_shape = nullptr;
    memset(vm->shape_copy_cache, 0, sizeof(vm->shape_copy_cache));
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
    vm->node_url_instance_shape = nullptr;
    vm->node_string_decoder_state_shape = nullptr;
    vm->node_string_decoder_shape = nullptr;
    vm->node_sqlite_run_result_shape = nullptr;
    vm->ffi = nullptr;
    vm->interp_call_cache = nullptr;
    vm->global_property_cache = nullptr;
    vm->exact_script_call = nullptr;
    vm->global_capacity = program->global_count > 0 ? program->global_count : 1;
#if !MAL_REALMS
    vm->global_environment = (MalGlobalEnvironment) {0};
    vm->globals = malloc(sizeof(MalValue) * (usize) vm->global_capacity);
#endif
    // Fixed-capacity, never reallocated (see MAL_MAX_CALL_FRAMES): keeps every
    // live frame pointer stable across re-entrant calls.
    vm->frame_capacity = MAL_MAX_CALL_FRAMES;
    vm->frames = malloc(mal_vm_frame_storage_bytes(vm->frame_capacity));
    vm->frame_count = 0;

    vm->value_stack_capacity = MAL_VALUE_STACK_CAPACITY;
    vm->value_stack = malloc(sizeof(MalValue) * (usize) vm->value_stack_capacity);
    vm->value_stack_size = 0;
    vm->service_epoch = 0;
    vm->proxy_dispatch_depth = 0;
    vm->stack_limit = mal_vm_compute_stack_limit();
    vm->native_stack_top = mal_vm_compute_stack_top();
    mal_vm_sync_entry_stack_limit(vm);
    vm->gc_native_frames = 0;
    // Fibers: the main fiber is created at the end of init (once every exec field
    // it adopts is finalized). Null the list heads first so init_main can link on.
    vm->current_fiber = nullptr;
    vm->fibers_head = nullptr;
    // Host context (reactor/timers) is attached by the host layer, not the engine.
    vm->host = nullptr;
    vm->host_web_platform = false;
    vm->host_node = false;
    vm->console_node_hooks = nullptr;
    vm->prepared_values = nullptr;
    vm->runtime_cleanup_count = 0;
    vm->active_job = nullptr;
    vm->kept_objects = nullptr;
    vm->kept_count = 0;
    vm->kept_capacity = 0;

    vm->compiler_fn = mal_value_new_undefined();
    vm->compiler_installed = false;
    vm->loaded_images = nullptr;
    vm->loaded_image_count = 0;
    vm->loaded_image_capacity = 0;

    vm->native_frames = nullptr;
    vm->native_frame_count = 0;
    vm->native_frame_capacity = 0;
    vm->root_frame_head = nullptr;
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
    vm->async_context = nullptr;
    vm->node_v8_expose_gc = false;

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
    vm->finalization_registry_cell_pool = nullptr;
    vm->finalization_registry_cell_pool_count = 0;
    vm->unhandled_rejections = nullptr;
    vm->unhandled_count = 0;
    vm->unhandled_capacity = 0;
	vm->entry_async_promise = mal_value_new_undefined();
    vm->errors_forwarded = false;
    vm->uncaught_reported = false;
}

/** Phase 4: create language heap roots, intrinsics, module state, and the main fiber. */
static void mal_vm_init_language_state(MalVm *vm, const MalRuntimeImage *program) {
    vm->symbol_registry = (MalSymbolRegistry) {0};
    vm->atoms = (MalAtomStore) {0};
    vm->native_source_cache = (MalNativeSourceCache) {0};
	mal_heap_init(&vm->heap, 0);
    mal_gc_configure_heap(vm);
    // Interned so closures, natives, and program constants share one transition key;
    // a private copy made every closure creation compare these names by content.
    vm->heap.native_function_length_key =
        mal_atom_store_intern(&vm->atoms, mal_string_new_ascii(&vm->heap, "length", 6));
    vm->heap.native_function_name_key =
        mal_atom_store_intern(&vm->atoms, mal_string_new_ascii(&vm->heap, "name", 4));
#if MAL_REALMS
    // global_capacity is already established above, so the initial realm can own
    // both its absolute globals array and intrinsics before intrinsic initialization.
    // mal_realm_new links only after all active root slots are safe to scan.
    vm->realms = nullptr;
    vm->initial_realm = mal_realm_new(vm);
    // Enter the initial realm: sets both VM aliases and primes heap.current_realm.
    mal_realm_switch(vm, vm->initial_realm);
#else
    for (i32 i = 0; i < program->global_count; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
#endif
    for (i32 i = 0; i < MAL_INTRINSIC_COUNT; i++) {
        vm->intrinsics[i] = mal_value_new_undefined();
    }
    for (i32 i = 0; i < program->string_constant_count; i++) {
        vm->string_constant_atoms[i] = mal_property_atomize_string(
            vm, (MalString *) &vm->runtime_image->string_constants[i]);
    }
    // A guarded own-slot load may execute before its source allocation site.
    // Build only those named literal shapes now, after their canonical atoms
    // exist, so both compiled and interpreted guards can hit on first use.
    mal_vm_materialize_precompiled_literal_shapes(vm, program, 0, 0);
    for (u32 i = 0; i < MAL_HOT_KEY_COUNT; i++) {
        vm->hot_intrinsic_keys[i] = nullptr;
    }
    vm->closure_metadata_shape = nullptr;
    for (u32 i = 0; i < MAL_ASCII_ATOM_CACHE_CAPACITY; i++) {
        vm->ascii_atom_cache[i] = (MalAsciiAtomCacheEntry) {0};
    }
    for (u32 i = 0; i < MAL_STATIC_SLOT_CACHE_CAPACITY; i++) {
        vm->static_slot_cache[i] = (MalStaticSlotCacheEntry) {0};
    }
    vm->regexp_templates = nullptr;
    vm->static_load_sites = nullptr;
    vm->literal_template_shapes = nullptr;
    vm->json_key_cache = nullptr;
    vm->json_plan_cache = nullptr;
    for (u32 i = 0; i < MAL_WATCHED_LOOKUP_CACHE_CAPACITY; i++) {
        vm->watched_lookup_cache[i] = (MalWatchedLookupEntry) {0};
    }
    for (u32 i = 0; i < 256; i++) {
        vm->code_unit_strings[i] = nullptr;
    }

    mal_intrinsics_init(vm);

    // Build the emergency exception while allocation is healthy, without normal
    // stack capture. Its throw path later only copies this rooted value.
    vm->allocation_error = mal_vm_create_allocation_error(vm);

    // CommonJS module registry: one lazily-loaded slot per CJS module.
    if (program->cjs_module_count > 0) {
        vm->cjs_registry = malloc(sizeof(MalCjsModuleSlot) * (usize) program->cjs_module_count);
        for (i32 i = 0; i < program->cjs_module_count; i++) {
            vm->cjs_registry[i] = (MalCjsModuleSlot) {
                .module_object = mal_value_new_undefined(),
                .loaded = false,
                .alias = -1,
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

void mal_vm_init(MalVm *vm, const MalRuntimeImage *program) {
	mal_isolate_claim_sole();
	mal_vm_init_engine_state(vm);
	mal_vm_adopt_program_image(vm, program);
	mal_vm_init_execution_state(vm, program);
	mal_vm_init_language_state(vm, program);
	// The first image of a relocatable program links nothing in; it only publishes.
	mal_vm_publish_module_exports(vm, program, nullptr, 0);
}

MalValue mal_vm_cjs_require(MalVm *vm, i32 id) {
    if (vm->frame_count > 0) {
        i32 caller_function_index =
            vm->frames[vm->frame_count - 1].function_index;
        id += vm->function_cjs_module_bases[caller_function_index];
    }
    if (id < 0 || id >= vm->runtime_image->cjs_module_count) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "invalid CommonJS module id");
        return mal_value_new_undefined();
    }
    if (vm->cjs_registry[id].alias >= 0) id = vm->cjs_registry[id].alias;

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
    i32 function_index = vm->runtime_image->cjs_module_function_indices[id];
    const MalFunction *function = &vm->runtime_image->functions[function_index];
    MalRootSpan args_span;
    mal_gc_root(&args_span, args, countof(args));
    if (function->compiled != nullptr) {
        function->compiled(
            vm, exports_value, args, 5, mal_value_new_undefined(), nullptr,
            mal_value_new_undefined(), nullptr
        );
    } else {
        mal_vm_interpret_function(
            vm, function_index, mal_value_new_undefined(), exports_value, args, 5,
            mal_value_new_undefined(), nullptr
        );
    }
    mal_gc_unroot(&args_span);
    // The body may splice in another image, which reallocates the registry.
    slot = &vm->cjs_registry[id];
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
    if (vm->kept_count > 0 && vm->kept_objects[vm->kept_count - 1] == value) {
        return;
    }
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

void mal_vm_run_runtime_cleanups(MalVm *vm) {
    mal_gc_begin_teardown(vm);
    while (vm->runtime_cleanup_count > 0) {
        void (*cleanup)(MalVm *vm) = vm->runtime_cleanups[--vm->runtime_cleanup_count];
        cleanup(vm);
    }
}

void mal_vm_free(MalVm *vm) {
    mal_gc_begin_teardown(vm);
    while (vm->prepared_values != nullptr) {
        MalPreparedValue *entry = vm->prepared_values;
        vm->prepared_values = entry->next;
        free(entry->identity);
        free(entry->data);
        free(entry);
    }
	mal_profile_finish(vm);
    mal_vm_run_runtime_cleanups(vm);
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
    for (i32 i = 0; i < vm->loaded_image_count; i++) {
        mal_loaded_runtime_image_free(vm->loaded_images[i]);
    }
    free(vm->loaded_images);
    if (vm->property_cache != nullptr) {
        for (i32 i = 0; i < vm->runtime_image->function_count; i++) {
            MalPropertyCachePool *pool = &vm->property_cache[i];
            if (pool->sites != nullptr) {
                for (i32 j = 0; j < vm->runtime_image->functions[i].property_ic_count; j++) {
                    mal_object_unregister_prototype_cache(&pool->sites[j]);
                }
            }
            free(pool->sites);
        }
        free(vm->property_cache);
    }
    if (vm->literal_shape_cache != nullptr) {
        for (i32 i = 0; i < vm->runtime_image->function_count; i++) {
            free(vm->literal_shape_cache[i]);
        }
        free(vm->literal_shape_cache);
    }
    mal_vm_class_cells_free(vm);
    free(vm->property_stub);
    if (vm->inherited_property_stub != nullptr) {
        for (usize i = 0; i < MAL_INHERITED_STUB_CACHE_ROW_COUNT; i++) {
            MalInlineCache *stub = &vm->inherited_property_stub[i];
            if (stub->key != 0) {
                mal_object_unregister_prototype_cache(stub);
            }
        }
        free(vm->inherited_property_stub);
    }
    free(vm->builtin_missing_rows);
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
    free(vm->global_environment.bindings);
    free(vm->globals);
#endif
    free(vm->cjs_registry);
    free(vm->function_cjs_module_bases);
    free(vm->call_entries);
    mal_module_link_registry_free(&vm->module_links);

    // The VM-owned constant/template tables (the instruction/code-unit data their
    // rows point at is owned elsewhere — static, or the caller's loaded runtime image).
    free((MalFunction *) vm->live_runtime_image.functions);
    free(vm->string_constant_atoms);
    free((MalString *) vm->live_runtime_image.string_constants);
    free((MalBigInt *) vm->live_runtime_image.bigint_constants);
    free((u32 *) vm->live_runtime_image.literal_template_data);
    free((i32 *) vm->live_runtime_image.cjs_module_function_indices);
    free(vm->file_string_atoms);
    free((char **) vm->live_runtime_image.files);
    free((MalSourcePos *) vm->live_runtime_image.source_positions);

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

    // Store RAW buffers must be released while the owning heap is still live.
    mal_symbol_registry_free(&vm->symbol_registry);
    mal_atom_store_free(&vm->atoms);
    mal_native_source_cache_free(&vm->native_source_cache);
    // Free every live cell's owned side allocations before releasing the heap,
    // so a teardown leaves no shutdown leak (mal_heap_free only munmaps the
    // chunks + frees LOS records; it does not run per-cell finalizers).
    mal_gc_finalize_all(vm);
    // Other VMs on this thread may still own dependency rows; release only after all of ours are detached.
    mal_object_release_idle_prototype_dependencies();
    mal_vm_free_job_pool(vm);
    mal_promise_free_reaction_pool(vm);
    mal_vm_free_coroutine_buffer_pool(vm);
    mal_async_generator_free_request_pool(vm);
    mal_finalization_registry_free_cell_pool(vm);
    free(vm->tiny_string_cache);
    vm->tiny_string_cache = nullptr;
    free(vm->small_uint_string_cache);
    vm->small_uint_string_cache = nullptr;
    vm->small_uint_string_cache_scan_limit = 0;
    free(vm->small_bigint_cache);
    vm->small_bigint_cache = nullptr;
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

    vm->runtime_image = nullptr;
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
// untouched. Side data lives in the loaded arena (mutable); static runtime images
// never pass through this splice path. Mirrors the reference list in
// src/compiler/target/program-image-codec.ts.
static i32 mal_vm_rebase_value_operand(i32 operand, i32 string_base) {
    if (operand >= 0) return operand;
    if (operand > MAL_VALUE_OPERAND_STRING_BASE || operand < MAL_VALUE_OPERAND_STRING_MIN) {
        return operand;
    }
    i32 index = MAL_VALUE_OPERAND_STRING_BASE - operand;
    return MAL_VALUE_OPERAND_STRING_BASE - (index + string_base);
}

static void mal_vm_rebase_instruction(
    MalInstruction *in, i32 *instruction_data, i32 fn_base, const i32 *global_remap,
    i32 string_base, i32 bigint_base, i32 template_base
) {
    switch (in->opcode) {
        case MAL_OP_CREATE_FUNCTION:
            in->as.create_function.function_index += fn_base;
            break;
        case MAL_OP_GUARD_FUNCTION_INDEX:
            in->as.guard_function_index.function_index += fn_base;
            break;
        case MAL_OP_GUARD_BASE_CONSTRUCTOR_LAYOUT: {
            in->as.guard_base_constructor_layout.function_index += fn_base;
            i32 *data = &instruction_data[
                in->as.guard_base_constructor_layout.data_offset];
            if (data[2] >= 0) data[2] += string_base;
            if (data[3] >= 0) data[3] += fn_base;
            for (i32 index = 0; index < data[0]; index++) data[4 + index] += string_base;
            break;
        }
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
        case MAL_OP_LOAD_GLOBAL_INDEX:
            in->as.load_global_index.index = global_remap[in->as.load_global_index.index];
            break;
        case MAL_OP_LOAD_GLOBAL:
            in->as.load_global.index = global_remap[in->as.load_global.index];
            break;
        case MAL_OP_STORE_GLOBAL:
            in->as.store_global.index = global_remap[in->as.store_global.index];
            break;
        case MAL_OP_CREATE_STRING:
            in->as.create_string.string_index += string_base;
            break;
        case MAL_OP_LOAD_PROPERTY_STATIC:
        case MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH:
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
        case MAL_OP_SELECT_SHAPE_CASE: {
            i32 *data = instruction_data + in->as.select_shape_case.data_offset;
            for (i32 index = 0; index < in->as.select_shape_case.candidate_count; index++) {
                data[index * 2] += fn_base;
            }
            break;
        }
        case MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE: {
            i32 *data = instruction_data +
                in->as.load_property_static_shape_case.data_offset;
            data[0] += string_base;
            break;
        }
        case MAL_OP_PROBE_READ: {
            i32 *data = instruction_data + in->as.probe_read.data_offset;
            if (mal_vm_probe_read_kind_named((u8) data[1])) data[2] += string_base;
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
            if (in->as.instantiate_literal_template.cache_slot >= 0)
                in->as.instantiate_literal_template.cache_slot =
                    global_remap[in->as.instantiate_literal_template.cache_slot];
            break;
        case MAL_OP_QUERY_STATIC_DATA:
            instruction_data[in->as.query_static_data.data_offset] += template_base;
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
        case MAL_OP_DECLARE_GLOBAL_LEXICAL:
            in->as.declare_global_lexical.name_string_index += string_base;
            in->as.declare_global_lexical.index = global_remap[in->as.declare_global_lexical.index];
            break;
        case MAL_OP_GLOBAL_BINDING_QUERY:
            in->as.global_binding_query.name_string_index += string_base;
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
            in->as.create_template_object.cache_slot = global_remap[in->as.create_template_object.cache_slot];
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
            if (in->as.create_module_namespace.cache_slot >= 0)
                in->as.create_module_namespace.cache_slot =
                    global_remap[in->as.create_module_namespace.cache_slot];
            i32 *data = instruction_data + in->as.create_module_namespace.data_offset;
            i32 count = data[0];
            i32 *names = &data[1];
            i32 *slots = &data[1 + count];
            for (i32 i = 0; i < count; i++) {
                names[i] += string_base;
                slots[i] = global_remap[slots[i]];
            }
            break;
        }
        case MAL_OP_CALL: {
            in->as.call.callee = mal_vm_rebase_value_operand(in->as.call.callee, string_base);
            in->as.call.this_value = mal_vm_rebase_value_operand(in->as.call.this_value, string_base);
            i32 *data = instruction_data + in->as.call.data_offset;
            if (data[1] >= 0) {
                data[1] += fn_base;
            }
            for (i32 i = 0; i < data[2]; i++) {
                data[i + 3] += fn_base;
            }
            for (i32 i = 0; i < data[0]; i++) {
                i32 operand = i + 3 + data[2];
                data[operand] = mal_vm_rebase_value_operand(data[operand], string_base);
            }
            break;
        }
        case MAL_OP_CALL_KNOWN: {
            in->as.call_known.this_value = mal_vm_rebase_value_operand(
                in->as.call_known.this_value, string_base);
            i32 *data = instruction_data + in->as.call_known.data_offset;
            for (i32 i = 0; i < data[0]; i++) {
                data[i + 1] = mal_vm_rebase_value_operand(data[i + 1], string_base);
            }
            break;
        }
        case MAL_OP_CONSTRUCT: {
            in->as.construct.callee = mal_vm_rebase_value_operand(in->as.construct.callee, string_base);
            i32 *data = instruction_data + in->as.construct.data_offset;
            if (data[1] >= 0) {
                data[1] += fn_base;
            }
            for (i32 i = 0; i < data[0]; i++) {
                data[i + 3] = mal_vm_rebase_value_operand(data[i + 3], string_base);
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
            case MAL_LITERAL_UNDEFINED:
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

/** Grow geometrically so splicing many images stays linear in their total size. */
static i32 mal_vm_grown_capacity(i32 capacity, i32 needed) {
    i64 grown = (i64) capacity * 2;
    if (grown < needed) grown = needed;
    return grown > INT32_MAX ? needed : (i32) grown;
}

i32 mal_vm_splice_runtime_image(MalVm *vm, const MalRuntimeImage *loaded) {
    MalRuntimeImage *live = &vm->live_runtime_image;
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
    i32 linked_namespace_slots = 0;
    if (!mal_vm_resolve_module_imports(vm, loaded, global_base, &linked_namespace_slots)) {
        return -1;
    }
    // Each image-local global slot's absolute slot: imports alias earlier images'.
    i32 *global_remap = malloc(sizeof(i32) * (usize) (loaded->global_count > 0 ? loaded->global_count : 1));
    if (global_remap == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return -1;
    }
    for (i32 i = 0; i < loaded->global_count; i++) global_remap[i] = global_base + i;
    i32 cjs_import_count = 0;
    for (i32 i = 0; i < loaded->module_import_count; i++) {
        const MalModuleLink *link = &loaded->module_imports[i];
        if (link->kind == MAL_MODULE_LINK_CJS) cjs_import_count++;
        else global_remap[link->slot] = link->target;
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
    // copy so spliced instructions can use one merged program table.
    i32 new_template_count = template_base + loaded->literal_template_data_count;
    if (new_template_count > vm->literal_template_capacity) {
        vm->literal_template_capacity = mal_vm_grown_capacity(vm->literal_template_capacity, new_template_count);
        live->literal_template_data = realloc(
            (u32 *) live->literal_template_data,
            sizeof(u32) * (usize) vm->literal_template_capacity);
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
            free(global_remap);
            return -1;
        }
    }
    live->literal_template_data_count = new_template_count;

    // Globals: grow and undefined-initialize the same absolute range in every realm,
    // including the namespace slots first created by this image's imports.
    i32 new_globals = global_base + loaded->global_count + linked_namespace_slots;
#if MAL_REALMS
    if (new_globals > vm->global_capacity) {
        vm->global_capacity = mal_vm_grown_capacity(vm->global_capacity, new_globals);
        for (MalRealm *realm = vm->realms; realm != nullptr; realm = realm->next) {
            realm->globals = realloc(realm->globals, sizeof(MalValue) * (usize) vm->global_capacity);
        }
    }
    for (MalRealm *realm = vm->realms; realm != nullptr; realm = realm->next) {
        for (i32 i = global_base; i < new_globals; i++) {
            realm->globals[i] = mal_value_new_undefined();
        }
    }
    vm->globals = vm->current_realm->globals;
#else
    if (new_globals > vm->global_capacity) {
        vm->global_capacity = mal_vm_grown_capacity(vm->global_capacity, new_globals);
        vm->globals = realloc(vm->globals, sizeof(MalValue) * (usize) vm->global_capacity);
    }
    for (i32 i = global_base; i < new_globals; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
#endif
    live->global_count = new_globals;

    // Portable host exports are program-local global slots. Rebase their
    // loader-owned slot tables so the embedding can install them after splice.
    for (i32 i = 0; i < loaded->host_install_count; i++) {
        MalHostInstall *install = (MalHostInstall *) &loaded->host_installs[i];
        MalHostInstallSlot *slots = (MalHostInstallSlot *) install->slots;
        for (i32 slot = 0; slot < install->slot_count; slot++) {
            slots[slot].slot = global_remap[slots[slot].slot];
        }
    }

    // Debug tables: append program-local paths and source positions. Inline
    // chains refer to function/source-position indices and must be rebased just
    // like bytecode operands.
    i32 new_file_count = file_base + loaded->file_count;
    if (new_file_count > vm->file_capacity) {
        i32 old_capacity = vm->file_capacity;
        vm->file_capacity = mal_vm_grown_capacity(vm->file_capacity, new_file_count);
        live->files = realloc(
            (char **) live->files, sizeof(char *) * (usize) vm->file_capacity);
        vm->file_string_atoms = realloc(
            vm->file_string_atoms,
            sizeof(MalString *) * (usize) vm->file_capacity);
        memset(
            vm->file_string_atoms + old_capacity, 0,
            sizeof(MalString *) * (usize) (vm->file_capacity - old_capacity));
    }
    const char **files = (const char **) live->files;
    for (i32 i = 0; i < loaded->file_count; i++) {
        files[file_base + i] = loaded->files[i];
    }
    live->file_count = new_file_count;

    i32 new_source_position_count =
        source_position_base + loaded->source_position_count;
    if (new_source_position_count > vm->source_position_capacity) {
        vm->source_position_capacity =
            mal_vm_grown_capacity(vm->source_position_capacity, new_source_position_count);
        live->source_positions = realloc(
            (MalSourcePos *) live->source_positions,
            sizeof(MalSourcePos) * (usize) vm->source_position_capacity);
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
    i32 previous_function_capacity = vm->function_capacity;
    if (new_functions > vm->function_capacity) {
        vm->function_capacity = mal_vm_grown_capacity(vm->function_capacity, new_functions);
        live->functions = realloc(
            (MalFunction *) live->functions, sizeof(MalFunction) * (usize) vm->function_capacity);
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
                fn_base, global_remap, string_base, bigint_base, template_base);
        }
        functions[fn_base + f] = fn;
    }
    live->function_count = new_functions;

    // CommonJS module ids are program-local numeric values. Append the
    // module-to-function rows here; the caller function's segment base is
    // applied by mal_vm_cjs_require so no instruction data needs rewriting.
    // Imported modules follow the image's own and alias the owning image's entry.
    i32 own_cjs_module_count = cjs_module_base + loaded->cjs_module_count;
    i32 new_cjs_module_count = own_cjs_module_count + cjs_import_count;
    if (new_cjs_module_count > vm->cjs_module_capacity) {
        vm->cjs_module_capacity = mal_vm_grown_capacity(vm->cjs_module_capacity, new_cjs_module_count);
        live->cjs_module_function_indices = realloc(
            (i32 *) live->cjs_module_function_indices,
            sizeof(i32) * (usize) vm->cjs_module_capacity);
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
            sizeof(MalCjsModuleSlot) * (usize) vm->cjs_module_capacity);
        for (i32 i = cjs_module_base; i < new_cjs_module_count; i++) {
            vm->cjs_registry[i] = (MalCjsModuleSlot) {
                .module_object = mal_value_new_undefined(),
                .loaded = false,
                .alias = -1,
            };
        }
    }
    for (i32 i = 0; i < loaded->module_import_count; i++) {
        const MalModuleLink *link = &loaded->module_imports[i];
        if (link->kind != MAL_MODULE_LINK_CJS) continue;
        cjs_module_function_indices[cjs_module_base + link->slot] = -1;
        vm->cjs_registry[cjs_module_base + link->slot].alias = link->target;
    }
    live->cjs_module_count = new_cjs_module_count;

    // The realloc above may have moved the function table out from under any
    // frame that is live across this splice. Re-resolve every running and saved
    // fiber frame before later splice work can collect; the current fiber's saved
    // slice is stale while its live slice resides in the VM.
    for (i32 i = 0; i < vm->frame_count; i++) {
        vm->frames[i].function = &functions[vm->frames[i].function_index];
    }
    for (MalFiber *fiber = vm->fibers_head; fiber != nullptr; fiber = fiber->next) {
        if (fiber == vm->current_fiber || fiber->state == MAL_FIBER_FINISHED) {
            continue;
        }
        for (i32 i = 0; i < fiber->exec.frame_count; i++) {
            MalVmFrame *frame = &fiber->exec.frames[i];
            frame->function = &functions[frame->function_index];
        }
    }

    // Per-function caches grow with the function table.
    if (vm->function_capacity != previous_function_capacity) {
        usize capacity = (usize) vm->function_capacity;
        vm->property_cache =
            realloc(vm->property_cache, sizeof(MalPropertyCachePool) * capacity);
        vm->literal_shape_cache =
            realloc(vm->literal_shape_cache, sizeof(MalShape **) * capacity);
        vm->function_cjs_module_bases =
            realloc(vm->function_cjs_module_bases, sizeof(i32) * capacity);
        vm->call_entries = realloc(vm->call_entries, sizeof(MalCompiledFunction) * capacity);
    }
    for (i32 i = fn_base; i < new_functions; i++) {
        vm->property_cache[i] = (MalPropertyCachePool){0};
        vm->literal_shape_cache[i] = nullptr;
        vm->function_cjs_module_bases[i] = cjs_module_base;
        vm->call_entries[i] = nullptr;
    }

    // Spliced functions may execute guarded loads before their own literal
    // origins. Their strings and function rows are now fully rebased and live.
    mal_vm_materialize_precompiled_literal_shapes(vm, loaded, fn_base, string_base);

    bool published = mal_vm_publish_module_exports(vm, loaded, global_remap, cjs_module_base);
    free(global_remap);
    return published ? fn_base : -1;
}

void mal_vm_retain_loaded_runtime_image(MalVm *vm, MalLoadedRuntimeImage *loaded) {
    if (vm->loaded_image_count == vm->loaded_image_capacity) {
        vm->loaded_image_capacity =
            vm->loaded_image_capacity == 0 ? 4 : vm->loaded_image_capacity * 2;
        vm->loaded_images = realloc(
            vm->loaded_images,
            sizeof(MalLoadedRuntimeImage *) * (usize) vm->loaded_image_capacity);
    }
    vm->loaded_images[vm->loaded_image_count++] = loaded;
}

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index) {
    MalCallable *callable = malloc(sizeof(MalCallable));

    callable->vm = vm;
    callable->function = &vm->runtime_image->functions[function_index];
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
    callable->is_compiled = false;
    callable->instruction_pointer = 0;
    callable->gc_safepoint_ip = -1;
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
        mal_vm_release_shaded_coroutine_buffer(vm, frame->registers);
        mal_vm_release_shaded_coroutine_buffer(vm, frame->arguments);
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
bool mal_vm_owns_realm(const MalVm *vm, const MalRealm *realm) {
    if (realm == nullptr) return false;
    if (realm == vm->initial_realm) return true;
    for (const MalRealm *owned = vm->realms; owned != nullptr; owned = owned->next) {
        if (owned == realm) return true;
    }
    return false;
}

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
    MalHeap *heap = &vm->heap;
    // A built-in constructor's `prototype` is fixed like a class's, so both use the cache.
    bool function = mal_value_is_function_object(constructor) ||
        mal_value_is_native_function_object(constructor);
    if (function) {
        const void *identity = mal_value_to_heap(constructor);
        for (usize i = 0; i < countof(heap->fixed_constructor_prototypes); i++) {
            if (heap->fixed_constructor_prototypes[i].constructor == identity &&
                heap->fixed_constructor_prototypes[i].heap_epoch == heap->epoch) {
                MAL_PERF_COUNT(fixed_constructor_prototype_hits);
                *prototype_out = heap->fixed_constructor_prototypes[i].prototype;
                return true;
            }
        }
    }
    MalKey key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE);
    MalValue prototype;
    // An own data property is what [[Get]] returns; a script function creates its
    // `prototype` lazily and a native one may lack it, so only an absent one needs
    // the generic path.
    MalPropertyLookup own = function
        ? mal_object_get_own(mal_value_to_object(constructor), key)
        : (MalPropertyLookup) {0};
    if (own.present && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        prototype = own.desc.value;
        if (mal_value_is_object(prototype) &&
            !(own.desc.flags & (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE))) {
            usize slot = heap->fixed_constructor_next++ % countof(heap->fixed_constructor_prototypes);
            heap->fixed_constructor_prototypes[slot].constructor = mal_value_to_heap(constructor);
            heap->fixed_constructor_prototypes[slot].prototype = mal_value_to_object(prototype);
            heap->fixed_constructor_prototypes[slot].heap_epoch = heap->epoch;
        }
    } else if (!mal_vm_get_property(vm, constructor, key, &prototype)) {
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
    const MalFunction *function = &vm->runtime_image->functions[function_index];
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
    frame->is_compiled = false;
    frame->instruction_pointer = argument_snapshot_count;
    frame->gc_safepoint_ip = -1;
    frame->return_register = return_register;
    frame->caller_frame_index = caller_frame_index;
    frame->enter_seq = vm->frame_seq++;
    mal_vm_frame_mark_native_position(frame, vm);
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
    // A terminating isolate's throw is uncatchable; no catch or finally runs.
    if (mal_gc_terminating()) return false;
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
            // An async body's uncaught throw rejects its promise; its callers'
            // handlers never see it, even before the first await.
            if (frame->generator != nullptr && frame->generator->is_async) return false;
            continue;
        }

        for (i32 i = vm->frame_count - 1; i > frame_index; i--) {
            mal_vm_pop_frame_storage(vm, &vm->frames[i]);
        }

        vm->frame_count = frame_index + 1;
        frame->instruction_pointer = innermost->handler_ip;
        frame->gc_safepoint_ip = -1;
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

// Exact maps omit noncollecting operations, whose stale registers cannot be scanned.
static bool mal_vm_prepare_interpreter_safepoint_except(
    MalVmFrame *frame,
    i32 instruction_ip,
    i32 preserved_register
) {
    const MalFunction *function = frame->function;
    if (!function->gc_safepoints_trusted) return true;
    const i32 *row = function->gc_safepoints;
    for (i32 index = 0; index < function->gc_safepoint_count; index++) {
        i32 row_ip = *row++;
        i32 root_count = *row++;
        row += root_count;
        i32 clear_count = *row++;
        if (row_ip == instruction_ip) {
            for (i32 clear = 0; clear < clear_count; clear++) {
                if (row[clear] != preserved_register) {
                    frame->registers[row[clear]] = mal_value_new_undefined();
                }
            }
            return true;
        }
        row += clear_count;
        if (row_ip > instruction_ip) break;
    }
    return false;
}

static bool mal_vm_prepare_interpreter_safepoint(MalVmFrame *frame, i32 instruction_ip) {
    return mal_vm_prepare_interpreter_safepoint_except(frame, instruction_ip, -1);
}

// Direct leaves write through the frame's published register buffer, so only the
// shadow instruction pointer needs publishing before a helper, throw, or GC seam.
#define MAL_VM_INTERPRETER_DIRECT_LEAF() \
    MAL_PERF_COUNT(interpreter_direct_leaf_executions)

#if MAL_PROFILE && MAL_PERF_STATS
#define MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(ip) \
    do { \
        i32 fused_profile_site_id = frame->function->profile_site_ids == nullptr \
            ? -1 \
            : frame->function->profile_site_ids[(ip)]; \
        vm->profile_current_site_id = fused_profile_site_id; \
        MAL_PROFILE_SITE_EVENT( \
            vm, fused_profile_site_id, MAL_PROFILE_SITE_EXECUTION, 1); \
        MAL_VM_INTERPRETER_DIRECT_LEAF(); \
    } while (0)
#else
#define MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(ip) \
    do { \
        (void) (ip); \
        MAL_VM_INTERPRETER_DIRECT_LEAF(); \
    } while (0)
#endif

#define MAL_VM_INTERPRETER_ACTIVATION_BOUNDARY(call) \
    do { \
        mal_vm_prepare_interpreter_safepoint(frame, instruction_pointer - 1); \
        frame->instruction_pointer = instruction_pointer; \
        frame->gc_safepoint_ip = instruction_pointer - 1; \
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
        mal_vm_prepare_interpreter_safepoint(frame, instruction_pointer - 1); \
        frame->instruction_pointer = instruction_pointer; \
        frame->gc_safepoint_ip = instruction_pointer - 1; \
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
        bool can_poll = mal_vm_prepare_interpreter_safepoint(frame, instruction_pointer - 1); \
        frame->instruction_pointer = instruction_pointer; \
        frame->gc_safepoint_ip = instruction_pointer - 1; \
        MAL_PERF_COUNT(interpreter_state_syncs); \
        MAL_PERF_COUNT(interpreter_boundary_dispatches); \
        call; \
        if (can_poll && mal_vm_interpreter_activation_is_current(vm, activation) && mal_gc_poll_requested()) { \
            mal_gc_safepoint(vm); \
        } \
        if (mal_vm_interpreter_activation_is_current(vm, activation)) { \
            MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE(activation); \
        } \
    } while (0)

#define MAL_VM_INTERPRETER_SYNC_AT(safepoint_ip) \
    do { \
        mal_vm_prepare_interpreter_safepoint(frame, (safepoint_ip)); \
        frame->instruction_pointer = instruction_pointer; \
        frame->gc_safepoint_ip = (safepoint_ip); \
        MAL_PERF_COUNT(interpreter_state_syncs); \
    } while (0)

#define MAL_VM_INTERPRETER_SYNC() \
    MAL_VM_INTERPRETER_SYNC_AT(instruction_pointer - 1)

static_assert(
    MAL_DIRECT_BUILTIN_SET_DELETE - MAL_DIRECT_BUILTIN_MAP_GET == 6,
    "exact collection builtin opcodes must stay contiguous"
);

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

            case MAL_OP_BASE_CONSTRUCT_RESULT: {
                MalValue value = registers[instruction->as.base_construct_result.value];
                registers[instruction->as.base_construct_result.dst] =
                    mal_value_is_object(value)
                    ? value
                    : registers[instruction->as.base_construct_result.receiver];
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }

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
                    &vm->runtime_image->string_constants[instruction->as.create_string.string_index]);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_BIGINT:
                registers[instruction->as.create_bigint.dst] = mal_value_from_bigint(
                    &vm->runtime_image->bigint_constants[instruction->as.create_bigint.bigint_index]);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_OBJECT:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_object(frame, instruction));
                break;
            case MAL_OP_CREATE_BASE_CONSTRUCT_RECEIVER:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_create_base_construct_receiver(frame, instruction));
                break;
            case MAL_OP_CREATE_OBJECT_SHAPED:
                // Successful creation cannot collect or replace this activation.
                mal_op_create_object_shaped(frame, instruction);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    MAL_VM_INTERPRETER_SYNC();
                    break;
                }
                if (instruction_pointer < frame->function->instruction_count) {
                    const MalInstruction *jump = &instructions[instruction_pointer];
                    if (jump->opcode == MAL_OP_JUMP &&
                        jump->as.jump.target_ip > instruction_pointer) {
                        MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(instruction_pointer);
                        instruction_pointer = jump->as.jump.target_ip;
                        MAL_PERF_COUNT(interpreter_create_object_shaped_jump_fusions);
                    }
                }
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_CREATE_ARRAY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_array(frame, instruction));
                break;
            case MAL_OP_INSTANTIATE_LITERAL_TEMPLATE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_instantiate_literal_template(frame, instruction));
                break;
            case MAL_OP_QUERY_STATIC_DATA:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_query_static_data(frame, instruction));
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
                if (instruction_pointer < frame->function->instruction_count) {
                    const MalInstruction *branch = &instructions[instruction_pointer];
                    if (branch->opcode == MAL_OP_JUMP_IF &&
                        branch->as.jump_if.cond == instruction->as.binary.dst &&
                        branch->as.jump_if.target_ip > instruction_pointer) {
                        bool truthy = mal_value_is_boolean(result)
                            ? mal_value_to_boolean(result)
                            : mal_value_is_truthy(result);
                        MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(instruction_pointer);
                        instruction_pointer++;
                        if (truthy) {
                            instruction_pointer = branch->as.jump_if.target_ip;
                        }
                        MAL_PERF_COUNT(interpreter_binary_branch_fusions);
                    }
                }
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
            case MAL_OP_LOAD_GLOBAL_INDEX:
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                registers[instruction->as.load_global_index.dst] = mal_value_from_i32(instruction->as.load_global_index.index);
                continue;
            case MAL_OP_LOAD_GLOBAL: {
                i32 dst = instruction->as.load_global.dst;
                MalValue value = vm->globals[instruction->as.load_global.index];
                registers[dst] = value;
                if (!mal_value_is_empty(value) &&
                    instruction_pointer < frame->function->instruction_count) {
                    const MalInstruction *tdz_check = &instructions[instruction_pointer];
                    if (tdz_check->opcode == MAL_OP_THROW_IF_TDZ &&
                        tdz_check->as.throw_if_tdz.src == dst) {
                        MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(instruction_pointer);
                        instruction_pointer++;
                        MAL_PERF_COUNT(interpreter_global_tdz_fusions);
                    }
                }
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_LOAD_PRIMORDIAL:
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_load_primordial(frame, instruction));
                break;
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
                    mal_vm_array_try_get_index(
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
                // This one dispatch site serves every static name, so it also keeps the
                // length rows inline; they are recorded only for `length` sites.
                bool cache_hit = mal_vm_property_try_load_length_static(vm, object, ic, &result);
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
            case MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH: {
                MalValue object = registers[instruction->as.load_property_static.object];
                if (mal_value_is_heap_type(object, MAL_HEAP_ARRAY_OBJECT)) {
                    const MalArrayObject *array =
                        (const MalArrayObject *) mal_value_to_heap(object);
                    registers[instruction->as.load_property_static.dst] =
                        mal_value_from_u32(mal_array_object_length(array));
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_load_property_static(frame, instruction));
                break;
            }
            case MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT: {
                const i32 *data = frame->function->instruction_data +
                    instruction->as.load_property_static_known_own_slot.data_offset;
                MalValue object = registers[
                    instruction->as.load_property_static_known_own_slot.object];
                MalValue result;
                MalInlineCache *ic = mal_vm_property_ic_at(
                    frame, instruction->as.load_property_static_known_own_slot.ic_index);
                if (mal_vm_try_load_known_own_slots(
                        vm, object, ic, data[1], &data[2], &result)) {
                    registers[instruction->as.load_property_static_known_own_slot.dst] = result;
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_load_property_static_known_own_slot_fallback(frame, instruction));
                break;
            }
            case MAL_OP_SELECT_SHAPE_CASE: {
                const i32 *data = frame->function->instruction_data +
                    instruction->as.select_shape_case.data_offset;
                MalValue object = registers[instruction->as.select_shape_case.object];
                i32 shape_case = mal_vm_select_shape_case(
                    vm,
                    object,
                    instruction->as.select_shape_case.candidate_count,
                    data);
                registers[instruction->as.select_shape_case.dst] =
                    mal_value_from_i32(shape_case);
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE: {
                const i32 *data = frame->function->instruction_data +
                    instruction->as.load_property_static_shape_case.data_offset;
                MalValue object = registers[
                    instruction->as.load_property_static_shape_case.object];
                MalValue encoded_case = registers[
                    instruction->as.load_property_static_shape_case.shape_case];
                i32 shape_case = mal_value_is_int32(encoded_case)
                    ? mal_value_to_i32(encoded_case)
                    : -1;
                MalValue result;
                if (mal_vm_try_load_shape_case(
                        object, shape_case, data[2], &data[3], &result)) {
                    registers[instruction->as.load_property_static_shape_case.dst] = result;
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(
                    mal_op_load_property_static_shape_case_fallback(frame, instruction));
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
                MalInlineCache *ic = mal_vm_property_ic_at(
                    frame, instruction->as.store_property_static_known_own_slot.ic_index);
                if (mal_vm_try_store_known_own_slots(
                        vm, object, value, ic, data[1], &data[2])) {
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
            case MAL_OP_CALL_REST_ARGUMENTS: {
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_call_rest_arguments(frame, instruction));
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
            case MAL_OP_FOR_IN_HAS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_for_in_has(frame, instruction));
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
                MalObject *generator_prototype =
                    mal_vm_generator_instance_prototype(
                        vm, frame->callee, start_is_async_generator);

                MalGeneratorObject *generator = start_is_async_generator
                    ? mal_generator_object_new_async(
                        &vm->heap, generator_prototype, true)
                    : mal_generator_object_new(&vm->heap, generator_prototype);

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
                MalGeneratorObject *generator = frame->generator;
                // Wire frames lack trusted liveness; capture before clearing aliased resume outputs.
                MalValue transfer_roots[] = {
                    mal_value_from_object((MalObject *) generator),
                    frame->registers[instruction->as.yield.yielded_src],
                };
                MalRootSpan transfer_root_span;
                mal_gc_root(&transfer_root_span, transfer_roots, 2);
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
                // SATB: yielded_value + frame.env are traced heap fields overwritten
                // here; shade the previous contents (a re-suspend replaces the env
                // from the last suspend). The register buffer is mutated in place
                // (root state until this suspend), so its slots need no shade.
                mal_gc_write_barrier(generator->yielded_value);
                generator->yielded_value = transfer_roots[1];
                frame->registers[instruction->as.yield.value_dst] = mal_value_new_undefined();
                frame->registers[instruction->as.yield.mode_dst] = mal_value_new_undefined();
                generator->resume_value_register = instruction->as.yield.value_dst;
                generator->resume_mode_register = instruction->as.yield.mode_dst;
                generator->state = MAL_GENERATOR_SUSPENDED_YIELD;

                if (generator->frame.env != nullptr) {
                    mal_gc_write_barrier_env(generator->frame.env);
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
                mal_gc_unroot(&transfer_root_span);
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
                MalGeneratorObject *state = frame->generator;
                // PromiseResolve can collect after an aliased operand has left the frame.
                MalValue transfer_roots[] = {
                    mal_value_from_object((MalObject *) state),
                    frame->registers[instruction->as.await.awaited_src],
                };
                MalRootSpan transfer_root_span;
                mal_gc_root(&transfer_root_span, transfer_roots, 2);
                MAL_VM_INTERPRETER_SYNC();
                MAL_PERF_COUNT(interpreter_boundary_dispatches);
                frame->registers[instruction->as.await.value_dst] = mal_value_new_undefined();
                frame->registers[instruction->as.await.mode_dst] = mal_value_new_undefined();
                state->resume_value_register = instruction->as.await.value_dst;
                state->resume_mode_register = instruction->as.await.mode_dst;
                state->state = MAL_GENERATOR_SUSPENDED_YIELD;

                // SATB: frame.env is a traced heap field overwritten by the re-suspend.
                if (state->frame.env != nullptr) {
                    mal_gc_write_barrier_env(state->frame.env);
                }
                state->frame = *frame;
                // Re-suspend at await: old async state re-acquires its frame.
                mal_gc_remember_if_old(&state->object.header);

                vm->frame_count--;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
                mal_async_function_await(vm, state, transfer_roots[1]);
                mal_gc_unroot(&transfer_root_span);
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
            case MAL_OP_GUARD_SERVICE_EPOCH:
                registers[instruction->as.guard_service_epoch.dst] = mal_value_new_boolean(mal_vm_guard_service_epoch(vm, mal_ops_number_as_f64(registers[instruction->as.guard_service_epoch.epoch])));
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_READ_SERVICE_EPOCH:
                registers[instruction->as.read_service_epoch.dst] = mal_ops_number_value(mal_vm_read_service_epoch(vm));
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            case MAL_OP_PROBE_READ: {
                const i32 *data = frame->function->instruction_data + instruction->as.probe_read.data_offset;
                MalValue value;
                bool success = mal_vm_probe_read(vm,
                    registers[instruction->as.probe_read.object],
                    registers[data[0]], (u8) data[1], data[2],
                    mal_vm_probe_read_kind_named((u8) data[1]) ? mal_vm_property_ic_at(frame, data[3]) : nullptr,
                    &value);
                registers[instruction->as.probe_read.dst] = value;
                registers[instruction->as.probe_read.success] = success ? MAL_VALUE_TRUE : MAL_VALUE_FALSE;
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
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
            case MAL_OP_DECLARE_GLOBAL_LEXICAL:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_declare_global_lexical(frame, instruction));
                break;
            case MAL_OP_GLOBAL_BINDING_QUERY:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_global_binding_query(frame, instruction));
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
            case MAL_OP_BUILTIN_ERROR:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_builtin_error(frame, instruction));
                break;
            case MAL_OP_PREPARED_STRING_COMPARE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_prepared_string_compare(frame, instruction));
                break;
            case MAL_OP_PRECISE_NUMBER_SUM:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_precise_number_sum(frame, instruction));
                break;
            case MAL_OP_STRING_CONCAT_LENGTH:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_string_concat_length(frame, instruction));
                break;
            case MAL_OP_CONCAT_STRINGS:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_concat_strings(frame, instruction));
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
            case MAL_OP_CREATE_ARRAY_FROM_ITERABLE:
                MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER(mal_op_create_array_from_iterable(frame, instruction));
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
            case MAL_OP_GUARD_FUNCTION_INDEX: {
                bool matches = mal_vm_callee_has_index(
                    vm,
                    registers[instruction->as.guard_function_index.callee],
                    instruction->as.guard_function_index.function_index);
                registers[instruction->as.guard_function_index.dst] =
                    mal_value_new_boolean(matches);
                if (instruction_pointer < frame->function->instruction_count) {
                    const MalInstruction *branch = &instructions[instruction_pointer];
                    if (branch->opcode == MAL_OP_JUMP_IF &&
                        branch->as.jump_if.cond == instruction->as.guard_function_index.dst &&
                        branch->as.jump_if.target_ip > instruction_pointer) {
                        MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(instruction_pointer);
                        instruction_pointer++;
                        if (matches) {
                            instruction_pointer = branch->as.jump_if.target_ip;
                        }
                        MAL_PERF_COUNT(interpreter_guard_branch_fusions);
                    }
                }
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
            case MAL_OP_GUARD_BASE_CONSTRUCTOR_LAYOUT: {
                const i32 *data = &frame->function->instruction_data[
                    instruction->as.guard_base_constructor_layout.data_offset];
                bool matches = mal_vm_guard_base_constructor_layout(
                    vm,
                    registers[instruction->as.guard_base_constructor_layout.callee],
                    instruction->as.guard_base_constructor_layout.function_index,
                    data[0], &data[4], data[2], data[3],
                    mal_vm_property_ic_at(frame, data[1]));
                registers[instruction->as.guard_base_constructor_layout.dst] =
                    mal_value_new_boolean(matches);
                if (instruction_pointer < frame->function->instruction_count) {
                    const MalInstruction *branch = &instructions[instruction_pointer];
                    if (branch->opcode == MAL_OP_JUMP_IF &&
                        branch->as.jump_if.cond ==
                            instruction->as.guard_base_constructor_layout.dst &&
                        branch->as.jump_if.target_ip > instruction_pointer) {
                        MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF(instruction_pointer);
                        instruction_pointer++;
                        if (matches) instruction_pointer = branch->as.jump_if.target_ip;
                        MAL_PERF_COUNT(interpreter_guard_branch_fusions);
                    }
                }
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                continue;
            }
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
                const i32 *call_data = frame->function->instruction_data +
                    instruction->as.call.data_offset;
                i32 guarded_tag = call_data[3 + call_data[2] + call_data[0]];
                if ((guarded_tag < 0 ||
                     (guarded_tag > 0 && guarded_tag <= MAL_MATH_UNARY_ROUND)) &&
                    mal_op_call_guarded_math(frame, instruction)) {
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    continue;
                }
                if (guarded_tag > MAL_MATH_UNARY_ROUND &&
                    mal_op_call_guarded_builtin(frame, instruction)) {
                    MAL_VM_INTERPRETER_DIRECT_LEAF();
                    if (!mal_gc_poll_requested()) continue;
                    MalVmInterpreterActivation activation =
                        mal_vm_interpreter_activation(vm, frame);
                    if (!mal_vm_prepare_interpreter_safepoint_except(
                        frame,
                        instruction_pointer - 1,
                        instruction->as.call.dst)) continue;
                    frame->instruction_pointer = instruction_pointer;
                    frame->gc_safepoint_ip = instruction_pointer - 1;
                    MAL_PERF_COUNT(interpreter_state_syncs);
                    MAL_PERF_COUNT(interpreter_boundary_dispatches);
                    mal_gc_safepoint(vm);
                    if (mal_vm_interpreter_activation_is_current(vm, activation)) {
                        MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE(activation);
                    }
                    break;
                }
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_call(frame, instruction));
                break;
            }
            case MAL_OP_CALL_KNOWN:
                MAL_VM_INTERPRETER_SYNCHRONIZED_CALL(mal_op_call_known(frame, instruction));
                break;
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
                i32 safepoint_ip = instruction_pointer - 1;
                bool backedge = instruction->as.jump.target_ip < instruction_pointer;
                instruction_pointer = instruction->as.jump.target_ip;
                MAL_VM_INTERPRETER_DIRECT_LEAF();
                if (backedge && mal_gc_poll_requested()) {
                    MAL_VM_INTERPRETER_SYNC_AT(safepoint_ip);
                    mal_gc_safepoint(vm);
                    frame = &vm->frames[vm->frame_count - 1];
                    instructions = frame->function->instructions;
                    registers = frame->registers;
                    instruction_pointer = frame->instruction_pointer;
                    MAL_PERF_COUNT(interpreter_state_reloads);
                    if (mal_gc_poll_termination(vm)) break;
                }
                continue;
            }
            case MAL_OP_JUMP_IF: {
                i32 safepoint_ip = instruction_pointer - 1;
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
                if (backedge && mal_gc_poll_requested()) {
                    MAL_VM_INTERPRETER_SYNC_AT(safepoint_ip);
                    mal_gc_safepoint(vm);
                    frame = &vm->frames[vm->frame_count - 1];
                    instructions = frame->function->instructions;
                    registers = frame->registers;
                    instruction_pointer = frame->instruction_pointer;
                    MAL_PERF_COUNT(interpreter_state_reloads);
                    if (mal_gc_poll_termination(vm)) break;
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
                if (vm->completion.kind == MAL_COMPLETION_NORMAL && mal_gc_poll_requested()) {
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
#undef MAL_VM_INTERPRETER_SYNC_AT
#undef MAL_VM_INTERPRETER_SYNCHRONIZED_CALL
#undef MAL_VM_INTERPRETER_SYNCHRONIZED_HELPER
#undef MAL_VM_INTERPRETER_RELOAD_AND_CONTINUE
#undef MAL_VM_INTERPRETER_ACTIVATION_BOUNDARY
#undef MAL_VM_INTERPRETER_ATTRIBUTE_FUSED_LEAF
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

static MalVmUncaughtHandler mal_vm_uncaught_handler;

void mal_vm_set_uncaught_handler(MalVmUncaughtHandler handler) {
    mal_vm_uncaught_handler = handler;
}

/* Hands `error` to the handler with no throw pending; false leaves `error` (or the
 * handler's own throw) pending. */
static bool mal_vm_offer_uncaught(MalVm *vm, MalValue error, bool from_rejection, MalValue promise) {
    if (mal_vm_uncaught_handler == nullptr || vm->errors_forwarded) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = error};
        return false;
    }
    MalValue roots[] = {error, promise};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    bool handled = mal_vm_uncaught_handler(vm, roots[0], from_rejection, roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) handled = false;
    else if (!handled) vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[0]};
    mal_gc_unroot(&root);
    return handled;
}

bool mal_vm_report_uncaught(MalVm *vm) {
    if (mal_vm_offer_uncaught(vm, vm->completion.value, false, mal_value_new_undefined())) {
        return true;
    }
    mal_vm_print_thrown(vm, vm->completion.value, "Uncaught ");
    vm->uncaught_reported = true;
    return false;
}

void mal_vm_note_unhandled_rejection(MalVm *vm, MalValue promise) {
    if (vm->unhandled_count == vm->unhandled_capacity) {
        vm->unhandled_capacity = vm->unhandled_capacity == 0 ? 8 : vm->unhandled_capacity * 2;
        vm->unhandled_rejections = realloc(vm->unhandled_rejections, sizeof(MalValue) * (usize) vm->unhandled_capacity);
    }
    vm->unhandled_rejections[vm->unhandled_count++] = promise;
}

void mal_vm_report_unhandled_rejections(MalVm *vm) {
    if (vm->errors_forwarded && vm->completion.kind == MAL_COMPLETION_THROW) {
        vm->unhandled_count = 0;
        return;
    }
    for (i32 i = 0; i < vm->unhandled_count; i++) {
        MalValue promise_value = vm->unhandled_rejections[i];
        if (!mal_value_is_promise_object(promise_value)) {
            continue;
        }
        MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
        // A handler attached between rejection and the checkpoint clears it.
        if (promise->state == MAL_PROMISE_REJECTED && !promise->is_handled) {
            if (vm->errors_forwarded) {
                // Completion roots the reason before the rejection candidates are released.
                vm->completion = (MalCompletion) {
                    .kind = MAL_COMPLETION_THROW, .value = promise->result};
                break;
            }
            if (mal_vm_uncaught_handler == nullptr && !vm->host_node) {
                mal_vm_print_thrown(vm, promise->result, "Uncaught (in promise) ");
                continue;
            }
            // Node's default --unhandled-rejections=throw: an unconsumed rejection is fatal.
            promise->is_handled = true;
            if (mal_vm_offer_uncaught(vm, promise->result, true, promise_value)) continue;
            mal_vm_print_thrown(vm, vm->completion.value, "Uncaught (in promise) ");
            vm->uncaught_reported = true;
            break;
        }
    }
    vm->unhandled_count = 0;
}

void mal_vm_run(MalVm *vm, MalCallable *callable) {
    i32 entry_index = callable->function_index;
    const MalFunction *entry = &vm->runtime_image->functions[entry_index];
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
        {
            MalValue value = entry->compiled(
                vm, entry_this, nullptr, 0, mal_value_new_undefined(), nullptr,
                mal_value_new_undefined(), nullptr
            );
            // Runtime eval can splice functions into the live program and move
            // its function table. The index is stable; a pointer cached across the
            // compiled call is not.
            entry = &vm->runtime_image->functions[entry_index];
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
    MalRootSpan script_result_root;
    mal_gc_root(&script_result_root, &script_completion.value, 1);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    if (vm->errors_forwarded && mal_value_is_promise_object(vm->entry_async_promise)) {
        mal_value_to_promise_object(vm->entry_async_promise)->is_handled = true;
    }
    mal_vm_drain_microtasks(vm);
    mal_gc_unroot(&script_result_root);

    if (script_completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = script_completion;
        if (!vm->errors_forwarded) mal_vm_report_uncaught(vm);
        return;
    }

    mal_vm_check_entry_evaluation(vm);
}

bool mal_vm_check_entry_evaluation(MalVm *vm) {
    if (mal_value_is_promise_object(vm->entry_async_promise)) {
        MalPromiseObject *result = mal_value_to_promise_object(vm->entry_async_promise);
        if (result->state == MAL_PROMISE_REJECTED) {
            vm->completion =
                (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = result->result};
            return false;
        }
    }
    return true;
}

void mal_vm_resume_generator(MalVm *vm, MalGeneratorObject *generator, MalValue sent_value, i32 resume_mode) {
    // Re-resolve in case a runtime-eval splice moved the function table while
    // this generator was suspended (function_index is the source of truth).
    const MalFunction *function = &vm->live_runtime_image.functions[generator->frame.function_index];

    // SATB resume seam (concurrent cycle): a suspended coroutine's frame is heap
    // state (traced via the generator cell); resuming migrates it to root state.
    // Shade its current register/arg values into the snapshot BEFORE the resume
    // delivers the sent value / runs the body, or a value published from a
    // coroutine register into an already-black object would be lost (the
    // root-migration window). Mirrors the tracer: null-check the frame
    // function before re-resolving (splice-safe) so register_count is read fresh.
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
        // A refused entry throws into the coroutine from the compiled prologue, since
        // resume destinations name snapshot mailboxes independently of native locals.
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
    mal_vm_frame_mark_native_position(frame, vm);

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

#if UINTPTR_MAX != UINT64_MAX || (!defined(__aarch64__) && !defined(__x86_64__))
__attribute__((noinline)) uptr mal_vm_native_stack_address(void) {
    // The fallback frame is below the caller even when its frame pointer is not.
    return (uptr) __builtin_frame_address(0);
}
#endif

__attribute__((cold, noinline)) void mal_vm_throw_stack_overflow(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
}

void mal_vm_sync_entry_stack_limit(MalVm *vm) {
#if !defined(__wasi__)
    if (vm->runtime_image != nullptr && vm->runtime_image->conservative_stack_roots) {
        vm->entry_stack_limit = &mal_isolate_locals()->entry_stack_limit;
        atomic_store_explicit(vm->entry_stack_limit, vm->stack_limit, memory_order_relaxed);
        // Stored after the real limit, so a request between the two is not lost.
        if (mal_gc_poll_requested()) {
            atomic_store_explicit(vm->entry_stack_limit, UINTPTR_MAX, memory_order_relaxed);
        }
        return;
    }
    vm->entry_stack_limit = &vm->own_entry_stack_limit;
    atomic_store_explicit(vm->entry_stack_limit, vm->stack_limit, memory_order_relaxed);
#else
    vm->entry_stack_limit = &vm->own_entry_stack_limit;
    *vm->entry_stack_limit = vm->stack_limit;
#endif
}

__attribute__((cold, noinline)) bool mal_vm_enter_compiled_limit(MalVm *vm) {
    if (mal_vm_native_stack_address() < vm->stack_limit) {
        mal_vm_throw_stack_overflow(vm);
        return false;
    }
    mal_vm_sync_entry_stack_limit(vm);
    if (!mal_gc_poll_requested() || !mal_gc_entry_poll_due()) return true;
    mal_gc_safepoint(vm);
    if (mal_gc_poll_termination(vm)) return false;
    // A gated or stressed collection leaves the request pending for the next entry.
    if (mal_gc_poll_requested()) mal_vm_sync_entry_stack_limit(vm);
    return true;
}

__attribute__((cold, noinline)) MalNativeFrame *mal_vm_enter_compiled_slow(
    MalVm *vm, i32 function_index
) {
    i32 count = vm->native_frame_count;
    if (count >= MAL_NATIVE_CALL_DEPTH_LIMIT) {
        mal_vm_throw_stack_overflow(vm);
        return nullptr;
    }
    if (mal_vm_native_stack_address() < mal_vm_entry_stack_limit(vm) &&
            !mal_vm_enter_compiled_limit(vm)) {
        return nullptr;
    }
    if (vm->native_frames == nullptr) {
        // Untouched rows stay uncommitted; full capacity keeps every live row in place.
        vm->native_frames = calloc(MAL_NATIVE_CALL_DEPTH_LIMIT, sizeof(MalNativeFrame));
        if (vm->native_frames == nullptr) {
            mal_vm_throw_stack_overflow(vm);
            return nullptr;
        }
        vm->native_frame_capacity = MAL_NATIVE_CALL_DEPTH_LIMIT;
    }
    return mal_vm_push_native_frame(vm, count, function_index);
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

static MalStackTrace *mal_vm_stack_trace_new(MalVm *vm, usize frame_capacity) {
    usize frame_bytes;
    usize bytes;
    if (!mal_checked_size_multiply(
            sizeof(MalStackFrameRecord), frame_capacity, SIZE_MAX, &frame_bytes) ||
        !mal_checked_size_add(sizeof(MalStackTrace), frame_bytes, SIZE_MAX, &bytes)) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    MalStackTrace *trace = malloc(bytes);
    if (trace == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    trace->frame_count = 0;
    trace->async_parent = nullptr;
    trace->frame_skip = 0;
    trace->frame_limit = -1;
    return trace;
}

#if MAL_NATIVE_FRAME_WALK
/* Every registered descriptor, sorted by code address when a capture needs it.
 * Registration happens once per generated function and captures are rare next to
 * calls, so one lock serves both. */
static pthread_mutex_t g_compiled_frames_lock = PTHREAD_MUTEX_INITIALIZER;
static MalCompiledFrameDesc **g_compiled_frames;
static usize g_compiled_frame_count;
static usize g_compiled_frame_capacity;
static bool g_compiled_frames_sorted = true;
static uptr g_compiled_text_start;
static uptr g_compiled_text_end;

#if !defined(__APPLE__)
extern const char __start_mal_js_text[] __attribute__((weak));
extern const char __stop_mal_js_text[] __attribute__((weak));
#endif

static void mal_compiled_text_bounds(const void *code) {
#if defined(__APPLE__)
    Dl_info info;
    unsigned long size = 0;
    if (dladdr(code, &info) == 0 || info.dli_fbase == nullptr) return;
    const u8 *start = getsectiondata(
        (const struct mach_header_64 *) info.dli_fbase, "__TEXT", "__mal_js", &size);
    if (start == nullptr) return;
    g_compiled_text_start = (uptr) start;
    g_compiled_text_end = (uptr) start + size;
#else
    (void) code;
    g_compiled_text_start = (uptr) __start_mal_js_text;
    g_compiled_text_end = (uptr) __stop_mal_js_text;
#endif
}

void mal_compiled_frame_register(MalCompiledFrameDesc *desc, i32 frame_offset) {
    pthread_mutex_lock(&g_compiled_frames_lock);
    if (atomic_load_explicit(&desc->frame_offset, memory_order_relaxed) == 0) {
        if (g_compiled_frame_count == g_compiled_frame_capacity) {
            usize capacity = g_compiled_frame_capacity == 0 ? 256 : g_compiled_frame_capacity * 2;
            MalCompiledFrameDesc **frames = realloc(g_compiled_frames, capacity * sizeof *frames);
            // Without a slot the function stays out of traces and retries on its next entry.
            if (frames == nullptr) goto done;
            g_compiled_frames = frames;
            g_compiled_frame_capacity = capacity;
        }
        if (g_compiled_text_end == 0) mal_compiled_text_bounds(desc->code);
        g_compiled_frames[g_compiled_frame_count++] = desc;
        g_compiled_frames_sorted = false;
        atomic_store_explicit(&desc->frame_offset, frame_offset, memory_order_release);
    }
done:
    pthread_mutex_unlock(&g_compiled_frames_lock);
}

static int mal_compiled_frame_compare(const void *left, const void *right) {
    uptr a = (uptr) (*(MalCompiledFrameDesc *const *) left)->code;
    uptr b = (uptr) (*(MalCompiledFrameDesc *const *) right)->code;
    return a < b ? -1 : a > b;
}

static const MalCompiledFrameDesc *mal_compiled_frame_containing(uptr address) {
    // Unknown bounds leave the record's descriptor check as the only filter.
    if (g_compiled_text_end != 0 &&
            (address < g_compiled_text_start || address >= g_compiled_text_end)) {
        return nullptr;
    }
    usize low = 0;
    usize high = g_compiled_frame_count;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if ((uptr) g_compiled_frames[middle]->code <= address) low = middle + 1;
        else high = middle;
    }
    return low == 0 ? nullptr : g_compiled_frames[low - 1];
}

static uptr mal_vm_running_stack_top(const MalVm *vm) {
    const MalFiber *fiber = vm->current_fiber;
    if (fiber != nullptr && fiber->stack_base != nullptr) {
        return (uptr) fiber->stack_base + fiber->stack_size;
    }
    return vm->native_stack_top != 0 ? vm->native_stack_top : UINTPTR_MAX;
}

typedef struct MalWalkedFrame {
    /** The compiled function's frame pointer, which orders it against interpreted frames. */
    uptr frame;
    const MalNativeFrame *record;
} MalWalkedFrame;

/* Compiled frames from the innermost outwards, counting past `capacity`. The walk
 * ends at the first frame record that does not lie above the previous one. Like the
 * conservative root scan, it reads other functions' frames, which sanitizers poison. */
static __attribute__((noinline, no_sanitize("address", "thread"))) usize mal_vm_walk_compiled_frames(
    const MalVm *vm, MalWalkedFrame *out, usize capacity
) {
    uptr top = mal_vm_running_stack_top(vm);
    uptr frame = (uptr) __builtin_frame_address(0);
    usize count = 0;
    pthread_mutex_lock(&g_compiled_frames_lock);
    if (!g_compiled_frames_sorted) {
        qsort(g_compiled_frames, g_compiled_frame_count, sizeof *g_compiled_frames,
              mal_compiled_frame_compare);
        g_compiled_frames_sorted = true;
    }
    for (;;) {
        const uptr *link = (const uptr *) frame;
        uptr caller = link[0];
        uptr return_address = link[1];
        if (caller <= frame || caller >= top || (caller & (sizeof(uptr) - 1)) != 0) break;
        // A call that ends its function returns to the first byte of the next one.
        const MalCompiledFrameDesc *desc = mal_compiled_frame_containing(return_address - 1);
        if (desc != nullptr) {
            i32 offset = atomic_load_explicit(&desc->frame_offset, memory_order_acquire);
            const MalNativeFrame *record = (const MalNativeFrame *) ((const char *) caller + offset);
            if (offset != 0 && (uptr) record > frame && (uptr) (record + 1) <= top &&
                    record->desc == desc) {
                if (count < capacity) out[count] = (MalWalkedFrame) {.frame = caller, .record = record};
                count++;
            }
        }
        frame = caller;
    }
    pthread_mutex_unlock(&g_compiled_frames_lock);
    return count;
}
#endif

i32 mal_vm_innermost_compiled_function(MalVm *vm) {
#if MAL_NATIVE_FRAME_WALK
    MalWalkedFrame frames[16];
    usize capacity = sizeof frames / sizeof frames[0];
    usize count = mal_vm_walk_compiled_frames(vm, frames, capacity);
    for (usize index = 0; index < count && index < capacity; index++) {
        if (!mal_native_frame_hidden(frames[index].record)) return frames[index].record->function_index;
    }
#else
    for (i32 index = vm->native_frame_count - 1; index >= 0; index--) {
        if (!mal_native_frame_hidden(&vm->native_frames[index])) return vm->native_frames[index].function_index;
    }
#endif
    return -1;
}

static void mal_stack_trace_push_interpreted(MalStackTrace *trace, const MalVmFrame *frame) {
    // The instruction pointer was advanced past the executing/call
    // instruction, so ip - 1 is the responsible site (as in unwinding).
    trace->frames[trace->frame_count++] = (MalStackFrameRecord) {
        .function_index = frame->function_index,
        .pos_id = mal_vm_position_for(frame->function, frame->instruction_pointer - 1),
    };
}

static void mal_stack_trace_push_native(
    MalVm *vm, MalStackTrace *trace, const MalNativeFrame *frame
) {
    if (mal_native_frame_hidden(frame)) return;
    trace->frames[trace->frame_count++] = (MalStackFrameRecord) {
        .function_index = frame->function_index,
        .pos_id = mal_vm_native_frame_pos_id(vm, frame),
    };
}

MalStackTrace *mal_vm_capture_stack(MalVm *vm) {
    // Both live-frame stacks are already ordered. Merge them from their newest
    // ends directly into one coallocated trace instead of sorting scratch.
#if MAL_NATIVE_FRAME_WALK
    MalWalkedFrame inline_native[128];
    MalWalkedFrame *native = inline_native;
    const usize inline_capacity = sizeof inline_native / sizeof inline_native[0];
    usize native_count = mal_vm_walk_compiled_frames(vm, native, inline_capacity);
    if (native_count > inline_capacity) {
        usize bytes;
        if (!mal_checked_size_multiply(sizeof *native, native_count, SIZE_MAX, &bytes) ||
                (native = malloc(bytes)) == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return nullptr;
        }
        usize walked = mal_vm_walk_compiled_frames(vm, native, native_count);
        if (walked < native_count) native_count = walked;
    }
#else
    usize native_count = (usize) vm->native_frame_count;
#endif
    usize frame_capacity;
    MalStackTrace *trace = nullptr;
    if (!mal_checked_size_add((usize) vm->frame_count, native_count, INT_MAX, &frame_capacity)) {
        mal_vm_throw_allocation_error(vm);
    } else {
        trace = mal_vm_stack_trace_new(vm, frame_capacity);
    }
    if (trace == nullptr) {
#if MAL_NATIVE_FRAME_WALK
        if (native != inline_native) free(native);
#endif
        return nullptr;
    }

    i32 interpreted = vm->frame_count - 1;
#if MAL_NATIVE_FRAME_WALK
    usize next_native = 0;
    while (interpreted >= 0 || next_native < native_count) {
        // A compiled frame is newer than an interpreted one exactly when it lies below it.
        if (interpreted >= 0 && (next_native == native_count ||
                mal_vm_frame_native_positions(vm)[interpreted] <= native[next_native].frame)) {
            mal_stack_trace_push_interpreted(trace, &vm->frames[interpreted--]);
        } else {
            mal_stack_trace_push_native(vm, trace, native[next_native++].record);
        }
    }
    if (native != inline_native) free(native);
#else
    i32 native = vm->native_frame_count - 1;
    while (interpreted >= 0 || native >= 0) {
        if (interpreted >= 0 && (native < 0 || native < vm->frames[interpreted].native_depth)) {
            mal_stack_trace_push_interpreted(trace, &vm->frames[interpreted--]);
        } else {
            mal_stack_trace_push_native(vm, trace, &vm->native_frames[native--]);
        }
    }
#endif

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
    while (async_state != nullptr &&
           async_state->async_data->awaited_by != nullptr && guard++ < 100000) {
        MalGeneratorObject *parent = async_state->async_data->awaited_by;
        const MalFunction *function = parent->frame.function;
        MalStackTrace *segment = mal_vm_stack_trace_new(vm, 1);
        if (segment == nullptr) {
            mal_vm_free_stack_trace(trace);
            return nullptr;
        }
        segment->frame_count = 1;
        // The awaiter is suspended at its `await`; ip - 1 is that await's site.
        segment->frames[0] = (MalStackFrameRecord) {
            .function_index = parent->frame.function_index,
            .pos_id = parent->frame.is_compiled
                ? mal_function_position_entry_id(
                      function, parent->frame.compiled_suspend_position_entry - 1)
                : mal_vm_position_for(function, parent->frame.instruction_pointer - 1),
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
            usize required;
            usize new_capacity;
            usize trace_bytes;
            usize free_bytes;
            if (!mal_checked_size_add(
                    (usize) vm->captured_trace_count, 1, INT_MAX, &required) ||
                !mal_checked_size_growth(
                    (usize) vm->captured_trace_capacity,
                    required,
                    16,
                    INT_MAX,
                    &new_capacity) ||
                !mal_checked_size_multiply(
                    sizeof(MalStackTrace *), new_capacity, SIZE_MAX, &trace_bytes) ||
                !mal_checked_size_multiply(
                    sizeof(i32), new_capacity, SIZE_MAX, &free_bytes)) {
                mal_vm_throw_allocation_error(vm);
                return -1;
            }
            MalStackTrace **grown_traces = malloc(trace_bytes);
            i32 *grown_free_next = malloc(free_bytes);
            if (grown_traces == nullptr || grown_free_next == nullptr) {
                free(grown_traces);
                free(grown_free_next);
                mal_vm_throw_allocation_error(vm);
                return -1;
            }
            if (vm->captured_trace_count > 0) {
                memcpy(
                    grown_traces,
                    vm->captured_traces,
                    sizeof(MalStackTrace *) * (usize) vm->captured_trace_count);
                memcpy(
                    grown_free_next,
                    vm->captured_trace_free_next,
                    sizeof(i32) * (usize) vm->captured_trace_count);
            }
            free(vm->captured_traces);
            free(vm->captured_trace_free_next);
            vm->captured_traces = grown_traces;
            vm->captured_trace_free_next = grown_free_next;
            vm->captured_trace_capacity = (i32) new_capacity;
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

typedef MalTextBuffer MalStackBuf;

static void mal_stack_buf_require(MalTextBufferStatus status) {
    // Stack formatting has no completion channel; preserve its infallible contract.
    if (status != MAL_TEXT_BUFFER_OK) {
        abort();
    }
}

static void mal_stack_buf_push_ascii(MalStackBuf *buf, const char *text) {
    mal_stack_buf_require(mal_text_buffer_append_ascii(buf, (const byte *) text));
}

static void mal_stack_buf_push_string(MalStackBuf *buf, const MalString *string) {
    mal_stack_buf_require(mal_text_buffer_append_string(buf, string));
}

static void mal_stack_buf_push_i32(MalStackBuf *buf, i32 value) {
    mal_stack_buf_require(mal_text_buffer_append_i32(buf, value));
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
                bool have_pos = pos_id >= 0 && pos_id < vm->runtime_image->source_position_count;
                const MalSourcePos *pos = have_pos ? &vm->runtime_image->source_positions[pos_id] : nullptr;
                bool inlined = pos != nullptr && pos->inlined_function_index >= 0 &&
                    pos->inlined_function_index < vm->runtime_image->function_count;
                i32 function_index = inlined ? pos->inlined_function_index : record->function_index;
                const MalFunction *function = &vm->runtime_image->functions[function_index];

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

                const MalString *name = function->name_string_index >= 0 &&
                        function->name_string_index < vm->runtime_image->string_constant_count
                    ? &vm->runtime_image->string_constants[function->name_string_index]
                    : nullptr;
                if (name != nullptr && mal_string_length(name) > 0) {
                    mal_stack_buf_push_string(&buf, name);
                } else {
                    mal_stack_buf_push_ascii(&buf, "<anonymous>");
                }

                bool have_file = function->file_index >= 0 && function->file_index < vm->runtime_image->file_count;
                if (have_file || have_pos) {
                    mal_stack_buf_push_ascii(&buf, " (");
                    if (have_file) {
                        mal_stack_buf_push_ascii(&buf, vm->runtime_image->files[function->file_index]);
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

    return mal_text_buffer_finish(&vm->heap, &buf);
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
    const MalFunction *function = &vm->runtime_image->functions[function_index];
    bool returns_promise = function->kind == MAL_FUNCTION_KIND_ASYNC;
    MalValue saved_entry_async_promise = vm->entry_async_promise;
    MalRootSpan entry_promise_root;
    // ASYNC_START temporarily replaces the VM slot while this call can collect.
    if (returns_promise) mal_gc_root(&entry_promise_root, &saved_entry_async_promise, 1);

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
        mal_gc_unroot(&entry_promise_root);
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

static __attribute__((noinline)) MalCompletion mal_vm_call_value_general(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

// Out of line so link-time inlining does not copy the front into every runtime caller.
__attribute__((noinline)) MalCompletion mal_vm_call_value(
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

#if !(MAL_PROFILE && MAL_PERF_STATS)
    // Accessors and builtin callbacks mostly call plain compiled functions, which
    // need no bound resolution, realm switch, receiver boxing or frame growth. This
    // front stays apart from the general body so these calls skip its larger frame
    // and stack-protected argument buffer.
    if (mal_value_is_function_object(callee)) {
        MalFunctionObject *function_object = mal_value_to_function_object(callee);
        i32 function_index = mal_function_object_function_index(function_object);
        if (function_index >= 0 && function_index < vm->runtime_image->function_count) {
            const MalFunction *function = &vm->runtime_image->functions[function_index];
            if (function->compiled != nullptr && !function->is_class_constructor &&
                (function->strict || mal_value_is_object(this_value))
#if MAL_REALMS
                && (function_object->realm == nullptr ||
                    function_object->realm == vm->current_realm)
#endif
            ) {
#if MAL_REALMS
                MalRealm *saved_realm = vm->current_realm;
#endif
                MalValue value = function->compiled(
                    vm, this_value, args, arg_count, mal_value_new_undefined(),
                    function_object->creation_env, callee, nullptr);
#if MAL_REALMS
                mal_vm_realm_switch_to(vm, saved_realm);
#endif
                return vm->completion.kind == MAL_COMPLETION_THROW
                    ? vm->completion
                    : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
            }
        }
    }
#endif
    return mal_vm_call_value_general(vm, callee, this_value, args, arg_count);
}

static __attribute__((noinline)) MalCompletion mal_vm_call_value_general(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
    // A callable proxy routes [[Call]] through its apply trap.
    if (mal_value_is_proxy_object(callee)) {
        MalCompletion proxy_completion =
            mal_proxy_apply(vm, mal_value_to_proxy_object(callee), this_value, args, arg_count);
#if MAL_PROFILE && MAL_PERF_STATS
        vm->profile_current_site_id = saved_profile_site;
#endif
        return proxy_completion;
    }

    MalValue inline_args[MAL_BOUND_INLINE_ARGS];
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        callee, this_value, args, arg_count, true,
        inline_args, countof(inline_args));
    // A bound function's target can be a callable proxy, which only its apply trap calls.
    if (mal_value_is_proxy_object(resolution.callee)) {
        MalCompletion proxy_completion = mal_proxy_apply(
            vm, mal_value_to_proxy_object(resolution.callee), resolution.this_value,
            resolution.args, resolution.arg_count);
        free(resolution.owned_args);
#if MAL_PROFILE && MAL_PERF_STATS
        vm->profile_current_site_id = saved_profile_site;
#endif
        return proxy_completion;
    }
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
        const MalFunction *function = &vm->runtime_image->functions[function_index];
        MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

        if (!mal_vm_require_ordinary_call_target(vm, function)) {
            completion = vm->completion;
        } else if (function->compiled != nullptr) {
            // Native-backend function: invoke directly (no stack marshaling). The
            // C stack, not the value stack, bounds this recursion.
            MalValue this_value = mal_vm_callee_this(vm, function, resolution.this_value);
            MalValue value = function->compiled(vm, this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), env, resolution.callee, nullptr);
            completion = vm->completion.kind == MAL_COMPLETION_THROW
                ? vm->completion
                : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
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

static inline __attribute__((always_inline)) MalValue mal_vm_call_native_value(
    MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count
) {
    MalNativeFunctionObject *native_function = mal_value_to_native_function_object(callee);
    MAL_PROFILE_NATIVE_CALL(vm, native_function);
    MalNativeFunctionCallback callback = mal_native_function_object_callback(native_function);
    MAL_PERF_COUNT(call_cache_native_dispatches);
    if (mal_perf_stats_enabled) {
        MalString *native_name = mal_native_function_object_name(native_function);
        if (native_name != nullptr) mal_perf_native_call_name(native_name);
    }
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
    MalCalleeRoots ncr;
    mal_gc_callee_roots_begin(&ncr, this_value, mal_value_new_undefined(), callee, args, arg_count);
    vm->gc_native_frames++;
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
    MalValue value = callback(vm, this_value, args, arg_count, mal_value_new_undefined(), callee);
#if MAL_PROFILE && MAL_PERF_STATS
    vm->profile_current_site_id = saved_profile_site;
#endif
    vm->gc_native_frames--;
    mal_gc_callee_roots_end(&ncr);
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    return value;
}

// Native callee roots stay out of the compiled-call frame used by recursive JS middleware.
__attribute__((noinline)) static MalCompletion mal_vm_call_cached_fallback(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    // %Function.prototype.call% only forwards to its receiver, so `f.call(x, ...)` enters f
    // directly; a non-callable receiver still reaches the builtin and its TypeError.
    if (callee == vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL] &&
        mal_value_is_callable(this_value)) {
        MAL_PERF_COUNT(call_cache_function_call_forwards);
        MalValue value = mal_vm_call_cached_value(
            vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(),
            arg_count > 1 ? args + 1 : nullptr, arg_count > 1 ? arg_count - 1 : 0);
        return vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    }
    // %Function.prototype.apply% likewise only spreads its list into a call of its receiver,
    // which can then take the compiled or native dispatch below instead of generic [[Call]].
    if (mal_value_is_native_function_object(callee) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) ==
            mal_builtin_function_prototype_apply &&
#if MAL_REALMS
        mal_vm_callee_realm(vm, callee) == vm->current_realm &&
#endif
        mal_value_is_callable(this_value)) {
        MAL_PERF_COUNT(call_cache_function_apply_forwards);
        MalValue list = arg_count > 1 ? args[1] : mal_value_new_undefined();
        MalValue inline_args[8];
        MalValue *call_args = inline_args;
        i32 call_arg_count = 0;
        if (!mal_value_is_nil(list)) {
            // Its getters may run JavaScript; collection stays off until the list is rooted.
            vm->gc_native_frames++;
            bool listed = mal_vm_create_list_from_array_like(
                vm, list, inline_args, countof(inline_args), &call_args, &call_arg_count);
            vm->gc_native_frames--;
            if (!listed) return vm->completion;
        }
        MalRootSpan args_span;
        mal_gc_root(&args_span, call_args, call_arg_count);
        MalValue value = mal_vm_call_cached_value(
            vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(),
            call_arg_count > 0 ? call_args : nullptr, call_arg_count);
        mal_gc_unroot(&args_span);
        if (call_args != inline_args) free(call_args);
        return vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    }
    // A plain native needs none of the generic call's bound or proxy resolution.
    if (mal_value_is_native_function_object(callee)) {
        MalValue value = mal_vm_call_native_value(vm, callee, this_value, args, arg_count);
        return vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    }

    MAL_PERF_COUNT(call_cache_dispatch_misses);
    return mal_vm_call_value(vm, callee, this_value, args, arg_count);
}

static inline __attribute__((always_inline)) MalValue mal_vm_dispatch_cached_value(
    MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count);

// Clang otherwise turns short variable-length copy loops into library memcpy calls.
#if defined(__clang__)
#define MAL_SCALAR_COPIES __attribute__((no_builtin("memcpy"), no_builtin("memmove")))
#else
#define MAL_SCALAR_COPIES
#endif

/**
 * The bound call's probe stands for its target's dispatch. Bound prefixes and call
 * arguments are a few values, so they merge with scalar copies: a library memcpy call
 * per merge costs more than the values it moves.
 */
__attribute__((noinline)) MAL_SCALAR_COPIES static MalValue mal_vm_call_bound_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    MalValue inline_args[MAL_BOUND_INLINE_ARGS];
    MalBoundFunctionObject *bound = mal_value_to_bound_function_object(callee);
    i32 bound_count = bound->bound_count;
    if (!mal_value_is_bound_function_object(bound->target) &&
        bound_count <= (i32) countof(inline_args) - arg_count) {
        if (bound_count == 0)
            return mal_vm_dispatch_cached_value(
                vm, bound->target, bound->bound_this, args, arg_count);
        const MalValue *bound_args = bound->bound_args;
        for (i32 i = 0; i < bound_count; i++) inline_args[i] = bound_args[i];
        for (i32 i = 0; i < arg_count; i++) inline_args[bound_count + i] = args[i];
        return mal_vm_dispatch_cached_value(
            vm, bound->target, bound->bound_this, inline_args, bound_count + arg_count);
    }
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        callee, this_value, args, arg_count, true, inline_args, countof(inline_args));
    MalValue value = mal_vm_dispatch_cached_value(
        vm, resolution.callee, resolution.this_value, resolution.args, resolution.arg_count);
    free(resolution.owned_args);
    return value;
}

__attribute__((noinline)) static MalValue mal_vm_call_cached_value_fallback(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    // A plain native is the common miss of the compiled-function probe; only the call and
    // apply builtins, which forward to their receiver, and non-natives go further.
    if (mal_value_is_native_function_object(callee) &&
        callee != vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL] &&
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) !=
            mal_builtin_function_prototype_apply) {
        MalValue value = mal_vm_call_native_value(vm, callee, this_value, args, arg_count);
        return vm->completion.kind == MAL_COMPLETION_THROW ? MAL_VALUE_UNDEFINED : value;
    }
    MalCompletion completion =
        mal_vm_call_cached_fallback(vm, callee, this_value, args, arg_count);
    if (completion.kind != MAL_COMPLETION_THROW) return completion.value;
    vm->completion = completion;
    return MAL_VALUE_UNDEFINED;
}

/** A sloppy callee's primitive or nullish receiver needs OrdinaryCallBindThis first. */
__attribute__((noinline)) static MalValue mal_vm_call_compiled_bound_this(
    MalVm *vm,
    const MalFunction *function,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    return function->compiled(
        vm, mal_vm_callee_this(vm, function, this_value), args, arg_count,
        mal_value_new_undefined(), mal_value_to_function_object(callee)->creation_env, callee,
        nullptr);
}

void mal_vm_refresh_call_entry(MalVm *vm, i32 function_index) {
    const MalFunction *function = &vm->runtime_image->functions[function_index];
    vm->call_entries[function_index] = function->strict && !function->is_class_constructor
        ? function->compiled : nullptr;
}

MalValue mal_vm_call_cached_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return MAL_VALUE_UNDEFINED;
    }
    MAL_PERF_COUNT(call_cache_probes);
    return mal_vm_dispatch_cached_value(vm, callee, this_value, args, arg_count);
}

static inline __attribute__((always_inline)) MalValue mal_vm_dispatch_cached_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (mal_value_is_function_object(callee)) {
        MalFunctionObject *function_object = mal_value_to_function_object(callee);
        i32 function_index = mal_function_object_function_index(function_object);
#if MAL_REALMS || (MAL_PROFILE && MAL_PERF_STATS)
        if (function_index >= 0 && function_index < vm->runtime_image->function_count) {
            const MalFunction *function = &vm->runtime_image->functions[function_index];
            if (function->compiled != nullptr && !function->is_class_constructor) {
                MAL_PERF_COUNT(call_cache_compiled_dispatches);
#if MAL_PROFILE && MAL_PERF_STATS
                i32 saved_profile_site = vm->profile_current_site_id;
#endif
#if MAL_REALMS
                MalRealm *saved_realm = vm->current_realm;
                mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
                MalValue value = function->compiled(
                    vm, mal_vm_callee_this(vm, function, this_value), args, arg_count,
                    mal_value_new_undefined(), function_object->creation_env, callee, nullptr);
#if MAL_REALMS
                mal_vm_realm_switch_to(vm, saved_realm);
#endif
#if MAL_PROFILE && MAL_PERF_STATS
                vm->profile_current_site_id = saved_profile_site;
#endif
                return value;
            }
        }
#else
        if ((u32) function_index < (u32) vm->runtime_image->function_count) {
            // Every path is a tail call, so the dispatch keeps no frame of its own.
            MalCompiledFunction strict_entry = vm->call_entries[function_index];
            if (strict_entry != nullptr) {
                MAL_PERF_COUNT(call_cache_compiled_dispatches);
                return strict_entry(
                    vm, this_value, args, arg_count, mal_value_new_undefined(),
                    function_object->creation_env, callee, nullptr);
            }
            const MalFunction *function = &vm->runtime_image->functions[function_index];
            if (function->compiled != nullptr && !function->is_class_constructor) {
                MAL_PERF_COUNT(call_cache_compiled_dispatches);
                if (!function->strict && !mal_value_is_object(this_value))
                    return mal_vm_call_compiled_bound_this(
                        vm, function, callee, this_value, args, arg_count);
                return function->compiled(
                    vm, this_value, args, arg_count, mal_value_new_undefined(),
                    function_object->creation_env, callee, nullptr);
            }
        }
#endif
    }
    if (mal_value_is_bound_function_object(callee))
        return mal_vm_call_bound_value(vm, callee, this_value, args, arg_count);
    return mal_vm_call_cached_value_fallback(vm, callee, this_value, args, arg_count);
}

bool mal_vm_prepare_builtin_callback(MalVm *vm, MalValue callback, MalExactScriptCall *exact) {
    if (!mal_value_is_function_object(callback)) return false;
    MalFunctionObject *closure = mal_value_to_function_object(callback);
    i32 index = mal_function_object_function_index(closure);
    if (index < 0 || index >= vm->runtime_image->function_count) return false;
#if MAL_REALMS
    // A realm stamp must share this VM's function-index space, not merely be callable.
    if (!mal_vm_owns_realm(vm, closure->realm)) return false;
#endif
    const MalFunction *function = &vm->runtime_image->functions[index];
    if (function->kind != MAL_FUNCTION_KIND_NORMAL ||
        function->is_class_constructor || function->compiled == nullptr) return false;
    *exact = (MalExactScriptCall) {
        .previous = vm->exact_script_call,
        .callee = callback,
        .function_index = index,
        .compiled_callback = function->compiled,
        .numeric_sort_comparator = nullptr,
        .numeric_sort_kernel = nullptr,
        .env = closure->creation_env,
        .numeric_reduce_callback = nullptr,
    };
#if MAL_REALMS
    if (closure->realm != vm->current_realm) {
        MAL_PERF_COUNT(builtin_callback_foreign_realm_nominations);
    }
#endif
    return true;
}

MalCompletion mal_vm_call_exact_script(
    MalVm *vm,
    i32 function_index,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }
    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    const MalFunction *function = &vm->runtime_image->functions[function_index];
    MalEnv *env = function_object->creation_env;
    MalCompletion completion;

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif

    if (!mal_vm_require_ordinary_call_target(vm, function)) {
        completion = vm->completion;
    } else if (function->compiled != nullptr) {
        MalValue callee_this = mal_vm_callee_this(vm, function, this_value);
        MalValue value = function->compiled(
            vm, callee_this, args, arg_count, mal_value_new_undefined(),
            env, callee, nullptr);
        completion = vm->completion.kind == MAL_COMPLETION_THROW
            ? vm->completion
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
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

MalCompletion mal_vm_call_exact_native(
    MalVm *vm,
    MalNativeFunctionCallback callback,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif

    MalNativeFunctionObject *native_function =
        mal_value_to_native_function_object(callee);
    MAL_PROFILE_NATIVE_CALL(vm, native_function);
    if (mal_perf_stats_enabled) {
        MalString *native_name = mal_native_function_object_name(native_function);
        if (native_name != nullptr) {
            mal_perf_native_call_name(
                native_name);
        }
    }
    MalCalleeRoots roots;
    mal_gc_callee_roots_begin(
        &roots, this_value, mal_value_new_undefined(), callee, args, arg_count);
    vm->gc_native_frames++;
    MalValue value = callback(
        vm, this_value, args, arg_count, mal_value_new_undefined(), callee);
    vm->gc_native_frames--;
    mal_gc_callee_roots_end(&roots);

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
        expected_function_index >= vm->runtime_image->function_count) {
        return mal_vm_call_cached(
            vm, callee, this_value, args, arg_count);
    }

    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    if (mal_function_object_function_index(function_object) != expected_function_index) {
        return mal_vm_call_cached(
            vm, callee, this_value, args, arg_count);
    }
    return mal_vm_call_exact_script(
        vm, expected_function_index, callee, this_value, args, arg_count);
}

MalCompletion mal_vm_call_function_call_direct(
    MalVm *vm,
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
            vm, call_method, target, args, arg_count);
    }

    MalValue this_value = arg_count > 0 ? args[0] : mal_value_new_undefined();
    const MalValue *target_args = arg_count > 1 ? args + 1 : nullptr;
    i32 target_arg_count = arg_count > 1 ? arg_count - 1 : 0;
    if (expected_function_index >= 0) {
        return mal_vm_call_direct(
            vm, expected_function_index, target, this_value,
            target_args, target_arg_count);
    }
    return mal_vm_call_cached(
        vm, target, this_value, target_args, target_arg_count);
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
        expected_function_index >= vm->runtime_image->function_count) {
        return mal_vm_construct_value(vm, callee, args, arg_count);
    }

    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    i32 function_index = mal_function_object_function_index(function_object);
    if (function_index != expected_function_index) {
        return mal_vm_construct_value(vm, callee, args, arg_count);
    }

    const MalFunction *function = &vm->runtime_image->functions[function_index];
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
        this_value = mal_value_from_object(mal_object_new_reserved(
            &vm->heap, prototype, function->constructor_slot_reserve));
    }

    MalEnv *env = function_object->creation_env;
    MalCompletion completion;
    if (function->compiled != nullptr) {
        {
            MalCalleeRoots ncr;
            mal_gc_callee_roots_begin(
                &ncr, this_value, callee, callee, args, arg_count);
            MalValue value = function->compiled(
                vm, this_value, args, arg_count, callee, env, callee, nullptr);
            mal_gc_callee_roots_end(&ncr);
            // Direct eval may splice a program and reallocate the function table
            // while the compiled constructor runs. The stable index survives; the
            // pre-call pointer does not.
            function = &vm->runtime_image->functions[function_index];
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

static MalCompletion mal_vm_construct_with_native_target(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target, MalNativeFunctionCallback exact_callback) {
#if MAL_PROFILE && MAL_PERF_STATS
    i32 saved_profile_site = vm->profile_current_site_id;
#endif
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }

    // `new C(...)` with C itself as new.target, such as every regex literal: no proxy
    // trap, bound target, or prototype from another new.target applies.
    if (new_target == callee && mal_value_is_native_function_object(callee)) {
        MalNativeFunctionObject *native_function = mal_value_to_native_function_object(callee);
        if (!mal_native_function_object_is_constructor(native_function)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            return vm->completion;
        }
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
        MAL_PROFILE_NATIVE_CALL(vm, native_function);
        MalNativeFunctionCallback callback = exact_callback != nullptr
            ? exact_callback : mal_native_function_object_callback(native_function);
        MalCalleeRoots ncr;
        mal_gc_callee_roots_begin(&ncr, mal_value_new_undefined(), new_target, callee, args, arg_count);
        vm->gc_native_frames++;
        MalValue value = callback(vm, mal_value_new_undefined(), args, arg_count, new_target, callee);
        vm->gc_native_frames--;
        mal_gc_callee_roots_end(&ncr);
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
    MalValue inline_args[MAL_BOUND_INLINE_ARGS];
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        callee, mal_value_new_undefined(), args, arg_count, false,
        inline_args, countof(inline_args));
    MalCompletion completion = {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    MalValue effective_new_target = mal_bound_function_object_new_target(callee, new_target);

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
        MalNativeFunctionCallback callback = exact_callback != nullptr
            ? exact_callback : mal_native_function_object_callback(native_function);
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
        if (!dynamic_function_constructor &&
            !mal_native_function_object_handles_new_target_prototype(native_function) &&
            mal_value_is_object(value) &&
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
        const MalFunction *function = &vm->runtime_image->functions[function_index];
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
                this_value = mal_value_from_object(mal_object_new_reserved(
                    &vm->heap, prototype, function->constructor_slot_reserve));
            }

            if (function->compiled != nullptr) {
                // Native-backend constructor: the compiled body returns enough raw
                // state for the post-body derived-result checks below.
                {
                    // The instance exists only as this_value until the body stores
                    // it, so root it (plus new.target/args) for the call: a
                    // collection inside the constructor would otherwise sweep it.
                    MalCalleeRoots ncr;
                    mal_gc_callee_roots_begin(&ncr, this_value, effective_new_target,
                                              resolution.callee, resolution.args,
                                              resolution.arg_count);
                    MalValue value = function->compiled(vm, this_value, resolution.args, resolution.arg_count, effective_new_target, env, resolution.callee, nullptr);
                    mal_gc_callee_roots_end(&ncr);
                    // Direct eval may splice a program and reallocate the function table
                    // while the compiled constructor runs. The stable index survives; the
                    // pre-call pointer does not.
                    function = &vm->runtime_image->functions[function_index];
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

MalCompletion mal_vm_construct_value_with_target(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target) {
    return mal_vm_construct_with_native_target(vm, callee, args, arg_count, new_target, nullptr);
}

MalCompletion mal_vm_construct_exact_native(MalVm *vm, MalNativeFunctionCallback callback, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target) {
    return mal_vm_construct_with_native_target(vm, callee, args, arg_count, new_target, callback);
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
        i32 name_index = vm->runtime_image->functions[
            mal_function_object_function_index(mal_value_to_function_object(callee))
        ].name_string_index;

        if (name_index >= 0 && name_index < vm->runtime_image->string_constant_count) {
            return &vm->runtime_image->string_constants[name_index];
        }

        return mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_EMPTY);
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
    MalVm *vm, const MalRuntimeImage *program, i32 function_base, i32 string_base
) {
    for (i32 index = 0; index < program->precompiled_literal_shape_count; index++) {
        const MalPrecompiledLiteralShape *descriptor =
            &program->precompiled_literal_shapes[index];
        i32 function_index = descriptor->function_index + function_base;
        if (function_index < 0
            || function_index >= vm->runtime_image->function_count
            || descriptor->shape_cache_index < 0
            || descriptor->key_count < 1
            || descriptor->key_count > MAL_SHAPE_MAX_INLINE_SLOTS) {
            continue;
        }
        const MalFunction *function = &vm->runtime_image->functions[function_index];
        if (descriptor->shape_cache_index >= function->literal_shape_count) continue;
        MalShape **row = vm->literal_shape_cache[function_index];
        if (row != nullptr && row[descriptor->shape_cache_index] != nullptr) continue;

        MalString *keys[MAL_SHAPE_MAX_INLINE_SLOTS];
        bool valid = true;
        for (i32 key = 0; key < descriptor->key_count; key++) {
            i32 string_index = descriptor->key_string_indices[key] + string_base;
            if (string_index < 0
                || string_index >= vm->runtime_image->string_constant_count
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
