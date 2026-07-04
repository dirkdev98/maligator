#include "fiber.h"

#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/*
 * The running fiber (isolate-local). Set by mal_fiber_load_exec right before a
 * switch-in, so it is always the fiber about to run. TODO(SMP): _Thread_local
 * once schedulers run on OS threads (isolate_todo.md Phase 4).
 */
MalFiber *mal_current_fiber = nullptr;

/*
 * Set by the scheduler; invoked by the bootstrap when a fiber's entry returns, to
 * switch control back to the scheduler. Never returns to the bootstrap.
 */
void (*mal_fiber_exit_hook)(MalFiber *finished) = nullptr;

/* ---------------------------------------------------------------------------
 * Raw stack switch — module-level assembly.
 *
 * void mal_fiber_switch(void **from_sp, void **to_sp):
 *   push callee-saved regs of the current context, store SP -> *from_sp,
 *   load SP <- *to_sp, pop that context's callee-saved regs, ret into it.
 *
 * A fresh fiber is bootstrapped by hand-laying a fake saved-register frame on its
 * stack whose "return address" slot is mal_fiber_bootstrap (see mal_fiber_create),
 * so the first switch-in restores that frame and rets straight into the bootstrap.
 * --------------------------------------------------------------------------- */

#if defined(__APPLE__)
#define MAL_ASM_SYM(name) "_" #name
#else
#define MAL_ASM_SYM(name) #name
#endif

#if defined(__aarch64__)

/* Callee-saved: x19..x30 (12 GPRs) + d8..d15 (8 FPRs) = 160 bytes, 16-aligned. */
#define MAL_FIBER_FRAME_SIZE 160
#define MAL_FIBER_RET_OFFSET 88 /* x30 (lr) slot: stp x29,x30,[sp,#80] */

__asm__(
    ".text\n"
    ".p2align 2\n"
    ".globl " MAL_ASM_SYM(mal_fiber_switch) "\n" MAL_ASM_SYM(mal_fiber_switch) ":\n"
    "    stp x19, x20, [sp, #-160]!\n"
    "    stp x21, x22, [sp, #16]\n"
    "    stp x23, x24, [sp, #32]\n"
    "    stp x25, x26, [sp, #48]\n"
    "    stp x27, x28, [sp, #64]\n"
    "    stp x29, x30, [sp, #80]\n"
    "    stp d8,  d9,  [sp, #96]\n"
    "    stp d10, d11, [sp, #112]\n"
    "    stp d12, d13, [sp, #128]\n"
    "    stp d14, d15, [sp, #144]\n"
    "    mov x2, sp\n"
    "    str x2, [x0]\n" /* *from_sp = sp */
    "    ldr x2, [x1]\n" /* sp = *to_sp   */
    "    mov sp, x2\n"
    "    ldp x21, x22, [sp, #16]\n"
    "    ldp x23, x24, [sp, #32]\n"
    "    ldp x25, x26, [sp, #48]\n"
    "    ldp x27, x28, [sp, #64]\n"
    "    ldp x29, x30, [sp, #80]\n"
    "    ldp d8,  d9,  [sp, #96]\n"
    "    ldp d10, d11, [sp, #112]\n"
    "    ldp d12, d13, [sp, #128]\n"
    "    ldp d14, d15, [sp, #144]\n"
    "    ldp x19, x20, [sp], #160\n"
    "    ret\n");

#elif defined(__x86_64__)

/* Callee-saved: rbp, rbx, r12..r15 = 6 GPRs. We pad the fresh frame to 64 bytes
 * so ctx_sp stays 16-aligned; the return-address slot lands at offset 48. */
#define MAL_FIBER_FRAME_SIZE 64
#define MAL_FIBER_RET_OFFSET 48

__asm__(
    ".text\n"
    ".p2align 4\n"
    ".globl " MAL_ASM_SYM(mal_fiber_switch) "\n" MAL_ASM_SYM(mal_fiber_switch) ":\n"
    "    pushq %rbp\n"
    "    pushq %rbx\n"
    "    pushq %r12\n"
    "    pushq %r13\n"
    "    pushq %r14\n"
    "    pushq %r15\n"
    "    movq %rsp, (%rdi)\n" /* *from_sp = rsp */
    "    movq (%rsi), %rsp\n" /* rsp = *to_sp   */
    "    popq %r15\n"
    "    popq %r14\n"
    "    popq %r13\n"
    "    popq %r12\n"
    "    popq %rbx\n"
    "    popq %rbp\n"
    "    ret\n");

#else
#error "mal_fiber_switch: unsupported architecture (need aarch64 or x86_64)"
#endif

/* ---------------------------------------------------------------------------
 * Bootstrap: the return target baked into a fresh fiber's fake frame.
 * --------------------------------------------------------------------------- */

void mal_fiber_bootstrap(void) {
    MalFiber *self = mal_current_fiber;
    self->state = MAL_FIBER_RUNNING;
    self->entry(self->arg);
    self->state = MAL_FIBER_FINISHED;
    /* Hand control back to the scheduler; must not return here (this stack is
     * about to be reaped). */
    if (mal_fiber_exit_hook != nullptr) {
        mal_fiber_exit_hook(self);
    }
    __builtin_trap();
}

/* ---------------------------------------------------------------------------
 * Lifecycle.
 * --------------------------------------------------------------------------- */

/* Approximate per-fiber C-stack safety margin for the compiled-entry limit check.
 * The main fiber uses the real platform bound; spawned fibers get this. */
#define MAL_FIBER_STACK_MARGIN ((usize) 64 * 1024)
#define MAL_FIBER_DEFAULT_FRAMES 1024

static usize mal_fiber_page_round(usize n) {
    usize page = (usize) sysconf(_SC_PAGESIZE);
    return (n + page - 1) & ~(page - 1);
}

MalFiber *mal_fiber_create(
    MalVm *vm, void (*entry)(void *), void *arg, usize stack_size, i32 value_stack_capacity) {
    MalFiber *f = calloc(1, sizeof(MalFiber));
    f->entry = entry;
    f->arg = arg;
    f->state = MAL_FIBER_NEW;
    f->is_main = false;

    /* Owned C stack: mmap reserves the range; pages are faulted in lazily on
     * first touch (lazy-commit). A PROT_NONE guard page at the low end turns a
     * stack overflow into a fault instead of silent corruption. */
    usize page = (usize) sysconf(_SC_PAGESIZE);
    if (stack_size == 0) {
        stack_size = MAL_FIBER_DEFAULT_STACK_SIZE;
    }
    stack_size = mal_fiber_page_round(stack_size) + page /* guard */;
    void *base = mmap(
        nullptr, stack_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (base == MAP_FAILED) {
        free(f);
        return nullptr;
    }
    mprotect(base, page, PROT_NONE); /* guard page (stack grows down into it) */
    f->stack_base = base;
    f->stack_size = stack_size;

    /* Hand-lay the initial context frame at the top of the stack so the first
     * mal_fiber_switch restores it and rets into mal_fiber_bootstrap. */
    uptr top = (uptr) base + stack_size; /* page-aligned => 16-aligned */
    uptr frame = top - MAL_FIBER_FRAME_SIZE;
    memset((void *) frame, 0, MAL_FIBER_FRAME_SIZE);
    *(void **) (frame + MAL_FIBER_RET_OFFSET) = (void *) mal_fiber_bootstrap;
    f->ctx_sp = (void *) frame;

    /* Owned exec buffers (the per-fiber slice of VM state). */
    if (value_stack_capacity <= 0) {
        value_stack_capacity = MAL_FIBER_DEFAULT_VALUE_STACK;
    }
    f->exec.value_stack = malloc(sizeof(MalValue) * (usize) value_stack_capacity);
    f->exec.value_stack_capacity = value_stack_capacity;
    f->exec.value_stack_size = 0;
    f->exec.frames = malloc(sizeof(MalVmFrame) * MAL_FIBER_DEFAULT_FRAMES);
    f->exec.frame_capacity = MAL_FIBER_DEFAULT_FRAMES;
    f->exec.frame_count = 0;
    f->exec.native_frames = nullptr;
    f->exec.native_frame_count = 0;
    f->exec.native_frame_capacity = 0;
    f->exec.native_call_depth = 0;
    f->exec.stack_limit = (uptr) base + page + MAL_FIBER_STACK_MARGIN;
    f->exec.gc_native_frames = 0;
    f->exec.frame_seq = 0;
    f->exec.completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    f->exec.root_frame_head = nullptr;
    f->exec.root_span_head = nullptr;

    /* Register on the isolate's fiber list (for GC root enumeration). */
    f->next = vm->fibers_head;
    vm->fibers_head = f;
    return f;
}

void mal_fiber_init_main(MalFiber *main_fiber, MalVm *vm) {
    memset(main_fiber, 0, sizeof(*main_fiber));
    main_fiber->state = MAL_FIBER_RUNNING;
    main_fiber->is_main = true;
    main_fiber->stack_base = nullptr; /* adopts the OS stack */
    /* The main fiber runs first and owns the VM's already-allocated exec buffers.
     * Its saved slice is written lazily by the first save_exec (when we switch
     * away from it); we seed it now so a GC before any switch is still correct. */
    mal_fiber_save_exec(main_fiber, vm);

    main_fiber->next = vm->fibers_head;
    vm->fibers_head = main_fiber;
    vm->current_fiber = main_fiber;
    mal_current_fiber = main_fiber;
}

void mal_fiber_destroy(MalVm *vm, MalFiber *fiber) {
    /* Unlink from the isolate fiber list. */
    MalFiber **pp = &vm->fibers_head;
    while (*pp != nullptr && *pp != fiber) {
        pp = &(*pp)->next;
    }
    if (*pp == fiber) {
        *pp = fiber->next;
    }

    if (!fiber->is_main) {
        free(fiber->exec.value_stack);
        free(fiber->exec.frames);
        free(fiber->exec.native_frames);
    }
    if (fiber->stack_base != nullptr) {
        munmap(fiber->stack_base, fiber->stack_size);
    }
    if (!fiber->is_main) {
        free(fiber);
    }
}

/* ---------------------------------------------------------------------------
 * Exec-state save / restore (the "swap approach": keep MalVm field names, move
 * the per-fiber slice in and out around a switch so builtins are untouched).
 * --------------------------------------------------------------------------- */

void mal_fiber_save_exec(MalFiber *f, MalVm *vm) {
    f->exec.value_stack = vm->value_stack;
    f->exec.value_stack_size = vm->value_stack_size;
    f->exec.value_stack_capacity = vm->value_stack_capacity;
    f->exec.frames = vm->frames;
    f->exec.frame_count = vm->frame_count;
    f->exec.frame_capacity = vm->frame_capacity;
    f->exec.native_frames = vm->native_frames;
    f->exec.native_frame_count = vm->native_frame_count;
    f->exec.native_frame_capacity = vm->native_frame_capacity;
    f->exec.native_call_depth = vm->native_call_depth;
    f->exec.stack_limit = vm->stack_limit;
    f->exec.gc_native_frames = vm->gc_native_frames;
    f->exec.frame_seq = vm->frame_seq;
    f->exec.completion = vm->completion;
    f->exec.root_frame_head = mal_root_frame_head;
    f->exec.root_span_head = mal_root_span_head;
}

void mal_fiber_load_exec(MalFiber *f, MalVm *vm) {
    vm->value_stack = f->exec.value_stack;
    vm->value_stack_size = f->exec.value_stack_size;
    vm->value_stack_capacity = f->exec.value_stack_capacity;
    vm->frames = f->exec.frames;
    vm->frame_count = f->exec.frame_count;
    vm->frame_capacity = f->exec.frame_capacity;
    vm->native_frames = f->exec.native_frames;
    vm->native_frame_count = f->exec.native_frame_count;
    vm->native_frame_capacity = f->exec.native_frame_capacity;
    vm->native_call_depth = f->exec.native_call_depth;
    vm->stack_limit = f->exec.stack_limit;
    vm->gc_native_frames = f->exec.gc_native_frames;
    vm->frame_seq = f->exec.frame_seq;
    vm->completion = f->exec.completion;
    mal_root_frame_head = f->exec.root_frame_head;
    mal_root_span_head = f->exec.root_span_head;
    vm->current_fiber = f;
    mal_current_fiber = f;
}
