#include "./gc.h"

#include <stdio.h>
#include <stdlib.h>

#include "./array_buffer_object.h"
#include "./array_object.h"
#include "./arguments_object.h"
#include "./async_context.h"
#include "./bound_function_object.h"
#include "./builtin_error.h"
#include "./builtin_async_generator.h"
#include "./builtin_data_view.h"
#include "./builtin_finalization_registry.h"
#include "./builtin_iterator_helpers.h"
#include "./builtin_promise.h"
#include "./builtin_weak_ref.h"
#include "./fiber.h"
#include "./function_object.h"
#include "./generator_object.h"
#include "./heap_string.h"
#include "./heap_symbol.h"
#include "./intl_object.h"
#include "./iterator_object.h"
#include "./map_object.h"
#include "./microtask.h"
#include "./module_namespace_object.h"
#include "./monotonic_clock.h"
#include "./object.h"
#include "./perf_stats.h"
#include "./profile.h"
#include "./primitive_wrapper_object.h"
#include "./promise_object.h"
#include "./property_store.h"
#include "./proxy_object.h"
#include "./regexp_object.h"
#include "./temporal_object.h"
#include "./shape.h"
#include "./typed_array_object.h"
#include "./vm.h"
#include "./vm_ops.h"
#include "mal_i18n.h"
#include "mal_regexp.h"
#if MAL_TEMPORAL
#include "temporal_rs/Duration.h"
#include "temporal_rs/Instant.h"
#include "temporal_rs/PlainDate.h"
#include "temporal_rs/PlainDateTime.h"
#include "temporal_rs/PlainMonthDay.h"
#include "temporal_rs/PlainTime.h"
#include "temporal_rs/PlainYearMonth.h"
#include "temporal_rs/ZonedDateTime.h"
#endif

/*
 * Mutator-contract state + hooks. The flags stay false and the SATB hook is a
 * no-op until concurrent marking is enabled.
 */

#if MAL_GC_CONCURRENT
bool mal_gc_marking_active = false;
/* Black allocation: while true, freshly allocated managed cells are born BLACK
 * (see mal_heap_header_init) so a cell created mid-cycle is never swept this
 * cycle. On for the WHOLE cycle (init-mark through sweep-complete), not just the
 * mark phase — a WHITE cell created during the incremental sweep would otherwise
 * be reclaimed while still reachable. Under generational this over-tenures those
 * cells (they read as sticky-old); accepted for v1, counted in MAL_GC_STATS. */
bool mal_gc_black_alloc = false;
/* Bytes born BLACK (over-tenured) since process start; see mal_gc_black_alloc. */
usize mal_gc_black_alloc_bytes = 0;
#endif

volatile bool mal_gc_poll = false;

MalRootFrame *mal_root_frame_head = nullptr;
MalRootSpan *mal_root_span_head = nullptr;

/* Preemption hook (docs/decisions/03-wave-0-host-architecture.md). Null in a plain
 * run; the scheduler installs one so a safepoint can yield the running fiber when its reduction
 * budget is exhausted. Called from mal_gc_safepoint, i.e. only where a context
 * switch is safe (roots precise, no un-rooted native frame). */
void (*mal_gc_preempt_hook)(MalVm *vm) = nullptr;

/* External root sources: how the host/runtime layers contribute GC roots to the
 * engine without the engine knowing their types (e.g. pending setTimeout
 * callbacks). Each is invoked during root scanning and calls mal_gc_mark_value on
 * its live values. Process-global (host installs them once, shared across the
 * process); NOT part of the per-isolate MalGcState. SMP requires a per-isolate registry
 * once SMP runs multiple isolates. */
#define MAL_GC_MAX_ROOT_SOURCES 8
static struct {
    MalGcRootSourceFn fn;
    void *data;
} g_root_sources[MAL_GC_MAX_ROOT_SOURCES];
static i32 g_root_source_count = 0;

void mal_gc_register_root_source(MalGcRootSourceFn fn, void *data) {
    if (g_root_source_count < MAL_GC_MAX_ROOT_SOURCES) {
        g_root_sources[g_root_source_count].fn = fn;
        g_root_sources[g_root_source_count].data = data;
        g_root_source_count++;
    }
}

/* Per-type finalizers/tracers registered by the host/runtime for types they own.
 * Process-global (installed once), like the root sources above. */
static MalGcFinalizer g_type_finalizers[MAL_HEAP_TYPE_COUNT];

void mal_gc_register_finalizer(MalHeapType type, MalGcFinalizer fn) {
    if ((usize) type < (usize) MAL_HEAP_TYPE_COUNT) {
        g_type_finalizers[type] = fn;
    }
}

static MalGcTracer g_type_tracers[MAL_HEAP_TYPE_COUNT];

void mal_gc_register_tracer(MalHeapType type, MalGcTracer fn) {
    if ((usize) type < (usize) MAL_HEAP_TYPE_COUNT) {
        g_type_tracers[type] = fn;
    }
}

// ---------------------------------------------------------------------------
// Per-isolate collector state (MalGcState).
//
// The mutable working state of the collector — grey worklist, weak lists,
// remembered set, per-collection stats, stress counters, and (concurrent build)
// the SATB buffer + incremental-cycle state — hangs off MalVm as vm->gc. The
// registered root-source / per-type hook tables stay process-global above (host
// installs them once). A single file-static `g_gc` caches vm->gc so the marking
// helpers (mal_gc_mark_value, called by the public tracer API without a vm) reach
// the worklist through one global deref, exactly as the pre-refactor `g_grey`
// did; C2 makes it _Thread_local. Single mutator / single thread for now.
// ---------------------------------------------------------------------------

#if MAL_GC_CONCURRENT
typedef enum MalGcPhase {
    MAL_GC_PHASE_IDLE, // no cycle in flight
    MAL_GC_PHASE_MARK, // incremental grey/SATB draining
    MAL_GC_PHASE_SWEEP, // incremental block sweep
} MalGcPhase;
#endif

struct MalGcState {
    // Grey worklist (explicit, no recursion): shaded-but-not-yet-traced cells.
    MalHeapHeader **grey;
    usize grey_count;
    usize grey_capacity;

    // Weak collections (WeakMap/WeakSet) reached during the main mark. Their entry
    // key/value edges are NOT traced there; the ephemeron pass after the mark marks
    // each value whose key is live (a fixpoint) and drops entries with dead keys.
    MalMapObject **weak_maps;
    usize weak_maps_count;
    usize weak_maps_capacity;

    // WeakRefs reached during the main mark: their target edge is weak, so it is not
    // followed here; the weak pass nulls the target if it did not otherwise survive.
    MalWeakRefObject **weak_refs;
    usize weak_refs_count;
    usize weak_refs_capacity;

    // FinalizationRegistries reached during the main mark; the weak pass enqueues a
    // cleanup job for each reclaimed target and unlinks that cell.
    MalFinalizationRegistryObject **fin_regs;
    usize fin_regs_count;
    usize fin_regs_capacity;

    // Scratch list of dead keys to delete from a weak collection after its pass
    // (deleting mid-iteration is avoided).
    MalKey *dead_keys;
    usize dead_keys_count;
    usize dead_keys_capacity;

#if MAL_GC_GENERATIONAL
    // Remembered set: old (sticky-BLACK) cells written with a young pointer since
    // the last collection (the card barrier records them). Rebuilt every collection.
    MalHeapHeader **remembered;
    usize remembered_count;
    usize remembered_capacity;
    // One in every major_every collections (and the first) is a full major.
    u32 collection_index;
#endif

#if MAL_GC_CONCURRENT
    // SATB (snapshot-at-the-beginning) buffer: references handed over by the
    // deletion barrier / frame shades while marking is active. Grown, never
    // dropped; a mark step drains [satb_drained, satb_count) into the grey
    // worklist. The buffer may grow during a drain (a shade fired by tracing),
    // so draining reads satb_count each iteration.
    MalValue *satb;
    usize satb_count;
    usize satb_capacity;
    usize satb_drained;

    // Incremental-cycle state machine (driven from mal_gc_safepoint).
    MalGcPhase phase;
    // bytes_allocated at which an in-flight cycle must finish synchronously (the
    // hard backstop = the old STW trigger). Degrade-to-STW, never OOM.
    usize backstop_at;
    // bytes_allocated at the previous mark step, for the assist budget.
    usize bytes_at_last_step;
#endif

    // --- Config (read once from env in mal_gc_init) ---------------------------
    // Stress mode (MAL_GC_STRESS=N): collect every N gated safepoints.
    i32 stress_interval;
    i32 stress_counter;
    bool verify_enabled;
    bool stats_enabled;
#if MAL_GC_GENERATIONAL
    u32 major_every; // MAL_GC_MAJOR_EVERY
#endif
#if MAL_GC_CONCURRENT
    // MAL_GC_MODE=stw: force every cycle synchronous (the backstop path).
    bool mode_stw;
    // Assist ratio (MAL_GC_ASSIST): grey/SATB entries traced per byte allocated
    // since the last mark step, so marking outruns allocation.
    u32 assist;
#endif

    // --- Per-collection statistics (MAL_GC_STATS=1) ---------------------------
    u64 collections;
    u64 minor_count;
    u64 major_count;
    u64 total_ns;
    u64 max_pause_ns;
    usize peak_live_bytes;
    usize allocated_bytes;
    u64 compiled_root_slots_scanned;
    u64 compiled_root_slots_skipped;
#if MAL_GC_CONCURRENT
    u64 cycles; // concurrent cycles started
    u64 sync_backstop; // cycles that had to finish synchronously
    u64 init_mark_ns; // last init-mark pause
    u64 remark_ns; // last remark pause
    u64 max_mark_step_ns; // largest single mark step
    u64 max_sweep_step_ns; // largest single sweep step
#endif
};

/* The vm whose collector is currently active + a cache of its state. Both are set
 * once at mal_gc_init and live for the vm's lifetime (single mutator); the SATB
 * barrier and the marking helpers read g_gc between collections too, so — unlike
 * the pre-concurrent code that scoped g_gc_vm to a single mal_gc_collect call —
 * they must stay valid the whole time. Becomes _Thread_local in C2. */
static MalVm *g_gc_vm = nullptr;
static MalGcState *g_gc = nullptr;
/* Captured for the atexit stats printer (which has no vm handle). Points at the
 * live vm->gc while the vm exists, and at g_gc_stats_snapshot after teardown so the
 * exit report survives an explicit mal_vm_free. The printer reads only scalar stat
 * fields, so the snapshot's stale buffer pointers are never dereferenced. */
static MalGcState g_gc_stats_snapshot;
static MalGcState *g_gc_stats_state = nullptr;

MalHeap *mal_gc_current_heap(void) {
    return &g_gc_vm->heap;
}

i32 mal_gc_swap_stress_interval(i32 interval) {
    if (g_gc == nullptr || g_gc->stress_interval == 0) {
        return 0;
    }
    i32 previous = g_gc->stress_interval;
    g_gc->stress_interval = interval < 1 ? 1 : interval;
    return previous;
}

static void mal_gc_grey_push(MalHeapHeader *cell) {
    if (g_gc->grey_count == g_gc->grey_capacity) {
        g_gc->grey_capacity = g_gc->grey_capacity == 0 ? 4096 : g_gc->grey_capacity * 2;
        g_gc->grey = realloc(g_gc->grey, g_gc->grey_capacity * sizeof(MalHeapHeader *));
    }
    g_gc->grey[g_gc->grey_count++] = cell;
}

static void mal_gc_register_weak_map(MalMapObject *map) {
    if (g_gc->weak_maps_count == g_gc->weak_maps_capacity) {
        g_gc->weak_maps_capacity = g_gc->weak_maps_capacity == 0 ? 64 : g_gc->weak_maps_capacity * 2;
        g_gc->weak_maps = realloc(g_gc->weak_maps, g_gc->weak_maps_capacity * sizeof(MalMapObject *));
    }
    g_gc->weak_maps[g_gc->weak_maps_count++] = map;
}

static void mal_gc_register_weak_ref(MalWeakRefObject *ref) {
    if (g_gc->weak_refs_count == g_gc->weak_refs_capacity) {
        g_gc->weak_refs_capacity = g_gc->weak_refs_capacity == 0 ? 64 : g_gc->weak_refs_capacity * 2;
        g_gc->weak_refs = realloc(g_gc->weak_refs, g_gc->weak_refs_capacity * sizeof(MalWeakRefObject *));
    }
    g_gc->weak_refs[g_gc->weak_refs_count++] = ref;
}

static void mal_gc_register_fin_reg(MalFinalizationRegistryObject *reg) {
    if (g_gc->fin_regs_count == g_gc->fin_regs_capacity) {
        g_gc->fin_regs_capacity = g_gc->fin_regs_capacity == 0 ? 32 : g_gc->fin_regs_capacity * 2;
        g_gc->fin_regs = realloc(g_gc->fin_regs, g_gc->fin_regs_capacity * sizeof(MalFinalizationRegistryObject *));
    }
    g_gc->fin_regs[g_gc->fin_regs_count++] = reg;
}

static void mal_gc_dead_key_push(MalKey key) {
    if (g_gc->dead_keys_count == g_gc->dead_keys_capacity) {
        g_gc->dead_keys_capacity = g_gc->dead_keys_capacity == 0 ? 64 : g_gc->dead_keys_capacity * 2;
        g_gc->dead_keys = realloc(g_gc->dead_keys, g_gc->dead_keys_capacity * sizeof(MalKey));
    }
    g_gc->dead_keys[g_gc->dead_keys_count++] = key;
}

void mal_gc_satb_record(MalValue old_value) {
#if MAL_GC_CONCURRENT
    // Filter: only heap-pointer values that are not already marked need to enter
    // the snapshot (marking is idempotent, but this trims the common no-op). Never
    // drop a qualifying entry — the buffer grows as needed; a dropped deletion
    // barrier value is a lost live object.
    if (!mal_value_is_heap(old_value)) {
        return;
    }
    MalHeapHeader *cell = mal_value_to_heap(old_value);
    if (cell->storage == MAL_HEAP_STORAGE_IMMORTAL || cell->mark == MAL_MARK_BLACK) {
        return;
    }
    if (g_gc->satb_count == g_gc->satb_capacity) {
        g_gc->satb_capacity = g_gc->satb_capacity == 0 ? 4096 : g_gc->satb_capacity * 2;
        g_gc->satb = realloc(g_gc->satb, g_gc->satb_capacity * sizeof(MalValue));
    }
    g_gc->satb[g_gc->satb_count++] = old_value;
#else
    (void) old_value;
#endif
}

static void mal_gc_print_stats(void) {
    MalGcState *g = g_gc_stats_state;
    if (g == nullptr) {
        return;
    }
    usize allocated_bytes = g_gc_vm != nullptr && g_gc_vm->gc == g
        ? g_gc_vm->heap.bytes_allocated
        : g->allocated_bytes;
    fprintf(stderr,
            "[gc-stats] collections=%llu minor=%llu major=%llu total_ms=%.3f "
            "max_pause_ms=%.3f peak_live_bytes=%llu allocated_bytes=%llu "
            "compiled_root_slots_scanned=%llu compiled_root_slots_skipped=%llu "
            "object_slot_coallocations=%llu object_slot_grow_migrations=%llu "
            "object_slot_dictionary_migrations=%llu stack_object_materializations=%llu",
            (unsigned long long) g->collections, (unsigned long long) g->minor_count,
            (unsigned long long) g->major_count, (double) g->total_ns / 1.0e6,
            (double) g->max_pause_ns / 1.0e6, (unsigned long long) g->peak_live_bytes,
            (unsigned long long) allocated_bytes,
            (unsigned long long) g->compiled_root_slots_scanned,
            (unsigned long long) g->compiled_root_slots_skipped,
            (unsigned long long) mal_object_slot_coallocation_count(),
            (unsigned long long) mal_object_slot_grow_migration_count(),
            (unsigned long long) mal_object_slot_dictionary_migration_count(),
            (unsigned long long) mal_vm_stack_object_materialization_count());
#if MAL_GC_CONCURRENT
    fprintf(stderr,
            " cycles=%llu sync_backstop=%llu over_tenure_bytes=%llu "
            "init_mark_ms=%.3f remark_ms=%.3f max_mark_step_ms=%.3f max_sweep_step_ms=%.3f",
            (unsigned long long) g->cycles, (unsigned long long) g->sync_backstop,
            (unsigned long long) mal_gc_black_alloc_bytes,
            (double) g->init_mark_ns / 1.0e6, (double) g->remark_ns / 1.0e6,
            (double) g->max_mark_step_ns / 1.0e6, (double) g->max_sweep_step_ns / 1.0e6);
#endif
    fprintf(stderr, "\n");
    if (getenv("MAL_PROMISE_STATS") != nullptr) {
        fprintf(
            stderr,
            "[promise-stats] job_allocations=%llu job_reuses=%llu "
            "reaction_allocations=%llu reaction_reuses=%llu "
            "direct_capabilities=%llu materialized_fallback_pairs=%llu "
            "direct_intrinsic_creations=%llu direct_async_results=%llu "
            "frame_allocations=%llu frame_reuses=%llu "
            "request_allocations=%llu request_reuses=%llu\n",
            (unsigned long long) mal_promise_job_allocation_count(),
            (unsigned long long) mal_promise_job_reuse_count(),
            (unsigned long long) mal_promise_reaction_allocation_count(),
            (unsigned long long) mal_promise_reaction_reuse_count(),
            (unsigned long long) mal_promise_direct_capability_count(),
            (unsigned long long) mal_promise_direct_fallback_pair_count(),
            (unsigned long long) mal_promise_direct_intrinsic_creation_count(),
            (unsigned long long) mal_promise_direct_async_result_count(),
            (unsigned long long) mal_coroutine_buffer_allocation_count(),
            (unsigned long long) mal_coroutine_buffer_reuse_count(),
            (unsigned long long) mal_async_generator_request_allocation_count(),
            (unsigned long long) mal_async_generator_request_reuse_count()
        );
    }
    if (getenv("MAL_COROUTINE_STATS") != nullptr) {
        fprintf(
            stderr,
            "[coroutine-stats] requests=%llu allocations=%llu reuses=%llu "
            "releases=%llu pooled=%llu dropped=%llu peak_retained_bytes=%llu\n",
            (unsigned long long) mal_coroutine_buffer_request_count(),
            (unsigned long long) mal_coroutine_buffer_allocation_count(),
            (unsigned long long) mal_coroutine_buffer_reuse_count(),
            (unsigned long long) mal_coroutine_buffer_release_count(),
            (unsigned long long) mal_coroutine_buffer_pooled_count(),
            (unsigned long long) mal_coroutine_buffer_dropped_count(),
            (unsigned long long) mal_coroutine_buffer_peak_retained_bytes()
        );
    }
    if (getenv("MAL_VM_STATS") != nullptr) {
        u64 instruction_count = mal_vm_loaded_instruction_count();
        u64 instruction_data_count = mal_vm_loaded_instruction_data_count();
        u64 instruction_bytes = instruction_count * sizeof(MalInstruction);
        u64 instruction_data_bytes = instruction_data_count * sizeof(i32);
        fprintf(
            stderr,
            "[vm-stats] instruction_size=%zu instruction_count=%llu "
            "instruction_bytes=%llu instruction_data_bytes=%llu bytecode_bytes=%llu\n",
            sizeof(MalInstruction),
            (unsigned long long) instruction_count,
            (unsigned long long) instruction_bytes,
            (unsigned long long) instruction_data_bytes,
            (unsigned long long) (instruction_bytes + instruction_data_bytes)
        );
    }
}

/* Auto-collection heap-growth policy: the first collection fires once this many
 * bytes have been allocated; after each one the next trigger is set past the
 * surviving set by at least this floor (so a small live set cannot thrash). */
#define MAL_GC_DEFAULT_THRESHOLD ((usize) 16 * 1024 * 1024)
#define MAL_GC_MIN_INCREMENT ((usize) 4 * 1024 * 1024)

usize mal_gc_next_at = (usize) -1;

void mal_gc_init(MalVm *vm) {
    MalGcState *g = calloc(1, sizeof(MalGcState));
    vm->gc = g;
    g_gc = g;
    g_gc_vm = vm;
    g_gc_stats_state = g;
    mal_perf_stats_init();
#if MAL_GC_GENERATIONAL
    g->major_every = 8;
#endif
#if MAL_GC_CONCURRENT
    g->phase = MAL_GC_PHASE_IDLE;
    g->assist = 4; // grey/SATB entries traced per byte allocated since the last step
    const char *assist = getenv("MAL_GC_ASSIST");
    if (assist != nullptr && assist[0] != '\0') {
        unsigned long v = strtoul(assist, nullptr, 10);
        if (v >= 1) {
            g->assist = (u32) v;
        }
    }
    const char *mode = getenv("MAL_GC_MODE");
    g->mode_stw = mode != nullptr && (mode[0] == 's' || mode[0] == 'S');
#endif

    const char *stress = getenv("MAL_GC_STRESS");
    if (stress != nullptr && stress[0] != '\0' && stress[0] != '0') {
        g->stress_interval = atoi(stress);
        if (g->stress_interval < 1) {
            g->stress_interval = 1;
        }
        mal_gc_poll = true; // make the next loop/call safepoint collect
    } else if (getenv("MAL_GC_OFF") == nullptr) {
        // Auto-collection (default): the allocator raises mal_gc_poll when
        // bytes_allocated reaches mal_gc_next_at; the next safepoint collects.
        const char *thr = getenv("MAL_GC_THRESHOLD");
        mal_gc_next_at =
            thr != nullptr ? (usize) strtoull(thr, nullptr, 10) : MAL_GC_DEFAULT_THRESHOLD;
        if (mal_gc_next_at == 0) {
            mal_gc_next_at = 1;
        }
    }
    g->verify_enabled = getenv("MAL_GC_VERIFY") != nullptr;
    // Poisoning dead cells makes a use-after-free of a missed root crash loudly
    // rather than silently alias a recycled cell; pair it with verification.
    mal_heap_poison_on_free = g->verify_enabled;

    if (getenv("MAL_GC_STATS") != nullptr) {
        g->stats_enabled = true;
        atexit(mal_gc_print_stats);
    }

#if MAL_GC_GENERATIONAL
    const char *major_every = getenv("MAL_GC_MAJOR_EVERY");
    if (major_every != nullptr) {
        unsigned long v = strtoul(major_every, nullptr, 10);
        if (v >= 1) {
            g->major_every = (u32) v;
        }
    }
#endif
}

// ---------------------------------------------------------------------------
// Non-moving mark/sweep collector.
//
// Tri-color marking with an explicit grey worklist (no recursion): roots are
// shaded grey, then drained, tracing each cell's outgoing edges. The header mark
// field is the colour. A non-moving sweep then finalizes and reclaims unreached
// cells. Shapes and closure environments are traced through; shapes are not GC
// cells (malloc'd directly), so they are never marked or swept. Under
// MAL_GC_CONCURRENT the mark + sweep are sliced across safepoints; see the cycle
// state machine at the bottom of the file.
// ---------------------------------------------------------------------------

/** Shade a cell grey: a managed, non-immortal cell reached for the first time.
 * In verify mode it instead asserts the cell is already marked — a reachable but
 * unmarked cell means a trace edge was missed. */
/* Type of the cell currently being re-traced by the verifier (diagnostic only):
 * lets a freed-target abort name the OWNER whose edge was missed, not just the
 * swept target. -1 while scanning roots (no owning cell). */
static i32 g_gc_verify_source = -1;
static bool g_gc_verifying = false;

/* Route EVERY mark-byte write to BLACK through one helper so C2 can atomicize it
 * in a single place (relaxed store; marking is idempotent). */
static inline void mal_gc_set_black(MalHeapHeader *cell) {
    cell->mark = MAL_MARK_BLACK;
}

static void mal_gc_shade(MalHeapHeader *cell) {
    if (cell == nullptr || cell->storage == MAL_HEAP_STORAGE_IMMORTAL) {
        return;
    }
    if (g_gc_verifying) {
        if (cell->mark == MAL_MARK_FREE) {
            fprintf(stderr, "[gc verify] live cell (source type=%d) points to a freed "
                "cell type=%d: a root or trace edge was missed, the target was swept "
                "while still reachable\n", g_gc_verify_source, cell->type);
            abort();
        }
        return;
    }
    if (cell->mark == MAL_MARK_BLACK) {
        return;
    }
    mal_gc_set_black(cell);
    mal_gc_grey_push(cell);
}

void mal_gc_mark_value(MalValue value) {
    if (mal_value_is_heap(value)) {
        mal_gc_shade(mal_value_to_heap(value));
    }
}

/** Whether a value is live for weak-reference purposes: a non-heap or immortal
 * value is always live; a managed cell is live iff the main mark reached it. */
static bool mal_gc_is_marked(MalValue value) {
    if (!mal_value_is_heap(value)) {
        return true;
    }
    MalHeapHeader *cell = mal_value_to_heap(value);
    return cell->storage == MAL_HEAP_STORAGE_IMMORTAL || cell->mark == MAL_MARK_BLACK;
}

void mal_gc_mark_values(const MalValue *values, i32 count) {
    if (values == nullptr) {
        return;
    }
    for (i32 i = 0; i < count; ++i) {
        mal_gc_mark_value(values[i]);
    }
}

static void mal_gc_mark_object(MalObject *object) {
    if (object != nullptr) {
        mal_gc_shade(&object->header);
    }
}

static void mal_gc_mark_string(MalString *string) {
    if (string != nullptr) {
        mal_gc_shade(&string->header);
    }
}

/** Trace a table's live entries (keys + inline values + descriptor refs). */
static void mal_gc_trace_table(MalTable *table) {
    if (table == nullptr) {
        return;
    }
    MalTableIter iter;
    mal_table_iter_init(&iter, table, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        mal_gc_mark_value(key.value);
        if (mal_table_mode(table) == MAL_TABLE_MODE_OBJECT) {
            MalPropertyDesc desc = mal_property_entry_desc(table, entry);
            mal_gc_mark_value(desc.value);
            mal_gc_mark_value(desc.getter);
            mal_gc_mark_value(desc.setter);
        } else {
            mal_gc_mark_value(mal_table_entry_value(table, entry));
        }
    }
}

/** Shade a closure environment cell. Its captured slots and parent chain are
 * traced when the cell is drained from the grey worklist (mal_gc_trace_cell,
 * MAL_HEAP_ENV) — keeping reachable envs (and only those) alive through a sweep. */
static void mal_gc_trace_env(MalEnv *env) {
    if (env != nullptr) {
        mal_gc_shade(&env->header);
    }
}

typedef void (*MalGcFrameValueVisitor)(MalValue value);

static bool mal_gc_visit_exact_frame_registers(
    MalVmFrame *frame,
    MalGcFrameValueVisitor visit) {
    const MalFunction *function = frame->function;
    if (function == nullptr || !function->gc_safepoints_trusted ||
        frame->gc_safepoint_ip < 0 || frame->registers == nullptr) {
        return false;
    }
    const i32 *row = function->gc_safepoints;
    for (i32 index = 0; index < function->gc_safepoint_count; index++) {
        i32 instruction_ip = *row++;
        i32 root_count = *row++;
        if (instruction_ip == frame->gc_safepoint_ip) {
            for (i32 root = 0; root < root_count; root++) {
                visit(frame->registers[row[root]]);
            }
            return true;
        }
        row += root_count;
        i32 clear_count = *row++;
        row += clear_count;
        if (instruction_ip > frame->gc_safepoint_ip) break;
    }
    return false;
}

static void mal_gc_visit_frame_registers(
    MalVmFrame *frame,
    MalGcFrameValueVisitor visit) {
    if (frame->function == nullptr || frame->registers == nullptr) {
        return;
    }
    if (mal_gc_visit_exact_frame_registers(frame, visit)) {
        return;
    }
    for (i32 register_index = 0;
         register_index < frame->function->register_count;
         register_index++) {
        visit(frame->registers[register_index]);
    }
}

/** Trace an interpreter / generator activation frame. */
static void mal_gc_trace_frame(MalVmFrame *frame) {
    mal_gc_visit_frame_registers(frame, mal_gc_mark_value);
    mal_gc_mark_values(frame->arguments, frame->argument_count);
    mal_gc_mark_value(frame->this_value);
    mal_gc_mark_value(frame->arguments_object);
    mal_gc_mark_value(frame->callee);
    mal_gc_mark_value(frame->new_target);
    mal_gc_trace_env(frame->env);
}

/* SATB teardown/resume shade: see gc.h. Mirrors mal_gc_trace_frame but records
 * each edge into the SATB snapshot instead of marking. Only reached while marking
 * is active (call sites gate on mal_gc_marking_active); the env is boxed as a heap
 * value so the deletion barrier keeps the activation's captured-slot env too. */
void mal_gc_satb_shade_frame(MalVmFrame *frame) {
    mal_gc_visit_frame_registers(frame, mal_gc_satb_record);
    if (frame->arguments != nullptr) {
        for (i32 i = 0; i < frame->argument_count; ++i) {
            mal_gc_satb_record(frame->arguments[i]);
        }
    }
    mal_gc_satb_record(frame->this_value);
    mal_gc_satb_record(frame->arguments_object);
    mal_gc_satb_record(frame->callee);
    mal_gc_satb_record(frame->new_target);
    if (frame->env != nullptr) {
        mal_gc_satb_record(mal_value_from_heap(&frame->env->header));
    }
}

/** Common edges of every MalObject-based cell: prototype, inline slots, overflow.
 * The shape tree is malloc-owned, but its property atoms are heap strings, so
 * they are marked here through both owning objects and the heap root scan. */
static void mal_gc_trace_object_common(MalObject *object) {
    mal_gc_mark_object(object->prototype);
    const MalShape *shape = object->shape;
    if (object->slots != nullptr) {
        for (u32 i = 0; i < shape->inline_count; ++i) {
            mal_gc_mark_value(shape->props[i].key);
            mal_gc_mark_value(object->slots[shape->props[i].slot]);
        }
    }
    mal_gc_trace_table(object->overflow);
}

/** Trace a cell's outgoing edges (the cell is already BLACK). */
static void mal_gc_trace_cell(MalHeapHeader *cell) {
    switch (cell->type) {
        case MAL_HEAP_STRING: {
            MalString *string = (MalString *) cell;
            if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
                mal_gc_mark_string(string->parent);
            } else if (string->storage == MAL_STRING_STORAGE_CONS) {
                mal_gc_mark_string(string->left);
                mal_gc_mark_string(string->right);
            }
            return;
        }
        case MAL_HEAP_BIGINT:
            return; // leaves (code_units / digits are non-pointer payload)
        case MAL_HEAP_SYMBOL:
            mal_gc_mark_string(((MalSymbol *) cell)->description);
            return;
        case MAL_HEAP_ENV: {
            // Not a MalObject: trace the parent env and this env's captured slots
            // (the count is stored on the env, so synthetic per-iteration envs trace
            // too).
            MalEnv *env = (MalEnv *) cell;
            if (env->parent != nullptr) {
                mal_gc_shade(&env->parent->header);
            }
            mal_gc_mark_values(env->slots, env->slot_count);
            return;
        }
        case MAL_HEAP_ASYNC_CONTEXT: {
            MalAsyncContext *context = (MalAsyncContext *) cell;
            if (context->parent != nullptr) {
                mal_gc_shade(&context->parent->header);
            }
            if (context->storage != nullptr) {
                mal_gc_shade(&context->storage->header);
            }
            mal_gc_mark_value(context->store);
            return;
        }
        case MAL_HEAP_ASYNC_LOCAL_STORAGE_STATE: {
            MalAsyncLocalStorageState *state =
                (MalAsyncLocalStorageState *) cell;
            mal_gc_mark_value(state->default_value);
            mal_gc_mark_value(state->name);
            return;
        }
        case MAL_HEAP_ASYNC_RESOURCE_STATE: {
            MalAsyncResourceState *state = (MalAsyncResourceState *) cell;
            if (state->context != nullptr) {
                mal_gc_shade(&state->context->header);
            }
            return;
        }
        case MAL_HEAP_ASYNC_RUN_SCOPE_STATE: {
            MalAsyncRunScopeState *state = (MalAsyncRunScopeState *) cell;
            if (state->storage != nullptr) {
                mal_gc_shade(&state->storage->header);
            }
            mal_gc_mark_value(state->previous_store);
            return;
        }
        default:
            break;
    }

    MalObject *object = (MalObject *) cell;
    mal_gc_trace_object_common(object);

    // Host/runtime-registered per-type tracers (e.g. the fetch Headers name/value
    // list) — marks edges the engine has no type knowledge of.
    if (g_type_tracers[cell->type] != nullptr) {
        g_type_tracers[cell->type](cell);
    }

    switch (cell->type) {
        case MAL_HEAP_ARGUMENTS_OBJECT:
            mal_gc_trace_env(((MalArgumentsObject *) cell)->env);
            break;
        case MAL_HEAP_ARRAY_OBJECT: {
            // Dense element vector: trace the live region [0, dense_count). Hole
            // sentinels are static (non-pointer) values, so marking them is a no-op.
            MalArrayObject *array = (MalArrayObject *) cell;
            if (array->elements != nullptr) {
                mal_gc_mark_values(array->elements, (i32) array->dense_count);
            }
            break;
        }
        case MAL_HEAP_FUNCTION_OBJECT:
            mal_gc_trace_env(((MalFunctionObject *) cell)->creation_env);
            break;
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT: {
            MalNativeFunctionObject *fn = (MalNativeFunctionObject *) cell;
            mal_gc_mark_string(fn->name);
            mal_gc_mark_values(fn->slots, fn->slot_count);
            break;
        }
        case MAL_HEAP_BOUND_FUNCTION_OBJECT: {
            MalBoundFunctionObject *bound = (MalBoundFunctionObject *) cell;
            mal_gc_mark_value(bound->target);
            mal_gc_mark_value(bound->bound_this);
            mal_gc_mark_values(bound->bound_args, bound->bound_count);
            break;
        }
        case MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT:
            mal_gc_mark_value(((MalPrimitiveWrapperObject *) cell)->primitive_data);
            break;
        case MAL_HEAP_ITERATOR_OBJECT:
            mal_gc_mark_value(((MalIteratorObject *) cell)->target);
            break;
        case MAL_HEAP_MAP_OBJECT:
        case MAL_HEAP_SET_OBJECT: {
            MalMapObject *map = (MalMapObject *) cell;
            // A weak collection's entries are not strong edges: defer them to the
            // ephemeron pass (which marks values of live keys and drops the rest).
            // In verify mode the pass has already run, so trace them as a normal
            // dangling check — every survivor must be live.
            if (map->weak && !g_gc_verifying) {
                mal_gc_register_weak_map(map);
            } else {
                mal_gc_trace_table(map->entries);
            }
            break;
        }
        case MAL_HEAP_TYPED_ARRAY_OBJECT:
            mal_gc_mark_object((MalObject *) ((MalTypedArrayObject *) cell)->buffer);
            break;
        case MAL_HEAP_DATA_VIEW_OBJECT:
            mal_gc_mark_object((MalObject *) mal_data_view_object_buffer((MalDataViewObject *) cell));
            break;
        case MAL_HEAP_PROXY_OBJECT: {
            MalProxyObject *proxy = (MalProxyObject *) cell;
            mal_gc_mark_value(proxy->target);
            mal_gc_mark_value(proxy->handler);
            break;
        }
        case MAL_HEAP_INTL_OBJECT: {
            MalIntlObject *intl = (MalIntlObject *) cell;
            mal_gc_mark_value(intl->data);
            mal_gc_mark_value(intl->bound);
            break;
        }
        case MAL_HEAP_REGEXP_OBJECT: {
            MalRegExpObject *re = (MalRegExpObject *) cell;
            mal_gc_mark_string(re->source);
            mal_gc_mark_string(re->flags);
            break;
        }
        case MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT: {
            MalRegExpStringIteratorObject *it = (MalRegExpStringIteratorObject *) cell;
            mal_gc_mark_value(it->regexp);
            mal_gc_mark_string(it->string);
            break;
        }
        case MAL_HEAP_ITERATOR_HELPER_OBJECT: {
            MalIteratorHelperObject *ih = (MalIteratorHelperObject *) cell;
            mal_gc_mark_value(ih->iterator);
            mal_gc_mark_value(ih->next_method);
            mal_gc_mark_value(ih->callback);
            mal_gc_mark_value(ih->inner_iterator);
            mal_gc_mark_value(ih->inner_next);
            mal_gc_mark_value(ih->sources);
            mal_gc_mark_value(ih->source_methods);
            mal_gc_mark_value(ih->zip_padding);
            mal_gc_mark_value(ih->zip_keys);
            break;
        }
        case MAL_HEAP_WEAK_REF_OBJECT:
            // The target is a weak edge: register for the weak pass, do not follow
            // it. In verify mode the pass has run (target is undefined or a
            // survivor), so trace it as an ordinary dangling check.
            if (g_gc_verifying) {
                mal_gc_mark_value(((MalWeakRefObject *) cell)->target);
            } else {
                mal_gc_register_weak_ref((MalWeakRefObject *) cell);
            }
            break;
        case MAL_HEAP_FINALIZATION_REGISTRY_OBJECT: {
            MalFinalizationRegistryObject *reg = (MalFinalizationRegistryObject *) cell;
            mal_gc_mark_value(reg->cleanup_callback); // strong
            for (MalFinRegCell *fc = reg->cells; fc != nullptr; fc = fc->next) {
                mal_gc_mark_value(fc->held_value); // strong; passed to the callback
                if (g_gc_verifying) {
                    // Survivors after the pass: targets/tokens must be live too.
                    mal_gc_mark_value(fc->target);
                    mal_gc_mark_value(fc->unregister_token);
                }
            }
            // target / unregister_token are weak edges, handled by the weak pass.
            if (!g_gc_verifying) {
                mal_gc_register_fin_reg(reg);
            }
            break;
        }
        case MAL_HEAP_MODULE_NAMESPACE_OBJECT: {
            MalModuleNamespaceObject *ns = (MalModuleNamespaceObject *) cell;
            mal_gc_mark_value(ns->init_fn);
            for (i32 i = 0; i < ns->export_count; ++i) {
                mal_gc_mark_string(ns->exports[i].name);
            }
            break;
        }
        case MAL_HEAP_GENERATOR_OBJECT: {
            MalGeneratorObject *gen = (MalGeneratorObject *) cell;
            // A COMPLETED coroutine's frame register/argument buffers were freed at
            // teardown (mal_vm_op_coroutine_return_compiled / the interpreter frame
            // pop) yet frame.registers stays dangling and frame.function stays set —
            // tracing it would follow freed memory. Skip it, mirroring the finalizer,
            // which frees the frame buffers only while the coroutine is suspended.
            if (gen->state != MAL_GENERATOR_COMPLETED) {
                // Re-resolve the frame's function from its index (the source of
                // truth) before tracing: an eval splice can realloc the function
                // table and move it, dangling the cached gen->frame.function until
                // the coroutine next resumes (which re-resolves the same way, see
                // mal_vm_resume_generator). mal_vm_splice_runtime_image only fixes up
                // the live vm->frames, not suspended coroutine frames, and this
                // trace runs before the resume. frame.function is null for a
                // never-populated frame (mal_generator_object_new), which stays a
                // no-op trace.
                if (gen->frame.function != nullptr) {
                    gen->frame.function =
                        &g_gc_vm->live_runtime_image.functions[gen->frame.function_index];
                }
                mal_gc_trace_frame(&gen->frame);
            }
            mal_gc_mark_value(gen->yielded_value);
            if (gen->async_data != nullptr) {
                mal_gc_mark_value(gen->async_data->promise);
                if (gen->async_data->awaited_by != nullptr) {
                    mal_gc_shade(&gen->async_data->awaited_by->object.header);
                }
                // Pending async-generator requests (malloc'd nodes, traced via
                // the owner) remain reachable through the coallocated tail.
                for (MalAsyncGeneratorRequest *req = gen->async_data->queue_head;
                     req != nullptr; req = req->next) {
                    mal_gc_mark_value(req->promise);
                    mal_gc_mark_value(req->promise_constructor);
                    mal_gc_mark_value(req->value);
                }
            }
            break;
        }
        case MAL_HEAP_PROMISE_OBJECT: {
            MalPromiseObject *promise = (MalPromiseObject *) cell;
            mal_gc_mark_value(promise->result);
            for (MalPromiseReaction *r = promise->reactions_head; r != nullptr; r = r->next) {
                mal_gc_mark_value(r->cap_resolve);
                mal_gc_mark_value(r->cap_reject);
                mal_gc_mark_value(r->on_fulfilled);
                mal_gc_mark_value(r->on_rejected);
#if MAL_NODE
                if (r->async_context != nullptr) {
                    mal_gc_shade(&r->async_context->header);
                }
#endif
            }
            if (promise->async_owner != nullptr) {
                mal_gc_shade(&promise->async_owner->object.header);
            }
            break;
        }
        default:
            break; // OBJECT / ARRAY (elements live in the overflow table) / DATE:
                    // common edges only
    }
}

// --- Roots -----------------------------------------------------------------

/** Trace a microtask job's live MalValue fields (queued or currently running). */
static void mal_gc_mark_job(MalJob *job) {
#if MAL_NODE
    if (job->async_context != nullptr) {
        mal_gc_shade(&job->async_context->header);
    }
#endif
    if (job->kind == MAL_JOB_PROMISE_REACTION ||
        job->kind == MAL_JOB_ASYNC_AWAIT ||
        job->kind == MAL_JOB_ASYNC_GENERATOR_RETURN ||
        job->kind == MAL_JOB_ASYNC_FROM_SYNC) {
        mal_gc_mark_value(job->as.reaction.handler);
        mal_gc_mark_value(job->as.reaction.cap_resolve);
        mal_gc_mark_value(job->as.reaction.cap_reject);
        mal_gc_mark_value(job->as.reaction.argument);
    } else {
        mal_gc_mark_value(job->as.thenable.then);
        mal_gc_mark_value(job->as.thenable.thenable);
        mal_gc_mark_value(job->as.thenable.resolve_fn);
        mal_gc_mark_value(job->as.thenable.reject_fn);
    }
}

/*
 * Scan one fiber's execution slice: its value stack, interpreter frames, current
 * completion, and its GC root chains (compiled-frame shadow stack + transient
 * root spans). For the *running* fiber these come from the live MalVm fields + the
 * global root-chain heads; for a *suspended* fiber they come from its saved slice
 * (fiber.h) — the values are still valid because the collector is non-moving and a
 * suspended fiber's C stack (holding the MalRootSpan records) is preserved.
 */
static void mal_gc_scan_fiber_exec(
    MalValue *value_stack,
    i32 value_stack_size,
    MalVmFrame *frames,
    i32 frame_count,
    MalValue completion_value,
    MalRootFrame *root_frame_head,
    MalRootSpan *root_span_head) {
    i32 stack_cursor = 0;
    bool exact_stack_windows = true;
    for (i32 i = 0; i < frame_count; i++) {
        const MalVmFrame *frame = &frames[i];
        if (frame->stack_base < 0) continue;
        if (frame->function == nullptr) {
            exact_stack_windows = false;
            break;
        }
        i32 retained_arguments = frame->arguments == nullptr ? 0 : frame->argument_count;
        i64 frame_end = (i64) frame->stack_base + retained_arguments +
            frame->function->register_count;
        if (frame->stack_base < stack_cursor ||
            frame_end < frame->stack_base || frame_end > value_stack_size) {
            exact_stack_windows = false;
            break;
        }
        stack_cursor = (i32) frame_end;
    }
    if (!exact_stack_windows) {
        mal_gc_mark_values(value_stack, value_stack_size);
    } else {
        stack_cursor = 0;
        for (i32 i = 0; i < frame_count; i++) {
            const MalVmFrame *frame = &frames[i];
            if (frame->stack_base < 0) continue;
            mal_gc_mark_values(
                value_stack + stack_cursor,
                frame->stack_base - stack_cursor);
            i32 retained_arguments = frame->arguments == nullptr ? 0 : frame->argument_count;
            stack_cursor = frame->stack_base + retained_arguments +
                frame->function->register_count;
        }
        mal_gc_mark_values(value_stack + stack_cursor, value_stack_size - stack_cursor);
    }
    for (i32 i = 0; i < frame_count; ++i) {
        mal_gc_trace_frame(&frames[i]);
    }
    mal_gc_mark_value(completion_value);
    for (MalRootFrame *frame = root_frame_head; frame != nullptr; frame = frame->prev) {
        i32 slot_count = frame->desc->slot_count;
        u64 inactive = frame->inactive_slots;
        if (inactive == 0) {
            mal_gc_mark_values(frame->slots, slot_count);
            if (g_gc != nullptr && g_gc->stats_enabled) {
                g_gc->compiled_root_slots_scanned += (u64) slot_count;
            }
        } else {
            u64 scanned = 0;
            for (i32 slot = 0; slot < slot_count; slot++) {
                if (slot < 64 && (inactive & (UINT64_C(1) << slot)) != 0) {
                    /* A dead physical register can be reused at a later safepoint;
                     * clearing it prevents reactivation from tracing a pointer freed
                     * while this slot was inactive. */
                    frame->slots[slot] = MAL_VALUE_UNDEFINED;
                    continue;
                }
                mal_gc_mark_value(frame->slots[slot]);
                scanned++;
            }
            if (g_gc != nullptr && g_gc->stats_enabled) {
                g_gc->compiled_root_slots_scanned += scanned;
                g_gc->compiled_root_slots_skipped += (u64) slot_count - scanned;
            }
        }
        mal_gc_trace_env(frame->env);
    }
    for (MalRootSpan *span = root_span_head; span != nullptr; span = span->prev) {
        mal_gc_mark_values(span->slots, span->count);
    }
}

static void mal_gc_scan_roots(MalVm *vm) {
    // This opportunistic cache is not a root: no collection cycle may retain its
    // last Map or key. Every sync/concurrent/verify root scan passes through here.
    mal_vm_invalidate_map_get_set_cache(vm);

    // The heap-owned transition tree retains keys even when no live object
    // currently owns an intermediate shape.
    mal_shape_visit_transition_keys(&vm->heap, mal_gc_mark_value);
    mal_gc_mark_string(vm->heap.native_function_length_key);
    mal_gc_mark_string(vm->heap.native_function_name_key);
    if (vm->tiny_string_cache != nullptr) {
        for (usize i = 0; i < MAL_TINY_STRING_CACHE_CAPACITY; ++i) {
            mal_gc_mark_string(vm->tiny_string_cache[i]);
        }
    }
    if (vm->small_uint_string_cache != nullptr) {
        if (vm->small_uint_string_cache_scan_limit
            > MAL_SMALL_UINT_STRING_CACHE_CAPACITY) {
            abort();
        }
        for (usize i = 0; i < vm->small_uint_string_cache_scan_limit; ++i) {
            mal_gc_mark_string(vm->small_uint_string_cache[i]);
        }
    }
    if (vm->small_bigint_cache != nullptr) {
        for (usize i = 0; i < MAL_SMALL_BIGINT_CACHE_CAPACITY; ++i) {
            if (vm->small_bigint_cache[i] != nullptr) {
                mal_gc_mark_value(
                    mal_value_from_bigint(vm->small_bigint_cache[i]));
            }
        }
    }

    // The running fiber's execution slice lives in the live MalVm fields + the
    // global root-chain heads.
    mal_gc_scan_fiber_exec(
        vm->value_stack,
        vm->value_stack_size,
        vm->frames,
        vm->frame_count,
        vm->completion.value,
        mal_root_frame_head,
        mal_root_span_head);

    // Every *suspended* fiber's slice lives in its saved state. Skip the running
    // fiber (its live slice was scanned above) and any finished-but-unreaped one.
    for (struct MalFiber *f = vm->fibers_head; f != nullptr; f = f->next) {
        if (f == vm->current_fiber || f->state == MAL_FIBER_FINISHED) {
            continue;
        }
        mal_gc_scan_fiber_exec(
            f->exec.value_stack,
            f->exec.value_stack_size,
            f->exec.frames,
            f->exec.frame_count,
            f->exec.completion.value,
            f->exec.root_frame_head,
            f->exec.root_span_head);
#if MAL_NODE
        if (f->exec.async_context != nullptr) {
            mal_gc_shade(&f->exec.async_context->header);
        }
#endif
    }

    // Isolate-shared roots (one per isolate, not per fiber).
    mal_gc_mark_value(vm->allocation_error);
#if MAL_NODE
    if (vm->async_context != nullptr) {
        mal_gc_shade(&vm->async_context->header);
    }
#endif
#if MAL_REALMS
    mal_gc_mark_value(vm->error_stack_marker);
    // Every realm's globals and intrinsics are roots. The VM aliases point into the
    // current realm, which this loop already covers.
    for (MalRealm *realm = vm->realms; realm != nullptr; realm = realm->next) {
        mal_gc_mark_values(realm->globals, vm->runtime_image->global_count);
        mal_gc_mark_values(realm->intrinsics, MAL_INTRINSIC_COUNT);
    }
#else
    mal_gc_mark_values(vm->globals, vm->runtime_image->global_count);
    mal_gc_mark_values(vm->intrinsics, MAL_INTRINSIC_COUNT);
#endif
    mal_gc_mark_values(vm->unhandled_rejections, vm->unhandled_count);
    mal_gc_mark_value(vm->entry_async_promise);
    mal_gc_trace_table(vm->symbol_registry);
    mal_gc_trace_table(vm->atoms);

    for (MalJob *job = vm->job_head; job != nullptr; job = job->next) {
        mal_gc_mark_job(job);
    }
    if (vm->active_job != nullptr) {
        mal_gc_mark_job(vm->active_job);
    }
    mal_gc_mark_values(vm->kept_objects, vm->kept_count);

    // The baked compiler's `__compile` closure (eval), captured off globalThis;
    // closes over the whole compiler environment, kept alive by tracing it here.
    mal_gc_mark_value(vm->compiler_fn);

    if (vm->cjs_registry != nullptr) {
        for (i32 i = 0; i < vm->runtime_image->cjs_module_count; ++i) {
            mal_gc_mark_value(vm->cjs_registry[i].module_object);
        }
    }

    // Host/runtime root sources (e.g. pending setTimeout callbacks) contribute
    // their roots here, so the engine's collector needs no knowledge of their types.
    for (i32 i = 0; i < g_root_source_count; ++i) {
        g_root_sources[i].fn(vm, g_root_sources[i].data);
    }
    // (Compiled shadow-frame + root-span chains are scanned per fiber above, via
    // mal_gc_scan_fiber_exec.)
}

// --- Finalization ----------------------------------------------------------

static void mal_gc_finalize_cell(MalHeapHeader *cell) {
    switch (cell->type) {
        case MAL_HEAP_STRING: {
            MalString *string = (MalString *) cell;
            if (string->storage == MAL_STRING_STORAGE_OWNED) {
                gc_free_raw(&g_gc_vm->heap, (void *) string->code_units);
                string->code_units = nullptr;
            }
            // External, dependent, and cons strings do not own code-unit buffers.
            return;
        }
        case MAL_HEAP_SYMBOL:
        case MAL_HEAP_BIGINT:
        case MAL_HEAP_ENV:
        case MAL_HEAP_ASYNC_CONTEXT:
        case MAL_HEAP_ASYNC_LOCAL_STORAGE_STATE:
        case MAL_HEAP_ASYNC_RESOURCE_STATE:
        case MAL_HEAP_ASYNC_RUN_SCOPE_STATE:
            return; // no owned side allocations (env slots are inline, not a MalObject)
        default:
            break;
    }

    // Host/runtime-registered per-type finalizers (e.g. fetch Response/Request body
    // buffers) — frees their owned memory without an engine->runtime type dependency.
    // Runs before the common object cleanup below.
    if (g_type_finalizers[cell->type] != nullptr) {
        g_type_finalizers[cell->type](cell);
    }

    // MalObject-based cell: free its type-specific owned memory, then the common
    // overflow table and inline-slots buffer. Idempotent (null after free).
    switch (cell->type) {
        case MAL_HEAP_ARRAY_OBJECT: {
            MalArrayObject *array = (MalArrayObject *) cell;
            if (array->elements != nullptr) {
                gc_free_raw(&g_gc_vm->heap, array->elements); // RAW-space dense vector
                array->elements = nullptr;
                array->capacity = 0;
                array->dense_count = 0;
            }
            break;
        }
        case MAL_HEAP_MAP_OBJECT:
        case MAL_HEAP_SET_OBJECT: {
            MalMapObject *map = (MalMapObject *) cell;
            if (map->entries != nullptr) {
                mal_table_release_owner(map->entries);
                map->entries = nullptr;
            }
            break;
        }
        case MAL_HEAP_ARRAY_BUFFER_OBJECT: {
            MalArrayBufferObject *buffer = (MalArrayBufferObject *) cell;
            if (!buffer->detached) {
                // Shared with detach so a sensitive store is scrubbed on the
                // sweep too — the path most secret-bearing buffers actually take,
                // since nothing detaches a digest state or a derived tag.
                mal_array_buffer_object_release_store(buffer);
                buffer->detached = true;
            }
            break;
        }
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT: {
            MalNativeFunctionObject *fn = (MalNativeFunctionObject *) cell;
            if (fn->slots != nullptr) {
                gc_free_raw(&g_gc_vm->heap, fn->slots);
                fn->slots = nullptr;
            }
            break;
        }
        case MAL_HEAP_REGEXP_OBJECT: {
#if MAL_REGEXP
            // No regexp objects are ever allocated under engine.regexp:false, so this
            // finalizer is dead there — and mal_regexp_free (regress FFI) isn't linked.
            MalRegExpObject *re = (MalRegExpObject *) cell;
            if (re->matcher != nullptr) {
                mal_regexp_free(re->matcher);
                re->matcher = nullptr;
            }
#endif
            break;
        }
        case MAL_HEAP_TEMPORAL_OBJECT: {
#if MAL_TEMPORAL
            MalTemporalObject *temporal = (MalTemporalObject *) cell;
            if (temporal->handle != nullptr) {
                switch (temporal->kind) {
                    case MAL_TEMPORAL_DURATION:
                        temporal_rs_Duration_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_INSTANT:
                        temporal_rs_Instant_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_PLAIN_DATE:
                        temporal_rs_PlainDate_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_PLAIN_DATE_TIME:
                        temporal_rs_PlainDateTime_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_PLAIN_MONTH_DAY:
                        temporal_rs_PlainMonthDay_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_PLAIN_TIME:
                        temporal_rs_PlainTime_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_PLAIN_YEAR_MONTH:
                        temporal_rs_PlainYearMonth_destroy(temporal->handle);
                        break;
                    case MAL_TEMPORAL_ZONED_DATE_TIME:
                        temporal_rs_ZonedDateTime_destroy(temporal->handle);
                        break;
                }
                temporal->handle = nullptr;
            }
#endif
            break;
        }
        case MAL_HEAP_INTL_OBJECT: {
            MalIntlObject *intl = (MalIntlObject *) cell;
            if (intl->handle != nullptr) {
                // Only a build with the service compiled links its free fn (and only
                // it can create the handle), so gate per-service to keep the link
                // clean when Collator / PluralRules are dropped (engine.intl.features).
#if MAL_INTL_HAS_COLLATOR
                if (intl->kind == MAL_INTL_COLLATOR) {
                    mal_i18n_collator_free(intl->handle);
                }
#endif
#if MAL_INTL_HAS_PLURAL_RULES
                if (intl->kind == MAL_INTL_PLURAL_RULES) {
                    mal_i18n_plural_rules_free(intl->handle);
                }
#endif
#if MAL_INTL_HAS_NUMBER_FORMAT
                if (intl->kind == MAL_INTL_NUMBER_FORMAT) {
                    mal_i18n_number_formatter_free(intl->handle);
                }
#endif
#if MAL_INTL_HAS_DATE_TIME_FORMAT
                if (intl->kind == MAL_INTL_DATE_TIME_FORMAT) {
                    mal_i18n_datetime_formatter_free(intl->handle);
                }
#endif
                intl->handle = nullptr;
            }
            break;
        }
        case MAL_HEAP_MODULE_NAMESPACE_OBJECT: {
            MalModuleNamespaceObject *ns = (MalModuleNamespaceObject *) cell;
            if (ns->exports != nullptr) {
                free(ns->exports);
                ns->exports = nullptr;
            }
            break;
        }
        case MAL_HEAP_FINALIZATION_REGISTRY_OBJECT: {
            MalFinalizationRegistryObject *reg = (MalFinalizationRegistryObject *) cell;
            MalFinRegCell *fc = reg->cells;
            while (fc != nullptr) {
                MalFinRegCell *next = fc->next;
                mal_finalization_registry_cell_recycle(g_gc_vm, fc);
                fc = next;
            }
            reg->cells = nullptr;
            break;
        }
        case MAL_HEAP_PROMISE_OBJECT: {
            // A promise collected while still pending owns its reaction nodes.
            MalPromiseObject *promise = (MalPromiseObject *) cell;
            mal_promise_free_reactions(g_gc_vm, promise->reactions_head);
            promise->reactions_head = nullptr;
            promise->reactions_tail = nullptr;
            break;
        }
        case MAL_HEAP_GENERATOR_OBJECT: {
            // A suspended (abandoned) generator/async activation still owns its
            // frame's malloc'd register and argument buffers
            // (transferred off the VM frame stack on suspend). A COMPLETED
            // generator already freed them via the run loop's frame teardown
            // (leaving these pointers dangling), so release ONLY while suspended
            // to avoid a double free.
            MalGeneratorObject *gen = (MalGeneratorObject *) cell;
            if (gen->state == MAL_GENERATOR_SUSPENDED_START ||
                gen->state == MAL_GENERATOR_SUSPENDED_YIELD) {
                mal_generator_release_frame(g_gc_vm, gen);
            }
            if (gen->async_data != nullptr) {
                mal_async_generator_free_requests(
                    g_gc_vm, gen->async_data->queue_head);
                gen->async_data->queue_head = nullptr;
                gen->async_data->queue_tail = nullptr;
            }
            break;
        }
        case MAL_HEAP_ITERATOR_OBJECT:
            mal_iterator_object_release_table_pin((MalIteratorObject *) cell);
            break;
        default:
            break;
    }

    MalObject *object = (MalObject *) cell;
    mal_builtin_error_finalize_object(g_gc_vm, object);
    // Exact inherited/missing IC entries retain untraced prototype/holder
    // identities. Invalidate them before a prototype cell can enter a free list
    // and have its address reused; ordinary collections with no dead prototypes
    // leave the cache epoch untouched.
    if (object->is_prototype) {
        mal_object_invalidate_prototype_dependents(object);
        mal_object_bump_prototype_chain_epoch();
        MAL_PERF_COUNT(prototype_epoch_finalize_invalidations);
    }
    if (object->overflow != nullptr) {
        mal_table_free(object->overflow);
        object->overflow = nullptr;
    }
    mal_object_release_slots(object);
}

// --- Mark / weak / verify --------------------------------------------------

/** Verify visitor: re-trace a survivor's edges (in verify mode shading aborts on
 * a freed target). FREE cells are dead this cycle and are skipped. */
static void mal_gc_verify_cell(MalHeapHeader *cell) {
    if (cell->mark != MAL_MARK_FREE) {
        g_gc_verify_source = (i32) cell->type;
        mal_gc_trace_cell(cell);
        g_gc_verify_source = -1;
    }
}

/** Post-sweep dangling-pointer check (MAL_GC_VERIFY): every root and surviving
 * cell must point only at other survivors, never at a cell the sweep just freed.
 * A freed target means marking missed a live cell (a missing root or trace edge)
 * and swept it from under a still-reachable reference — the exact corruption that
 * later reads as a use-after-free. Runs right after the sweep, before any new
 * allocation can recycle a freed cell, so MAL_MARK_FREE is unambiguous. Under the
 * concurrent collector it runs at CYCLE END (after the incremental sweep drains). */
static void mal_gc_verify(MalVm *vm) {
    g_gc_verifying = true;
    mal_gc_scan_roots(vm);
    mal_heap_walk_cells(&vm->heap, mal_gc_verify_cell);
    g_gc_verifying = false;
}

/** Drain the grey worklist, tracing each cell's strong edges. */
static void mal_gc_drain(void) {
    while (g_gc->grey_count > 0) {
        mal_gc_trace_cell(g_gc->grey[--g_gc->grey_count]);
    }
}

#if MAL_GC_CONCURRENT
/** Drain the SATB buffer into the grey worklist: re-shade every recorded snapshot
 * reference. The buffer can grow while draining (tracing a shaded cell may fire a
 * barrier / another shade), so re-read satb_count each pass; never drop an entry. */
static void mal_gc_drain_satb(void) {
    while (g_gc->satb_drained < g_gc->satb_count) {
        MalValue v = g_gc->satb[g_gc->satb_drained++];
        mal_gc_mark_value(v);
    }
}
#endif

/** Weak-reference processing, after the main mark has drained. Today: the
 * WeakMap/WeakSet ephemeron pass. A weak entry's value is live iff its key is
 * live, and marking a value can revive another collection's key, so iterate the
 * "mark values of live keys" step to a fixpoint; then drop entries whose key did
 * not survive. Keys are tested, never shaded — that is what makes them weak. */
static void mal_gc_weak_pass(void) {
    bool changed = true;
    while (changed) {
        changed = false;
        for (usize i = 0; i < g_gc->weak_maps_count; ++i) {
            MalTable *entries = g_gc->weak_maps[i]->entries;
            if (entries == nullptr) {
                continue;
            }
            MalTableIter iter;
            mal_table_iter_init(&iter, entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (!mal_gc_is_marked(key.value)) {
                    continue;
                }
                MalValue value = mal_table_entry_value(entries, entry);
                if (mal_value_is_heap(value) && !mal_gc_is_marked(value)) {
                    mal_gc_mark_value(value);
                    changed = true;
                }
            }
        }
        mal_gc_drain(); // a freshly marked value may revive another weak key
    }

    // Drop entries whose key did not survive (collected first; deleting mid-
    // iteration is avoided). The values, if dead, are reclaimed by the sweep.
    for (usize i = 0; i < g_gc->weak_maps_count; ++i) {
        MalTable *entries = g_gc->weak_maps[i]->entries;
        if (entries == nullptr) {
            continue;
        }
        g_gc->dead_keys_count = 0;
        MalTableIter iter;
        mal_table_iter_init(&iter, entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            if (!mal_gc_is_marked(key.value)) {
                mal_gc_dead_key_push(key);
            }
        }
        for (usize d = 0; d < g_gc->dead_keys_count; ++d) {
            mal_table_delete(entries, g_gc->dead_keys[d]);
        }
        // mal_table_delete only tombstones; without compaction a churning weak
        // collection's order array grows without bound. Weak collections have no
        // JS iteration surface, so compacting (which renumbers storage) is safe.
        if (g_gc->dead_keys_count > 0) {
            mal_table_compact(entries);
        }
    }

    // WeakRef: null any target that did not otherwise survive, so a later deref()
    // sees undefined rather than a reclaimed cell.
    for (usize i = 0; i < g_gc->weak_refs_count; ++i) {
        if (!mal_gc_is_marked(g_gc->weak_refs[i]->target)) {
            g_gc->weak_refs[i]->target = mal_value_new_undefined();
        }
    }

    // FinalizationRegistry: for each cell whose target was reclaimed, enqueue a
    // cleanup job (callback(heldValue) — never the dead target) and unlink the
    // cell. The held value was marked strongly above, so it survives to the job.
    for (usize i = 0; i < g_gc->fin_regs_count; ++i) {
        MalFinalizationRegistryObject *reg = g_gc->fin_regs[i];
        MalFinRegCell **link = &reg->cells;
        while (*link != nullptr) {
            MalFinRegCell *fc = *link;
            if (!mal_gc_is_marked(fc->target)) {
                mal_vm_enqueue_reaction_job(g_gc_vm, reg->cleanup_callback, false,
                    mal_value_new_undefined(), mal_value_new_undefined(), fc->held_value);
                *link = fc->next;
                mal_finalization_registry_cell_recycle(g_gc_vm, fc);
            } else {
                // [[UnregisterToken]] is weak independently of the target. A
                // live target can therefore outlast an otherwise unreachable
                // token; clear that dead edge before sweep so the registry never
                // retains a dangling MalValue.
                if (mal_value_is_heap(fc->unregister_token) &&
                    !mal_gc_is_marked(fc->unregister_token)) {
                    fc->unregister_token = mal_value_new_undefined();
                }
                link = &fc->next;
            }
        }
    }
}

#if MAL_GC_GENERATIONAL
// --- Generational (sticky mark-bit) state -----------------------------------
//
// Remembered set: old (survived-a-collection, sticky-BLACK) cells written with a
// young (WHITE) pointer since the last collection, recorded by the card barrier
// (gc.h). A minor collection scans roots + traces each remembered cell to reach
// its young children, WITHOUT re-marking the old generation — that is the work it
// saves over a full mark. The set is rebuilt every collection.

void mal_gc_remember(MalHeapHeader *owner) {
    owner->dirty = 1;
    if (g_gc->remembered_count == g_gc->remembered_capacity) {
        g_gc->remembered_capacity = g_gc->remembered_capacity == 0 ? 256 : g_gc->remembered_capacity * 2;
        g_gc->remembered = realloc(g_gc->remembered, g_gc->remembered_capacity * sizeof(MalHeapHeader *));
    }
    g_gc->remembered[g_gc->remembered_count++] = owner;
}

// Clear the remembered set after a collection: drop the dirty flag on each member
// (a later write re-records it) and empty the list.
static void mal_gc_clear_remembered(void) {
    for (usize i = 0; i < g_gc->remembered_count; ++i) {
        g_gc->remembered[i]->dirty = 0;
    }
    g_gc->remembered_count = 0;
}

// Major-collection pre-pass visitor: demote every live cell to WHITE so the
// following full mark reclaims old garbage and cross-generation cycles, and drop
// any stale dirty flag (the remembered set is emptied alongside).
static void mal_gc_reset_marks_cell(MalHeapHeader *cell) {
    if (cell->mark == MAL_MARK_BLACK) {
        cell->mark = MAL_MARK_WHITE;
    }
    cell->dirty = 0;
}
#endif

// --- Statistics helpers ----------------------------------------------------

/* Fold one pause/step duration into the stats: total time, the global max pause,
 * and (concurrent build) the caller-specified per-phase slot. */
static void mal_gc_stat_record(u64 elapsed_ns) {
    if (!g_gc->stats_enabled) {
        return;
    }
    g_gc->total_ns += elapsed_ns;
    if (elapsed_ns > g_gc->max_pause_ns) {
        g_gc->max_pause_ns = elapsed_ns;
    }
}

static void mal_gc_stat_peak_live(MalVm *vm) {
    if (g_gc->stats_enabled) {
        g_gc->allocated_bytes = vm->heap.bytes_allocated;
        if (vm->heap.live_bytes > g_gc->peak_live_bytes) {
            g_gc->peak_live_bytes = vm->heap.live_bytes;
        }
    }
}

// --- Synchronous (stop-the-world) collection -------------------------------

/* Advance the auto-collection trigger past the surviving set (heap doubling with a
 * floor): collect again only after another ~live-set of allocation. Shared by the
 * STW path and the concurrent cycle's completion. Returns the chosen `grow`. */
static usize mal_gc_advance_trigger(MalVm *vm) {
    usize grow = vm->heap.live_bytes * 2;
    if (grow < MAL_GC_MIN_INCREMENT) {
        grow = MAL_GC_MIN_INCREMENT;
    }
    if (mal_gc_next_at != (usize) -1) {
        mal_gc_next_at = vm->heap.bytes_allocated + grow;
    }
    return grow;
}

/* One synchronous mark-sweep collection. `major` demotes the whole heap to WHITE
 * (gen) so old garbage + cross-generation cycles are reclaimed; a minor leaves old
 * cells BLACK and finds young survivors via roots + the remembered set. This is
 * today's mal_gc_collect body, factored so the concurrent build can reuse it for
 * STW minors and for finishing a cycle synchronously (backstop / MODE=stw). */
static void mal_gc_collect_sync(MalVm *vm, bool major) {
	mal_profile_event(vm, MAL_PROFILE_RECORD_GC_BEGIN, major ? 1 : 0);
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    g_gc->grey_count = 0;
    g_gc->weak_maps_count = 0;
    g_gc->weak_refs_count = 0;
    g_gc->fin_regs_count = 0;

#if MAL_GC_GENERATIONAL
    if (major) {
        mal_heap_walk_cells(&vm->heap, mal_gc_reset_marks_cell);
        g_gc->remembered_count = 0; // dirty flags cleared by the reset walk above
    }
    // Survivors of BOTH minor and (gen) major stay BLACK = old (sticky promotion).
    mal_heap_sweep_sticky = true;
#endif

    mal_gc_scan_roots(vm);
#if MAL_GC_GENERATIONAL
    if (!major) {
        // Trace each remembered old cell's edges to reach (and mark) its young
        // children; the old cell itself is left BLACK (not re-shaded), so the old
        // generation is not re-marked. mal_gc_trace_cell also (re-)registers weak
        // collections it reaches, so a dirtied old WeakMap's dead young keys are
        // still cleaned this cycle.
        for (usize i = 0; i < g_gc->remembered_count; ++i) {
            mal_gc_trace_cell(g_gc->remembered[i]);
        }
    }
#endif
    mal_gc_drain();

    mal_gc_weak_pass();

    mal_heap_sweep(&vm->heap, mal_gc_finalize_cell);

#if MAL_GC_GENERATIONAL
    mal_heap_sweep_sticky = false;
    mal_gc_clear_remembered();
#endif

    if (g_gc->verify_enabled) {
        mal_gc_verify(vm);
    }

    mal_gc_advance_trigger(vm);

	if (g_gc->stats_enabled) {
        u64 elapsed = mal_monotonic_now_ns() - start_ns;
        g_gc->collections++;
        mal_gc_stat_record(elapsed);
        mal_gc_stat_peak_live(vm);
#if MAL_GC_GENERATIONAL
        if (major) {
            g_gc->major_count++;
        } else {
            g_gc->minor_count++;
        }
#else
        g_gc->major_count++; // a non-generational collection is always a full mark-sweep
        (void) major;
#endif
	}
	mal_profile_event(vm, MAL_PROFILE_RECORD_GC_END, major ? 1 : 0);
}

#if !MAL_GC_CONCURRENT
/** Collection selected by the automatic/stress cadence: minor generations stay
 * cheap while every `major_every` turn reclaims the whole heap. */
static void mal_gc_collect_scheduled(MalVm *vm) {
    g_gc_vm = vm;
#if MAL_GC_GENERATIONAL
    bool major = (g_gc->collection_index++ % g_gc->major_every) == 0;
#else
    bool major = true;
#endif
    mal_gc_collect_sync(vm, major);
}

/* The public host/test hook promises one complete collection. Do not route it
 * through the generational cadence: a target promoted by earlier stress minors
 * must still be reclaimable by the explicit `gc()` that observes its death. */
void mal_gc_collect(MalVm *vm) {
    g_gc_vm = vm;
#if MAL_GC_GENERATIONAL
    g_gc->collection_index++;
#endif
    mal_gc_collect_sync(vm, true);
}
#endif

// ===========================================================================
// Concurrent incremental collector (MAL_GC_CONCURRENT).
//
// The whole cycle runs on the mutator thread, sliced at safepoints — no atomics,
// no races (C2 adds the marker thread). Composition with generational: minors
// stay STW-inline (short by construction); only the periodic MAJOR runs as a
// concurrent cycle, and no minor starts while a cycle is in flight (the safepoint
// advances the cycle instead). Black allocation over-tenures mid-cycle allocations
// (accepted, counted). Roots are SATB-exempt: init-mark and remark re-scan them,
// so both pauses are O(roots), never O(heap).
// ===========================================================================
#if MAL_GC_CONCURRENT

/* Begin a concurrent MAJOR cycle: the init-mark pause. Scan roots, enable marking
 * (SATB barrier) + black allocation, and — under generational — demote the whole
 * heap to WHITE first (as today's STW major does) so old garbage and
 * cross-generation cycles are reclaimed this cycle. O(roots + heap-reset); the
 * heap-reset walk is the one O(heap) step of a pause, unavoidable for a sticky
 * major and identical to the STW major's pre-pass. */
static void mal_gc_cycle_begin(MalVm *vm) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    g_gc->grey_count = 0;
    g_gc->weak_maps_count = 0;
    g_gc->weak_refs_count = 0;
    g_gc->fin_regs_count = 0;
    g_gc->satb_count = 0;
    g_gc->satb_drained = 0;

#if MAL_GC_GENERATIONAL
    mal_heap_walk_cells(&vm->heap, mal_gc_reset_marks_cell);
    g_gc->remembered_count = 0; // dirty flags cleared by the reset walk above
    mal_heap_sweep_sticky = true; // survivors stay BLACK = old
#endif

    // Enable the SATB deletion barrier + black allocation, THEN snapshot the roots.
    // Ordering: with marking active, any store the mutator makes after this shades
    // its old value; the root scan captures the current roots. A cell reachable at
    // this instant is either marked now (root-reachable) or preserved by the
    // barrier / black allocation for the rest of the cycle.
    mal_gc_marking_active = true;
    mal_gc_black_alloc = true;
    mal_gc_scan_roots(vm);

    g_gc->phase = MAL_GC_PHASE_MARK;
    g_gc->bytes_at_last_step = vm->heap.bytes_allocated;

    if (g_gc->stats_enabled) {
        u64 elapsed = mal_monotonic_now_ns() - start_ns;
        g_gc->cycles++;
        g_gc->init_mark_ns = elapsed;
        mal_gc_stat_record(elapsed);
    }
}

/* The remark pause: drain the remaining SATB + grey to empty, re-scan roots (they
 * are SATB-exempt), run the weak/ephemeron pass, then clear marking and hand off
 * to the incremental sweep. O(roots + floating snapshot), not O(heap). */
static void mal_gc_cycle_remark(MalVm *vm) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;

    // Re-scan roots: a value that moved from a (SATB-exempt) root into an already
    // black object during marking is caught here.
    mal_gc_scan_roots(vm);
    // Drain to a joint fixpoint: draining grey can append to SATB (a shaded frame),
    // and draining SATB shades new grey. Loop until both are empty.
    do {
        mal_gc_drain();
        mal_gc_drain_satb();
    } while (g_gc->grey_count > 0);

    mal_gc_weak_pass();

    // Marking is complete: stop the barrier (further stores need no snapshot) and
    // hand off to the sweep. Black allocation stays ON through the sweep so a cell
    // born during sweeping is not reclaimed as WHITE garbage.
    mal_gc_marking_active = false;
    g_gc->satb_count = 0;
    g_gc->satb_drained = 0;

    // Bump the epoch BEFORE any cell can be reused (the sweep reclaims cells): the
    // call-site caches treat a changed epoch as an invalidation (ABA guard).
    mal_heap_sweep_begin(&vm->heap);
    g_gc->phase = MAL_GC_PHASE_SWEEP;

    if (g_gc->stats_enabled) {
        u64 elapsed = mal_monotonic_now_ns() - start_ns;
        g_gc->remark_ns = elapsed;
        mal_gc_stat_record(elapsed);
    }
}

/* Finish an in-flight cycle's sweep and close it out: reset the sticky flag,
 * clear the remembered set, disable black allocation, run verify (cycle end), and
 * advance the trigger. Called both by the incremental sweep on completion and by
 * the synchronous-finish path (which sweeps everything remaining first). */
static void mal_gc_cycle_finish_sweep(MalVm *vm) {
#if MAL_GC_GENERATIONAL
    mal_heap_sweep_sticky = false;
    mal_gc_clear_remembered();
#endif
    mal_gc_black_alloc = false;
    g_gc->phase = MAL_GC_PHASE_IDLE;

    if (g_gc->verify_enabled) {
        mal_gc_verify(vm);
    }
    mal_gc_advance_trigger(vm);

    if (g_gc->stats_enabled) {
        g_gc->collections++;
        g_gc->major_count++; // a concurrent cycle is always a major
        mal_gc_stat_peak_live(vm);
    }
}

/* One incremental mark step: drain up to `budget` grey/SATB entries. Returns true
 * when marking is drained to empty (time to remark). */
static bool mal_gc_mark_step(MalVm *vm, usize budget) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    usize worked = 0;
    while (worked < budget) {
        if (g_gc->grey_count > 0) {
            mal_gc_trace_cell(g_gc->grey[--g_gc->grey_count]);
            worked++;
        } else if (g_gc->satb_drained < g_gc->satb_count) {
            mal_gc_mark_value(g_gc->satb[g_gc->satb_drained++]);
            worked++;
        } else {
            break; // nothing left to do this step
        }
    }
    bool drained = g_gc->grey_count == 0 && g_gc->satb_drained >= g_gc->satb_count;
    g_gc->bytes_at_last_step = vm->heap.bytes_allocated;
    if (g_gc->stats_enabled) {
        u64 elapsed = mal_monotonic_now_ns() - start_ns;
        if (elapsed > g_gc->max_mark_step_ns) {
            g_gc->max_mark_step_ns = elapsed;
        }
        mal_gc_stat_record(elapsed);
    }
    return drained;
}

/* Number of CELL blocks to sweep per incremental sweep step. */
#define MAL_GC_SWEEP_BLOCKS_PER_STEP 16

/* One incremental sweep step: reclaim up to N blocks. Returns true when the whole
 * heap is swept (the cycle is done). */
static bool mal_gc_sweep_step(MalVm *vm) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    bool done = mal_heap_sweep_step(&vm->heap, mal_gc_finalize_cell, MAL_GC_SWEEP_BLOCKS_PER_STEP);
    if (g_gc->stats_enabled) {
        u64 elapsed = mal_monotonic_now_ns() - start_ns;
        if (elapsed > g_gc->max_sweep_step_ns) {
            g_gc->max_sweep_step_ns = elapsed;
        }
        mal_gc_stat_record(elapsed);
    }
    return done;
}

/* Finish whatever remains of the in-flight cycle synchronously, then leave it
 * IDLE. The one function behind the three synchronous callers: the hard backstop
 * (allocation reached mal_gc_next_at mid-cycle), MAL_GC_MODE=stw, and the explicit
 * mal_gc_collect entry (host gc() / teardown). Degrade-to-STW, never OOM. */
static void mal_gc_cycle_finish_sync(MalVm *vm) {
    if (g_gc->phase == MAL_GC_PHASE_MARK) {
        mal_gc_cycle_remark(vm); // drains SATB+grey, weak pass, opens the sweep
    }
    if (g_gc->phase == MAL_GC_PHASE_SWEEP) {
        // Sweep everything remaining in one shot.
        while (!mal_heap_sweep_step(&vm->heap, mal_gc_finalize_cell, (usize) -1)) {
            // loop until the whole heap is swept
        }
        mal_gc_cycle_finish_sweep(vm);
    }
}

/* The explicit "collect now, completely and synchronously" entry (host gc() hook,
 * teardown). A complete collection is what the caller expects: if a cycle is
 * mid-flight, finish it synchronously FIRST — but that cycle's snapshot may retain
 * objects that died after it began (SATB floating garbage) — and then run a fresh
 * synchronous major, which snapshots the CURRENT roots and reclaims that floating
 * garbage too. So gc() matches the STW collector's "reclaim everything dead now". */
void mal_gc_collect(MalVm *vm) {
    g_gc_vm = vm;
    if (g_gc->phase != MAL_GC_PHASE_IDLE) {
        mal_gc_cycle_finish_sync(vm);
    }
    mal_gc_collect_sync(vm, true); // fresh full major over the current snapshot
}

/* Advance an in-flight cycle by one step, or (if idle) decide whether a collection
 * is due and start one. Returns having done at most one bounded unit of GC work.
 * The pacer: the assist budget is proportional to bytes allocated since the last
 * mark step, so marking outruns allocation; the hard backstop finishes the cycle
 * synchronously if allocation reaches mal_gc_next_at first. */
static void mal_gc_cycle_advance(MalVm *vm, usize mark_budget) {
    switch (g_gc->phase) {
        case MAL_GC_PHASE_MARK: {
            // Hard backstop: if allocation has reached the old STW trigger before the
            // cycle finished, finish it synchronously rather than float garbage.
            if (vm->heap.bytes_allocated >= g_gc->backstop_at) {
                u64 s = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
                mal_gc_cycle_finish_sync(vm);
                if (g_gc->stats_enabled) {
                    g_gc->sync_backstop++;
                    mal_gc_stat_record(mal_monotonic_now_ns() - s);
                }
                return;
            }
            if (mal_gc_mark_step(vm, mark_budget)) {
                mal_gc_cycle_remark(vm); // marking drained → remark + open the sweep
            }
            return;
        }
        case MAL_GC_PHASE_SWEEP: {
            if (mal_gc_sweep_step(vm)) {
                mal_gc_cycle_finish_sweep(vm);
            }
            return;
        }
        default:
            return;
    }
}

/* The assist budget for the next mark step: grey/SATB entries to trace, ∝ bytes
 * allocated since the last step (so a faster mutator does proportionally more
 * marking). A floor keeps progress even under a quiet mutator. */
static usize mal_gc_mark_budget(MalVm *vm) {
    usize delta = vm->heap.bytes_allocated - g_gc->bytes_at_last_step;
    usize budget = (delta / 64) * g_gc->assist;
    if (budget < 4096) {
        budget = 4096; // floor: always make real progress per gated safepoint
    }
    return budget;
}

/* Concurrent-build safepoint: drive the cycle state machine. */
static void mal_gc_concurrent_safepoint(MalVm *vm) {
    g_gc_vm = vm;

    // Stress-for-concurrency: force a cycle start every N gated safepoints with a
    // tiny mark budget to maximize mutator/marker interleavings; advance an
    // in-flight cycle a tiny step at every safepoint. MODE=stw recovers today's
    // behaviour (each forced collection is fully synchronous).
    if (g_gc->stress_interval != 0) {
        if (g_gc->mode_stw) {
            if (++g_gc->stress_counter >= g_gc->stress_interval) {
                g_gc->stress_counter = 0;
                mal_gc_collect(vm);
            }
            return;
        }
        if (g_gc->phase != MAL_GC_PHASE_IDLE) {
            mal_gc_cycle_advance(vm, 64); // tiny budget → many interleavings
        } else if (++g_gc->stress_counter >= g_gc->stress_interval) {
            g_gc->stress_counter = 0;
            g_gc->backstop_at = (usize) -1; // stress: no byte backstop, run to completion
            mal_gc_cycle_begin(vm);
        }
        return;
    }

    // Auto mode.
    if (g_gc->phase != MAL_GC_PHASE_IDLE) {
        // A cycle is in flight: advance it. Any auto-trigger poll raised meanwhile
        // ADVANCES this cycle (a mark/sweep step) rather than starting a collection.
        mal_gc_cycle_advance(vm, mal_gc_mark_budget(vm));
        mal_gc_poll = false;
        return;
    }

    if (!mal_gc_poll) {
        return;
    }
    mal_gc_poll = false;
    if (vm->heap.bytes_allocated < mal_gc_next_at) {
        return; // polled for preemption only; nothing owed
    }

    // A collection is due. Decide minor vs. major by the generational cadence.
#if MAL_GC_GENERATIONAL
    bool major = (g_gc->collection_index % g_gc->major_every) == 0;
#else
    bool major = true;
#endif
    if (!major) {
        // Minor: STW-inline, exactly as today (short by construction).
#if MAL_GC_GENERATIONAL
        g_gc->collection_index++;
#endif
        mal_gc_collect_sync(vm, false);
        return;
    }

    // Major turn. MODE=stw forces it synchronous (the backstop path).
#if MAL_GC_GENERATIONAL
    g_gc->collection_index++;
#endif
    if (g_gc->mode_stw) {
        mal_gc_collect_sync(vm, true);
        return;
    }
    // Start a concurrent major cycle. The backstop is one more growth increment of
    // headroom (a full ~live-set of allocation) in which to finish incrementally;
    // reaching it forces a synchronous finish.
    usize grow = vm->heap.live_bytes * 2;
    if (grow < MAL_GC_MIN_INCREMENT) {
        grow = MAL_GC_MIN_INCREMENT;
    }
    g_gc->backstop_at = vm->heap.bytes_allocated + grow;
    mal_gc_cycle_begin(vm);
}
#endif // MAL_GC_CONCURRENT

void mal_gc_safepoint(MalVm *vm) {
    // Only safe to collect when no native builtin is active: its C-local scratch
    // is not enumerable as a root, so collecting inside one could free values it
    // still holds. Compiled frames are fine (they publish root frames); all other
    // live state is in the interpreter frames + value stack, covered by the scan.
	if (vm->gc_native_frames != 0) {
		return;
	}
	mal_profile_safepoint(vm);
#if MAL_GC_CONCURRENT
    mal_gc_concurrent_safepoint(vm);
#else
    if (g_gc->stress_interval != 0) {
        if (++g_gc->stress_counter >= g_gc->stress_interval) {
            g_gc->stress_counter = 0;
            mal_gc_collect_scheduled(vm);
        }
    } else if (mal_gc_poll) {
        // Auto mode: collect only if actually due. The poll may also have been
        // raised purely to force a preemption safepoint (below), so don't assume a
        // collection is owed just because we were polled.
        if (vm->heap.bytes_allocated >= mal_gc_next_at) {
            mal_gc_collect_scheduled(vm); // advances past the surviving set
        }
        mal_gc_poll = false;
    }
#endif
    // Preemption: this is a safe point to switch fibers (roots are precise here and
    // no un-rooted native frame is live — the gate above). The scheduler's hook
    // yields the running fiber if its budget is spent, and returns here on resume.
    if (mal_gc_preempt_hook != nullptr) {
        mal_gc_preempt_hook(vm);
    }
}

/** Finalize-all visitor: free a live cell's owned side allocations regardless of
 * reachability. FREE cells (already finalized this run) are skipped, and the
 * cell is marked FREE so a second pass is a no-op. */
static void mal_gc_finalize_live_cell(MalHeapHeader *cell) {
    if (cell->mark != MAL_MARK_FREE) {
        mal_gc_finalize_cell(cell);
        cell->mark = MAL_MARK_FREE;
    }
}

/* Teardown helper: free EVERY cell's owned side allocations (overflow tables,
 * Map/Set entries, ArrayBuffer data, array elements, Rust regexp/Intl handles,
 * slots buffers) regardless of liveness, so a process that tears its VM down
 * leaves no shutdown leak for `leaks` / Guard Malloc to report. The per-cell
 * finalizer is idempotent (nulls each field), and gc_free_raw'd buffers that
 * live in the heap's RAW blocks / LOS are reclaimed by the following
 * mal_heap_free; this only covers the plain-malloc'd and Rust-owned memory that
 * mal_heap_free does not. LOS-resident cells (large MalObjects — effectively
 * none) are not walked; that gap matches the tracked LOS-sweep limitation. Call
 * once, immediately before mal_heap_free. */
void mal_gc_finalize_all(MalVm *vm) {
    g_gc_vm = vm; // mal_gc_finalize_cell reaches the heap through g_gc_vm
    mal_heap_walk_cells(&vm->heap, mal_gc_finalize_live_cell);
}

/* Free the per-isolate collector state's growable buffers + the struct itself.
 * Call at VM teardown (after mal_gc_finalize_all, before/after mal_heap_free — the
 * buffers are plain malloc'd, independent of the heap). */
void mal_gc_state_free(MalVm *vm) {
    MalGcState *g = vm->gc;
    if (g == nullptr) {
        return;
    }
    free(g->grey);
    free(g->weak_maps);
    free(g->weak_refs);
    free(g->fin_regs);
    free(g->dead_keys);
#if MAL_GC_GENERATIONAL
    free(g->remembered);
#endif
#if MAL_GC_CONCURRENT
    free(g->satb);
#endif
    // Snapshot the stats before freeing so the atexit printer (MAL_GC_STATS) still
    // reports after an explicit teardown; the snapshot's buffer pointers are stale
    // but the printer touches only scalar counters.
    if (g_gc_stats_state == g) {
        if (vm->heap.bytes_allocated > g->allocated_bytes) {
            g->allocated_bytes = vm->heap.bytes_allocated;
        }
        g_gc_stats_snapshot = *g;
        g_gc_stats_state = &g_gc_stats_snapshot;
    }
    free(g);
    vm->gc = nullptr;
    if (g_gc == g) {
        g_gc = nullptr;
        g_gc_vm = nullptr;
    }
}
