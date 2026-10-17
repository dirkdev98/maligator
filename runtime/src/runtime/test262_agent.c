#include "test262_agent.h"

#include "array_buffer_object.h"
#include "atomics_async.h"
#include "builtin_atomics.h"
#include "builtin_eval.h"
#include "gc.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "host.h"
#include "intrinsics.h"
#include "reactor.h"
#include "shared_memory.h"
#include "test262_host.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_host_timer.h"

#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if MAL_REALMS

// $262.agent (INTERPRETING.md): every agent is a thread with its own VM built
// from the test's image, so it can evaluate its source with the eval compiler.
#define TEST262_AGENT_STACK_BYTES (16u << 20)

typedef struct Test262Report {
    struct Test262Report *next;
    usize length;
    c16 units[];
} Test262Report;

typedef struct Test262Agent {
    struct Test262Agent *next;
    c16 *source;
    usize source_length;
    // Set while the agent's event loop can be woken; cleared before its host is freed.
    MalReactor *reactor;
    u64 received;
    bool running;
    bool exited;
} Test262Agent;

static struct {
    pthread_mutex_t lock;
    pthread_cond_t changed;
    const MalRuntimeImage *image;
    Test262Agent *agents;
    u64 generation;
    MalSharedMemory *memory;
    bool bigint;
    i128 bigint_value;
    f64 number;
    Test262Report *reports;
    Test262Report *reports_tail;
} g_test262 = {.lock = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};

static MAL_ISOLATE_LOCAL Test262Agent *g_self;
static MAL_ISOLATE_LOCAL MalValue g_receiver;
static MAL_ISOLATE_LOCAL bool g_waiting;
static MAL_ISOLATE_LOCAL bool g_leaving;

// The shell host Test262's Atomics tests assume of every agent: an event loop
// with timers and waitAsync deadlines that keep it running.
static bool test262_host_setup(MalVm *vm, bool can_block) {
    if (mal_host_attach(vm) == nullptr) return false;
    if (!mal_atomics_async_install(vm, true)) return false;
    mal_host_timers_install(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]));
    mal_atomics_set_agent(can_block, nullptr);
    return true;
}

static c16 *test262_copy_units(MalVm *vm, MalValue value, usize *length) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return nullptr;
    MalValue rooted = mal_value_from_string(string);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    *length = string->length;
    c16 *units = malloc(sizeof(c16) * (*length > 0 ? *length : 1));
    if (units == nullptr) {
        mal_vm_throw_allocation_error(vm);
    } else if (*length > 0) {
        memcpy(units, mal_string_code_units(string), sizeof(c16) * *length);
    }
    mal_gc_unroot(&root);
    return units;
}

static void test262_sleep_ms(MalVm *vm, const MalValue *args, i32 arg_count) {
    f64 ms;
    if (!mal_vm_to_number(vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &ms)) return;
    if (!(ms > 0)) return;
    ms = fmin(ms, 1e9);
    struct timespec delay = {.tv_sec = (time_t) (ms / 1000), .tv_nsec = (long) (fmod(ms, 1000) * 1e6)};
    while (nanosleep(&delay, &delay) != 0) {}
}

static MalValue mal_test262_agent_sleep(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    test262_sleep_ms(vm, args, arg_count);
    return mal_value_new_undefined();
}

static MalValue mal_test262_agent_monotonic_now(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_ops_number_value((f64) mal_reactor_now_ns() / 1e6);
}

static void test262_agent_scan_roots(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    mal_gc_mark_value(g_receiver);
}

static bool test262_agent_left(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    return g_leaving;
}

static void test262_agent_stop_waiting(MalVm *vm) {
    if (!g_waiting) return;
    g_waiting = false;
    mal_reactor_release_work(&mal_host(vm)->reactor);
}

// Runs a broadcast this agent has not taken yet as a macrotask of its own loop.
static bool test262_agent_drain(MalVm *vm) {
    Test262Agent *agent = g_self;
    if (agent == nullptr || !mal_value_is_callable(g_receiver)) return false;
    pthread_mutex_lock(&g_test262.lock);
    if (agent->received == g_test262.generation) {
        pthread_mutex_unlock(&g_test262.lock);
        return false;
    }
    agent->received = g_test262.generation;
    MalSharedMemory *memory = g_test262.memory;
    mal_shared_memory_retain(memory);
    bool bigint = g_test262.bigint;
    i128 bigint_value = g_test262.bigint_value;
    f64 number = g_test262.number;
    pthread_cond_broadcast(&g_test262.changed);
    pthread_mutex_unlock(&g_test262.lock);

    MalValue values[] = {g_receiver, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalArrayBufferObject *buffer = mal_array_buffer_object_wrap_shared(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE]), memory);
    mal_shared_memory_release(memory);
    if (buffer == nullptr) {
        mal_vm_throw_allocation_error(vm);
    } else {
        values[1] = mal_value_from_array_buffer_object(buffer);
        values[2] = bigint
            ? mal_value_from_bigint(mal_bigint_new(&vm->heap, bigint_value))
            : mal_ops_number_value(number);
        mal_vm_call_value(vm, values[0], mal_value_new_undefined(), &values[1], 2);
    }
    mal_gc_unroot(&root);
    return true;
}

static MalValue mal_test262_agent_receive_broadcast(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "$262.agent.receiveBroadcast requires a function");
        return mal_value_new_undefined();
    }
    g_receiver = args[0];
    // A receiver keeps the agent's loop alive until it leaves.
    if (!g_waiting && !g_leaving) {
        g_waiting = mal_reactor_retain_work(&mal_host(vm)->reactor);
    }
    return mal_value_new_undefined();
}

static MalValue mal_test262_agent_report(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    usize length;
    c16 *units = test262_copy_units(vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &length);
    if (units == nullptr) return mal_value_new_undefined();
    Test262Report *report = malloc(sizeof(Test262Report) + sizeof(c16) * length);
    if (report == nullptr) {
        free(units);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    report->next = nullptr;
    report->length = length;
    if (length > 0) memcpy(report->units, units, sizeof(c16) * length);
    free(units);
    pthread_mutex_lock(&g_test262.lock);
    if (g_test262.reports_tail != nullptr) g_test262.reports_tail->next = report;
    else g_test262.reports = report;
    g_test262.reports_tail = report;
    pthread_mutex_unlock(&g_test262.lock);
    return mal_value_new_undefined();
}

static MalValue mal_test262_agent_leaving(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    g_leaving = true;
    test262_agent_stop_waiting(vm);
    return mal_value_new_undefined();
}

static void test262_agent_report_error(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    MalString *string;
    byte *text = nullptr;
    usize length = 0;
    if (mal_vm_to_string(vm, error, &string)) text = mal_string_to_utf8(string, &length);
    fprintf(stderr, "Test262 agent: uncaught %.*s\n", (int) length, text != nullptr ? (const char *) text : "exception");
    free(text);
    mal_gc_unroot(&root);
}

static void *test262_agent_main(void *data) {
    Test262Agent *agent = data;
    sigset_t all;
    sigfillset(&all);
    pthread_sigmask(SIG_BLOCK, &all, nullptr);

    MalVm *vm = calloc(1, sizeof(MalVm));
    bool ready = false;
    if (vm != nullptr) {
        mal_vm_init(vm, g_test262.image);
        ready = test262_host_setup(vm, true);
    }
    if (ready) {
        g_self = agent;
        g_receiver = mal_value_new_undefined();
        mal_gc_register_root_source(test262_agent_scan_roots, nullptr);
        mal_host_register_macrotask_drain(test262_agent_drain, false);
        mal_test262_install(vm);
    }
    pthread_mutex_lock(&g_test262.lock);
    agent->reactor = ready ? &mal_host(vm)->reactor : nullptr;
    agent->running = true;
    agent->exited = !ready;
    pthread_cond_broadcast(&g_test262.changed);
    pthread_mutex_unlock(&g_test262.lock);

    if (ready) {
        MalValue source = mal_value_from_string(
            mal_string_new_copy(&vm->heap, agent->source, agent->source_length));
        MalRootSpan root;
        mal_gc_root(&root, &source, 1);
        mal_realm_eval_script(vm, vm->current_realm, source);
        mal_gc_unroot(&root);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_host_run_event_loop_until(vm, test262_agent_left, nullptr);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) test262_agent_report_error(vm);
    }

    pthread_mutex_lock(&g_test262.lock);
    agent->reactor = nullptr;
    agent->exited = true;
    pthread_cond_broadcast(&g_test262.changed);
    pthread_mutex_unlock(&g_test262.lock);
    if (vm != nullptr) {
        if (ready) {
            test262_agent_stop_waiting(vm);
            g_receiver = mal_value_new_undefined();
        }
        mal_test262_detach_host(vm);
        mal_vm_free(vm);
        free(vm);
    }
    mal_atomics_set_agent(false, nullptr);
    g_self = nullptr;
    return nullptr;
}

static MalValue mal_test262_agent_start(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    Test262Agent *agent = calloc(1, sizeof(Test262Agent));
    if (agent == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    agent->source = test262_copy_units(vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &agent->source_length);
    if (agent->source == nullptr) {
        free(agent);
        return mal_value_new_undefined();
    }
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setstacksize(&attributes, TEST262_AGENT_STACK_BYTES);
    pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_mutex_lock(&g_test262.lock);
    agent->received = g_test262.generation;
    pthread_t thread;
    if (pthread_create(&thread, &attributes, test262_agent_main, agent) != 0) {
        pthread_mutex_unlock(&g_test262.lock);
        pthread_attr_destroy(&attributes);
        free(agent->source);
        free(agent);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "$262.agent.start: cannot start a thread");
        return mal_value_new_undefined();
    }
    pthread_attr_destroy(&attributes);
    agent->next = g_test262.agents;
    g_test262.agents = agent;
    while (!agent->running) pthread_cond_wait(&g_test262.changed, &g_test262.lock);
    pthread_mutex_unlock(&g_test262.lock);
    return mal_value_new_undefined();
}

static bool test262_broadcast_pending(void) {
    for (Test262Agent *agent = g_test262.agents; agent != nullptr; agent = agent->next) {
        if (!agent->exited && agent->received != g_test262.generation) return true;
    }
    return false;
}

static MalValue mal_test262_agent_broadcast(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count < 1 || !mal_value_is_array_buffer_object(args[0])
        || !mal_value_to_array_buffer_object(args[0])->shared) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "$262.agent.broadcast requires a SharedArrayBuffer");
        return mal_value_new_undefined();
    }
    MalValue value = arg_count > 1 ? args[1] : mal_value_new_undefined();
    bool bigint = mal_value_is_bigint(value);
    f64 number = 0;
    if (!bigint && !mal_value_is_undefined(value) && !mal_vm_to_number(vm, value, &number)) {
        return mal_value_new_undefined();
    }
    MalSharedMemory *memory = mal_value_to_array_buffer_object(args[0])->shared_memory;
    mal_shared_memory_retain(memory);
    pthread_mutex_lock(&g_test262.lock);
    if (g_test262.memory != nullptr) mal_shared_memory_release(g_test262.memory);
    g_test262.memory = memory;
    g_test262.bigint = bigint;
    g_test262.bigint_value = bigint ? mal_bigint_value(mal_value_to_bigint(value)) : 0;
    g_test262.number = number;
    g_test262.generation++;
    for (Test262Agent *agent = g_test262.agents; agent != nullptr; agent = agent->next) {
        if (agent->reactor != nullptr) mal_reactor_wake(agent->reactor);
    }
    while (test262_broadcast_pending()) pthread_cond_wait(&g_test262.changed, &g_test262.lock);
    pthread_mutex_unlock(&g_test262.lock);
    return mal_value_new_undefined();
}

static MalValue mal_test262_agent_get_report(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    pthread_mutex_lock(&g_test262.lock);
    Test262Report *report = g_test262.reports;
    if (report != nullptr) {
        g_test262.reports = report->next;
        if (g_test262.reports == nullptr) g_test262.reports_tail = nullptr;
    }
    pthread_mutex_unlock(&g_test262.lock);
    if (report == nullptr) return mal_value_new_null();
    MalString *string = mal_string_new_copy(&vm->heap, report->units, report->length);
    free(report);
    return mal_value_from_string(string);
}


static void test262_install_agent(MalVm *vm, MalObject *host) {
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    MalObject *agent = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_data(vm, host, "agent", mal_value_from_object(agent), flags);
    mal_intrinsic_define_method_n(vm, agent, "sleep", 1, mal_test262_agent_sleep);
    mal_intrinsic_define_method_n(vm, agent, "monotonicNow", 0, mal_test262_agent_monotonic_now);
    if (g_self != nullptr) {
        mal_intrinsic_define_method_n(vm, agent, "receiveBroadcast", 1, mal_test262_agent_receive_broadcast);
        mal_intrinsic_define_method_n(vm, agent, "report", 1, mal_test262_agent_report);
        mal_intrinsic_define_method_n(vm, agent, "leaving", 0, mal_test262_agent_leaving);
    } else {
        mal_intrinsic_define_method_n(vm, agent, "start", 1, mal_test262_agent_start);
        mal_intrinsic_define_method_n(vm, agent, "broadcast", 2, mal_test262_agent_broadcast);
        mal_intrinsic_define_method_n(vm, agent, "getReport", 0, mal_test262_agent_get_report);
    }
}

bool mal_test262_attach_host(MalVm *vm, const MalRuntimeImage *agent_image, bool can_block) {
    g_test262.image = agent_image;
    if (!test262_host_setup(vm, can_block)) return false;
    mal_test262_set_host_extension(test262_install_agent);
    mal_test262_install(vm);
    return true;
}

void mal_test262_run_event_loop(MalVm *vm) {
    if (vm->completion.kind != MAL_COMPLETION_THROW) mal_host_run_event_loop(vm);
}

void mal_test262_detach_host(MalVm *vm) {
    if (mal_host(vm) == nullptr) return;
    mal_host_timers_free(vm);
    mal_host_detach(vm);
}

#else

bool mal_test262_attach_host(MalVm *vm, const MalRuntimeImage *agent_image, bool can_block) {
    (void) agent_image;
    (void) can_block;
    mal_test262_install(vm);
    return true;
}

void mal_test262_run_event_loop(MalVm *vm) {
    (void) vm;
}

void mal_test262_detach_host(MalVm *vm) {
    (void) vm;
}

#endif
