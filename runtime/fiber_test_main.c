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

/*
 * Fiber-foundation acceptance test. Drives the fiber scheduler on a real
 * isolate and asserts the three properties Phase 0 must deliver:
 *
 *   1. Fibers actually interleave under preemption (a CPU loop that only hits
 *      safepoints still yields — "preemptively fair").
 *   2. A value allocated + rooted in one fiber survives GCs that run while that
 *      fiber is SUSPENDED (the new suspended-fiber root scan is correct).
 *   3. Every fiber runs to completion and the VM tears down cleanly.
 *
 * Run under MAL_GC_STRESS=1 + MAL_GC_VERIFY=1 for the strong version: a collection
 * fires at every safepoint (so GCs land while peers are suspended) and swept cells
 * are poisoned (so a missed root corrupts the held string loudly).
 *
 * The emitted `mal_runtime_image` (a trivial compiled program) is used only to
 * stand up a real VM with intrinsics + heap; its program body is never run.
 */

extern const MalRuntimeImage mal_runtime_image;

#define FIBER_COUNT 4
#define ITER_PER_FIBER 12
#define PREEMPT_BUDGET 3

static MalVm *g_vm;

/* Execution log: each safepoint step records its fiber id, so we can prove the
 * fibers were interleaved rather than each run to completion. */
static int g_log[FIBER_COUNT * ITER_PER_FIBER];
static int g_log_len = 0;

static int g_finished = 0;    /* fibers that ran their entry to completion */
static int g_corruptions = 0; /* held-string mismatches after a GC */

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
        if (s->code_units[i] != (c16) (unsigned char) bytes[i]) {
            return false;
        }
    }
    return true;
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

    for (int i = 0; i < ITER_PER_FIBER; i++) {
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

        if (!string_matches(held, payload, len)) {
            g_corruptions++;
        }
    }

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
