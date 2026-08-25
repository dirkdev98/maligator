#include "vm.h"

#include <stdio.h>
#include <time.h>

#include "argon2.h"
#include "host.h"
#include "node_crypto.h"
#include "node_immediate.h"
#include "web_host_timer.h"

/*
 * Host entry for the asynchronous Argon2 start-failure fixture.
 *
 * The two transient conditions a `crypto.argon2` caller has to survive — no
 * worker available, and a full queue — are host states, not JavaScript ones:
 * neither can be produced from the fixture, and the default pool (two workers,
 * a 64-job queue) will not reach either without a pathological amount of real
 * derivation. So this driver stands the same host up with a one-worker,
 * one-slot pool whose derivation is deliberately slow, and arms the pool to
 * come up empty exactly once.
 *
 * Otherwise identical to host_main.c: the fixture runs on a real event loop and
 * reports through the usual RESULT protocol.
 */

extern const MalProgramImage mal_vm_definition;

/* Long enough that a burst of synchronous calls cannot drain through it, short
 * enough that the two jobs the pool does accept cost half a second. */
#define CRYPTO_START_DERIVE_NANOS 250000000L

/* Stands in for a real derivation: holds the single worker so the queue is full
 * for the rest of the burst, then writes a deterministic tag. */
static i32 crypto_start_slow_derive(
    const MalArgon2Params *params, byte *out, usize out_len, void *data) {
    (void) data;
    struct timespec delay = {.tv_sec = 0, .tv_nsec = CRYPTO_START_DERIVE_NANOS};
    (void) nanosleep(&delay, nullptr);
    for (usize i = 0; i < out_len; i++) {
        out[i] = (byte) (params->message_len + (byte) i);
    }
    return 0;  // MAL_ARGON2_STATUS_OK
}

int main(int argc, char **argv) {
    setvbuf(stdout, nullptr, _IOLBF, 0);

    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    mal_host_attach(&vm);

    MalHost *host = mal_host(&vm);
    MalArgon2Config config = {
        .worker_count = 1,
        .queue_capacity = 1,
        .derive = crypto_start_slow_derive,
    };
    if (host == nullptr || !mal_argon2_configure(&host->argon2, &config)) {
        printf("FAIL: could not configure the argon2 pool\n");
        printf("RESULT 0/1\n");
        return 1;
    }
    // Consumed by the fixture's first call, which must reach its callback with
    // "Argon2 worker unavailable" rather than throwing.
    mal_argon2_test_fail_next_pool_start(&host->argon2);

    MalObject *global_this = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install(&vm, global_this);
    mal_node_immediates_install(&vm, global_this);

    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_host_run_event_loop(&vm);

    return vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
}
