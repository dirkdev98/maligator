#include "vm.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fiber.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "scheduler.h"
#include "value.h"
#include "vm_ops.h"

/*
 * Fiber-foundation acceptance test. Drives the fiber scheduler on a real
 * isolate and asserts the four properties Phase 0 must deliver:
 *
 *   1. Fibers actually interleave under preemption (a CPU loop that only hits
 *      safepoints still yields — "preemptively fair").
 *   2. A value allocated + rooted in one fiber survives GCs that run while that
 *      fiber is SUSPENDED (the new suspended-fiber root scan is correct).
 *   3. Every fiber runs to completion and the VM tears down cleanly.
 *   4. Runtime eval can relocate the function table while a peer's interpreter
 *      frame is suspended without invalidating its GC scan or later resume.
 *
 * Run under MAL_GC_STRESS=1 + MAL_GC_VERIFY=1 for the strong version: a collection
 * fires at every safepoint (so GCs land while peers are suspended) and swept cells
 * are poisoned (so a missed root corrupts the held string loudly).
 *
 * The emitted `mal_runtime_image` (a trivial compiled program) stands up a real
 * VM and supplies the interpreter function used by the suspended-frame case;
 * its program body is never run.
 */

extern const MalRuntimeImage mal_runtime_image;

#define FIBER_COUNT 4
#define ITER_PER_FIBER 12
#define PREEMPT_BUDGET 3
#define SPLICE_FUNCTION_COUNT 8192

static MalVm *g_vm;

/* Execution log: each safepoint step records its fiber id, so we can prove the
 * fibers were interleaved rather than each run to completion. */
static int g_log[FIBER_COUNT * ITER_PER_FIBER];
static int g_log_len = 0;

static int g_finished = 0;    /* fibers that ran their entry to completion */
static int g_corruptions = 0; /* held-string mismatches after a GC */
static bool g_suspended_frame_ready = false;
static bool g_splice_completed = false;
static bool g_splice_reallocated = false;
static bool g_suspended_root_survived = false;
static bool g_suspended_frame_rebound = false;
static bool g_suspended_callback_rebound = false;
static bool g_suspended_numeric_callbacks_rebound = false;
static int g_callback_context_corruptions = 0;

static MalValue exact_probe_callback(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalEnv *env, MalValue callee,
    void *entry_state
) {
    (void) vm;
    (void) this_value;
    (void) new_target;
    (void) env;
    (void) callee;
    (void) entry_state;
    return arg_count > 0 ? args[0] : MAL_VALUE_UNDEFINED;
}

static f64 exact_probe_reduce(
    MalVm *vm, MalValue this_value, f64 accumulator, f64 value, f64 index,
    MalValue receiver, MalEnv *env, MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) env;
    return receiver == callee ? accumulator + value + index : -1;
}

static f64 exact_probe_compare(
    MalVm *vm, MalValue this_value, f64 left, f64 right, MalEnv *env, MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) env;
    (void) callee;
    return left - right;
}

/* Build the unique payload a fiber holds across its whole lifetime. */
static int make_payload(intptr_t id, byte *buf, int cap) {
    int n = snprintf(buf, (size_t) cap, "fiber-%ld-payload-0123456789", (long) id);
    return n;
}

/* Verify a held string value still matches its original ASCII bytes. Under
 * MAL_GC_VERIFY a swept-then-poisoned cell fails this (or crashes reading it). */
static bool string_matches(MalValue value, const byte *bytes, int length) {
    if (!mal_value_is_string(value)) {
        return false;
    }
    MalString *s = mal_value_to_string(value);
    if ((int) mal_string_length(s) != length) {
        return false;
    }
    for (int i = 0; i < length; i++) {
        if (mal_string_code_unit_at(s, (usize) i) != (c16) (unsigned char) bytes[i]) {
            return false;
        }
    }
    return true;
}

static void suspended_frame_worker(void *arg) {
    (void) arg;
    const MalFunction *functions = g_vm->live_runtime_image.functions;
    if (g_vm->live_runtime_image.function_count <= 0 ||
        functions[0].kind != MAL_FUNCTION_KIND_NORMAL ||
        functions[0].register_count <= 0) {
        return;
    }

    i32 previous_frame_count = g_vm->frame_count;
    if (!mal_vm_push_function_frame(
            g_vm,
            0,
            nullptr,
            mal_value_new_undefined(),
            0,
            -1,
            -1)) {
        return;
    }

    static const byte payload[] = "suspended-frame-root-0123456789";
    MalVmFrame *frame = &g_vm->frames[g_vm->frame_count - 1];
    frame->registers[0] = mal_value_from_string(
        mal_string_new_ascii(&g_vm->heap, payload, sizeof(payload) - 1));
    MalValue callback = mal_vm_op_create_function(g_vm, 0, nullptr);
    MalRootSpan callback_root;
    mal_gc_root(&callback_root, &callback, 1);
    MalExactScriptCall exact = {
        .previous = g_vm->exact_script_call,
        .callee = callback,
        .function_index = 0,
        .compiled_callback = exact_probe_callback,
        .numeric_reduce_callback = exact_probe_reduce,
        .numeric_sort_comparator = exact_probe_compare,
    };
    g_vm->exact_script_call = &exact;
    g_suspended_frame_ready = true;
    mal_sched_yield();

    frame = &g_vm->frames[g_vm->frame_count - 1];
    g_suspended_root_survived = string_matches(
        frame->registers[0], payload, (int) sizeof(payload) - 1);
    g_suspended_frame_rebound =
        frame->function == &g_vm->live_runtime_image.functions[frame->function_index];
    if (g_vm->exact_script_call == &exact) {
        MalCompletion completion = mal_vm_call_builtin_callback(
            g_vm, callback, MAL_VALUE_UNDEFINED, &frame->registers[0], 1);
        g_suspended_callback_rebound = completion.kind == MAL_COMPLETION_NORMAL &&
            completion.value == frame->registers[0];
        f64 reduced = 0, compared = 0;
        g_suspended_numeric_callbacks_rebound = mal_vm_call_numeric_reduce_callback(
            g_vm, &exact, 7, 3, 2, callback, &reduced) && reduced == 12 &&
            mal_vm_try_numeric_sort_comparison(
                g_vm, callback, mal_ops_number_value(9), mal_ops_number_value(4), &compared)
                == MAL_NUMERIC_SORT_COMPLETE && compared == 5;
    }
    g_vm->exact_script_call = exact.previous;
    mal_gc_unroot(&callback_root);

    g_vm->value_stack_size = frame->stack_base;
    g_vm->frame_count = previous_frame_count;
}

static void splice_worker(void *arg) {
    (void) arg;
    if (!g_suspended_frame_ready) {
        return;
    }

    uptr old_function_table = (uptr) g_vm->live_runtime_image.functions;
    MalFunction *added = calloc(SPLICE_FUNCTION_COUNT, sizeof(MalFunction));
    if (added == nullptr) {
        return;
    }
    for (i32 i = 0; i < SPLICE_FUNCTION_COUNT; i++) {
        added[i].name_string_index = -1;
        added[i].argument_retention_limit = -1;
    }
    MalRuntimeImage loaded = {
        .functions = added,
        .function_count = SPLICE_FUNCTION_COUNT,
    };
    i32 expected_base = g_vm->live_runtime_image.function_count;
    i32 actual_base = mal_vm_splice_runtime_image(g_vm, &loaded);
    g_splice_completed = actual_base == expected_base;
    g_splice_reallocated =
        (uptr) g_vm->live_runtime_image.functions != old_function_table;
    free(added);

    if (g_splice_completed) {
        mal_gc_collect(g_vm);
    }
}

static void worker(void *arg) {
    intptr_t id = (intptr_t) arg;

    byte payload[64];
    int len = make_payload(id, payload, (int) sizeof(payload));

    /* Allocate a heap string and root it on this fiber's C stack for its whole
     * life. The root span links onto mal_root_span_head (this fiber's chain),
     * which is saved/restored across every yield. */
    MalValue held = mal_value_from_string(mal_string_new_ascii(&g_vm->heap, payload, (usize) len));
    MalRootSpan span;
    mal_gc_root(&span, &held, 1);
    if (g_vm->exact_script_call != nullptr) g_callback_context_corruptions++;
    MalValue callback = mal_vm_op_create_function(g_vm, 0, nullptr);
    MalRootSpan callback_root;
    mal_gc_root(&callback_root, &callback, 1);
    MalExactScriptCall outer = {
        .previous = g_vm->exact_script_call,
        .callee = callback,
        .function_index = 0,
        .compiled_callback = exact_probe_callback,
    };
    g_vm->exact_script_call = &outer;

    for (int i = 0; i < ITER_PER_FIBER; i++) {
        MalExactScriptCall nested = outer;
        nested.previous = &outer;
        g_vm->exact_script_call = &nested;
        if (g_log_len < (int) (sizeof(g_log) / sizeof(g_log[0]))) {
            g_log[g_log_len++] = (int) id;
        }

        /* Generate collectable garbage each step so the collector is genuinely
         * sweeping (not a no-op) while our `held` string must survive. */
        byte junk[16];
        int jn = snprintf(junk, sizeof(junk), "junk-%d", i);
        volatile MalValue garbage =
            mal_value_from_string(mal_string_new_ascii(&g_vm->heap, junk, (usize) jn));
        (void) garbage; /* deliberately unrooted -> reclaimable */

        if (!string_matches(held, payload, len)) {
            g_corruptions++;
        }

        /* Poll point: may collect (STRESS) and may preempt this fiber. */
        mal_gc_safepoint(g_vm);

        if (g_vm->exact_script_call != &nested) g_callback_context_corruptions++;
        else {
            MalCompletion completion = mal_vm_call_builtin_callback(
                g_vm, callback, MAL_VALUE_UNDEFINED, &held, 1);
            if (completion.kind != MAL_COMPLETION_NORMAL || completion.value != held)
                g_callback_context_corruptions++;
        }
        g_vm->exact_script_call = nested.previous;
        mal_sched_yield();
        if (g_vm->exact_script_call != &outer) g_callback_context_corruptions++;

        if (!string_matches(held, payload, len)) {
            g_corruptions++;
        }
    }

    g_vm->exact_script_call = outer.previous;
    mal_gc_unroot(&callback_root);
    mal_gc_unroot(&span);
    g_finished++;
}

/* Count maximal runs of a single fiber id in the log. If the fibers were never
 * preempted, each runs to completion => exactly FIBER_COUNT runs. More runs proves
 * interleaving happened. */
static int count_runs(void) {
    if (g_log_len == 0) {
        return 0;
    }
    int runs = 1;
    for (int i = 1; i < g_log_len; i++) {
        if (g_log[i] != g_log[i - 1]) {
            runs++;
        }
    }
    return runs;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_host_attach(&vm); // scheduler drives the host reactor (empty here)
    g_vm = &vm;

    MalScheduler sched;
    mal_sched_init(&sched, &vm);
    sched.default_budget = PREEMPT_BUDGET; /* force frequent preemption */

    mal_sched_spawn(&sched, suspended_frame_worker, nullptr);
    mal_sched_spawn(&sched, splice_worker, nullptr);
    for (intptr_t i = 0; i < FIBER_COUNT; i++) {
        mal_sched_spawn(&sched, worker, (void *) i);
    }

    mal_sched_run(&sched);
    mal_sched_shutdown();

    int runs = count_runs();
    int total_steps = g_log_len;

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"all fibers finished", g_finished == FIBER_COUNT},
        {"no root corruption", g_corruptions == 0},
        {"fibers interleaved (preemption)", runs > FIBER_COUNT},
        {"all steps executed", total_steps == FIBER_COUNT * ITER_PER_FIBER},
        {"eval splice completed while peer frame was suspended", g_splice_completed},
        {"eval splice reallocated the function table", g_splice_reallocated},
        {"suspended frame root survived splice-time GC", g_suspended_root_survived},
        {"suspended frame rebound after function-table relocation", g_suspended_frame_rebound},
        {"suspended exact callback survives function-table relocation", g_suspended_callback_rebound},
        {"suspended numeric callbacks survive function-table relocation", g_suspended_numeric_callbacks_rebound},
        {"nested exact callbacks remain local to each fiber", g_callback_context_corruptions == 0},
        {"main fiber restores its empty callback context", vm.exact_script_call == nullptr},
    };
    int total = (int) (sizeof(checks) / sizeof(checks[0]));
    int passed = 0;
    for (int i = 0; i < total; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("fibertest CHECK FAIL: %s\n", checks[i].name);
        }
    }
    printf(
        "fibertest: finished=%d/%d corruptions=%d runs=%d steps=%d\n",
        g_finished,
        FIBER_COUNT,
        g_corruptions,
        runs,
        total_steps);
    printf("fibertest PASS %d/%d\n", passed, total);

    /* Force a final collection then tear down, so leak/verify tooling sees a clean
     * exit and the collector is exercised with only the main fiber live. */
    mal_gc_collect(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);

    return passed == total ? 0 : 1;
}
