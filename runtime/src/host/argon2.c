#include "argon2.h"

#include "host.h"

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#if MAL_NODE
#include "mal_argon2.h"
#else
/* Status codes are part of this module's contract regardless of the backend, so
 * the stub build keeps the same numbers rather than inventing its own. */
#define MAL_ARGON2_STATUS_OK 0
#define MAL_ARGON2_STATUS_INVALID_ARGUMENT (-1)
#define MAL_ARGON2_STATUS_MEMORY (-2)
#define MAL_ARGON2_STATUS_INTERNAL (-3)
#endif

#define MAL_ARGON2_DEFAULT_WORKERS 2
#define MAL_ARGON2_DEFAULT_QUEUE_CAPACITY 64

/* Job-owned copies of the caller's bytes. Scrubbed and freed on every path. */
typedef struct MalArgon2Inputs {
    byte *message;
    usize message_len;
    byte *nonce;
    usize nonce_len;
    byte *secret;
    usize secret_len;
    byte *associated_data;
    usize associated_data_len;
} MalArgon2Inputs;

struct MalArgon2Result {
    byte *tag;
    usize tag_length;
    i32 status;
};

typedef struct MalArgon2Job {
    struct MalArgon2Job *next;
    struct MalArgon2Job *all_next;
    MalHostHandle operation;
    MalArgon2Params params;
    MalArgon2Inputs inputs;
    MalArgon2Result *result;
    bool cancelled;
    bool completed;
} MalArgon2Job;

typedef struct MalArgon2State {
    pthread_mutex_t mutex;
    pthread_cond_t ready;
    MalHost *host;
    MalArgon2Job *head;
    MalArgon2Job *tail;
    MalArgon2Job *requests;
    pthread_t *threads;
    usize thread_limit;
    usize thread_count;
    usize queue_capacity;
    usize queued;
    u32 max_memory_kib;
    u32 max_tag_length;
    MalArgon2Derive derive;
    void *derive_data;
    bool pool_started;
    bool accepting;
    bool stopping;
} MalArgon2State;

/* Overwrite secret-bearing storage before it is released. The volatile store
 * keeps this from being optimized away as dead. */
static void mal_argon2_scrub(byte *bytes, usize length) {
    volatile byte *cursor = (volatile byte *) bytes;
    for (usize i = 0; i < length; i++) {
        cursor[i] = 0;
    }
}

static void mal_argon2_scrub_free(byte *bytes, usize length) {
    if (bytes == nullptr) return;
    mal_argon2_scrub(bytes, length);
    free(bytes);
}

static void mal_argon2_inputs_free(MalArgon2Inputs *inputs) {
    mal_argon2_scrub_free(inputs->message, inputs->message_len);
    mal_argon2_scrub_free(inputs->nonce, inputs->nonce_len);
    mal_argon2_scrub_free(inputs->secret, inputs->secret_len);
    mal_argon2_scrub_free(inputs->associated_data, inputs->associated_data_len);
    memset(inputs, 0, sizeof(*inputs));
}

static bool mal_argon2_copy_input(
    const byte *source, usize length, byte **out, usize *out_length) {
    *out_length = length;
    if (length == 0) {
        *out = nullptr;
        return true;
    }
    if (source == nullptr) {
        return false;
    }
    byte *copy = malloc(length);
    if (copy == nullptr) {
        return false;
    }
    memcpy(copy, source, length);
    *out = copy;
    return true;
}

/* Copies every byte input on the calling thread; the resulting params point only
 * at job-owned storage. */
static bool mal_argon2_take_inputs(
    const MalArgon2Params *params, MalArgon2Inputs *inputs, MalArgon2Params *owned) {
    memset(inputs, 0, sizeof(*inputs));
    if (!mal_argon2_copy_input(
            params->message, params->message_len, &inputs->message, &inputs->message_len)
        || !mal_argon2_copy_input(
            params->nonce, params->nonce_len, &inputs->nonce, &inputs->nonce_len)
        || !mal_argon2_copy_input(
            params->secret, params->secret_len, &inputs->secret, &inputs->secret_len)
        || !mal_argon2_copy_input(params->associated_data, params->associated_data_len,
            &inputs->associated_data, &inputs->associated_data_len)) {
        mal_argon2_inputs_free(inputs);
        return false;
    }
    *owned = *params;
    owned->message = inputs->message;
    owned->nonce = inputs->nonce;
    owned->secret = inputs->secret;
    owned->associated_data = inputs->associated_data;
    return true;
}

void mal_argon2_result_release(MalArgon2Result *result) {
    if (result == nullptr) return;
    mal_argon2_scrub_free(result->tag, result->tag_length);
    free(result);
}

static void mal_argon2_result_destroy(void *data) {
    mal_argon2_result_release(data);
}

const byte *mal_argon2_result_tag(const MalArgon2Result *result, usize *length) {
    if (result == nullptr) {
        if (length != nullptr) *length = 0;
        return nullptr;
    }
    if (length != nullptr) *length = result->tag_length;
    return result->tag;
}

i32 mal_argon2_result_status(const MalArgon2Result *result) {
    return result == nullptr ? MAL_ARGON2_STATUS_INTERNAL : result->status;
}

/* The resource-policy gate. The memory ceiling is checked against the *rounded*
 * block count, so it matches what the derivation will actually allocate. Runs
 * before any allocation and before the backend is entered. */
static i32 mal_argon2_policy(
    const MalArgon2Params *params, u32 max_memory_kib, u32 max_tag_length) {
    if (params == nullptr) return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    if (max_tag_length != 0 && params->tag_length > max_tag_length) {
        return MAL_ARGON2_STATUS_POLICY;
    }
#if MAL_NODE
    u64 blocks = 0;
    if (mal_argon2_block_count(params->parallelism, params->memory_kib, &blocks)
        != MAL_ARGON2_STATUS_OK) {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    }
    if (max_memory_kib != 0 && blocks > (u64) max_memory_kib) {
        return MAL_ARGON2_STATUS_POLICY;
    }
#else
    // Without the backend there is no block-count helper; the tag ceiling above
    // is still enforced so the policy surface does not depend on the feature.
    (void) max_memory_kib;
#endif
    return MAL_ARGON2_STATUS_OK;
}

static void mal_argon2_state_limits(
    MalArgon2State *state, u32 *max_memory_kib, u32 *max_tag_length);

i32 mal_argon2_check_policy(MalArgon2 *argon2, const MalArgon2Params *params) {
    u32 max_memory_kib = MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB;
    u32 max_tag_length = MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH;
    if (argon2 != nullptr && argon2->state != nullptr) {
        mal_argon2_state_limits(argon2->state, &max_memory_kib, &max_tag_length);
    }
    return mal_argon2_policy(params, max_memory_kib, max_tag_length);
}

/* The one call into the Rust backend. */
static i32 mal_argon2_backend_derive(
    const MalArgon2Params *params, byte *out, usize out_len,
    u32 max_memory_kib, u32 max_tag_length) {
    i32 policy = mal_argon2_policy(params, max_memory_kib, max_tag_length);
    if (policy != MAL_ARGON2_STATUS_OK) return policy;
#if MAL_NODE
    // mal_argon2_init refuses a mismatched archive up front; this repeats the
    // check on the one path that can be reached without a host context
    // (argon2Sync in a hostless embedding). One compare against a derivation.
    if (mal_argon2_abi_version() != MAL_ARGON2_ABI_VERSION) {
        return MAL_ARGON2_STATUS_INTERNAL;
    }
    MalArgon2Request request = {
        .variant = params->variant,
        .parallelism = params->parallelism,
        .passes = params->passes,
        .memory_kib = params->memory_kib,
        .tag_length = params->tag_length,
        .message = (const uint8_t *) params->message,
        .message_len = params->message_len,
        .nonce = (const uint8_t *) params->nonce,
        .nonce_len = params->nonce_len,
        .secret = (const uint8_t *) params->secret,
        .secret_len = params->secret_len,
        .associated_data = (const uint8_t *) params->associated_data,
        .associated_data_len = params->associated_data_len,
    };
    return mal_argon2_hash(&request, (uint8_t *) out, out_len);
#else
    (void) out;
    (void) out_len;
    return MAL_ARGON2_STATUS_INTERNAL;
#endif
}

/* Injected derive hooks stand in for the backend, but the resource policy is the
 * host's and applies to them too. */
static i32 mal_argon2_run(
    MalArgon2State *state, const MalArgon2Params *params, byte *out, usize out_len) {
    if (state->derive != nullptr) {
        i32 policy = mal_argon2_policy(
            params, state->max_memory_kib, state->max_tag_length);
        if (policy != MAL_ARGON2_STATUS_OK) return policy;
        return state->derive(params, out, out_len, state->derive_data);
    }
    return mal_argon2_backend_derive(
        params, out, out_len, state->max_memory_kib, state->max_tag_length);
}

static void mal_argon2_remove_request(MalArgon2State *state, MalArgon2Job *request) {
    MalArgon2Job **link = &state->requests;
    while (*link != nullptr && *link != request) {
        link = &(*link)->all_next;
    }
    if (*link == request) {
        *link = request->all_next;
    }
}

static bool mal_argon2_remove_queued(MalArgon2State *state, MalArgon2Job *request) {
    MalArgon2Job *previous = nullptr;
    for (MalArgon2Job *queued = state->head; queued != nullptr; queued = queued->next) {
        if (queued != request) {
            previous = queued;
            continue;
        }
        if (previous == nullptr) {
            state->head = queued->next;
        } else {
            previous->next = queued->next;
        }
        if (state->tail == queued) {
            state->tail = previous;
        }
        state->queued--;
        mal_argon2_remove_request(state, queued);
        return true;
    }
    return false;
}

static void mal_argon2_request_free(MalArgon2Job *request) {
    mal_argon2_inputs_free(&request->inputs);
    mal_argon2_result_release(request->result);
    free(request);
}

static void *mal_argon2_worker(void *data) {
    MalArgon2State *state = data;
    for (;;) {
        pthread_mutex_lock(&state->mutex);
        while (state->head == nullptr && !state->stopping) {
            pthread_cond_wait(&state->ready, &state->mutex);
        }
        if (state->head == nullptr) {
            pthread_mutex_unlock(&state->mutex);
            return nullptr;
        }
        MalArgon2Job *request = state->head;
        state->head = request->next;
        if (state->head == nullptr) {
            state->tail = nullptr;
        }
        state->queued--;
        bool cancelled = request->cancelled;
        pthread_mutex_unlock(&state->mutex);

        MalHostHandle operation = request->operation;
        MalArgon2Result *result = request->result;
        MalHostTerminalResult terminal = MAL_HOST_TERMINAL_ERROR;
        if (!cancelled) {
            result->status = mal_argon2_run(
                state, &request->params, result->tag, result->tag_length);
            terminal = result->status == MAL_ARGON2_STATUS_OK
                ? MAL_HOST_TERMINAL_OK
                : MAL_HOST_TERMINAL_ERROR;
            if (result->status != MAL_ARGON2_STATUS_OK) {
                mal_argon2_scrub(result->tag, result->tag_length);
            }
        }
        // The inputs carry the password, pepper, and nonce; they are done the
        // moment the derivation is, so scrub them here rather than at reap.
        mal_argon2_inputs_free(&request->inputs);

        pthread_mutex_lock(&state->mutex);
        request->completed = true;
        request->result = nullptr;
        if (cancelled) {
            mal_argon2_remove_request(state, request);
        }
        pthread_mutex_unlock(&state->mutex);

        bool posted = !cancelled && mal_host_post_complete(
            state->host, operation, terminal, result, mal_argon2_result_destroy);
        if (!posted) {
            mal_argon2_result_release(result);
            if (!cancelled) {
                pthread_mutex_lock(&state->mutex);
                mal_argon2_remove_request(state, request);
                pthread_mutex_unlock(&state->mutex);
            }
        }
        (void) mal_reactor_release_work(&state->host->reactor);
        if (!posted) {
            free(request);
        }
    }
}

static bool mal_argon2_start_pool(MalArgon2State *state) {
    if (state->pool_started) {
        return state->thread_count > 0;
    }
    state->pool_started = true;
    state->threads = calloc(state->thread_limit, sizeof(pthread_t));
    if (state->threads == nullptr) {
        return false;
    }
    for (usize i = 0; i < state->thread_limit; i++) {
        if (pthread_create(
                &state->threads[state->thread_count], nullptr, mal_argon2_worker, state)
            != 0) {
            break;
        }
        state->thread_count++;
    }
    return state->thread_count > 0;
}

bool mal_argon2_init(MalArgon2 *argon2, MalHost *host) {
    if (argon2 == nullptr || host == nullptr) {
        return false;
    }
#if MAL_NODE
    // The linked archive and mal_argon2.h must agree on the request layout and
    // status codes. A mismatch would mis-marshal every derivation, so refuse to
    // stand the pool up rather than derive against the wrong struct.
    if (mal_argon2_abi_version() != MAL_ARGON2_ABI_VERSION) {
        return false;
    }
#endif
    argon2->state = nullptr;
    MalArgon2State *state = calloc(1, sizeof(MalArgon2State));
    if (state == nullptr) {
        return false;
    }
    if (pthread_mutex_init(&state->mutex, nullptr) != 0) {
        free(state);
        return false;
    }
    if (pthread_cond_init(&state->ready, nullptr) != 0) {
        pthread_mutex_destroy(&state->mutex);
        free(state);
        return false;
    }
    state->host = host;
    state->thread_limit = MAL_ARGON2_DEFAULT_WORKERS;
    state->queue_capacity = MAL_ARGON2_DEFAULT_QUEUE_CAPACITY;
    state->max_memory_kib = MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB;
    state->max_tag_length = MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH;
    state->accepting = true;
    argon2->state = state;
    return true;
}

bool mal_argon2_configure(MalArgon2 *argon2, const MalArgon2Config *config) {
    if (argon2 == nullptr || argon2->state == nullptr || config == nullptr
        || config->worker_count == 0 || config->queue_capacity == 0) {
        return false;
    }
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    bool configurable = state->accepting && !state->pool_started && state->queued == 0;
    if (configurable) {
        state->thread_limit = config->worker_count;
        state->queue_capacity = config->queue_capacity;
        state->max_memory_kib = config->max_memory_kib == 0
            ? MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB
            : config->max_memory_kib;
        state->max_tag_length = config->max_tag_length == 0
            ? MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH
            : config->max_tag_length;
        state->derive = config->derive;
        state->derive_data = config->derive_data;
    }
    pthread_mutex_unlock(&state->mutex);
    return configurable;
}

i32 mal_argon2_derive_sync(
    MalArgon2 *argon2, const MalArgon2Params *params, byte *out, usize out_len) {
    if (params == nullptr || out == nullptr || out_len == 0
        || params->tag_length != out_len) {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    }
    if (argon2 == nullptr || argon2->state == nullptr) {
        return mal_argon2_backend_derive(params, out, out_len,
            MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB, MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH);
    }
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    MalArgon2Derive derive = state->derive;
    void *derive_data = state->derive_data;
    u32 max_memory_kib = state->max_memory_kib;
    u32 max_tag_length = state->max_tag_length;
    pthread_mutex_unlock(&state->mutex);
    i32 policy = mal_argon2_policy(params, max_memory_kib, max_tag_length);
    if (policy != MAL_ARGON2_STATUS_OK) return policy;
    if (derive != nullptr) {
        return derive(params, out, out_len, derive_data);
    }
    return mal_argon2_backend_derive(
        params, out, out_len, max_memory_kib, max_tag_length);
}

static void mal_argon2_state_limits(
    MalArgon2State *state, u32 *max_memory_kib, u32 *max_tag_length) {
    pthread_mutex_lock(&state->mutex);
    *max_memory_kib = state->max_memory_kib;
    *max_tag_length = state->max_tag_length;
    pthread_mutex_unlock(&state->mutex);
}

MalArgon2StartResult mal_argon2_start(
    MalHost *host, const MalArgon2Params *params, MalHostHandle *operation) {
    if (operation != nullptr) {
        *operation = 0;
    }
    if (host == nullptr || params == nullptr || operation == nullptr
        || params->tag_length == 0) {
        return MAL_ARGON2_START_INVALID_ARGUMENT;
    }
    MalArgon2State *state = host->argon2.state;
    if (state == nullptr) {
        return MAL_ARGON2_START_SHUTDOWN;
    }
    // Before the tag buffer, the input copies, and the queue slot: a request the
    // policy will refuse must cost nothing.
    u32 max_memory_kib;
    u32 max_tag_length;
    mal_argon2_state_limits(state, &max_memory_kib, &max_tag_length);
    if (mal_argon2_policy(params, max_memory_kib, max_tag_length)
        != MAL_ARGON2_STATUS_OK) {
        return MAL_ARGON2_START_POLICY;
    }

    MalArgon2Job *request = calloc(1, sizeof(MalArgon2Job));
    MalArgon2Result *result = calloc(1, sizeof(MalArgon2Result));
    byte *tag = malloc(params->tag_length);
    if (request == nullptr || result == nullptr || tag == nullptr) {
        free(request);
        free(result);
        free(tag);
        return MAL_ARGON2_START_SYSTEM_ERROR;
    }
    memset(tag, 0, params->tag_length);
    result->tag = tag;
    result->tag_length = params->tag_length;
    result->status = MAL_ARGON2_STATUS_INTERNAL;
    request->result = result;
    if (!mal_argon2_take_inputs(params, &request->inputs, &request->params)) {
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SYSTEM_ERROR;
    }

    pthread_mutex_lock(&state->mutex);
    if (!state->accepting) {
        pthread_mutex_unlock(&state->mutex);
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SHUTDOWN;
    }
    if (state->queued >= state->queue_capacity) {
        pthread_mutex_unlock(&state->mutex);
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SATURATED;
    }
    if (!mal_argon2_start_pool(state)) {
        pthread_mutex_unlock(&state->mutex);
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SYSTEM_ERROR;
    }
    // Reserve the terminal slot, retain reactor work, then activate — unwound in
    // reverse on any failure so no half-started operation is left behind.
    if (!mal_host_operation_start(&host->tasks, operation)) {
        pthread_mutex_unlock(&state->mutex);
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SYSTEM_ERROR;
    }
    if (!mal_reactor_retain_work(&host->reactor)) {
        (void) mal_host_operation_abort_start(&host->tasks, *operation);
        *operation = 0;
        pthread_mutex_unlock(&state->mutex);
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SYSTEM_ERROR;
    }
    if (!mal_host_operation_activate(&host->tasks, *operation)) {
        (void) mal_reactor_release_work(&host->reactor);
        (void) mal_host_operation_abort_start(&host->tasks, *operation);
        *operation = 0;
        pthread_mutex_unlock(&state->mutex);
        mal_argon2_request_free(request);
        return MAL_ARGON2_START_SYSTEM_ERROR;
    }
    request->operation = *operation;
    if (state->tail == nullptr) {
        state->head = request;
    } else {
        state->tail->next = request;
    }
    state->tail = request;
    request->all_next = state->requests;
    state->requests = request;
    state->queued++;
    pthread_cond_signal(&state->ready);
    pthread_mutex_unlock(&state->mutex);
    return MAL_ARGON2_START_OK;
}

bool mal_argon2_cancel(MalHost *host, MalHostHandle operation) {
    if (host == nullptr || host->argon2.state == nullptr) {
        return false;
    }
    MalArgon2State *state = host->argon2.state;
    pthread_mutex_lock(&state->mutex);
    MalArgon2Job *matched = nullptr;
    bool queued = false;
    for (MalArgon2Job *request = state->requests; request != nullptr;
        request = request->all_next) {
        if (request->operation == operation) {
            request->cancelled = true;
            matched = request;
            queued = mal_argon2_remove_queued(state, request);
            break;
        }
    }
    pthread_mutex_unlock(&state->mutex);
    if (matched == nullptr) {
        return false;
    }
    bool cancelled = mal_host_operation_cancel(&host->tasks, operation);
    if (queued) {
        mal_argon2_request_free(matched);
        (void) mal_reactor_release_work(&host->reactor);
    }
    return cancelled;
}

void mal_argon2_reap_completed(MalArgon2 *argon2) {
    if (argon2 == nullptr || argon2->state == nullptr) return;
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    MalArgon2Job **link = &state->requests;
    while (*link != nullptr) {
        MalArgon2Job *request = *link;
        if (!request->completed
            || mal_host_operation_state(&state->host->tasks, request->operation)
                == MAL_HOST_OPERATION_ACTIVE) {
            link = &request->all_next;
            continue;
        }
        *link = request->all_next;
        free(request);
    }
    pthread_mutex_unlock(&state->mutex);
}

void mal_argon2_shutdown(MalArgon2 *argon2) {
    if (argon2 == nullptr || argon2->state == nullptr) {
        return;
    }
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    state->accepting = false;
    if (state->stopping) {
        pthread_mutex_unlock(&state->mutex);
        return;
    }
    state->stopping = true;
    MalArgon2Job *queued = state->head;
    state->head = nullptr;
    state->tail = nullptr;
    state->queued = 0;
    for (MalArgon2Job *request = queued; request != nullptr; request = request->next) {
        mal_argon2_remove_request(state, request);
    }
    for (MalArgon2Job *request = state->requests; request != nullptr;
        request = request->all_next) {
        request->cancelled = true;
        (void) mal_host_operation_cancel(&state->host->tasks, request->operation);
    }
    for (MalArgon2Job *request = queued; request != nullptr; request = request->next) {
        request->cancelled = true;
        (void) mal_host_operation_cancel(&state->host->tasks, request->operation);
    }
    usize thread_count = state->thread_count;
    pthread_cond_broadcast(&state->ready);
    pthread_mutex_unlock(&state->mutex);

    while (queued != nullptr) {
        MalArgon2Job *next = queued->next;
        mal_argon2_request_free(queued);
        (void) mal_reactor_release_work(&state->host->reactor);
        queued = next;
    }

    // A derivation already on a worker has no cancellation point, so this joins
    // for up to one full derivation per worker.
    for (usize i = 0; i < thread_count; i++) {
        (void) pthread_join(state->threads[i], nullptr);
    }
    pthread_mutex_lock(&state->mutex);
    state->thread_count = 0;
    pthread_mutex_unlock(&state->mutex);
}

void mal_argon2_free(MalArgon2 *argon2) {
    if (argon2 == nullptr || argon2->state == nullptr) {
        return;
    }
    mal_argon2_shutdown(argon2);
    MalArgon2State *state = argon2->state;
    MalArgon2Job *request = state->requests;
    while (request != nullptr) {
        MalArgon2Job *next = request->all_next;
        mal_argon2_request_free(request);
        request = next;
    }
    free(state->threads);
    pthread_cond_destroy(&state->ready);
    pthread_mutex_destroy(&state->mutex);
    free(state);
    argon2->state = nullptr;
}

usize mal_argon2_queued(MalArgon2 *argon2) {
    if (argon2 == nullptr || argon2->state == nullptr) {
        return 0;
    }
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    usize queued = state->queued;
    pthread_mutex_unlock(&state->mutex);
    return queued;
}

usize mal_argon2_workers(MalArgon2 *argon2) {
    if (argon2 == nullptr || argon2->state == nullptr) {
        return 0;
    }
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    usize workers = state->thread_count;
    pthread_mutex_unlock(&state->mutex);
    return workers;
}

bool mal_argon2_accepting(MalArgon2 *argon2) {
    if (argon2 == nullptr || argon2->state == nullptr) {
        return false;
    }
    MalArgon2State *state = argon2->state;
    pthread_mutex_lock(&state->mutex);
    bool accepting = state->accepting;
    pthread_mutex_unlock(&state->mutex);
    return accepting;
}
