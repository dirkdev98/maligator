#include "vm.h"

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "argon2.h"
#include "host.h"
#include "host_task.h"
#include "mal_argon2.h"
#include "reactor.h"

/*
 * Host-layer Argon2 worker-pool acceptance test.
 *
 * The lifecycle properties this covers — exactly one terminal per operation,
 * reactor work retained for the whole derivation and released exactly once,
 * queue saturation, cancellation, and a shutdown that joins an in-flight job —
 * are not observable from JavaScript, so they live here.
 *
 * A gated derive hook stands in for the real Argon2 so the timing is
 * deterministic; the derivation itself is covered by the Rust known-answer
 * vectors and the JavaScript fixtures.
 */

extern const MalVmDefinition mal_vm_definition;

typedef struct Argon2Gate {
    pthread_mutex_t mutex;
    pthread_cond_t ready;
    bool block;
    bool entered;
    int calls;
    /* Set when a job observed inputs that did not match its own parameters. */
    bool mismatched;
} Argon2Gate;

static void argon2_gate_init(Argon2Gate *gate, bool block) {
    memset(gate, 0, sizeof(*gate));
    pthread_mutex_init(&gate->mutex, nullptr);
    pthread_cond_init(&gate->ready, nullptr);
    gate->block = block;
}

static void argon2_gate_free(Argon2Gate *gate) {
    pthread_cond_destroy(&gate->ready);
    pthread_mutex_destroy(&gate->mutex);
}

static void argon2_gate_wait_entered(Argon2Gate *gate) {
    pthread_mutex_lock(&gate->mutex);
    while (!gate->entered) {
        pthread_cond_wait(&gate->ready, &gate->mutex);
    }
    pthread_mutex_unlock(&gate->mutex);
}

static void argon2_gate_release(Argon2Gate *gate) {
    pthread_mutex_lock(&gate->mutex);
    gate->block = false;
    pthread_cond_broadcast(&gate->ready);
    pthread_mutex_unlock(&gate->mutex);
}

static void *argon2_delayed_gate_release(void *data) {
    struct timespec delay = {.tv_nsec = 10 * 1000000};
    while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {
    }
    argon2_gate_release(data);
    return nullptr;
}

/* Writes a tag derived only from this job's own message, so a result that
 * belonged to another job (or read freed input storage) is detectable. */
static i32 argon2_test_derive(
    const MalArgon2Params *params, byte *out, usize out_len, void *data) {
    Argon2Gate *gate = data;
    pthread_mutex_lock(&gate->mutex);
    gate->calls++;
    gate->entered = true;
    // The worker must see the copy it was given, never the caller's storage.
    if (params->message_len == 0 || params->message == nullptr
        || params->nonce_len < 8) {
        gate->mismatched = true;
    }
    pthread_cond_broadcast(&gate->ready);
    while (gate->block) {
        pthread_cond_wait(&gate->ready, &gate->mutex);
    }
    pthread_mutex_unlock(&gate->mutex);
    for (usize i = 0; i < out_len; i++) {
        out[i] = (byte) (params->message[i % params->message_len] + (byte) i);
    }
    return MAL_ARGON2_STATUS_OK;
}

typedef struct Argon2TestHost {
    MalHost storage;
    MalHost *host;
} Argon2TestHost;

static bool argon2_test_host_init(
    Argon2TestHost *context, Argon2Gate *gate, usize workers, usize queue_capacity) {
    context->host = mal_host_init(&context->storage) ? &context->storage : nullptr;
    MalArgon2Config config = {
        .worker_count = workers,
        .queue_capacity = queue_capacity,
        .max_memory_kib = 0,
        .derive = argon2_test_derive,
        .derive_data = gate,
    };
    return context->host != nullptr && mal_argon2_configure(&context->host->argon2, &config);
}

static void argon2_test_host_free(Argon2TestHost *context) {
    mal_host_free(context->host);
}

static MalArgon2Params argon2_test_params(const byte *message, usize message_len) {
    static const byte nonce[16] = "0123456789abcdef";
    return (MalArgon2Params) {
        .variant = MAL_ARGON2_VARIANT_ID,
        .parallelism = 1,
        .passes = 1,
        .memory_kib = 8,
        .tag_length = 32,
        .message = message,
        .message_len = message_len,
        .nonce = nonce,
        .nonce_len = sizeof(nonce),
    };
}

static bool argon2_next_terminal(
    MalHost *host, MalHostHandle operation, MalHostTask *task) {
    while (mal_host_tasks_pending(&host->tasks) == 0
        && mal_reactor_has_pending(&host->reactor)) {
        mal_reactor_wait(&host->reactor);
    }
    return mal_host_next_task(&host->tasks, task)
        && task->kind == MAL_HOST_TASK_TERMINAL && task->operation == operation;
}

static bool argon2_single_job_completes(void) {
    Argon2Gate gate;
    Argon2TestHost context = {0};
    argon2_gate_init(&gate, false);
    bool ok = argon2_test_host_init(&context, &gate, 2, 64);
    byte message[8] = {1, 2, 3, 4, 5, 6, 7, 8};
    MalArgon2Params params = argon2_test_params(message, sizeof(message));
    MalHostHandle operation = 0;
    ok = ok && mal_argon2_workers(&context.host->argon2) == 0
        && mal_argon2_start(context.host, &params, &operation) == MAL_ARGON2_START_OK
        && operation != 0;
    // Reactor work is retained for the whole derivation, so the loop cannot exit
    // underneath a pending job.
    ok = ok && mal_host_has_pending_work(context.host);
    MalHostTask task = {0};
    ok = ok && argon2_next_terminal(context.host, operation, &task)
        && task.result == MAL_HOST_TERMINAL_OK;
    if (ok) {
        usize length = 0;
        const byte *tag = mal_argon2_result_tag(task.data, &length);
        ok = length == 32 && tag != nullptr
            && mal_argon2_result_status(task.data) == MAL_ARGON2_STATUS_OK;
        for (usize i = 0; ok && i < length; i++) {
            ok = tag[i] == (byte) (message[i % sizeof(message)] + (byte) i);
        }
    }
    if (task._node != nullptr) mal_host_task_release(&context.host->tasks, &task);
    // Exactly one terminal, and the retain was released with it.
    mal_reactor_wait(&context.host->reactor);
    ok = ok && !gate.mismatched && gate.calls == 1
        && mal_host_tasks_pending(&context.host->tasks) == 0
        && !mal_reactor_has_pending(&context.host->reactor)
        && mal_host_operations_pending(&context.host->tasks) == 0;
    argon2_test_host_free(&context);
    argon2_gate_free(&gate);
    return ok;
}

/* The caller's input storage is freed immediately after start; a worker that
 * borrowed it instead of copying reads freed memory. */
static bool argon2_copies_its_inputs(void) {
    Argon2Gate gate;
    Argon2TestHost context = {0};
    argon2_gate_init(&gate, true);
    bool ok = argon2_test_host_init(&context, &gate, 1, 4);
    byte *message = malloc(8);
    byte *secret = malloc(8);
    ok = ok && message != nullptr && secret != nullptr;
    if (!ok) {
        free(message);
        free(secret);
        argon2_test_host_free(&context);
        argon2_gate_free(&gate);
        return false;
    }
    memset(message, 0x41, 8);
    memset(secret, 0x42, 8);
    MalArgon2Params params = argon2_test_params(message, 8);
    params.secret = secret;
    params.secret_len = 8;
    MalHostHandle operation = 0;
    ok = ok && mal_argon2_start(context.host, &params, &operation) == MAL_ARGON2_START_OK;
    // Scribble over and release the originals while the job is gated.
    memset(message, 0xff, 8);
    memset(secret, 0xff, 8);
    free(message);
    free(secret);
    argon2_gate_release(&gate);
    MalHostTask task = {0};
    ok = ok && argon2_next_terminal(context.host, operation, &task)
        && task.result == MAL_HOST_TERMINAL_OK;
    if (ok) {
        usize length = 0;
        const byte *tag = mal_argon2_result_tag(task.data, &length);
        ok = length == 32;
        for (usize i = 0; ok && i < length; i++) {
            ok = tag[i] == (byte) (0x41 + (byte) i);
        }
    }
    if (task._node != nullptr) mal_host_task_release(&context.host->tasks, &task);
    ok = ok && !gate.mismatched;
    argon2_test_host_free(&context);
    argon2_gate_free(&gate);
    return ok;
}

static bool argon2_concurrent_jobs_stay_independent(void) {
    Argon2Gate gate;
    Argon2TestHost context = {0};
    argon2_gate_init(&gate, false);
    bool ok = argon2_test_host_init(&context, &gate, 2, 64);
    byte messages[4][8];
    MalHostHandle operations[4] = {0};
    for (usize i = 0; i < countof(messages); i++) {
        memset(messages[i], (byte) (0x10 + i), sizeof(messages[i]));
        MalArgon2Params params = argon2_test_params(messages[i], sizeof(messages[i]));
        ok = ok
            && mal_argon2_start(context.host, &params, &operations[i]) == MAL_ARGON2_START_OK;
    }
    int terminals = 0;
    bool tags_ok = ok;
    while (ok && terminals < (int) countof(operations)) {
        MalHostTask task = {0};
        while (mal_host_tasks_pending(&context.host->tasks) == 0
            && mal_reactor_has_pending(&context.host->reactor)) {
            mal_reactor_wait(&context.host->reactor);
        }
        if (!mal_host_next_task(&context.host->tasks, &task)) break;
        terminals++;
        usize index = countof(operations);
        for (usize i = 0; i < countof(operations); i++) {
            if (operations[i] == task.operation) index = i;
        }
        if (index == countof(operations) || task.result != MAL_HOST_TERMINAL_OK) {
            tags_ok = false;
        } else {
            usize length = 0;
            const byte *tag = mal_argon2_result_tag(task.data, &length);
            if (length != 32) tags_ok = false;
            for (usize i = 0; tags_ok && i < length; i++) {
                if (tag[i] != (byte) (messages[index][i % 8] + (byte) i)) tags_ok = false;
            }
        }
        mal_host_task_release(&context.host->tasks, &task);
    }
    mal_reactor_wait(&context.host->reactor);
    ok = ok && tags_ok && terminals == (int) countof(operations) && gate.calls == 4
        && !gate.mismatched && !mal_reactor_has_pending(&context.host->reactor)
        && mal_host_operations_pending(&context.host->tasks) == 0;
    argon2_test_host_free(&context);
    argon2_gate_free(&gate);
    return ok;
}

static bool argon2_saturation_is_bounded(void) {
    Argon2Gate gate;
    Argon2TestHost context = {0};
    argon2_gate_init(&gate, true);
    bool ok = argon2_test_host_init(&context, &gate, 1, 1);
    byte message[8] = {9, 9, 9, 9, 9, 9, 9, 9};
    MalArgon2Params params = argon2_test_params(message, sizeof(message));
    MalHostHandle first = 0;
    MalHostHandle second = 0;
    MalHostHandle rejected = 99;
    ok = ok && mal_argon2_start(context.host, &params, &first) == MAL_ARGON2_START_OK;
    if (ok) argon2_gate_wait_entered(&gate);
    ok = ok && mal_argon2_start(context.host, &params, &second) == MAL_ARGON2_START_OK
        && mal_argon2_queued(&context.host->argon2) == 1
        && mal_argon2_start(context.host, &params, &rejected) == MAL_ARGON2_START_SATURATED
        // A refused start creates no operation and leaks nothing.
        && rejected == 0;
    argon2_gate_release(&gate);
    int terminals = 0;
    MalHostTask task = {0};
    while (terminals < 2) {
        while (mal_host_tasks_pending(&context.host->tasks) == 0
            && mal_reactor_has_pending(&context.host->reactor)) {
            mal_reactor_wait(&context.host->reactor);
        }
        if (!mal_host_next_task(&context.host->tasks, &task)) break;
        terminals++;
        ok = ok && task.kind == MAL_HOST_TASK_TERMINAL;
        mal_host_task_release(&context.host->tasks, &task);
    }
    mal_reactor_wait(&context.host->reactor);
    ok = ok && terminals == 2 && !mal_reactor_has_pending(&context.host->reactor)
        && mal_host_operations_pending(&context.host->tasks) == 0;
    argon2_test_host_free(&context);
    argon2_gate_free(&gate);
    return ok;
}

static bool argon2_queued_cancellation_yields_one_terminal(void) {
    Argon2Gate gate;
    Argon2TestHost context = {0};
    argon2_gate_init(&gate, true);
    bool ok = argon2_test_host_init(&context, &gate, 1, 4);
    byte message[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    MalArgon2Params params = argon2_test_params(message, sizeof(message));
    MalHostHandle running = 0;
    MalHostHandle queued = 0;
    ok = ok && mal_argon2_start(context.host, &params, &running) == MAL_ARGON2_START_OK;
    if (ok) argon2_gate_wait_entered(&gate);
    ok = ok && mal_argon2_start(context.host, &params, &queued) == MAL_ARGON2_START_OK
        && mal_argon2_queued(&context.host->argon2) == 1
        && mal_argon2_cancel(context.host, queued)
        && mal_argon2_queued(&context.host->argon2) == 0
        // A handle this pool never issued must not be claimed.
        && !mal_argon2_cancel(context.host, 4242);
    argon2_gate_release(&gate);
    int cancelled = 0;
    int completed = 0;
    MalHostTask task = {0};
    for (int i = 0; i < 2; i++) {
        while (mal_host_tasks_pending(&context.host->tasks) == 0
            && mal_reactor_has_pending(&context.host->reactor)) {
            mal_reactor_wait(&context.host->reactor);
        }
        if (!mal_host_next_task(&context.host->tasks, &task)) break;
        if (task.result == MAL_HOST_TERMINAL_CANCELLED) cancelled++;
        if (task.result == MAL_HOST_TERMINAL_OK) completed++;
        mal_host_task_release(&context.host->tasks, &task);
    }
    mal_reactor_wait(&context.host->reactor);
    // The cancelled job never reached a worker, so only one derivation ran.
    ok = ok && cancelled == 1 && completed == 1 && gate.calls == 1
        && !mal_reactor_has_pending(&context.host->reactor)
        && mal_host_operations_pending(&context.host->tasks) == 0;
    argon2_test_host_free(&context);
    argon2_gate_free(&gate);
    return ok;
}

static bool argon2_shutdown_joins_queued_and_inflight(void) {
    Argon2Gate gate;
    Argon2TestHost context = {0};
    argon2_gate_init(&gate, true);
    bool ok = argon2_test_host_init(&context, &gate, 1, 4);
    byte message[8] = {7, 7, 7, 7, 7, 7, 7, 7};
    MalArgon2Params params = argon2_test_params(message, sizeof(message));
    MalHostHandle first = 0;
    MalHostHandle second = 0;
    ok = ok && mal_argon2_start(context.host, &params, &first) == MAL_ARGON2_START_OK;
    if (ok) argon2_gate_wait_entered(&gate);
    ok = ok && mal_argon2_start(context.host, &params, &second) == MAL_ARGON2_START_OK
        && mal_argon2_queued(&context.host->argon2) == 1;
    pthread_t releaser;
    bool releaser_started = ok
        && pthread_create(&releaser, nullptr, argon2_delayed_gate_release, &gate) == 0;
    ok = ok && releaser_started;
    if (releaser_started) {
        // Shutdown blocks for at most one derivation per worker: the in-flight
        // job has no cancellation point.
        mal_host_shutdown(context.host);
        ok = pthread_join(releaser, nullptr) == 0 && ok;
    } else {
        argon2_gate_release(&gate);
        mal_host_shutdown(context.host);
    }

    MalHostHandle refused = 7;
    ok = ok && !mal_argon2_accepting(&context.host->argon2)
        && mal_argon2_workers(&context.host->argon2) == 0
        && mal_argon2_queued(&context.host->argon2) == 0
        && mal_argon2_start(context.host, &params, &refused) == MAL_ARGON2_START_SHUTDOWN
        && refused == 0;
    int terminals = 0;
    MalHostTask task = {0};
    while (mal_host_next_task(&context.host->tasks, &task)) {
        terminals++;
        ok = task.kind == MAL_HOST_TASK_TERMINAL
            && task.result == MAL_HOST_TERMINAL_CANCELLED && ok;
        mal_host_task_release(&context.host->tasks, &task);
    }
    mal_reactor_wait(&context.host->reactor);
    ok = ok && terminals == 2 && !mal_reactor_has_pending(&context.host->reactor)
        && mal_host_operations_pending(&context.host->tasks) == 0;
    argon2_test_host_free(&context);
    argon2_gate_free(&gate);
    return ok;
}

/* The deterministic seam for the allocation-failure requirement: tiny ceilings
 * turn an over-budget request into a status, with nothing allocated and no
 * abort. Both ceilings are covered, on both the synchronous and the worker path. */
static bool argon2_resource_policy_refuses_without_allocating(void) {
    Argon2TestHost context = {0};
    context.host = mal_host_init(&context.storage) ? &context.storage : nullptr;
    MalArgon2Config config = {
        .worker_count = 1,
        .queue_capacity = 4,
        .max_memory_kib = 16,
        .max_tag_length = 32,
    };
    bool ok = context.host != nullptr
        && mal_argon2_configure(&context.host->argon2, &config);
    byte message[8] = {1, 1, 1, 1, 1, 1, 1, 1};
    byte tag[64] = {0};
    MalArgon2 *argon2 = ok ? &context.host->argon2 : nullptr;
    MalArgon2Params params = argon2_test_params(message, sizeof(message));

    // Over the memory ceiling: refused by the pre-check and by the derivation.
    params.memory_kib = 4096;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_POLICY
        && mal_argon2_derive_sync(argon2, &params, tag, 32) == MAL_ARGON2_STATUS_POLICY;
    // Over the tag ceiling, with memory well inside its own.
    params.memory_kib = 16;
    params.tag_length = 64;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_POLICY
        && mal_argon2_derive_sync(argon2, &params, tag, 64) == MAL_ARGON2_STATUS_POLICY;
    // The worker path refuses before it allocates a job, a tag, or a queue slot.
    MalHostHandle refused = 99;
    ok = ok && mal_argon2_start(context.host, &params, &refused) == MAL_ARGON2_START_POLICY
        && refused == 0 && mal_argon2_queued(argon2) == 0
        && mal_host_tasks_pending(&context.host->tasks) == 0
        && mal_host_operations_pending(&context.host->tasks) == 0;

    // Inside both ceilings the same call derives normally.
    params.tag_length = 32;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_OK
        && mal_argon2_derive_sync(argon2, &params, tag, 32) == MAL_ARGON2_STATUS_OK;
    bool wrote = false;
    for (usize i = 0; i < 32; i++) {
        if (tag[i] != 0) wrote = true;
    }
    // An output length that disagrees with tag_length must be refused outright.
    ok = ok && wrote
        && mal_argon2_derive_sync(argon2, &params, tag, 16)
            == MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    argon2_test_host_free(&context);
    return ok;
}

/* A zero in the config selects each compiled default rather than "no limit". */
static bool argon2_zero_config_selects_the_defaults(void) {
    Argon2TestHost context = {0};
    context.host = mal_host_init(&context.storage) ? &context.storage : nullptr;
    MalArgon2Config config = {.worker_count = 1, .queue_capacity = 4};
    bool ok = context.host != nullptr
        && mal_argon2_configure(&context.host->argon2, &config);
    MalArgon2 *argon2 = ok ? &context.host->argon2 : nullptr;
    byte message[8] = {2, 2, 2, 2, 2, 2, 2, 2};
    MalArgon2Params params = argon2_test_params(message, sizeof(message));

    params.memory_kib = MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_OK;
    params.memory_kib = MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB + 4;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_POLICY;

    params.memory_kib = 16;
    params.tag_length = MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_OK;
    params.tag_length = MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH + 1;
    ok = ok && mal_argon2_check_policy(argon2, &params) == MAL_ARGON2_STATUS_POLICY;

    // A null pool falls back to the same compiled defaults.
    ok = ok && mal_argon2_check_policy(nullptr, &params) == MAL_ARGON2_STATUS_POLICY;
    argon2_test_host_free(&context);
    return ok;
}

/* The real backend, unmocked: the RFC 9106 vector must survive the C ABI. */
static bool argon2_backend_matches_the_rfc_vector(void) {
    byte message[32];
    byte nonce[16];
    byte secret[8];
    byte associated_data[12];
    memset(message, 0x01, sizeof(message));
    memset(nonce, 0x02, sizeof(nonce));
    memset(secret, 0x03, sizeof(secret));
    memset(associated_data, 0x04, sizeof(associated_data));
    MalArgon2Params params = {
        .variant = MAL_ARGON2_VARIANT_ID,
        .parallelism = 4,
        .passes = 3,
        .memory_kib = 32,
        .tag_length = 32,
        .message = message,
        .message_len = sizeof(message),
        .nonce = nonce,
        .nonce_len = sizeof(nonce),
        .secret = secret,
        .secret_len = sizeof(secret),
        .associated_data = associated_data,
        .associated_data_len = sizeof(associated_data),
    };
    static const u8 expected[32] = {
        0x0d, 0x64, 0x0d, 0xf5, 0x8d, 0x78, 0x76, 0x6c, 0x08, 0xc0, 0x37, 0xa3,
        0x4a, 0x8b, 0x53, 0xc9, 0xd0, 0x1e, 0xf0, 0x45, 0x2d, 0x75, 0xb6, 0x5e,
        0xb5, 0x25, 0x20, 0xe9, 0x6b, 0x01, 0xe6, 0x59,
    };
    byte tag[32] = {0};
    if (mal_argon2_derive_sync(nullptr, &params, tag, sizeof(tag)) != MAL_ARGON2_STATUS_OK) {
        return false;
    }
    return memcmp(tag, expected, sizeof(expected)) == 0
        && mal_argon2_abi_version() == MAL_ARGON2_ABI_VERSION;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"one job completes with its own tag and exactly one terminal",
            argon2_single_job_completes()},
        {"inputs are copied, so freeing the originals cannot corrupt a job",
            argon2_copies_its_inputs()},
        {"four concurrent jobs return four independent tags",
            argon2_concurrent_jobs_stay_independent()},
        {"a saturated queue refuses a start without creating an operation",
            argon2_saturation_is_bounded()},
        {"cancelling a queued job yields exactly one cancelled terminal",
            argon2_queued_cancellation_yields_one_terminal()},
        {"shutdown joins queued and in-flight work and releases every retain",
            argon2_shutdown_joins_queued_and_inflight()},
        {"the resource policy refuses over-budget memory and tag lengths",
            argon2_resource_policy_refuses_without_allocating()},
        {"a zero in the config selects each compiled default ceiling",
            argon2_zero_config_selects_the_defaults()},
        {"the linked backend reproduces the RFC 9106 argon2id vector",
            argon2_backend_matches_the_rfc_vector()},
    };
    int total = (int) countof(checks);
    int passed = 0;
    for (int i = 0; i < total; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("argon2test CHECK FAIL: %s\n", checks[i].name);
        }
    }
    printf("argon2test PASS %d/%d\n", passed, total);

    mal_vm_free(&vm);
    return passed == total ? 0 : 1;
}
