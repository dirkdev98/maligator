#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;
typedef struct MalRuntimeImage MalRuntimeImage;

/**
 * Give a Test262 driver VM the shell host the Atomics tests assume (an event
 * loop with timers and $262.agent) and install $262. `can_block` is the main
 * agent's [[CanBlock]]; started agents can always block. Agents build their VMs
 * from `agent_image`, which must stay loaded for the process lifetime. False
 * when the host cannot attach.
 */
bool mal_test262_attach_host(MalVm *vm, const MalRuntimeImage *agent_image, bool can_block);

/** Run the event loop until idle unless the test already threw. */
void mal_test262_run_event_loop(MalVm *vm);

/** Release the host before mal_vm_free. */
void mal_test262_detach_host(MalVm *vm);
