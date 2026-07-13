#pragma once

#include "./defaults.h"
#include "gc.h"
#include "vm.h"

/*
 * Fibers — the stackful execution unit of the isolate scheduler (isolate_todo.md
 * Phase 0). Each fiber owns its own C stack, so a running fiber can be preempted
 * at any safepoint (mal_gc_poll site) by switching stacks back to the scheduler,
 * and resumed later. This is what makes actors "preemptively fair, CPU-bound
 * friendly": a tight compute loop still hits the poll sites the compiler already
 * emits at loop back-edges / call returns, and yields there.
 *
 * A fiber also owns the per-execution slice of VM state (value stack, interpreter
 * frames, native-frame trace stack, completion, GC root chains, C-stack limit).
 * On a context switch the scheduler swaps this slice in/out of the shared MalVm
 * (the isolate), so the thousands of `vm->value_stack` / `vm->frames` accesses in
 * the builtins need no change — the live MalVm always reflects the running fiber.
 *
 * GC correctness: the collector runs only at a safepoint, i.e. only in the
 * currently-running fiber (whose roots live in the MalVm + the global root
 * chains). Every *suspended* fiber's roots live in its saved slice + its own
 * (preserved) C stack, and are enumerated by walking the isolate's fiber list —
 * see mal_gc_scan_roots. Non-moving GC is load-bearing here: a suspended fiber's
 * C-stack pointers and root-span records stay valid across a collection.
 */

typedef enum MalFiberState {
    /* Created, never yet resumed (fresh stack awaiting bootstrap). */
    MAL_FIBER_NEW,
    /* Currently executing (== isolate's current_fiber). */
    MAL_FIBER_RUNNING,
    /* Suspended but wants to run again (in the scheduler run queue). */
    MAL_FIBER_RUNNABLE,
    /* Suspended waiting on an external event; a waker must re-enqueue it. */
    MAL_FIBER_BLOCKED,
    /* Entry function returned; awaiting reap by the scheduler. */
    MAL_FIBER_FINISHED,
} MalFiberState;

/*
 * The per-fiber slice of MalVm execution state. Field names mirror MalVm so the
 * save/restore is a literal field-by-field copy. When a fiber runs, THESE fields
 * are stale and the live values sit in MalVm; when it is suspended, the live
 * values were copied back here.
 */
typedef struct MalFiberExec {
    MalValue *value_stack;
    i32 value_stack_size;
    i32 value_stack_capacity;

    MalVmFrame *frames;
    i32 frame_count;
    i32 frame_capacity;

    MalNativeFrame *native_frames;
    i32 native_frame_count;
    i32 native_frame_capacity;

    i32 native_call_depth;
    uptr stack_limit;
    i32 gc_native_frames;
    u64 frame_seq;

    MalCompletion completion;

    /* The compiled-frame shadow stack + transient root spans for this fiber —
     * the globals mal_root_frame_head / mal_root_span_head while it runs. */
    MalRootFrame *root_frame_head;
    MalRootSpan *root_span_head;

#if MAL_REALMS
    /* The realm current when this fiber last ran. Restored on load through
     * mal_realm_switch so vm->current_realm, vm->intrinsics, and the heap's realm
     * cache all move together with the rest of the swapped-in execution slice. */
    MalRealm *current_realm;
#endif
} MalFiberExec;

typedef struct MalFiber {
    /* Saved stack pointer for mal_fiber_switch. Meaningless while RUNNING. */
    void *ctx_sp;

    MalFiberState state;

    /* The main fiber adopts the OS stack + the MalVm's pre-allocated exec buffers,
     * so it neither munmaps a stack nor frees those buffers on destroy. */
    bool is_main;

    /* Owned C stack (mmap'd), or null for the main fiber (adopts the OS stack). */
    void *stack_base;
    usize stack_size;

    /* Entry point run on first resume (ignored for the main fiber). */
    void (*entry)(void *arg);
    void *arg;

    /* Cooperative-preemption budget: decremented per safepoint, yields at <= 0. */
    i32 reductions_left;

    MalFiberExec exec;

    /* Isolate-wide list of all live fibers (for GC root enumeration). */
    struct MalFiber *next;
    /* Scheduler run-queue link (intrusive, singly-linked FIFO). */
    struct MalFiber *rq_next;
} MalFiber;

/* Default owned C-stack size for a spawned fiber. Lazy-committed on 64-bit
 * (reserved virtual, pages faulted in on use), so the reservation is cheap. */
#define MAL_FIBER_DEFAULT_STACK_SIZE ((usize) 256 * 1024)
/* Default per-fiber value-stack capacity (entries). Much smaller than the main
 * fiber's — spawned fibers are not expected to reach deep interpreter recursion.
 * Right-sizing / pooling this is a documented Phase-3 follow-up. */
#define MAL_FIBER_DEFAULT_VALUE_STACK 8192

/* The running fiber (isolate-local; set on every switch-in). TODO(SMP): make
 * _Thread_local when schedulers run on OS threads. */
extern MalFiber *mal_current_fiber;

/* Set by the scheduler: invoked by the bootstrap when a fiber's entry returns to
 * hand control back to the scheduler. Never returns to the bootstrap. */
extern void (*mal_fiber_exit_hook)(MalFiber *finished);

/* Raw stack switch (aarch64 / x86_64), defined in fiber.c module-level asm.
 * Saves callee-saved registers of the current context onto its stack, stores the
 * resulting SP into *from_sp, loads *to_sp, restores, and returns into it. */
void mal_fiber_switch(void **from_sp, void **to_sp);

/* Create a fresh fiber with its own stack, registered on the isolate's fiber
 * list. It runs `entry(arg)` the first time it is resumed. */
MalFiber *mal_fiber_create(
    MalVm *vm, void (*entry)(void *), void *arg, usize stack_size, i32 value_stack_capacity);

/* Initialize the main fiber in place: it adopts the OS stack and the MalVm's
 * already-allocated exec buffers (value_stack, frames). Registered on the list. */
void mal_fiber_init_main(MalFiber *main_fiber, MalVm *vm);

/* Reap a FINISHED (or otherwise dead) fiber: unlink from the isolate list, free
 * its owned buffers and stack. Must not be called on the running fiber. */
void mal_fiber_destroy(MalVm *vm, MalFiber *fiber);

/* Copy the live per-fiber slice out of MalVm into `fiber` (call before switching
 * away from it) / from `fiber` into MalVm (call before switching into it). These
 * also move the global root-chain heads. */
void mal_fiber_save_exec(MalFiber *fiber, MalVm *vm);
void mal_fiber_load_exec(MalFiber *fiber, MalVm *vm);

/* Entry trampoline target (module-level asm return address points here). Reads
 * the isolate's current_fiber, runs its entry, marks it FINISHED, and returns to
 * the scheduler. Never returns to its caller. Declared here only so the asm can
 * reference it; not for general use. */
void mal_fiber_bootstrap(void);
