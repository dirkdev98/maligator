#include "./gc.h"
#include "./gc_cpu_linux.h"
#include "./gc_process.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if !defined(__wasi__)
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#if defined(__linux__)
#include <sched.h>
#endif
#include "./executor.h"
#endif

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
#include "./set_object.h"
#include "./weak_collection.h"
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

MAL_ISOLATE_LOCAL bool mal_gc_marking_active = false;
/* New cells take the active color and OLD bit through mark and sweep, so a
 * post-snapshot allocation cannot be reclaimed by the in-flight major. */
MAL_ISOLATE_LOCAL bool mal_gc_black_alloc = false;
/* Bytes promoted by allocation during this isolate's majors. */
MAL_ISOLATE_LOCAL usize mal_gc_black_alloc_bytes = 0;

#if defined(__wasi__)
bool mal_gc_poll = false;
#else
static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "GC poll must be signal-safe and lock-free");
MAL_ISOLATE_LOCAL _Atomic bool mal_gc_poll = false;
#endif

MalGcPollTarget *mal_gc_current_poll_target(void) {
    return (MalGcPollTarget *) &mal_gc_poll;
}

#if defined(__wasi__)
bool mal_gc_termination = false;
#else
MAL_ISOLATE_LOCAL _Atomic bool mal_gc_termination = false;
#endif

MalGcTerminationTarget *mal_gc_current_termination_target(void) {
    return (MalGcTerminationTarget *) &mal_gc_termination;
}

void mal_gc_request_termination(MalGcTerminationTarget *termination, MalGcPollTarget *poll) {
    if (termination == nullptr) return;
#if defined(__wasi__)
    *(bool *) termination = true;
#else
    // Release pairs with the mutator's poll: the flag is visible before the poll is.
    atomic_store_explicit((_Atomic bool *) termination, true, memory_order_release);
#endif
    mal_gc_request_safepoint(poll);
}

bool mal_gc_poll_termination(MalVm *vm) {
    if (!mal_gc_termination) return false;
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_THROW, .value = MAL_VALUE_UNDEFINED };
    }
    return true;
}

void mal_gc_request_safepoint(MalGcPollTarget *target) {
    if (target == nullptr) return;
#if defined(__wasi__)
    *(bool *) target = true;
#else
    atomic_store_explicit((_Atomic bool *) target, true, memory_order_release);
#endif
}

MAL_ISOLATE_LOCAL MalRootSpan *mal_root_span_head = nullptr;

/* Preemption hook (docs/decisions/03-wave-0-host-architecture.md). Null in a plain
 * run; the scheduler installs one so a safepoint can yield the running fiber when its reduction
 * budget is exhausted. Called from mal_gc_safepoint, i.e. only where a context
 * switch is safe (roots precise, no un-rooted native frame). */
MAL_ISOLATE_LOCAL void (*mal_gc_preempt_hook)(MalVm *vm) = nullptr;

/* External root sources: how the host/runtime layers contribute GC roots to the
 * engine without the engine knowing their types (e.g. pending setTimeout
 * callbacks). Each is invoked during root scanning and calls mal_gc_mark_value on
 * its live values. Registrations belong to the isolate on the registering mutator
 * and persist across sequential VMs on that thread, so each callback must tolerate
 * an isolate without its host subsystem. */
#define MAL_GC_MAX_ROOT_SOURCES 16
typedef struct MalGcRootSource {
    MalGcRootSourceFn fn;
    void *data;
} MalGcRootSource;
static MAL_ISOLATE_LOCAL MalGcRootSource g_root_sources[MAL_GC_MAX_ROOT_SOURCES];
static MAL_ISOLATE_LOCAL i32 g_root_source_count = 0;

void mal_gc_register_root_source(MalGcRootSourceFn fn, void *data) {
    for (i32 i = 0; i < g_root_source_count; ++i) {
        if (g_root_sources[i].fn == fn && g_root_sources[i].data == data) return;
    }
    if (g_root_source_count == MAL_GC_MAX_ROOT_SOURCES) {
        fprintf(stderr, "[gc] root source capacity exceeded\n");
        abort();
    }
    g_root_sources[g_root_source_count].fn = fn;
    g_root_sources[g_root_source_count].data = data;
    g_root_source_count++;
}

/* Per-type finalizers/tracers name code for a heap type, not isolate state, so the
 * registry is process-wide. Every registration of a type installs the same function;
 * relaxed atomics let another isolate's helper read a slot while a mutator installs it. */
#if defined(__wasi__)
static MalGcFinalizer g_type_finalizers[MAL_HEAP_TYPE_COUNT];
static MalGcTracer g_type_tracers[MAL_HEAP_TYPE_COUNT];
#define mal_gc_type_hook_load(slot) (slot)
#define mal_gc_type_hook_store(slot, fn) ((slot) = (fn))
#else
static _Atomic(MalGcFinalizer) g_type_finalizers[MAL_HEAP_TYPE_COUNT];
static _Atomic(MalGcTracer) g_type_tracers[MAL_HEAP_TYPE_COUNT];
#define mal_gc_type_hook_load(slot) atomic_load_explicit(&(slot), memory_order_relaxed)
#define mal_gc_type_hook_store(slot, fn) \
    atomic_store_explicit(&(slot), (fn), memory_order_relaxed)
#endif

void mal_gc_register_finalizer(MalHeapType type, MalGcFinalizer fn) {
    if ((usize) type < (usize) MAL_HEAP_TYPE_COUNT) {
        mal_gc_type_hook_store(g_type_finalizers[type], fn);
    }
}

void mal_gc_register_tracer(MalHeapType type, MalGcTracer fn) {
    if ((usize) type < (usize) MAL_HEAP_TYPE_COUNT) {
        mal_gc_type_hook_store(g_type_tracers[type], fn);
    }
}

typedef enum MalGcPhase {
    MAL_GC_PHASE_IDLE, // no cycle in flight
    MAL_GC_PHASE_MARK, // incremental grey/SATB draining
    MAL_GC_PHASE_SWEEP, // incremental block sweep
} MalGcPhase;

#if !defined(__wasi__)
#define MAL_GC_WORKER_COUNT 2
usize (*mal_gc_test_worker_limit_hook)(void) = nullptr;
bool (*mal_gc_test_worker_start_failure_hook)(usize index) = nullptr;

static usize mal_gc_native_worker_limit(
    MalGcQuotaStatus *quota_status, bool *quota_complete) {
    *quota_status = MAL_GC_QUOTA_UNKNOWN;
    *quota_complete = false;
    if (mal_gc_test_worker_limit_hook != nullptr) {
        usize requested = mal_gc_test_worker_limit_hook();
        return requested < MAL_GC_WORKER_COUNT ? requested : MAL_GC_WORKER_COUNT;
    }
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    usize cpus = online > 0 ? (usize) online : 1;
#if defined(__linux__)
    cpu_set_t affinity;
    if (sched_getaffinity(0, sizeof(affinity), &affinity) == 0) {
        usize allowed = (usize) CPU_COUNT(&affinity);
        if (allowed > 0 && allowed < cpus) cpus = allowed;
    }
    MalGcCpuQuota quota = mal_gc_linux_cpu_quota(cpus);
    cpus = quota.cpus;
    *quota_status = quota.status;
    *quota_complete = quota.complete;
#endif
    usize spare = cpus > 1 ? cpus - 1 : 0;
    return spare < MAL_GC_WORKER_COUNT ? spare : MAL_GC_WORKER_COUNT;
}

/* One stride of a published batch. Each dispatch submits every slot as a bounded
 * executor job on the process-shared GC helper pool, or traces it inline when the
 * pool cannot accept it. The slot's queue is private until the batch is acknowledged. */
typedef struct MalGcWorker {
    MalGcState *gc;
    MalHeapHeader **discovered;
    usize discovered_count;
    usize discovered_capacity;
    usize index;
    // Test overlap hooks observe helper threads only, never the owner tracing inline.
    bool owner_inline;
    bool helper_granted;
    u64 batch_cpu_ns;
    u64 batch_snapshot_discoveries;
    u64 batch_drain_traces;
} MalGcWorker;
void (*mal_gc_test_trace_env_hook)(MalEnv *env) = nullptr;
void (*mal_gc_test_trace_snapshot_hook)(MalHeapHeader *cell) = nullptr;
void (*mal_gc_test_before_worker_join_hook)(void) = nullptr;
#endif

typedef enum MalGcPauseReason {
    MAL_GC_PAUSE_MINOR,
    MAL_GC_PAUSE_MAJOR_SLICE,
    MAL_GC_PAUSE_EXPLICIT,
    MAL_GC_PAUSE_FINISH_PENDING,
    MAL_GC_PAUSE_BACKSTOP,
    MAL_GC_PAUSE_STRESS_MINOR,
    MAL_GC_PAUSE_STRESS_MAJOR,
    MAL_GC_PAUSE_REASON_COUNT,
} MalGcPauseReason;

typedef struct MalGcLatency {
    u64 bins[10];
    u64 max_ns;
} MalGcLatency;

static const u64 mal_gc_latency_bounds_ns[] = {
    10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
};

static const char *const mal_gc_latency_bin_names[] = {
    "0to10us", "10to25us", "25to50us", "50to100us", "100to250us",
    "250to500us", "500to1000us", "1000to2500us", "2500to5000us", "ge5000us",
};

static const char *const mal_gc_pause_reason_names[MAL_GC_PAUSE_REASON_COUNT] = {
    "minor", "major_slice", "explicit", "finish_pending", "backstop",
    "stress_minor", "stress_major",
};

struct MalGcState {
    MalVm *vm;
    MalGcProcessParticipant *process;
    bool process_pressure;
    // Grey worklist (explicit, no recursion): shaded-but-not-yet-traced cells.
    MalHeapHeader **grey;
    usize grey_count;
    usize grey_capacity;
    MalHeapHeader **batch;
    usize batch_capacity;
    MalGcQuotaStatus worker_quota_status;
    bool worker_quota_complete;
#if !defined(__wasi__)
    MalValue *batch_edges;
    usize batch_edges_capacity;
    usize batch_edges_count;
    usize *batch_edge_offsets;
    usize *batch_edge_counts;
    usize batch_edge_meta_capacity;
    MalExecutorClient helpers;
    // The owning mutator's poll flag; helpers request safepoints only through it.
    MalGcPollTarget *poll_target;
    pthread_mutex_t worker_mutex;
    pthread_cond_t worker_done;
    MalGcWorker workers[MAL_GC_WORKER_COUNT];
    usize worker_limit;
    // Batch stride: slots admitted at first use, independent of helper thread count.
    usize workers_created;
    usize workers_pending;
    usize worker_batch_count;
    bool worker_batch_active;
    bool worker_batch_concurrent;
    bool worker_batch_drain;
    bool worker_sync_initialized;
#endif

    // WeakSet members are cleaned only after the WeakMap ephemeron fixpoint.
    MalWeakSetObject **weak_sets;
    usize weak_sets_count;
    usize weak_sets_capacity;

    MalWeakMapObject **weak_maps;
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

    // Remembered set: old cells written with a young pointer since
    // the last collection (the card barrier records them). Rebuilt every collection.
    MalHeapHeader **remembered;
    usize remembered_count;
    usize remembered_capacity;
    // One in every major_every collections (and the first) is a full major.
    u32 collection_index;

    // The bounded SATB buffer holds deletion-barrier values until a mark step or
    // full-batch mark claim transfers them to the grey queue.
    MalValue *satb;
    usize satb_count;
    usize satb_capacity;
    usize satb_drained;
    u64 satb_flushes;
    usize satb_high_water;

    // Incremental-cycle state machine (driven from mal_gc_safepoint).
    MalGcPhase phase;
    bool major_collection;
    // bytes_allocated at which an in-flight cycle must finish synchronously (the
    // hard backstop = the old STW trigger). Degrade-to-STW, never OOM.
    usize backstop_at;
    // bytes_allocated at the previous mark step, for the assist budget.
    usize bytes_at_last_step;
    usize last_major_live_bytes;
    usize promotion_debt;
    u64 promoted_bytes;

    // --- Config (read once from env in mal_gc_init) ---------------------------
    // Stress mode (MAL_GC_STRESS=N): collect every N gated safepoints.
    i32 stress_interval;
    i32 stress_counter;
    bool verify_enabled;
    bool stats_enabled;
    u32 major_every; // MAL_GC_MAJOR_EVERY
    // Assist ratio (MAL_GC_ASSIST): grey/SATB entries traced per byte allocated
    // since the last mark step, so marking outruns allocation.
    u32 assist;

    // --- Per-collection statistics (MAL_GC_STATS=1) ---------------------------
    u64 collections;
    u64 minor_count;
    u64 major_count;
    u64 pause_count;
    u64 total_ns;
    u64 max_pause_ns;
    u64 minor_pause_ns;
    u64 max_minor_pause_ns;
    MalGcLatency pause_latency[MAL_GC_PAUSE_REASON_COUNT];
    MalGcLatency mark_step_latency;
    u64 minor_mark_ns;
    u64 minor_sweep_ns;
    u64 minor_cells_inspected;
    u64 minor_blocks_inspected;
    u64 minor_remembered_owners;
    u64 minor_remembered_container_slots;
    u64 minor_remembered_discoveries;
    u64 minor_remembered_array_owners;
    u64 minor_remembered_array_slots;
    u64 minor_remembered_array_discoveries;
    u64 minor_remembered_map_owners;
    u64 minor_remembered_map_slots;
    u64 minor_remembered_map_discoveries;
    usize peak_live_bytes;
    usize allocated_bytes;
    MalHeapUsage heap_usage_before_teardown;
    u64 compiled_root_slots_scanned;
    u64 compiled_root_slots_skipped;
    u64 cycles; // incremental major cycles started
    u64 sync_backstop; // cycles that had to finish synchronously
    u64 init_mark_ns; // last init-mark pause
    u64 remark_ns; // last remark pause
    u64 max_mark_step_ns; // largest single mark step
    u64 major_array_trace_slots;
    u64 major_array_trace_ns;
    u64 max_major_array_trace_ns;
    u32 max_major_array_trace_slots;
    bool in_mark_step;
    u64 max_sweep_step_ns; // largest single sweep step
    u64 worker_traces;
    u64 worker_drain_traces;
    u64 minor_worker_batches;
    u64 minor_worker_traces;
    u64 minor_worker_cpu_ns;
    u64 concurrent_batches;
    u64 concurrent_traces;
    u64 concurrent_env_traces;
    u64 concurrent_discoveries;
    u64 concurrent_handoffs;
    u64 snapshot_traces;
    u64 snapshot_examined_values;
    u64 snapshot_values;
    u64 snapshot_heap_values;
    u64 snapshot_discoveries;
    u64 snapshot_only_batches;
    u64 snapshot_copy_ns;
    u64 snapshot_admit_ns;
    u64 snapshot_reserve_ns;
    u64 snapshot_inline_ns;
    u64 worker_merge_ns;
    u64 worker_wait_ns;
    u64 remark_wait_ns;
    u64 remark_join_ns;
    u64 worker_cpu_ns;
    u64 concurrent_worker_cpu_ns;
    u64 mutator_assist_traces;
    u64 weak_entry_visits;
    u64 weak_cleanup_visits;
    u64 weak_activated_values;
    u64 weak_pending_links_visited;
    usize weak_pending_peak_bytes;
    u64 weak_pass_ns;
};

#if !defined(__wasi__)
static void mal_gc_workers_stop(MalGcState *g);
#endif

/* Marking helpers and SATB barriers use the active VM throughout its lifetime. */
typedef struct MalGcThreadContext {
    MalVm *vm;
    MalGcState *gc;
    struct MalGcWorker *trace_worker;
    bool verifying;
    /* Type of the cell the verifier is re-tracing, so a freed-target abort names the
     * owner whose edge was missed; -1 while scanning roots. */
    i32 verify_source;
} MalGcThreadContext;
#if defined(__wasi__)
static MalGcThreadContext g_gc_thread = {.verify_source = -1};
#else
/* A worker binds its owning isolate before tracing and cannot borrow the mutator's context.
 * One thread-local keeps shading to a single TLV lookup on Darwin. */
static _Thread_local MalGcThreadContext g_gc_thread = {.verify_source = -1};
#endif
#define g_gc_vm (g_gc_thread.vm)
#define g_gc (g_gc_thread.gc)
#define g_trace_worker (g_gc_thread.trace_worker)
#define g_gc_verifying (g_gc_thread.verifying)
#define g_gc_verify_source (g_gc_thread.verify_source)
/* Process stats reporting (atexit printer, MAL_GC_CONTROL SIGUSR1) belongs to one
 * stats owner: the first stats-enabled isolate, or a later one after the previous
 * owner's teardown. Points at the owner's live vm->gc, and at g_gc_stats_snapshot
 * after teardown so the exit report survives an explicit mal_vm_free. The printer
 * reads only scalar stat fields, so the snapshot's stale buffer pointers are never
 * dereferenced. Ownership changes under g_gc_stats_mutex. */
static MalGcState g_gc_stats_snapshot;
static MalGcState *g_gc_stats_state = nullptr;
static volatile sig_atomic_t g_gc_stats_snapshot_requested = 0;
static bool g_gc_stats_atexit_registered = false;
static MAL_ISOLATE_LOCAL bool g_gc_stats_owner = false;
#if !defined(__wasi__)
static pthread_mutex_t g_gc_stats_mutex = PTHREAD_MUTEX_INITIALIZER;
static bool g_gc_stats_signal_installed = false;
static struct sigaction g_gc_stats_previous_signal_action;
/* The process signal targets the stats owner's mutator, whichever thread receives it. */
static MalGcPollTarget *_Atomic g_gc_stats_poll_target = nullptr;

static void mal_gc_request_stats_snapshot(int signal_number) {
    (void) signal_number;
    g_gc_stats_snapshot_requested = 1;
    mal_gc_request_safepoint(
        atomic_load_explicit(&g_gc_stats_poll_target, memory_order_relaxed));
}

#endif

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

#if !defined(__wasi__)
// Keep queue growth out of the mark probe's register-save prologue.
__attribute__((noinline))
#endif
static void mal_gc_grey_push(MalHeapHeader *cell) {
#if !defined(__wasi__)
    if (g_trace_worker != nullptr) {
        MalGcWorker *worker = g_trace_worker;
        if (worker->discovered_count == worker->discovered_capacity) {
            usize capacity = worker->discovered_capacity == 0
                ? 256 : worker->discovered_capacity * 2;
            MalHeapHeader **cells = realloc(worker->discovered,
                capacity * sizeof(MalHeapHeader *));
            if (cells == nullptr) abort();
            worker->discovered = cells;
            worker->discovered_capacity = capacity;
        }
        worker->discovered[worker->discovered_count++] = cell;
        return;
    }
#endif
    if (g_gc->grey_count == g_gc->grey_capacity) {
        g_gc->grey_capacity = g_gc->grey_capacity == 0 ? 4096 : g_gc->grey_capacity * 2;
        g_gc->grey = realloc(g_gc->grey, g_gc->grey_capacity * sizeof(MalHeapHeader *));
        if (g_gc->grey == nullptr) abort();
    }
    g_gc->grey[g_gc->grey_count++] = cell;
}

static void mal_gc_register_weak_map(MalWeakMapObject *map) {
    if (g_gc->weak_maps_count == g_gc->weak_maps_capacity) {
        usize capacity = g_gc->weak_maps_capacity == 0 ? 64 : g_gc->weak_maps_capacity * 2;
        MalWeakMapObject **maps = realloc(g_gc->weak_maps, capacity * sizeof(MalWeakMapObject *));
        if (maps == nullptr) abort();
        g_gc->weak_maps = maps;
        g_gc->weak_maps_capacity = capacity;
    }
    g_gc->weak_maps[g_gc->weak_maps_count++] = map;
}

static void mal_gc_register_weak_set(MalWeakSetObject *set) {
    if (g_gc->weak_sets_count == g_gc->weak_sets_capacity) {
        usize capacity = g_gc->weak_sets_capacity == 0 ? 64 : g_gc->weak_sets_capacity * 2;
        MalWeakSetObject **sets = realloc(g_gc->weak_sets, capacity * sizeof(MalWeakSetObject *));
        if (sets == nullptr) abort();
        g_gc->weak_sets = sets;
        g_gc->weak_sets_capacity = capacity;
    }
    g_gc->weak_sets[g_gc->weak_sets_count++] = set;
}

static void mal_gc_register_weak_ref(MalWeakRefObject *ref) {
    if (g_gc->weak_refs_count == g_gc->weak_refs_capacity) {
        usize capacity = g_gc->weak_refs_capacity == 0 ? 64 : g_gc->weak_refs_capacity * 2;
        MalWeakRefObject **refs = realloc(g_gc->weak_refs, capacity * sizeof(MalWeakRefObject *));
        if (refs == nullptr) abort();
        g_gc->weak_refs = refs;
        g_gc->weak_refs_capacity = capacity;
    }
    g_gc->weak_refs[g_gc->weak_refs_count++] = ref;
}

static void mal_gc_register_fin_reg(MalFinalizationRegistryObject *reg) {
    if (g_gc->fin_regs_count == g_gc->fin_regs_capacity) {
        usize capacity = g_gc->fin_regs_capacity == 0 ? 32 : g_gc->fin_regs_capacity * 2;
        MalFinalizationRegistryObject **regs = realloc(g_gc->fin_regs,
            capacity * sizeof(MalFinalizationRegistryObject *));
        if (regs == nullptr) abort();
        g_gc->fin_regs = regs;
        g_gc->fin_regs_capacity = capacity;
    }
    g_gc->fin_regs[g_gc->fin_regs_count++] = reg;
}

#define MAL_GC_SATB_BATCH_CAPACITY 4096

void mal_gc_satb_record(MalValue old_value) {
    if (!mal_value_is_heap(old_value)) {
        return;
    }
    MalHeapHeader *cell = mal_value_to_heap(old_value);
    if (cell->storage == MAL_HEAP_STORAGE_IMMORTAL ||
        mal_heap_mark_is_current(cell->mark, g_gc_vm->heap.mark_color)) {
        return;
    }
    if (g_gc->satb_capacity == 0) {
        g_gc->satb = malloc(MAL_GC_SATB_BATCH_CAPACITY * sizeof(MalValue));
        if (g_gc->satb == nullptr) abort();
        g_gc->satb_capacity = MAL_GC_SATB_BATCH_CAPACITY;
    } else if (g_gc->satb_count == g_gc->satb_capacity) {
        for (usize i = g_gc->satb_drained; i < g_gc->satb_count; ++i) {
            mal_gc_mark_value(g_gc->satb[i]);
        }
        g_gc->satb_count = 0;
        g_gc->satb_drained = 0;
        g_gc->satb_flushes++;
        mal_gc_poll = true;
    }
    if (mal_heap_mark_is_current(cell->mark, g_gc_vm->heap.mark_color)) return;
    g_gc->satb[g_gc->satb_count++] = old_value;
    if (g_gc->satb_count > g_gc->satb_high_water) {
        g_gc->satb_high_water = g_gc->satb_count;
    }
}

static void mal_gc_record_latency(MalGcLatency *latency, u64 elapsed_ns) {
    usize bin = 0;
    while (bin < countof(mal_gc_latency_bounds_ns) &&
           elapsed_ns >= mal_gc_latency_bounds_ns[bin]) {
        bin++;
    }
    latency->bins[bin]++;
    if (elapsed_ns > latency->max_ns) latency->max_ns = elapsed_ns;
}

static void mal_gc_print_latency(const char *name, const MalGcLatency *latency) {
    for (usize i = 0; i < countof(latency->bins); ++i) {
        fprintf(stderr, " %s_%s=%llu", name, mal_gc_latency_bin_names[i],
            (unsigned long long) latency->bins[i]);
    }
    fprintf(stderr, " %s_max_ns=%llu", name, (unsigned long long) latency->max_ns);
}

static void mal_gc_print_stats_now(void) {
    MalGcState *g = g_gc_stats_state;
    if (g == nullptr) {
        return;
    }
    usize allocated_bytes = g_gc_vm != nullptr && g_gc_vm->gc == g
        ? g_gc_vm->heap.bytes_allocated
        : g->allocated_bytes;
    bool live_heap = g_gc_vm != nullptr && g_gc_vm->gc == g;
    MalHeapUsage usage = live_heap
        ? mal_heap_usage(&g_gc_vm->heap) : g->heap_usage_before_teardown;
    usize worker_limit = 0;
#if !defined(__wasi__)
    worker_limit = g->worker_limit;
#endif
    fprintf(stderr,
            "[gc-stats] collections=%llu minor=%llu major=%llu pauses=%llu total_ms=%.3f "
            "max_pause_ms=%.3f peak_live_bytes=%llu allocated_bytes=%llu "
            "compiled_root_slots_scanned=%llu compiled_root_slots_skipped=%llu "
            "object_slot_coallocations=%llu object_slot_grow_migrations=%llu "
            "object_slot_dictionary_migrations=%llu stack_object_materializations=%llu",
            (unsigned long long) g->collections, (unsigned long long) g->minor_count,
            (unsigned long long) g->major_count, (unsigned long long) g->pause_count,
            (double) g->total_ns / 1.0e6,
            (double) g->max_pause_ns / 1.0e6, (unsigned long long) g->peak_live_bytes,
            (unsigned long long) allocated_bytes,
            (unsigned long long) g->compiled_root_slots_scanned,
            (unsigned long long) g->compiled_root_slots_skipped,
            (unsigned long long) mal_object_slot_coallocation_count(),
            (unsigned long long) mal_object_slot_grow_migration_count(),
            (unsigned long long) mal_object_slot_dictionary_migration_count(),
            (unsigned long long) mal_vm_stack_object_materialization_count());
    fprintf(stderr,
            " cycles=%llu sync_backstop=%llu over_tenure_bytes=%llu "
            "promoted_bytes=%llu promotion_debt=%llu last_major_live_bytes=%llu "
            "satb_flushes=%llu satb_high_water=%llu "
            "init_mark_ms=%.3f remark_ms=%.3f max_mark_step_ms=%.3f "
            "major_array_trace_slots=%llu major_array_trace_ms=%.3f "
            "max_major_array_trace_ms=%.3f max_major_array_trace_slots=%u "
            "max_sweep_step_ms=%.3f "
            "minor_pause_ms=%.3f max_minor_pause_ms=%.3f "
            "minor_mark_ms=%.3f minor_sweep_ms=%.3f "
            "minor_cells_inspected=%llu minor_blocks_inspected=%llu "
            "remembered_owners=%llu remembered_container_slots=%llu "
            "remembered_discoveries=%llu remembered_array_owners=%llu "
            "remembered_array_slots=%llu remembered_array_discoveries=%llu "
            "remembered_map_owners=%llu remembered_map_slots=%llu "
            "remembered_map_discoveries=%llu "
            "worker_traces=%llu worker_drain_traces=%llu "
            "minor_worker_batches=%llu minor_worker_traces=%llu "
            "minor_worker_cpu_ms=%.3f "
            "concurrent_batches=%llu concurrent_traces=%llu "
            "concurrent_env_traces=%llu concurrent_discoveries=%llu "
            "concurrent_handoffs=%llu "
            "worker_limit=%llu worker_cpu_ms=%.3f concurrent_worker_cpu_ms=%.3f "
            "mutator_assist_traces=%llu "
            "snapshot_traces=%llu snapshot_examined_values=%llu "
            "snapshot_values=%llu snapshot_heap_values=%llu "
            "snapshot_discoveries=%llu snapshot_only_batches=%llu "
            "snapshot_admit_ms=%.3f snapshot_reserve_ms=%.3f "
            "snapshot_copy_ms=%.3f snapshot_inline_ms=%.3f "
            "worker_merge_ms=%.3f worker_wait_ms=%.3f "
            "remark_wait_ms=%.3f remark_join_ms=%.3f",
            (unsigned long long) g->cycles, (unsigned long long) g->sync_backstop,
            (unsigned long long) mal_gc_black_alloc_bytes,
            (unsigned long long) g->promoted_bytes,
            (unsigned long long) g->promotion_debt,
            (unsigned long long) g->last_major_live_bytes,
            (unsigned long long) g->satb_flushes,
            (unsigned long long) g->satb_high_water,
            (double) g->init_mark_ns / 1.0e6, (double) g->remark_ns / 1.0e6,
            (double) g->max_mark_step_ns / 1.0e6,
            (unsigned long long) g->major_array_trace_slots,
            (double) g->major_array_trace_ns / 1.0e6,
            (double) g->max_major_array_trace_ns / 1.0e6,
            g->max_major_array_trace_slots, (double) g->max_sweep_step_ns / 1.0e6,
            (double) g->minor_pause_ns / 1.0e6,
            (double) g->max_minor_pause_ns / 1.0e6,
            (double) g->minor_mark_ns / 1.0e6,
            (double) g->minor_sweep_ns / 1.0e6,
            (unsigned long long) g->minor_cells_inspected,
            (unsigned long long) g->minor_blocks_inspected,
            (unsigned long long) g->minor_remembered_owners,
            (unsigned long long) g->minor_remembered_container_slots,
            (unsigned long long) g->minor_remembered_discoveries,
            (unsigned long long) g->minor_remembered_array_owners,
            (unsigned long long) g->minor_remembered_array_slots,
            (unsigned long long) g->minor_remembered_array_discoveries,
            (unsigned long long) g->minor_remembered_map_owners,
            (unsigned long long) g->minor_remembered_map_slots,
            (unsigned long long) g->minor_remembered_map_discoveries,
            (unsigned long long) g->worker_traces,
            (unsigned long long) g->worker_drain_traces,
            (unsigned long long) g->minor_worker_batches,
            (unsigned long long) g->minor_worker_traces,
            (double) g->minor_worker_cpu_ns / 1.0e6,
            (unsigned long long) g->concurrent_batches,
            (unsigned long long) g->concurrent_traces,
            (unsigned long long) g->concurrent_env_traces,
            (unsigned long long) g->concurrent_discoveries,
            (unsigned long long) g->concurrent_handoffs,
            (unsigned long long) worker_limit,
            (double) g->worker_cpu_ns / 1.0e6,
            (double) g->concurrent_worker_cpu_ns / 1.0e6,
            (unsigned long long) g->mutator_assist_traces,
            (unsigned long long) g->snapshot_traces,
            (unsigned long long) g->snapshot_examined_values,
            (unsigned long long) g->snapshot_values,
            (unsigned long long) g->snapshot_heap_values,
            (unsigned long long) g->snapshot_discoveries,
            (unsigned long long) g->snapshot_only_batches,
            (double) g->snapshot_admit_ns / 1.0e6,
            (double) g->snapshot_reserve_ns / 1.0e6,
            (double) g->snapshot_copy_ns / 1.0e6,
            (double) g->snapshot_inline_ns / 1.0e6,
            (double) g->worker_merge_ns / 1.0e6,
            (double) g->worker_wait_ns / 1.0e6,
            (double) g->remark_wait_ns / 1.0e6,
            (double) g->remark_join_ns / 1.0e6);
    fprintf(stderr,
            " weak_entry_visits=%llu weak_cleanup_visits=%llu "
            "weak_activated_values=%llu weak_pending_links_visited=%llu "
            "weak_pending_peak_bytes=%llu weak_pass_ms=%.3f",
            (unsigned long long) g->weak_entry_visits,
            (unsigned long long) g->weak_cleanup_visits,
            (unsigned long long) g->weak_activated_values,
            (unsigned long long) g->weak_pending_links_visited,
            (unsigned long long) g->weak_pending_peak_bytes,
            (double) g->weak_pass_ns / 1.0e6);
    const char *quota_status = g->worker_quota_status == MAL_GC_QUOTA_LIMITED ? "limited" :
        g->worker_quota_status == MAL_GC_QUOTA_UNLIMITED ? "unlimited" : "unknown";
    fprintf(stderr, " worker_quota_status=%s worker_quota_complete=%d",
        quota_status, g->worker_quota_complete);
    usize snapshot_reserved_bytes = 0;
#if !defined(__wasi__)
    snapshot_reserved_bytes = g->batch_edges_capacity * sizeof(MalValue) +
        g->batch_edge_meta_capacity * 2 * sizeof(usize);
#endif
    fprintf(stderr,
        " heap_usage_at=%s raw_owned_bytes=%llu managed_free_cell_bytes=%llu "
        "raw_free_cell_bytes=%llu raw_warm_block_bytes=%llu bump_free_bytes=%llu recycled_block_bytes=%llu "
        "unclaimed_chunk_bytes=%llu chunk_mapped_bytes=%llu "
        "snapshot_reserved_bytes=%llu",
        live_heap ? "live" : "pre_teardown",
        (unsigned long long) usage.raw_owned_bytes,
        (unsigned long long) usage.managed_free_cell_bytes,
        (unsigned long long) usage.raw_free_cell_bytes,
        (unsigned long long) usage.raw_warm_block_bytes,
        (unsigned long long) usage.bump_free_bytes,
        (unsigned long long) usage.recycled_block_bytes,
        (unsigned long long) usage.unclaimed_chunk_bytes,
        (unsigned long long) usage.chunk_mapped_bytes,
        (unsigned long long) snapshot_reserved_bytes);
    for (usize i = 0; i < MAL_GC_PAUSE_REASON_COUNT; ++i) {
        char name[48];
        snprintf(name, sizeof(name), "pause_%s", mal_gc_pause_reason_names[i]);
        mal_gc_print_latency(name, &g->pause_latency[i]);
    }
    mal_gc_print_latency("mark_step", &g->mark_step_latency);
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

static void mal_gc_print_stats_at_exit(void) {
    mal_gc_print_stats_now();
}

static void mal_gc_stats_claim(MalGcState *g) {
#if !defined(__wasi__)
    pthread_mutex_lock(&g_gc_stats_mutex);
#endif
    if (g_gc_stats_state == nullptr || g_gc_stats_state == &g_gc_stats_snapshot) {
        g_gc_stats_state = g;
        g_gc_stats_owner = true;
        if (!g_gc_stats_atexit_registered) {
            if (atexit(mal_gc_print_stats_at_exit) != 0) abort();
            g_gc_stats_atexit_registered = true;
        }
#if !defined(__wasi__)
        atomic_store_explicit(&g_gc_stats_poll_target, g->poll_target, memory_order_relaxed);
        if (getenv("MAL_GC_CONTROL") != nullptr && !g_gc_stats_signal_installed) {
            struct sigaction action = {0};
            action.sa_handler = mal_gc_request_stats_snapshot;
            sigemptyset(&action.sa_mask);
            action.sa_flags = SA_RESTART;
            if (sigaction(SIGUSR1, &action, &g_gc_stats_previous_signal_action) == 0) {
                g_gc_stats_signal_installed = true;
            }
        }
#endif
    }
#if !defined(__wasi__)
    pthread_mutex_unlock(&g_gc_stats_mutex);
#endif
}

static void mal_gc_stats_release(MalVm *vm, MalGcState *g) {
    if (!g_gc_stats_owner) return;
#if !defined(__wasi__)
    pthread_mutex_lock(&g_gc_stats_mutex);
#endif
    if (g_gc_stats_state == g) {
        if (vm->heap.bytes_allocated > g->allocated_bytes) {
            g->allocated_bytes = vm->heap.bytes_allocated;
        }
        g_gc_stats_snapshot = *g;
        g_gc_stats_state = &g_gc_stats_snapshot;
    }
    g_gc_stats_owner = false;
#if !defined(__wasi__)
    atomic_store_explicit(&g_gc_stats_poll_target, nullptr, memory_order_relaxed);
    if (g_gc_stats_signal_installed) {
        sigaction(SIGUSR1, &g_gc_stats_previous_signal_action, nullptr);
        g_gc_stats_signal_installed = false;
        g_gc_stats_snapshot_requested = 0;
    }
    pthread_mutex_unlock(&g_gc_stats_mutex);
#endif
}

u64 mal_gc_allocated_bytes(MalVm *vm) {
    return vm->heap.bytes_allocated;
}

u64 mal_gc_collection_count(MalVm *vm) {
    return vm->gc == nullptr ? 0 : vm->gc->collections;
}

#if !defined(__wasi__)
usize mal_gc_worker_limit(MalVm *vm) {
    return vm->gc == nullptr ? 0 : vm->gc->worker_limit;
}
#endif

/* Auto-collection heap-growth policy: the first collection fires once this many
 * bytes have been allocated; after each one the next trigger is set past the
 * surviving set by at least this floor (so a small live set cannot thrash). */
#define MAL_GC_DEFAULT_THRESHOLD ((usize) 16 * 1024 * 1024)
#define MAL_GC_MIN_INCREMENT ((usize) 4 * 1024 * 1024)

void mal_gc_init(MalVm *vm) {
    if (getenv("MAL_GC_GENERATIONAL") != nullptr ||
        getenv("MAL_GC_CONCURRENT") != nullptr ||
        getenv("MAL_GC_MODE") != nullptr ||
        getenv("MAL_GC_OFF") != nullptr) {
        fprintf(stderr, "GC mode flags were removed; Maligator uses one generational collector\n");
        abort();
    }
    MalGcState *g = calloc(1, sizeof(MalGcState));
    if (g == nullptr) abort();
    vm->gc = g;
    g->vm = vm;
    g->process = mal_gc_process_register(mal_gc_current_poll_target());
#if !defined(__wasi__)
    g->worker_limit = mal_gc_native_worker_limit(
        &g->worker_quota_status, &g->worker_quota_complete);
    g->poll_target = mal_gc_current_poll_target();
#endif
    g_gc = g;
    g_gc_vm = vm;
    mal_gc_marking_active = false;
    mal_gc_black_alloc = false;
    mal_gc_poll = false;
    mal_perf_stats_init();
    g->major_every = 8;
    g->phase = MAL_GC_PHASE_IDLE;
    g->assist = 4; // grey/SATB entries traced per byte allocated since the last step
    const char *assist = getenv("MAL_GC_ASSIST");
    if (assist != nullptr && assist[0] != '\0') {
        unsigned long v = strtoul(assist, nullptr, 10);
        if (v >= 1) {
            g->assist = (u32) v;
        }
    }
    const char *stress = getenv("MAL_GC_STRESS");
    if (stress != nullptr && stress[0] != '\0' && stress[0] != '0') {
        g->stress_interval = atoi(stress);
        if (g->stress_interval < 1) {
            g->stress_interval = 1;
        }
        mal_gc_poll = true; // make the next loop/call safepoint collect
    }
    g->verify_enabled = getenv("MAL_GC_VERIFY") != nullptr;

    if (getenv("MAL_GC_STATS") != nullptr) {
        g->stats_enabled = true;
        mal_gc_stats_claim(g);
    }

    const char *major_every = getenv("MAL_GC_MAJOR_EVERY");
    if (major_every != nullptr) {
        unsigned long v = strtoul(major_every, nullptr, 10);
        if (v >= 1) {
            g->major_every = (u32) v;
        }
    }
}

void mal_gc_configure_heap(MalVm *vm) {
    MalGcState *g = vm->gc;
    vm->heap.gc_stats = g->stats_enabled;
    if (g->stress_interval == 0) {
        const char *threshold = getenv("MAL_GC_THRESHOLD");
        vm->heap.next_gc_at = threshold != nullptr
            ? (usize) strtoull(threshold, nullptr, 10)
            : MAL_GC_DEFAULT_THRESHOLD;
        if (vm->heap.next_gc_at == 0) {
            vm->heap.next_gc_at = 1;
        }
    }
    // Poisoning dead cells makes a missed root fail before the cell is reused.
    vm->heap.poison_on_free = g->verify_enabled;
}

void mal_gc_begin_teardown(MalVm *vm) {
    MalGcState *g = vm->gc;
    if (g == nullptr) {
        return;
    }
    if (g_gc != g || g_gc_vm != vm) abort();
#if !defined(__wasi__)
    mal_gc_workers_stop(g);
#endif
    mal_gc_process_unregister(g->process);
    g->process = nullptr;
    if (g->stats_enabled) g->heap_usage_before_teardown = mal_heap_usage(&vm->heap);
    // Teardown invalidates published roots, so abandon any unfinished snapshot.
    g->phase = MAL_GC_PHASE_IDLE;
    g->stress_interval = 0;
    g->grey_count = 0;
    g->satb_count = 0;
    mal_gc_marking_active = false;
    mal_gc_black_alloc = false;
    mal_gc_poll = false;
    vm->heap.next_gc_at = (usize) -1;
}

void mal_gc_set_mutator_busy(MalVm *vm, bool busy) {
    if (vm->gc != nullptr) mal_gc_process_set_busy(vm->gc->process, busy);
}

void mal_gc_set_mutator_waker(MalVm *vm, void (*wake)(void *), void *data) {
    if (vm->gc != nullptr) mal_gc_process_set_waker(vm->gc->process, wake, data);
}

// ---------------------------------------------------------------------------
// Non-moving mark/sweep collector.
//
// Tri-color marking with an explicit grey worklist (no recursion): roots are
// shaded grey, then drained, tracing each cell's outgoing edges. The header mark
// field is the colour. A non-moving sweep then finalizes and reclaims unreached
// cells. Shapes and closure environments are traced through; shapes are not GC
// cells (malloc'd directly), so they are never marked or swept.
// Incremental major mark + sweep are sliced across safepoints; see the cycle
// state machine at the bottom of the file.
// ---------------------------------------------------------------------------

/** Shade a cell grey: a managed, non-immortal cell reached for the first time.
 * In verify mode it instead asserts the cell is already marked — a reachable but
 * unmarked cell means a trace edge was missed. */
static void mal_gc_shade(MalHeapHeader *cell) {
    if (cell == nullptr || cell->storage == MAL_HEAP_STORAGE_IMMORTAL) {
        return;
    }
    if (g_gc_verifying) {
        if (cell->mark & MAL_MARK_FREE) {
            fprintf(stderr, "[gc verify] live cell (source type=%d) points to a freed "
                "cell type=%d: a root or trace edge was missed, the target was swept "
                "while still reachable\n", g_gc_verify_source, cell->type);
            abort();
        }
        return;
    }
#if defined(__wasi__)
    u8 mark = cell->mark;
    if (mark & MAL_MARK_FREE) {
        fprintf(stderr, "[gc] attempted to shade a reclaimed cell\n");
        abort();
    }
    if (g_gc->major_collection) {
        if (mal_heap_mark_is_current(mark, g_gc_vm->heap.mark_color)) return;
        cell->mark = (mark & ~MAL_MARK_COLOR) | g_gc_vm->heap.mark_color;
    } else {
        if (mal_heap_mark_is_old(mark)) return;
        cell->mark = mark | MAL_MARK_OLD;
    }
#else
    u8 expected = atomic_load_explicit(&cell->mark, memory_order_relaxed);
    for (;;) {
        if (expected & MAL_MARK_FREE) {
            fprintf(stderr, "[gc] attempted to shade a reclaimed cell\n");
            abort();
        }
        u8 desired;
        if (g_gc->major_collection) {
            if (mal_heap_mark_is_current(expected, g_gc_vm->heap.mark_color)) return;
            desired = (expected & ~MAL_MARK_COLOR) | g_gc_vm->heap.mark_color;
        } else {
            if (mal_heap_mark_is_old(expected)) return;
            // Minors park the mutator and never dispatch workers, so no other
            // thread can compete for this young cell's mark.
            atomic_store_explicit(&cell->mark, expected | MAL_MARK_OLD,
                memory_order_relaxed);
            break;
        }
        if (atomic_compare_exchange_weak_explicit(&cell->mark, &expected, desired,
                memory_order_relaxed, memory_order_relaxed)) break;
    }
#endif
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
    if (cell->storage == MAL_HEAP_STORAGE_IMMORTAL) return true;
    u8 mark = cell->mark;
    return g_gc->major_collection
        ? mal_heap_mark_is_current(mark, g_gc_vm->heap.mark_color)
        : mal_heap_mark_is_old(mark);
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
        MalPropertyDesc desc = mal_property_entry_desc(table, entry);
        mal_gc_mark_value(desc.value);
        mal_gc_mark_value(desc.getter);
        mal_gc_mark_value(desc.setter);
    }
}

static void mal_gc_trace_map(MalMapStorage *storage) {
    MalMapKeyDomain domain = mal_map_storage_key_domain(storage);
    bool trace_keys = domain != MAL_MAP_KEYS_INT32 && domain != MAL_MAP_KEYS_NUMBER;
    MalMapIter iter;
    mal_map_iter_init(&iter, storage);
    MalValue key, value;
    while (mal_map_iter_next(&iter, &key, &value)) {
        if (trace_keys) mal_gc_mark_value(key);
        mal_gc_mark_value(value);
    }
}

// Active frames and exact complete-chain closures own their lexical links.
// Tagged/display captures own selected lexical state only; the owners' parent
// pointers may be stale after the frame exits and must not be followed.
static void mal_gc_trace_env(MalEnv *env) {
    for (; env != nullptr; env = env->parent) {
        if (mal_env_is_single_owner(env)) {
            mal_gc_shade(&mal_env_untag_single_owner(env)->header);
            return;
        }
        if (mal_env_is_capture_display(env)) {
            mal_gc_shade((MalHeapHeader *) env->parent);
            return;
        }
        mal_gc_shade(&env->header);
        if (!env->compact_parent) return;
    }
}

void mal_gc_satb_record_env(MalEnv *env) {
    for (; env != nullptr; env = env->parent) {
        if (mal_env_is_single_owner(env)) {
            mal_gc_satb_record(mal_value_from_heap(&mal_env_untag_single_owner(env)->header));
            return;
        }
        if (mal_env_is_capture_display(env)) {
            mal_gc_satb_record(mal_value_from_heap((MalHeapHeader *) env->parent));
            return;
        }
        mal_gc_satb_record(mal_value_from_heap(&env->header));
        if (!env->compact_parent) return;
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
    if (!frame->is_compiled && mal_gc_visit_exact_frame_registers(frame, visit)) {
        return;
    }
    for (i32 register_index = 0;
         register_index < (frame->is_compiled
             ? frame->compiled_register_count : frame->function->register_count);
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
 * is active (call sites gate on mal_gc_marking_active). Compact lexical links are
 * frame-owned edges, so record the full chain before the frame disappears. */
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
    mal_gc_satb_record_env(frame->env);
}

/** Common edges of every MalObject-based cell: prototype, inline slots, overflow.
 * The shape tree is malloc-owned, but its property atoms are heap strings, so
 * they are marked here through both owning objects and the heap root scan. */
static void mal_gc_trace_object_common(MalObject *object) {
    mal_gc_mark_object(mal_object_prototype(object));
    const MalShape *shape = object->shape;
    for (u32 i = 0; i < shape->inline_count; ++i) {
        mal_gc_mark_value(shape->props[i].key);
    }
    const void *fields = mal_object_fields(object);
    if (fields != nullptr) {
        u64 heap_fields = shape->heap_fields;
        while (heap_fields != 0) {
            u32 ordinal = (u32) __builtin_ctzll(heap_fields);
            heap_fields &= heap_fields - 1;
            mal_gc_shade(mal_shape_field_load_heap(fields, shape->props[ordinal].field));
        }
        u64 tagged_fields = shape->tagged_fields;
        while (tagged_fields != 0) {
            u32 ordinal = (u32) __builtin_ctzll(tagged_fields);
            tagged_fields &= tagged_fields - 1;
            mal_gc_mark_value(mal_shape_field_load(fields, shape->props[ordinal].field));
        }
    }
    mal_gc_trace_table(mal_object_overflow(object));
}

/** Trace a cell's outgoing edges after its mark claim. */
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
        case MAL_HEAP_STRING_CURSOR: {
            MalStringIterator *iterator = ((MalStringCursor *) cell)->iterator;
            if (iterator != nullptr) {
                mal_gc_mark_string((MalString *) iterator->current.string);
                for (usize i = 0; i < iterator->count; i++) {
                    mal_gc_mark_string((MalString *) iterator->stack[i].string);
                }
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
#if !defined(__wasi__)
            if (g_trace_worker != nullptr && !g_trace_worker->owner_inline &&
                g_gc->worker_batch_concurrent && mal_gc_test_trace_env_hook != nullptr) {
                mal_gc_test_trace_env_hook(env);
            }
#endif
            if (!env->compact_parent) mal_gc_trace_env(env->parent);
            for (i32 i = 0; i < env->slot_count; ++i) {
                mal_gc_mark_value(env->slots[i]);
            }
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
    MalGcTracer tracer = mal_gc_type_hook_load(g_type_tracers[cell->type]);
    if (tracer != nullptr) tracer(cell);

    switch (cell->type) {
        case MAL_HEAP_ARGUMENTS_OBJECT: {
            MalEnv *env = ((MalArgumentsObject *) cell)->env;
            // Mapped arguments own parameter slots, not their expired activation's links.
            if (env != nullptr) {
                if (mal_env_is_single_owner(env)) env = mal_env_untag_single_owner(env);
                mal_gc_shade(mal_env_is_capture_display(env)
                    ? (MalHeapHeader *) env->parent : &env->header);
            }
            break;
        }
        case MAL_HEAP_ARRAY_OBJECT: {
            // Dense element vector: trace the live region [0, dense_count). Hole
            // sentinels are static (non-pointer) values, so marking them is a no-op.
            MalArrayObject *array = (MalArrayObject *) cell;
            if (array->elements != nullptr) {
#if !defined(__wasi__)
                bool measure = g_trace_worker == nullptr;
#else
                bool measure = true;
#endif
                measure = measure && g_gc->stats_enabled && g_gc->in_mark_step &&
                    !g_gc_verifying;
                u32 slots = array->dense_count;
                bool minor_trace = !g_gc->major_collection && !g_gc_verifying;
                u32 scan_start = minor_trace && array->minor_scan_start <= slots
                    ? array->minor_scan_start : 0;
                u64 start_ns = measure ? mal_monotonic_now_ns() : 0;
                mal_gc_mark_values(array->elements + scan_start, (i32) (slots - scan_start));
                if (minor_trace) {
                    array->minor_scan_start = slots <= MAL_ARRAY_MINOR_SCAN_MAX ? slots : 0;
                }
                if (measure) {
                    u64 elapsed = mal_monotonic_now_ns() - start_ns;
                    g_gc->major_array_trace_slots += slots;
                    g_gc->major_array_trace_ns += elapsed;
                    if (elapsed > g_gc->max_major_array_trace_ns) {
                        g_gc->max_major_array_trace_ns = elapsed;
                    }
                    if (slots > g_gc->max_major_array_trace_slots)
                        g_gc->max_major_array_trace_slots = slots;
                }
            }
            break;
        }
        case MAL_HEAP_FUNCTION_OBJECT: {
            MalEnv *env = ((MalFunctionObject *) cell)->creation_env;
            if (env != nullptr && !mal_env_is_single_owner(env) &&
                    mal_env_is_capture_display(env)) {
                // Fallback closures can borrow a display coallocated in another function.
                MalHeapHeader *owner = (MalHeapHeader *) env->parent;
                if (owner != cell) mal_gc_shade(owner);
                if (env->function_index == MAL_ENV_CAPTURE_VALUES) {
                    for (i32 i = 0; i < env->slot_count; i++)
                        mal_gc_mark_value(env->slots[i + 1]);
                } else {
                    MalEnv **scopes = mal_env_capture_scopes(env);
                    for (i32 i = 0; i < env->slot_count; i++)
                        mal_gc_shade(&scopes[i]->header);
                }
            } else {
                mal_gc_trace_env(env);
            }
            break;
        }
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
        case MAL_HEAP_ITERATOR_OBJECT: {
            MalIteratorObject *iterator = (MalIteratorObject *) cell;
            mal_gc_mark_value(iterator->target);
            if (iterator->kind == MAL_ITERATOR_STRING_VALUES && iterator->string_cursor != nullptr) {
                mal_gc_mark_value(mal_value_from_heap(&iterator->string_cursor->header));
            }
            break;
        }
        case MAL_HEAP_MAP_OBJECT:
            mal_gc_trace_map(((MalMapObject *) cell)->entries);
            break;
        case MAL_HEAP_SET_OBJECT: {
            MalSetObject *set = (MalSetObject *) cell;
            if (mal_set_storage_traced_slots(set->entries) != 0) {
                MalSetIter iter;
                mal_set_iter_init(&iter, set->entries);
                MalValue key;
                while (mal_set_iter_next(&iter, &key)) mal_gc_mark_value(key);
            }
            break;
        }
        case MAL_HEAP_WEAK_MAP_OBJECT: {
            MalWeakMapObject *map = (MalWeakMapObject *) cell;
            if (!g_gc_verifying) {
                mal_gc_register_weak_map(map);
            } else {
                MalWeakMapIter iter;
                mal_weak_map_iter_init(&iter, map->entries);
                MalValue key, value;
                while (mal_weak_map_iter_next(&iter, &key, &value)) {
                    mal_gc_mark_value(key);
                    mal_gc_mark_value(value);
                }
            }
            break;
        }
        case MAL_HEAP_WEAK_SET_OBJECT: {
            MalWeakSetObject *set = (MalWeakSetObject *) cell;
            if (!g_gc_verifying) {
                mal_gc_register_weak_set(set);
            } else {
                MalWeakSetIter iter;
                mal_weak_set_iter_init(&iter, set->entries);
                MalValue key;
                while (mal_weak_set_iter_next(&iter, &key)) mal_gc_mark_value(key);
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
        if (frame->inactive_slots == 0 && frame->inactive_slot_words == nullptr) {
            mal_gc_mark_values(frame->slots, slot_count);
            if (g_gc != nullptr && g_gc->stats_enabled) {
                g_gc->compiled_root_slots_scanned += (u64) slot_count;
            }
        } else {
            u64 scanned = 0;
            /* Clear on every scan: loops can rewrite inactive slots before a later mask reactivates them. */
            for (i32 base = 0; base < slot_count;) {
                i32 count = slot_count - base < 64 ? slot_count - base : 64;
                u64 covered = count == 64 ? UINT64_MAX : (UINT64_C(1) << count) - 1;
                u64 inactive = mal_gc_root_frame_inactive_word(frame, base / 64) & covered;
                MalValue *slots = frame->slots + base;
                if (inactive == 0) {
                    mal_gc_mark_values(slots, count);
                    scanned += (u64) count;
                } else if (inactive == covered) {
                    for (i32 slot = 0; slot < count; slot++) slots[slot] = MAL_VALUE_UNDEFINED;
                } else {
                    for (i32 slot = 0; slot < count; slot++) {
                        if ((inactive & (UINT64_C(1) << slot)) != 0) {
                            slots[slot] = MAL_VALUE_UNDEFINED;
                        } else {
                            mal_gc_mark_value(slots[slot]);
                            scanned++;
                        }
                    }
                }
                base += count;
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

void mal_gc_clear_inactive_root_frame_slots(MalRootFrame *frame) {
    for (i32 base = 0; base < frame->desc->slot_count; base += 64) {
        u64 inactive = mal_gc_root_frame_inactive_word(frame, base / 64);
        if (inactive == 0) continue;
        i32 count = frame->desc->slot_count - base;
        if (count > 64) count = 64;
        for (i32 slot = 0; slot < count; slot++) {
            if ((inactive & (UINT64_C(1) << slot)) != 0) {
                frame->slots[base + slot] = MAL_VALUE_UNDEFINED;
            }
        }
    }
}

static void mal_gc_scan_roots(MalVm *vm) {
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
        vm->root_frame_head,
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
    mal_gc_mark_value(vm->error_stack_marker);
    for (MalPreparedValue *entry = vm->prepared_values; entry != nullptr; entry = entry->next) {
        mal_gc_mark_value(entry->value);
    }
#if MAL_NODE
    if (vm->async_context != nullptr) {
        mal_gc_shade(&vm->async_context->header);
    }
#endif
#if MAL_REALMS
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
    u32 intern_cursor = 0;
    MalString *atom;
    while ((atom = mal_atom_store_next(&vm->atoms, &intern_cursor)) != nullptr) {
        mal_gc_mark_string(atom);
    }
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_ATOMS].root_scan_slots, vm->atoms.capacity);
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_ATOMS].root_values, vm->atoms.size);
    intern_cursor = 0;
    MalSymbol *registered_symbol;
    while ((registered_symbol = mal_symbol_registry_next(&vm->symbol_registry, &intern_cursor)) != nullptr) {
        mal_gc_mark_value(mal_value_from_symbol(registered_symbol));
    }
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].root_scan_slots, vm->symbol_registry.capacity);
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].root_values, vm->symbol_registry.size);
    intern_cursor = 0;
    const MalNativeSourceEntry *native_source;
    while ((native_source = mal_native_source_cache_next(&vm->native_source_cache, &intern_cursor)) != nullptr) {
        mal_gc_mark_string(native_source->name);
        mal_gc_mark_string(native_source->source);
    }
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].root_scan_slots, vm->native_source_cache.capacity);
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].root_values, (u64) vm->native_source_cache.size * 2);

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
        case MAL_HEAP_STRING_CURSOR: {
            MalStringCursor *cursor = (MalStringCursor *) cell;
            if (cursor->iterator != nullptr) cursor->iterator->owner = nullptr;
            mal_string_cursor_dispose(cursor);
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
    MalGcFinalizer finalizer = mal_gc_type_hook_load(g_type_finalizers[cell->type]);
    if (finalizer != nullptr) finalizer(cell);

    // MalObject-based cell: free its type-specific owned memory, then the common
    // overflow table and inline-slots buffer. Idempotent (null after free).
    switch (cell->type) {
        case MAL_HEAP_ARRAY_OBJECT: {
            MalArrayObject *array = (MalArrayObject *) cell;
#if MAL_PERF_STATS
            mal_perf_collection_finalize(
                array,
                MAL_PERF_COLLECTION_ARRAY,
                g_gc_vm->heap.epoch,
                array->length,
                mal_array_object_perf_element_mask(array),
                0,
                array->dense_deopted);
#endif
            if (array->elements != nullptr) {
                gc_free_raw(&g_gc_vm->heap, array->elements); // RAW-space dense vector
                array->elements = nullptr;
                array->capacity = 0;
                array->dense_count = 0;
            }
            break;
        }
        case MAL_HEAP_MAP_OBJECT:
        {
            MalMapObject *map = (MalMapObject *) cell;
#if MAL_PERF_STATS
            MalPerfCollectionKind kind = MAL_PERF_COLLECTION_MAP;
            mal_perf_collection_finalize(
                map,
                kind,
                g_gc_vm->heap.epoch,
                mal_map_object_size(map),
                0,
                map->entries == nullptr ? 0 : mal_map_object_perf_key_mask(map),
                false);
#endif
            if (map->entries != nullptr) {
                mal_map_storage_release_owner(map->entries);
                map->entries = nullptr;
            }
            break;
        }
        case MAL_HEAP_SET_OBJECT: {
            MalSetObject *set = (MalSetObject *) cell;
#if MAL_PERF_STATS
            mal_perf_collection_finalize(
                set, MAL_PERF_COLLECTION_SET,
                g_gc_vm->heap.epoch, mal_set_object_size(set), 0,
                mal_set_object_perf_key_mask(set), false);
#endif
            mal_set_storage_release_owner(set->entries);
            set->entries = nullptr;
            break;
        }
        case MAL_HEAP_WEAK_MAP_OBJECT: {
            MalWeakMapObject *map = (MalWeakMapObject *) cell;
#if MAL_PERF_STATS
            mal_perf_collection_finalize(map, MAL_PERF_COLLECTION_WEAK_MAP,
                g_gc_vm->heap.epoch, mal_weak_map_object_size(map), 0,
                mal_weak_map_object_perf_key_mask(map), false);
#endif
            mal_weak_storage_free(map->entries);
            map->entries = nullptr;
            break;
        }
        case MAL_HEAP_WEAK_SET_OBJECT: {
            MalWeakSetObject *set = (MalWeakSetObject *) cell;
#if MAL_PERF_STATS
            mal_perf_collection_finalize(set, MAL_PERF_COLLECTION_WEAK_SET,
                g_gc_vm->heap.epoch, mal_weak_set_object_size(set), 0,
                mal_weak_set_object_perf_key_mask(set), false);
#endif
            mal_weak_storage_free(set->entries);
            set->entries = nullptr;
            break;
        }
        case MAL_HEAP_ARRAY_BUFFER_OBJECT: {
            MalArrayBufferObject *buffer = (MalArrayBufferObject *) cell;
            if (!buffer->detached) {
                // Shared with detach so a sensitive store is scrubbed on the
                // sweep too — the path most secret-bearing buffers actually take,
                // since nothing detaches a digest state or a derived tag.
                mal_array_buffer_object_release_store(&g_gc_vm->heap, buffer);
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
            mal_iterator_object_finalize_collection_pin((MalIteratorObject *) cell);
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
    if (mal_object_overflow(object) != nullptr) {
        mal_table_free(mal_object_overflow(object));
        mal_object_set_overflow_pointer(object, nullptr);
    }
    mal_object_release_slots(object);
    if (object->storage_kind == MAL_OBJECT_EXTERNAL) {
        free(mal_object_storage(object));
    }
}

// --- Mark / weak / verify --------------------------------------------------

/** Verify visitor: re-trace a survivor's edges (in verify mode shading aborts on
 * a freed target). FREE cells are dead this cycle and are skipped. */
static void mal_gc_verify_cell(MalHeapHeader *cell) {
    if ((cell->mark & MAL_MARK_FREE) == 0) {
        g_gc_verify_source = (i32) cell->type;
        mal_gc_trace_cell(cell);
        g_gc_verify_source = -1;
    }
}

/* Verify before any reclaimed cell can be reused, including after an incremental
 * sweep finishes; a surviving edge to FREE means a root or trace edge was missed. */
static void mal_gc_verify(MalVm *vm) {
    g_gc_verifying = true;
    mal_gc_scan_roots(vm);
    mal_heap_walk_cells(&vm->heap, mal_gc_verify_cell);
    g_gc_verifying = false;
}

static bool mal_gc_worker_can_trace(MalHeapHeader *cell) {
    if (mal_gc_type_hook_load(g_type_tracers[cell->type]) != nullptr) return false;
    switch (cell->type) {
        case MAL_HEAP_STRING:
        case MAL_HEAP_SYMBOL:
        case MAL_HEAP_BIGINT:
        case MAL_HEAP_ENV:
        case MAL_HEAP_OBJECT:
        case MAL_HEAP_ARRAY_OBJECT:
        case MAL_HEAP_FUNCTION_OBJECT:
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT:
        case MAL_HEAP_BOUND_FUNCTION_OBJECT:
        case MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT:
        case MAL_HEAP_ITERATOR_OBJECT:
            return true;
        case MAL_HEAP_MAP_OBJECT:
        case MAL_HEAP_SET_OBJECT:
            return true;
        default:
            return false;
    }
}

static bool mal_gc_worker_can_trace_during_mutation(MalHeapHeader *cell) {
    if (mal_gc_type_hook_load(g_type_tracers[cell->type]) != nullptr) return false;
    return cell->type == MAL_HEAP_SYMBOL || cell->type == MAL_HEAP_ASYNC_CONTEXT ||
        cell->type == MAL_HEAP_ENV;
}

#if !defined(__wasi__)
#define MAL_GC_SNAPSHOT_EDGE_LIMIT 2048
#define MAL_GC_SNAPSHOT_INLINE_LIMIT 32
#define MAL_GC_SNAPSHOT_DENSE_LIMIT 128

static bool mal_gc_snapshot_edge_count(MalHeapHeader *cell, usize *count) {
    if (cell->type != MAL_HEAP_OBJECT && cell->type != MAL_HEAP_ARRAY_OBJECT) return false;
    if (mal_gc_type_hook_load(g_type_tracers[cell->type]) != nullptr) return false;
    MalObject *object = (MalObject *) cell;
    if (object->shape == nullptr || mal_object_overflow(object) != nullptr ||
        object->shape->inline_count > MAL_GC_SNAPSHOT_INLINE_LIMIT ||
        (object->shape->inline_count > 0 && mal_object_fields(object) == nullptr)) return false;
    usize edges = (mal_object_prototype(object) != nullptr ? 1 : 0)
        + object->shape->inline_count
        + (usize) __builtin_popcountll(object->shape->heap_fields | object->shape->tagged_fields);
    if (cell->type == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) cell;
        if (array->dense_count > MAL_GC_SNAPSHOT_DENSE_LIMIT ||
            (array->dense_count > 0 && array->elements == nullptr)) return false;
        edges += array->dense_count;
    }
    *count = edges;
    return edges > 0;
}

static void mal_gc_snapshot_append_heap_edge(MalGcState *g, MalValue value) {
    if (mal_value_is_heap(value)) g->batch_edges[g->batch_edges_count++] = value;
}

static void mal_gc_snapshot_edges(MalGcState *g, MalHeapHeader *cell, usize index) {
    MalObject *object = (MalObject *) cell;
    usize offset = g->batch_edges_count;
    if (mal_object_prototype(object) != nullptr) {
        mal_gc_snapshot_append_heap_edge(g, mal_value_from_object(mal_object_prototype(object)));
    }
    const MalShape *shape = object->shape;
    for (u32 i = 0; i < shape->inline_count; ++i) {
        mal_gc_snapshot_append_heap_edge(g, shape->props[i].key);
    }
    const void *fields = mal_object_fields(object);
    u64 heap_fields = shape->heap_fields;
    while (heap_fields != 0) {
        u32 ordinal = (u32) __builtin_ctzll(heap_fields);
        heap_fields &= heap_fields - 1;
        mal_gc_snapshot_append_heap_edge(g, mal_value_from_heap(
            mal_shape_field_load_heap(fields, shape->props[ordinal].field)));
    }
    u64 tagged_fields = shape->tagged_fields;
    while (tagged_fields != 0) {
        u32 ordinal = (u32) __builtin_ctzll(tagged_fields);
        tagged_fields &= tagged_fields - 1;
        mal_gc_snapshot_append_heap_edge(g, mal_shape_field_load(
            fields, shape->props[ordinal].field));
    }
    if (cell->type == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) cell;
        for (u32 i = 0; i < array->dense_count; ++i) {
            mal_gc_snapshot_append_heap_edge(g, array->elements[i]);
        }
    }
    g->batch_edge_offsets[index] = offset;
    g->batch_edge_counts[index] = g->batch_edges_count - offset;
}

// Bounds one drain slice so a parked major cannot monopolize a shared helper thread;
// untraced discoveries merge into the grey queue for the next dispatch.
#define MAL_GC_HELPER_DRAIN_QUANTUM 8192

// Runs with g_gc, g_gc_vm and g_trace_worker bound to this slot's isolate.
static void mal_gc_helper_trace_slice(MalGcWorker *worker) {
    MalGcState *g = worker->gc;
    usize count = g->worker_batch_count;
    MalHeapHeader **batch = g->batch;
    struct timespec cpu_start;
    if (g->stats_enabled && clock_gettime(CLOCK_THREAD_CPUTIME_ID, &cpu_start) != 0) abort();
    for (usize i = worker->index; i < count; i += g->workers_created) {
        if (g->worker_batch_concurrent && g->batch_edge_counts[i] != SIZE_MAX) {
            if (mal_gc_test_trace_snapshot_hook != nullptr && !worker->owner_inline) {
                mal_gc_test_trace_snapshot_hook(batch[i]);
            }
            usize before = worker->discovered_count;
            usize end = g->batch_edge_offsets[i] + g->batch_edge_counts[i];
            for (usize edge = g->batch_edge_offsets[i]; edge < end; ++edge) {
                mal_gc_mark_value(g->batch_edges[edge]);
            }
            worker->batch_snapshot_discoveries += worker->discovered_count - before;
        } else {
            mal_gc_trace_cell(batch[i]);
        }
    }
    if (g->worker_batch_drain) {
        usize deferred = 0;
        while (worker->discovered_count > deferred &&
               worker->batch_drain_traces < MAL_GC_HELPER_DRAIN_QUANTUM) {
            usize last = worker->discovered_count - 1;
            MalHeapHeader *cell = worker->discovered[last];
            if (mal_gc_worker_can_trace(cell)) {
                worker->discovered_count = last;
                mal_gc_trace_cell(cell);
                worker->batch_drain_traces++;
            } else {
                worker->discovered[last] = worker->discovered[deferred];
                worker->discovered[deferred++] = cell;
            }
        }
    }
    if (g->stats_enabled) {
        struct timespec cpu_end;
        if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &cpu_end) != 0) abort();
        i64 elapsed = (i64) (cpu_end.tv_sec - cpu_start.tv_sec) * 1000000000
            + (i64) (cpu_end.tv_nsec - cpu_start.tv_nsec);
        worker->batch_cpu_ns = (u64) elapsed;
    }
}

// Acknowledges a slot. The last acknowledgement of a concurrent batch asks the owning
// mutator to merge at its next safepoint; it never touches this thread's poll flag.
static void mal_gc_helper_acknowledge(MalGcWorker *worker, bool traced) {
    MalGcState *g = worker->gc;
    if (worker->helper_granted) {
        worker->helper_granted = false;
        mal_gc_process_helper_release();
    }
    pthread_mutex_lock(&g->worker_mutex);
    if (--g->workers_pending == 0) {
        if (traced && g->worker_batch_concurrent) mal_gc_request_safepoint(g->poll_target);
        pthread_cond_signal(&g->worker_done);
    }
    pthread_mutex_unlock(&g->worker_mutex);
}

// Collector jobs carry their isolate's collector context explicitly and may only read
// the published batch, its snapshot edges, and the worker-safe trace classes.
static void mal_gc_helper_run(void *data) {
    MalGcWorker *worker = data;
    MalGcState *g = worker->gc;
    g_gc = g;
    g_gc_vm = g->vm;
    g_trace_worker = worker;
    mal_gc_helper_trace_slice(worker);
    g_trace_worker = nullptr;
    g_gc_vm = nullptr;
    g_gc = nullptr;
    mal_gc_helper_acknowledge(worker, true);
}

// Teardown discards queued slices; the abandoned batch is never merged.
static void mal_gc_helper_discard(void *data) {
    mal_gc_helper_acknowledge(data, false);
}

// The owning mutator traces a slot the pool could not take or had not started yet,
// keeping the same private-queue merge contract as a helper.
static void mal_gc_helper_run_inline(MalGcWorker *worker) {
    if (g_gc != worker->gc || g_trace_worker != nullptr) abort();
    g_trace_worker = worker;
    worker->owner_inline = true;
    mal_gc_helper_trace_slice(worker);
    worker->owner_inline = false;
    g_trace_worker = nullptr;
    mal_gc_helper_acknowledge(worker, true);
}

static bool mal_gc_workers_start(MalGcState *g) {
    if (g->worker_sync_initialized) return g->workers_created > 0;
    if (g->worker_limit == 0) abort();
    if (pthread_mutex_init(&g->worker_mutex, nullptr) != 0 ||
        pthread_cond_init(&g->worker_done, nullptr) != 0) {
        fprintf(stderr, "[gc] failed to initialize native worker synchronization\n");
        abort();
    }
    g->worker_sync_initialized = true;
    for (usize i = 0; i < g->worker_limit; ++i) {
        MalGcWorker *worker = &g->workers[i];
        worker->gc = g;
        worker->index = i;
        if (mal_gc_test_worker_start_failure_hook != nullptr &&
            mal_gc_test_worker_start_failure_hook(i)) {
            fprintf(stderr, "[gc] native worker start failed (%d); using %zu workers\n",
                EAGAIN, g->workers_created);
            g->worker_limit = g->workers_created;
            break;
        }
        g->workers_created++;
    }
    // Each dispatch has at most one queued job per slot, so slots bound the queue.
    if (g->workers_created > 0 && !mal_executor_client_init(&g->helpers, MAL_EXECUTOR_GC,
            g->workers_created, g->workers_created)) {
        fprintf(stderr, "[gc] native worker pool unavailable; using 0 workers\n");
        g->worker_limit = 0;
        g->workers_created = 0;
    }
    if (g->workers_created > 0) mal_profile_mark_worker_cpu_possible();
    return g->workers_created > 0;
}

static void mal_gc_workers_stop(MalGcState *g) {
    if (!g->worker_sync_initialized) return;
    if (mal_gc_test_before_worker_join_hook != nullptr) {
        mal_gc_test_before_worker_join_hook();
    }
    // Discards queued slices and waits only for this isolate's running ones.
    mal_executor_client_free(&g->helpers);
    g->workers_created = 0;
}

static void mal_gc_workers_start_batch(MalGcState *g, usize count,
        bool concurrent, bool drain) {
    if (!mal_gc_workers_start(g)) abort();
    if (concurrent && drain) abort();
    if (g->worker_batch_active) abort();
    // No slot of this isolate is outstanding, so these writes are published by submit.
    g->worker_batch_count = count;
    g->worker_batch_concurrent = concurrent;
    g->worker_batch_drain = drain;
    if (g->stats_enabled && !g->major_collection && !concurrent) g->minor_worker_batches++;
    g->workers_pending = g->workers_created;
    for (usize i = 0; i < g->workers_created; ++i) {
        g->workers[i].batch_snapshot_discoveries = 0;
        g->workers[i].batch_drain_traces = 0;
        g->workers[i].batch_cpu_ns = 0;
    }
    g->worker_batch_active = true;
    for (usize i = 0; i < g->workers_created; ++i) {
        MalGcWorker *worker = &g->workers[i];
        // Pool exhaustion must still progress: the owner traces the slot itself.
        worker->helper_granted = mal_gc_process_helper_acquire();
        if ((!worker->helper_granted && mal_gc_test_worker_limit_hook == nullptr) ||
            !mal_executor_submit(&g->helpers, mal_gc_helper_run, mal_gc_helper_discard,
                worker, 0, 0)) {
            mal_gc_helper_run_inline(worker);
        }
    }
}

static void mal_gc_grey_reserve(MalGcState *g, usize required) {
    if (required > SIZE_MAX / sizeof(MalHeapHeader *)) abort();
    usize capacity = g->grey_capacity == 0 ? 4096 : g->grey_capacity;
    while (capacity < required) {
        if (capacity > SIZE_MAX / (2 * sizeof(MalHeapHeader *))) {
            capacity = required;
            break;
        }
        capacity *= 2;
    }
    MalHeapHeader **cells = realloc(g->grey, capacity * sizeof(MalHeapHeader *));
    if (cells == nullptr) abort();
    g->grey = cells;
    g->grey_capacity = capacity;
}

static bool mal_gc_workers_collect_batch(MalGcState *g, bool wait) {
    if (!g->worker_batch_active) return true;
    u64 wait_start = g->stats_enabled && wait ? mal_monotonic_now_ns() : 0;
    if (wait) {
        // A blocked owner traces slices no helper has started, newest first, so a
        // saturated shared pool cannot stall it while started or oldest slices stay
        // on helpers.
        for (usize i = g->workers_created; i > 0; --i) {
            if (mal_executor_cancel(&g->helpers, &g->workers[i - 1])) {
                mal_gc_helper_run_inline(&g->workers[i - 1]);
            }
        }
    }
    pthread_mutex_lock(&g->worker_mutex);
    if (wait) {
        while (g->workers_pending != 0) {
            pthread_cond_wait(&g->worker_done, &g->worker_mutex);
        }
    } else if (g->workers_pending != 0) {
        pthread_mutex_unlock(&g->worker_mutex);
        return false;
    }
    pthread_mutex_unlock(&g->worker_mutex);
    if (wait_start != 0) g->worker_wait_ns += mal_monotonic_now_ns() - wait_start;
    u64 merge_start = g->stats_enabled ? mal_monotonic_now_ns() : 0;
    usize merged_count = g->grey_count;
    for (usize i = 0; i < g->workers_created; ++i) {
        if (g->workers[i].discovered_count > SIZE_MAX - merged_count) abort();
        merged_count += g->workers[i].discovered_count;
    }
    if (merged_count > g->grey_capacity) mal_gc_grey_reserve(g, merged_count);
    g->worker_traces += g->worker_batch_count;
    u64 batch_traces = g->worker_batch_count;
    for (usize i = 0; i < g->workers_created; ++i) {
        MalGcWorker *worker = &g->workers[i];
        g->worker_drain_traces += worker->batch_drain_traces;
        g->worker_traces += worker->batch_drain_traces;
        batch_traces += worker->batch_drain_traces;
        if (g->stats_enabled) {
            g->worker_cpu_ns += worker->batch_cpu_ns;
            if (!g->major_collection) g->minor_worker_cpu_ns += worker->batch_cpu_ns;
            if (g->worker_batch_concurrent) {
                g->concurrent_worker_cpu_ns += worker->batch_cpu_ns;
            }
        }
        if (g->worker_batch_concurrent) {
            g->concurrent_discoveries += worker->discovered_count;
            g->concurrent_handoffs += worker->discovered_count;
        }
        g->snapshot_discoveries += worker->batch_snapshot_discoveries;
        if (worker->discovered_count > 0) {
            // Every worker has acknowledged this batch; their private queues
            // cannot change until the next dispatch.
            memcpy(g->grey + g->grey_count, worker->discovered,
                worker->discovered_count * sizeof(MalHeapHeader *));
            g->grey_count += worker->discovered_count;
        }
        worker->discovered_count = 0;
    }
    if (g->stats_enabled && !g->major_collection) g->minor_worker_traces += batch_traces;
    if (g->worker_batch_concurrent) {
        g->concurrent_batches++;
        usize direct_count = 0;
        for (usize i = 0; i < g->worker_batch_count; ++i) {
            if (g->batch_edge_counts[i] != SIZE_MAX) {
                g->snapshot_traces++;
            } else {
                direct_count++;
                g->concurrent_traces++;
                if (g->batch[i]->type == MAL_HEAP_ENV) g->concurrent_env_traces++;
            }
        }
        if (direct_count == 0) g->snapshot_only_batches++;
    }
    g->batch_edges_count = 0;
    g->worker_batch_active = false;
    g->worker_batch_drain = false;
    if (merge_start != 0) g->worker_merge_ns += mal_monotonic_now_ns() - merge_start;
    return true;
}

static bool mal_gc_workers_trace_batch(MalGcState *g, usize count, bool drain) {
    if (!mal_gc_workers_start(g)) return false;
    mal_gc_workers_start_batch(g, count, false, drain);
    mal_gc_workers_collect_batch(g, true);
    return true;
}
#endif

#define MAL_GC_CONCURRENT_TRACE_BATCH_SIZE 512
#define MAL_GC_PARKED_TRACE_BATCH_SIZE 2048
#define MAL_GC_PARALLEL_BATCH_MIN 64

static void mal_gc_trace_parked_batch(usize count, bool drain) {
    usize safe_count = 0;
    for (usize i = 0; i < count; ++i) {
        MalHeapHeader *cell = g_gc->batch[i];
        if (mal_gc_worker_can_trace(cell)) {
            g_gc->batch[safe_count++] = cell;
        } else {
            mal_gc_trace_cell(cell);
        }
    }
#if !defined(__wasi__)
    if (g_gc->major_collection && g_gc->worker_limit > 0 &&
        safe_count >= MAL_GC_PARALLEL_BATCH_MIN) {
        if (mal_gc_workers_trace_batch(g_gc, safe_count, drain)) return;
    }
#endif
    for (usize i = 0; i < safe_count; ++i) mal_gc_trace_cell(g_gc->batch[i]);
}

#if !defined(__wasi__)
static bool mal_gc_trace_concurrent_batch(usize limit, usize *worked) {
    if (g_gc->worker_limit == 0) {
        *worked = 0;
        return false;
    }
    usize count = g_gc->grey_count;
    if (count > limit) count = limit;
    if (count > MAL_GC_CONCURRENT_TRACE_BATCH_SIZE) count = MAL_GC_CONCURRENT_TRACE_BATCH_SIZE;
    if (count == 0) {
        *worked = 0;
        return false;
    }
    if (g_gc->batch_capacity < count) {
        MalHeapHeader **batch = realloc(g_gc->batch, count * sizeof(MalHeapHeader *));
        if (batch == nullptr) abort();
        g_gc->batch = batch;
        g_gc->batch_capacity = count;
    }
    for (usize i = 0; i < count; ++i) {
        g_gc->batch[i] = g_gc->grey[--g_gc->grey_count];
    }
    usize direct_count = 0;
    usize snapshot_edges = 0;
    usize safe_count = 0;
    u64 admit_start = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    for (usize i = 0; i < count; ++i) {
        MalHeapHeader *cell = g_gc->batch[i];
        usize edges = 0;
        bool direct = mal_gc_worker_can_trace_during_mutation(cell);
        bool snapshot = !direct && mal_gc_snapshot_edge_count(cell, &edges) &&
            edges <= MAL_GC_SNAPSHOT_EDGE_LIMIT - snapshot_edges;
        if (!direct && !snapshot) continue;
        if (direct) direct_count++;
        if (snapshot) snapshot_edges += edges;
        g_gc->batch[i] = g_gc->batch[safe_count];
        g_gc->batch[safe_count++] = cell;
    }
    if (admit_start != 0) g_gc->snapshot_admit_ns += mal_monotonic_now_ns() - admit_start;
    if (direct_count + snapshot_edges < MAL_GC_PARALLEL_BATCH_MIN) {
        g_gc->batch_edges_count = 0;
        mal_gc_trace_parked_batch(count, false);
        *worked = count;
        return false;
    }
    if (!mal_gc_workers_start(g_gc)) {
        for (usize i = 0; i < count; ++i) mal_gc_trace_cell(g_gc->batch[i]);
        *worked = count;
        return false;
    }
    u64 reserve_start = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    if (g_gc->batch_edge_meta_capacity < safe_count) {
        usize *offsets = realloc(g_gc->batch_edge_offsets, safe_count * sizeof(usize));
        usize *counts = realloc(g_gc->batch_edge_counts, safe_count * sizeof(usize));
        if (offsets == nullptr || counts == nullptr) abort();
        g_gc->batch_edge_offsets = offsets;
        g_gc->batch_edge_counts = counts;
        g_gc->batch_edge_meta_capacity = safe_count;
    }
    if (g_gc->batch_edges_capacity < snapshot_edges) {
        MalValue *edges = realloc(g_gc->batch_edges, snapshot_edges * sizeof(MalValue));
        if (edges == nullptr) abort();
        g_gc->batch_edges = edges;
        g_gc->batch_edges_capacity = snapshot_edges;
    }
    if (reserve_start != 0) g_gc->snapshot_reserve_ns += mal_monotonic_now_ns() - reserve_start;
    g_gc->batch_edges_count = 0;
    u64 snapshot_start = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    for (usize i = 0; i < safe_count; ++i) {
        if (mal_gc_worker_can_trace_during_mutation(g_gc->batch[i])) {
            g_gc->batch_edge_counts[i] = SIZE_MAX;
        } else {
            mal_gc_snapshot_edges(g_gc, g_gc->batch[i], i);
        }
    }
    if (g_gc->stats_enabled) {
        g_gc->snapshot_copy_ns += mal_monotonic_now_ns() - snapshot_start;
    }
    g_gc->snapshot_examined_values += snapshot_edges;
    g_gc->snapshot_values += g_gc->batch_edges_count;
    g_gc->snapshot_heap_values += g_gc->batch_edges_count;
    u64 inline_start = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    for (usize i = safe_count; i < count; ++i) mal_gc_trace_cell(g_gc->batch[i]);
    if (inline_start != 0) g_gc->snapshot_inline_ns += mal_monotonic_now_ns() - inline_start;
    mal_gc_workers_start_batch(g_gc, safe_count, true, false);
    *worked = count;
    return true;
}
#endif

static usize mal_gc_trace_grey_batch(usize limit) {
    usize count = g_gc->grey_count;
    if (count > limit) count = limit;
    if (count > MAL_GC_PARKED_TRACE_BATCH_SIZE) count = MAL_GC_PARKED_TRACE_BATCH_SIZE;
    if (count == 0) return 0;
    if (g_gc->batch_capacity < count) {
        MalHeapHeader **batch = realloc(g_gc->batch,
            count * sizeof(MalHeapHeader *));
        if (batch == nullptr) abort();
        g_gc->batch = batch;
        g_gc->batch_capacity = count;
    }
    for (usize i = 0; i < count; ++i) {
        g_gc->batch[i] = g_gc->grey[--g_gc->grey_count];
    }
    mal_gc_trace_parked_batch(count, limit == (usize) -1);
    return count;
}

/** Drain the grey worklist, tracing each cell's strong edges. */
static void mal_gc_drain(void) {
    while (g_gc->grey_count > 0) {
        mal_gc_trace_grey_batch((usize) -1);
    }
}

/* Transfer unclaimed snapshot values to the grey queue without tracing payloads. */
static void mal_gc_drain_satb(void) {
    while (g_gc->satb_drained < g_gc->satb_count) {
        MalValue v = g_gc->satb[g_gc->satb_drained++];
        mal_gc_mark_value(v);
    }
}

typedef struct MalGcPendingEphemeron {
    MalHeapHeader *key;
    MalValue value;
    usize next;
} MalGcPendingEphemeron;

typedef struct MalGcEphemeronIndex {
    usize *buckets;
    usize bucket_count;
    MalGcPendingEphemeron *entries;
    usize count;
    usize capacity;
} MalGcEphemeronIndex;

static usize mal_gc_ephemeron_bucket(MalHeapHeader *key, usize bucket_count) {
    u64 bits = (u64) (uptr) key;
    bits ^= bits >> 30;
    bits *= 0xbf58476d1ce4e5b9ull;
    bits ^= bits >> 27;
    bits *= 0x94d049bb133111ebull;
    bits ^= bits >> 31;
    return (usize) bits & (bucket_count - 1);
}

static void mal_gc_ephemeron_resize(MalGcEphemeronIndex *index, usize bucket_count) {
    usize *buckets = calloc(bucket_count, sizeof(usize));
    if (buckets == nullptr) abort();
    if (g_gc->stats_enabled) {
        usize bytes = index->capacity * sizeof(MalGcPendingEphemeron)
            + (index->bucket_count + bucket_count) * sizeof(usize);
        if (bytes > g_gc->weak_pending_peak_bytes) g_gc->weak_pending_peak_bytes = bytes;
    }
    for (usize i = 0; i < index->count; ++i) {
        MalGcPendingEphemeron *entry = &index->entries[i];
        if (entry->key == nullptr) continue;
        usize bucket = mal_gc_ephemeron_bucket(entry->key, bucket_count);
        entry->next = buckets[bucket];
        buckets[bucket] = i + 1;
    }
    free(index->buckets);
    index->buckets = buckets;
    index->bucket_count = bucket_count;
}

static void mal_gc_ephemeron_wait(MalGcEphemeronIndex *index, MalHeapHeader *key,
        MalValue value) {
    if (index->bucket_count == 0 || index->count == index->bucket_count * 2) {
        mal_gc_ephemeron_resize(index,
            index->bucket_count == 0 ? 16 : index->bucket_count * 2);
    }
    if (index->count == index->capacity) {
        usize capacity = index->capacity == 0 ? 16 : index->capacity * 2;
        MalGcPendingEphemeron *entries = realloc(index->entries,
            capacity * sizeof(MalGcPendingEphemeron));
        if (entries == nullptr) abort();
        index->entries = entries;
        index->capacity = capacity;
        if (g_gc->stats_enabled) {
            usize bytes = index->capacity * sizeof(MalGcPendingEphemeron)
                + index->bucket_count * sizeof(usize);
            if (bytes > g_gc->weak_pending_peak_bytes) g_gc->weak_pending_peak_bytes = bytes;
        }
    }
    usize bucket = mal_gc_ephemeron_bucket(key, index->bucket_count);
    index->entries[index->count] = (MalGcPendingEphemeron) {
        .key = key, .value = value, .next = index->buckets[bucket]
    };
    index->buckets[bucket] = ++index->count;
}

static void mal_gc_ephemeron_activate(MalGcEphemeronIndex *index, MalHeapHeader *key) {
    if (index->bucket_count == 0) return;
    usize bucket = mal_gc_ephemeron_bucket(key, index->bucket_count);
    usize *link = &index->buckets[bucket];
    while (*link != 0) {
        MalGcPendingEphemeron *entry = &index->entries[*link - 1];
        if (g_gc->stats_enabled) g_gc->weak_pending_links_visited++;
        if (entry->key != key) {
            link = &entry->next;
            continue;
        }
        *link = entry->next;
        entry->key = nullptr;
        if (!mal_gc_is_marked(entry->value)) {
            mal_gc_mark_value(entry->value);
            if (g_gc->stats_enabled) g_gc->weak_activated_values++;
        }
    }
}

/* The main mark is parked here, so newly activated keys can be observed as each
 * grey cell is popped without sharing this temporary index with workers. */
static void mal_gc_weak_pass(void) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    MalGcEphemeronIndex index = {0};
    usize indexed_maps = 0;
    while (indexed_maps < g_gc->weak_maps_count || g_gc->grey_count > 0) {
        while (indexed_maps < g_gc->weak_maps_count) {
            MalWeakStorage *entries = g_gc->weak_maps[indexed_maps++]->entries;
            MAL_PERF_ADD(weak_storage_gc_scan_slots[1], mal_weak_storage_scan_slots(entries));
            MalWeakMapIter iter;
            mal_weak_map_iter_init(&iter, entries);
            MalValue key, value;
            while (mal_weak_map_iter_next(&iter, &key, &value)) {
                if (g_gc->stats_enabled) g_gc->weak_entry_visits++;
                if (mal_gc_is_marked(key)) {
                    mal_gc_mark_value(value);
                } else if (mal_value_is_heap(value) &&
                        mal_value_to_heap(value) != mal_value_to_heap(key) &&
                        !mal_gc_is_marked(value)) {
                    mal_gc_ephemeron_wait(&index, mal_value_to_heap(key), value);
                }
            }
        }
        if (g_gc->grey_count > 0) {
            MalHeapHeader *cell = g_gc->grey[--g_gc->grey_count];
            mal_gc_ephemeron_activate(&index, cell);
            mal_gc_trace_cell(cell);
        }
    }
    if (g_gc->stats_enabled) {
        usize bytes = index.capacity * sizeof(MalGcPendingEphemeron)
            + index.bucket_count * sizeof(usize);
        if (bytes > g_gc->weak_pending_peak_bytes) g_gc->weak_pending_peak_bytes = bytes;
    }
    free(index.entries);
    free(index.buckets);

    // Collector-owned deletion of dead weak entries must not put those edges back
    // into SATB after the ephemeron fixpoint has completed.
    mal_gc_marking_active = false;

    for (usize i = 0; i < g_gc->weak_maps_count; ++i) {
        MalWeakMapObject *map = g_gc->weak_maps[i];
        if (g_gc->stats_enabled) g_gc->weak_cleanup_visits += mal_weak_map_object_size(map);
        mal_weak_map_storage_retain(map->entries, mal_gc_is_marked);
    }

    for (usize i = 0; i < g_gc->weak_sets_count; i++) {
        MalWeakSetObject *set = g_gc->weak_sets[i];
        if (g_gc->stats_enabled) g_gc->weak_cleanup_visits += mal_weak_set_object_size(set);
        mal_weak_set_storage_retain(set->entries, mal_gc_is_marked);
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
    if (start_ns != 0) g_gc->weak_pass_ns += mal_monotonic_now_ns() - start_ns;
}

// --- Generational state ----------------------------------------------------
//
// Remembered set: old cells written with a young pointer, recorded by the card barrier
// (gc.h). A minor collection scans roots + traces each remembered cell to reach
// its young children, WITHOUT re-marking the old generation — that is the work it
// saves over a full mark. The set is rebuilt every collection.

void mal_gc_remember(MalHeapHeader *owner) {
    if (owner->type == MAL_HEAP_ARRAY_OBJECT) {
        ((MalArrayObject *) owner)->minor_scan_start = 0;
    }
    if (owner->dirty != MAL_REMEMBERED_CLEAN) {
        owner->dirty = MAL_REMEMBERED_FULL;
        return;
    }
    if (g_gc->remembered_count == g_gc->remembered_capacity) {
        usize capacity = g_gc->remembered_capacity == 0 ? 256 : g_gc->remembered_capacity * 2;
        MalHeapHeader **remembered = realloc(g_gc->remembered,
            capacity * sizeof(MalHeapHeader *));
        if (remembered == nullptr) abort();
        g_gc->remembered = remembered;
        g_gc->remembered_capacity = capacity;
    }
    owner->dirty = MAL_REMEMBERED_FULL;
    g_gc->remembered[g_gc->remembered_count++] = owner;
}

void mal_gc_array_card_slow(MalHeapHeader *owner, u32 index, MalValue value) {
    if (!mal_heap_mark_is_old(owner->mark) || owner->dirty == MAL_REMEMBERED_FULL ||
        !mal_value_is_heap(value) || mal_heap_mark_is_old(mal_value_to_heap(value)->mark)) return;
    MalArrayObject *array = (MalArrayObject *) owner;
    u32 start = array->minor_scan_start;
    if (index < start) start = index;
    if (owner->dirty == MAL_REMEMBERED_CLEAN) {
        mal_gc_remember(owner);
        // A partial card remains upgradeable by an unindexed store in the same epoch.
        owner->dirty = MAL_REMEMBERED_ARRAY_RANGE;
    }
    array->minor_scan_start = start;
}

// Clear the remembered set after a collection: drop the dirty flag on each member
// (a later write re-records it) and empty the list.
static void mal_gc_clear_remembered(void) {
    for (usize i = 0; i < g_gc->remembered_count; ++i) {
        g_gc->remembered[i]->dirty = 0;
    }
    g_gc->remembered_count = 0;
}

static u64 mal_gc_remembered_table_slots(const MalTable *table) {
    if (table == nullptr) return 0;
    return mal_table_size(table) * 4;
}

static u64 mal_gc_remembered_object_slots(const MalObject *object) {
    u64 slots = mal_object_fields(object) == nullptr ? 0
        : object->shape->inline_count
            + (u64) __builtin_popcountll(object->shape->heap_fields | object->shape->tagged_fields);
    return slots + mal_gc_remembered_table_slots(mal_object_overflow(object));
}

// --- Statistics helpers ----------------------------------------------------

static u64 mal_gc_pause_begin(MalVm *vm, bool major) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    mal_profile_event(vm, MAL_PROFILE_RECORD_GC_BEGIN, major ? 1 : 0);
    return start_ns;
}

static void mal_gc_pause_end(MalVm *vm, bool major, MalGcPauseReason reason, u64 start_ns) {
    mal_profile_event(vm, MAL_PROFILE_RECORD_GC_END, major ? 1 : 0);
    if (!g_gc->stats_enabled) return;
    u64 elapsed_ns = mal_monotonic_now_ns() - start_ns;
    g_gc->pause_count++;
    g_gc->total_ns += elapsed_ns;
    mal_gc_record_latency(&g_gc->pause_latency[reason], elapsed_ns);
    if (elapsed_ns > g_gc->max_pause_ns) g_gc->max_pause_ns = elapsed_ns;
    if (!major) {
        g_gc->minor_pause_ns += elapsed_ns;
        if (elapsed_ns > g_gc->max_minor_pause_ns) g_gc->max_minor_pause_ns = elapsed_ns;
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

/* Collect again only after another live-set of allocation, with a floor. */
static usize mal_gc_advance_trigger(MalVm *vm) {
    usize grow = vm->heap.live_bytes * 2;
    if (grow < MAL_GC_MIN_INCREMENT) {
        grow = MAL_GC_MIN_INCREMENT;
    }
    if (vm->heap.next_gc_at != (usize) -1) {
        vm->heap.next_gc_at = vm->heap.bytes_allocated + grow;
    }
    return grow;
}

/* A major flips color; a minor traces young cells from roots and remembered owners. */
static void mal_gc_collect_sync(MalVm *vm, bool major) {
    usize live_before = vm->heap.live_bytes;
    u64 minor_mark_start = g_gc->stats_enabled && !major ? mal_monotonic_now_ns() : 0;
    g_gc->grey_count = 0;
    g_gc->weak_maps_count = 0;
    g_gc->weak_sets_count = 0;
    g_gc->weak_refs_count = 0;
    g_gc->fin_regs_count = 0;
    g_gc->major_collection = major;

    if (major) {
        mal_gc_clear_remembered();
        mal_heap_begin_major(&vm->heap);
    }
    // Both collection kinds promote their survivors to old.

    mal_gc_scan_roots(vm);
    if (!major) {
        // Trace each remembered old cell's edges to reach (and mark) its young
        // children; the old cell itself stays claimed, so the old
        // generation is not re-marked. mal_gc_trace_cell also (re-)registers weak
        // collections it reaches, so a dirtied old WeakMap's dead young keys are
        // still cleaned this cycle.
        if (!g_gc->stats_enabled) {
            for (usize i = 0; i < g_gc->remembered_count; ++i) {
                mal_gc_trace_cell(g_gc->remembered[i]);
            }
        } else {
            for (usize i = 0; i < g_gc->remembered_count; ++i) {
                MalHeapHeader *owner = g_gc->remembered[i];
                u32 array_scan_start = owner->type == MAL_HEAP_ARRAY_OBJECT
                    ? ((MalArrayObject *) owner)->minor_scan_start : 0;
                usize grey_before = g_gc->grey_count;
                mal_gc_trace_cell(owner);
                u64 discoveries = g_gc->grey_count - grey_before;
                g_gc->minor_remembered_owners++;
                g_gc->minor_remembered_discoveries += discoveries;
                if (owner->type == MAL_HEAP_ARRAY_OBJECT) {
                    MalArrayObject *array = (MalArrayObject *) owner;
                    u64 slots = mal_gc_remembered_object_slots(&array->object) +
                        (array->elements == nullptr ? 0 : array->dense_count -
                            (array_scan_start <= array->dense_count ? array_scan_start : 0));
                    g_gc->minor_remembered_container_slots += slots;
                    g_gc->minor_remembered_array_owners++;
                    g_gc->minor_remembered_array_slots += slots;
                    g_gc->minor_remembered_array_discoveries += discoveries;
                } else if (owner->type == MAL_HEAP_MAP_OBJECT) {
                    MalMapObject *map = (MalMapObject *) owner;
                    u64 slots = mal_gc_remembered_object_slots(&map->object) +
                        mal_map_storage_traced_slots(map->entries);
                    g_gc->minor_remembered_container_slots += slots;
                    g_gc->minor_remembered_map_owners++;
                    g_gc->minor_remembered_map_slots += slots;
                    g_gc->minor_remembered_map_discoveries += discoveries;
                } else if (owner->type == MAL_HEAP_SET_OBJECT) {
                    MalSetObject *set = (MalSetObject *) owner;
                    u64 slots = mal_gc_remembered_object_slots(&set->object) +
                        mal_set_storage_traced_slots(set->entries);
                    g_gc->minor_remembered_container_slots += slots;
                    g_gc->minor_remembered_map_owners++;
                    g_gc->minor_remembered_map_slots += slots;
                    g_gc->minor_remembered_map_discoveries += discoveries;
                } else if (owner->type == MAL_HEAP_WEAK_MAP_OBJECT || owner->type == MAL_HEAP_WEAK_SET_OBJECT) {
                    u64 slots = mal_gc_remembered_object_slots((MalObject *) owner);
                    g_gc->minor_remembered_container_slots += slots;
                    g_gc->minor_remembered_map_owners++;
                    g_gc->minor_remembered_map_slots += slots;
                    g_gc->minor_remembered_map_discoveries += discoveries;
                }
            }
        }
    }
    mal_gc_drain();

    mal_gc_weak_pass();

    u64 minor_sweep_start = g_gc->stats_enabled && !major ? mal_monotonic_now_ns() : 0;
    if (minor_sweep_start != 0) g_gc->minor_mark_ns += minor_sweep_start - minor_mark_start;

    if (!major) {
        mal_heap_sweep_minor(&vm->heap, mal_gc_finalize_cell);
        if (g_gc->stats_enabled) {
            g_gc->minor_cells_inspected = vm->heap.minor_cells_inspected;
            g_gc->minor_blocks_inspected = vm->heap.minor_blocks_inspected;
        }
    } else
    {
        mal_heap_sweep(&vm->heap, mal_gc_finalize_cell);
    }
    if (minor_sweep_start != 0) {
        g_gc->minor_sweep_ns += mal_monotonic_now_ns() - minor_sweep_start;
    }
    if (major) {
        g_gc->last_major_live_bytes = vm->heap.live_bytes;
        g_gc->promotion_debt = 0;
    } else if (vm->heap.live_bytes > live_before) {
        usize promoted = vm->heap.live_bytes - live_before;
        g_gc->promotion_debt += promoted;
        g_gc->promoted_bytes += promoted;
    }

    mal_gc_clear_remembered();
    g_gc->major_collection = false;

    if (g_gc->verify_enabled) {
        mal_gc_verify(vm);
    }

    mal_gc_advance_trigger(vm);

	if (g_gc->stats_enabled) {
        g_gc->collections++;
        mal_gc_stat_peak_live(vm);
        if (major) {
            g_gc->major_count++;
        } else {
            g_gc->minor_count++;
        }
	}
}


// ===========================================================================
// Incremental major collector.
//
// The mutator owns roots, weak processing, and sweep; eligible major-mark tasks
// may run on native workers between safepoints. Minors park JavaScript, trace inline,
// and do not start while a major cycle is in flight. Black allocation over-tenures
// mid-cycle allocations (accepted, counted). Roots are SATB-exempt: init-mark and
// remark re-scan them, so both pauses are O(roots), never O(heap).
// ===========================================================================

/* Flipping the major color makes old marks stale without a heap-wide reset. */
static void mal_gc_cycle_begin(MalVm *vm) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    g_gc->grey_count = 0;
    g_gc->weak_maps_count = 0;
    g_gc->weak_sets_count = 0;
    g_gc->weak_refs_count = 0;
    g_gc->fin_regs_count = 0;
    g_gc->satb_count = 0;
    g_gc->satb_drained = 0;

    mal_gc_clear_remembered();
    mal_heap_begin_major(&vm->heap);
    g_gc->major_collection = true;

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
    }
}

/* The remark pause: drain the remaining SATB + grey to empty, re-scan roots (they
 * are SATB-exempt), run the weak/ephemeron pass, then clear marking and hand off
 * to the incremental sweep. O(roots + floating snapshot), not O(heap). */
static void mal_gc_cycle_remark(MalVm *vm) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
#if !defined(__wasi__)
    u64 wait_start = g_gc->stats_enabled && g_gc->worker_batch_active
        ? mal_monotonic_now_ns() : 0;
    u64 worker_wait_before = g_gc->worker_wait_ns;
    mal_gc_workers_collect_batch(g_gc, true);
    if (wait_start != 0) {
        g_gc->remark_join_ns += mal_monotonic_now_ns() - wait_start;
        g_gc->remark_wait_ns += g_gc->worker_wait_ns - worker_wait_before;
    }
#endif

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
    // born during sweeping is retained.
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
    }
}

/* Finish an in-flight cycle's sweep and close it out: reset the sticky flag,
 * clear the remembered set, disable black allocation, run verify (cycle end), and
 * advance the trigger. Called both by the incremental sweep on completion and by
 * the synchronous-finish path (which sweeps everything remaining first). */
static void mal_gc_cycle_finish_sweep(MalVm *vm) {
    mal_gc_clear_remembered();
    mal_gc_black_alloc = false;
    g_gc->phase = MAL_GC_PHASE_IDLE;
    g_gc->major_collection = false;
    g_gc->last_major_live_bytes = vm->heap.live_bytes;
    g_gc->promotion_debt = 0;

    if (g_gc->verify_enabled) {
        mal_gc_verify(vm);
    }
    mal_gc_advance_trigger(vm);

    if (g_gc->stats_enabled) {
        g_gc->collections++;
        g_gc->major_count++; // an incremental cycle is always a major
        mal_gc_stat_peak_live(vm);
    }
}

/* One incremental mark step: drain up to `budget` grey/SATB entries. Returns true
 * when marking is drained to empty (time to remark). */
static bool mal_gc_mark_step(MalVm *vm, usize budget) {
    u64 start_ns = g_gc->stats_enabled ? mal_monotonic_now_ns() : 0;
    if (g_gc->stats_enabled) g_gc->in_mark_step = true;
    usize worked = 0;
#if !defined(__wasi__)
    if (!mal_gc_workers_collect_batch(g_gc, false)) {
        while (worked < budget && worked < 256 && g_gc->grey_count > 0) {
            mal_gc_trace_cell(g_gc->grey[--g_gc->grey_count]);
            worked++;
        }
        if (g_gc->stats_enabled) g_gc->mutator_assist_traces += worked;
        goto finish_mark_step;
    }
#endif
    while (worked < budget) {
#if !defined(__wasi__)
        if (g_gc->grey_count > 0) {
            usize batch_work = 0;
            bool dispatched = mal_gc_trace_concurrent_batch(budget - worked, &batch_work);
            worked += batch_work;
            if (dispatched) goto finish_mark_step;
            if (batch_work > 0) continue;
        }
#endif
        if (g_gc->grey_count > 0) {
            worked += mal_gc_trace_grey_batch(budget - worked);
        } else if (g_gc->satb_drained < g_gc->satb_count) {
            mal_gc_mark_value(g_gc->satb[g_gc->satb_drained++]);
            worked++;
        } else {
            break; // nothing left to do this step
        }
    }
#if !defined(__wasi__)
finish_mark_step:
#endif
    bool drained = g_gc->grey_count == 0 && g_gc->satb_drained >= g_gc->satb_count;
#if !defined(__wasi__)
    drained = drained && !g_gc->worker_batch_active;
#endif
    g_gc->bytes_at_last_step = vm->heap.bytes_allocated;
    if (g_gc->stats_enabled) {
        u64 elapsed = mal_monotonic_now_ns() - start_ns;
        mal_gc_record_latency(&g_gc->mark_step_latency, elapsed);
        if (elapsed > g_gc->max_mark_step_ns) {
            g_gc->max_mark_step_ns = elapsed;
        }
        g_gc->in_mark_step = false;
    }
    return drained;
}

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
    }
    return done;
}

/* Finish an in-flight cycle when the allocation backstop or explicit gc() needs
 * a completed collection before the next bounded safepoint step. */
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

bool mal_gc_finish_pending_cycle(MalVm *vm) {
    if (g_gc_vm != vm) abort();
    if (vm->gc_native_frames != 0 || g_gc->phase == MAL_GC_PHASE_IDLE) return false;
    u64 start_ns = mal_gc_pause_begin(vm, true);
    mal_gc_cycle_finish_sync(vm);
    mal_gc_pause_end(vm, true, MAL_GC_PAUSE_FINISH_PENDING, start_ns);
    return true;
}

/* The explicit "collect now, completely and synchronously" entry (host gc() hook,
 * teardown). A complete collection is what the caller expects: if a cycle is
 * mid-flight, finish it synchronously FIRST — but that cycle's snapshot may retain
 * objects that died after it began (SATB floating garbage) — and then run a fresh
 * synchronous major, which snapshots the CURRENT roots and reclaims that floating
 * garbage too. So gc() matches the STW collector's "reclaim everything dead now". */
void mal_gc_collect(MalVm *vm) {
    if (g_gc_vm != vm) abort();
    u64 start_ns = mal_gc_pause_begin(vm, true);
    g_gc->collection_index++;
    if (g_gc->phase != MAL_GC_PHASE_IDLE) {
        mal_gc_cycle_finish_sync(vm);
    }
    mal_gc_collect_sync(vm, true); // fresh full major over the current snapshot
    mal_gc_pause_end(vm, true, MAL_GC_PAUSE_EXPLICIT, start_ns);
}

/* Advance an in-flight cycle by one step, or (if idle) decide whether a collection
 * is due and start one. Returns having done at most one bounded unit of GC work.
 * The pacer: the assist budget is proportional to bytes allocated since the last
 * mark step, so marking outruns allocation; the hard backstop finishes the cycle
 * synchronously if allocation reaches the heap trigger first. */
static MalGcPauseReason mal_gc_cycle_advance(MalVm *vm, usize mark_budget) {
    switch (g_gc->phase) {
        case MAL_GC_PHASE_MARK: {
            // Hard backstop: if allocation has reached the old STW trigger before the
            // cycle finished, finish it synchronously rather than float garbage.
            if (vm->heap.bytes_allocated >= g_gc->backstop_at) {
                mal_gc_cycle_finish_sync(vm);
                if (g_gc->stats_enabled) g_gc->sync_backstop++;
                return MAL_GC_PAUSE_BACKSTOP;
            }
            if (mal_gc_mark_step(vm, mark_budget)) {
                mal_gc_cycle_remark(vm); // marking drained → remark + open the sweep
            }
            return MAL_GC_PAUSE_MAJOR_SLICE;
        }
        case MAL_GC_PHASE_SWEEP: {
            if (mal_gc_sweep_step(vm)) {
                mal_gc_cycle_finish_sweep(vm);
            }
            return MAL_GC_PAUSE_MAJOR_SLICE;
        }
        default:
            return MAL_GC_PAUSE_MAJOR_SLICE;
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
    if (g_gc->process_pressure && budget <= SIZE_MAX / 2) budget *= 2;
    return budget;
}

static void mal_gc_incremental_safepoint(MalVm *vm) {
    if (g_gc_vm != vm) abort();
    bool polled = mal_gc_poll;
    if (g_gc->stress_interval == 0) {
#if defined(__wasi__)
        mal_gc_poll = false;
#else
        // Clear before taking pressure so a concurrent request keeps its next poll.
        polled = atomic_exchange_explicit(&mal_gc_poll, false, memory_order_acquire);
#endif
    }
    bool pressure = mal_gc_process_take_pressure(g_gc->process);
    if (pressure) g_gc->process_pressure = true;

    // Stress collection completes at each selected safepoint, preserving the
    // diagnostic's ability to expose a missing root at that exact boundary.
    if (g_gc->stress_interval != 0) {
        if (++g_gc->stress_counter >= g_gc->stress_interval) {
            g_gc->stress_counter = 0;
            bool major = (g_gc->collection_index++ % g_gc->major_every) == 0;
            u64 start_ns = mal_gc_pause_begin(vm, major);
            mal_gc_collect_sync(vm, major);
            mal_gc_pause_end(vm, major,
                major ? MAL_GC_PAUSE_STRESS_MAJOR : MAL_GC_PAUSE_STRESS_MINOR, start_ns);
        }
        return;
    }

    if (g_gc->phase != MAL_GC_PHASE_IDLE) {
        u64 start_ns = mal_gc_pause_begin(vm, true);
        MalGcPauseReason reason;
        if (pressure) {
            // Native reservations can grow without reaching the heap's allocation backstop.
            mal_gc_cycle_finish_sync(vm);
            if (g_gc->stats_enabled) g_gc->sync_backstop++;
            reason = MAL_GC_PAUSE_BACKSTOP;
        } else {
            reason = mal_gc_cycle_advance(vm, mal_gc_mark_budget(vm));
        }
        if (g_gc->phase == MAL_GC_PHASE_IDLE) g_gc->process_pressure = false;
        mal_gc_pause_end(vm, true, reason, start_ns);
        return;
    }

    if (!polled && !pressure) {
        return;
    }
    if (!pressure && vm->heap.bytes_allocated < vm->heap.next_gc_at) {
        return; // polled for preemption only; nothing owed
    }

    // A collection is due. Decide minor vs. major by the generational cadence.
    bool major = pressure || (g_gc->collection_index % g_gc->major_every) == 0;
    if (!major) {
        // Minor: STW-inline, exactly as today (short by construction).
        g_gc->collection_index++;
        u64 start_ns = mal_gc_pause_begin(vm, false);
        mal_gc_collect_sync(vm, false);
        mal_gc_pause_end(vm, false, MAL_GC_PAUSE_MINOR, start_ns);
        return;
    }

    // A major starts an incremental cycle with a hard allocation backstop.
    g_gc->collection_index++;
    // Start an incremental major cycle. The backstop is one more growth increment of
    // headroom (a full ~live-set of allocation) in which to finish incrementally;
    // reaching it forces a synchronous finish.
    usize grow = vm->heap.live_bytes * 2;
    if (grow < MAL_GC_MIN_INCREMENT) {
        grow = MAL_GC_MIN_INCREMENT;
    }
    g_gc->backstop_at = vm->heap.bytes_allocated + grow;
    u64 start_ns = mal_gc_pause_begin(vm, true);
    mal_gc_cycle_begin(vm);
    mal_gc_pause_end(vm, true, MAL_GC_PAUSE_MAJOR_SLICE, start_ns);
}

static void gc_safepoint_step(MalVm *vm);

void mal_gc_safepoint(MalVm *vm) {
    gc_safepoint_step(vm);
    // Every path through the step may consume the poll; termination must stay observable.
    if (mal_gc_termination) mal_gc_poll = true;
}

static void gc_safepoint_step(MalVm *vm) {
    // Only safe to collect when no native builtin is active: its C-local scratch
    // is not enumerable as a root, so collecting inside one could free values it
    // still holds. Compiled frames are fine (they publish root frames); all other
    // live state is in the interpreter frames + value stack, covered by the scan.
	if (vm->gc_native_frames != 0) {
		return;
	}
	mal_profile_safepoint(vm);
    if (g_gc_stats_owner && g_gc_stats_snapshot_requested != 0) {
        g_gc_stats_snapshot_requested = 0;
        mal_gc_print_stats_now();
    }
    mal_gc_incremental_safepoint(vm);
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
    if ((cell->mark & MAL_MARK_FREE) == 0) {
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
 * mal_heap_free does not. Managed large cells are included in the heap walk.
 * Call once, immediately before mal_heap_free. */
void mal_gc_finalize_all(MalVm *vm) {
    if (g_gc_vm != vm) abort();
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
    mal_gc_process_unregister(g->process);
    g->process = nullptr;
    free(g->grey);
    free(g->batch);
#if !defined(__wasi__)
    free(g->batch_edges);
    free(g->batch_edge_offsets);
    free(g->batch_edge_counts);
    if (g->worker_sync_initialized) {
        // Idempotent after begin_teardown; required when teardown skipped it.
        mal_executor_client_free(&g->helpers);
        for (usize i = 0; i < MAL_GC_WORKER_COUNT; ++i) {
            free(g->workers[i].discovered);
        }
        pthread_cond_destroy(&g->worker_done);
        pthread_mutex_destroy(&g->worker_mutex);
    }
#endif
    free(g->weak_maps);
    free(g->weak_sets);
    free(g->weak_refs);
    free(g->fin_regs);
    free(g->remembered);
    free(g->satb);
    // Snapshot the stats before freeing so the atexit printer (MAL_GC_STATS) still
    // reports after an explicit teardown; the snapshot's buffer pointers are stale
    // but the printer touches only scalar counters.
    mal_gc_stats_release(vm, g);
    free(g);
    vm->gc = nullptr;
    if (g_gc == g) {
        g_gc = nullptr;
        g_gc_vm = nullptr;
        mal_gc_marking_active = false;
        mal_gc_black_alloc = false;
        mal_gc_poll = false;
    }
}
