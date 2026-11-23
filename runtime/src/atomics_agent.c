#include "builtin_atomics.h"

// Per-isolate agent record. Each isolate runs on one mutator thread, so
// isolate-local storage is the agent's [[CanBlock]] and termination point.
// Native workers and the Test262 shell host opt in: a program's main agent keeps
// its event loop responsive, and threadless WASI has no agent that could notify.
MAL_ISOLATE_LOCAL bool mal_atomics_can_block = false;
MAL_ISOLATE_LOCAL MalSharedWaitInterrupt *mal_atomics_interrupt;
// Per isolate: only an isolate whose event loop installed the hook can settle
// its own waitAsync promises, and teardown clears it before the loop is freed.
MAL_ISOLATE_LOCAL MalAtomicsWaitAsyncHook mal_atomics_wait_async_hook;

void mal_atomics_set_agent(bool can_block, MalSharedWaitInterrupt *interrupt) {
#if defined(__wasi__)
    (void) can_block;
#else
    mal_atomics_can_block = can_block;
#endif
    mal_atomics_interrupt = interrupt;
}

void mal_atomics_set_wait_async_hook(MalAtomicsWaitAsyncHook hook) {
    mal_atomics_wait_async_hook = hook;
}
