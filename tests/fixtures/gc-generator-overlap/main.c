#include <pthread.h>
#include <stdio.h>
#include <time.h>

#include "function_object.h"
#include "gc.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static bool worker_entered;
static bool release_worker;
static MalEnv **carriers;
static usize carrier_count;
static MalObject *token;
static u32 token_finalized;

static usize one_worker(void) { return 1; }

static MalValue global_property(MalVm *vm, const byte *name) {
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    MalPropertyLookup found = mal_object_get_own(global, mal_intrinsic_string_key(vm, name));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

static MalValue observe_token(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count == 1 && mal_value_is_object(args[0])) token = mal_value_to_object(args[0]);
    return mal_value_new_undefined();
}

static bool frame_roots_token(const MalVmFrame *frame) {
    const MalFunction *function = frame->function;
    if (function == nullptr || function->compiled == nullptr ||
        frame->registers == nullptr || token == nullptr) return false;
    for (i32 slot = 0; slot < frame->compiled_register_count; slot++) {
        if (frame->registers[slot] == mal_value_from_object(token)) return true;
    }
    return false;
}

static void pause_carrier(MalEnv *env) {
    bool owned = false;
    for (usize i = 0; i < carrier_count; i++) {
        if (carriers[i] == env) owned = true;
    }
    if (!owned) return;
    pthread_mutex_lock(&gate_mutex);
    if (!worker_entered) {
        worker_entered = true;
        pthread_cond_signal(&gate_cond);
        while (!release_worker) pthread_cond_wait(&gate_cond, &gate_mutex);
    }
    pthread_mutex_unlock(&gate_mutex);
}

static void release_carrier(void) {
    pthread_mutex_lock(&gate_mutex);
    release_worker = true;
    pthread_cond_broadcast(&gate_cond);
    pthread_mutex_unlock(&gate_mutex);
}

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) token) token_finalized++;
}

int main(void) {
    mal_gc_test_worker_limit_hook = one_worker;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_gc_worker_limit(&vm) == 0) {
        mal_vm_free(&vm);
        mal_gc_test_worker_limit_hook = nullptr;
        puts("gc-generator-overlap SKIP");
        return 0;
    }
    vm.heap.next_gc_at = SIZE_MAX;
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_method(&vm, global, "__gcObserveToken", observe_token);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_vm_free_callable(callable);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;

    MalValue factory = global_property(&vm, "__gcMakeGenerator");
    if (!mal_value_is_function_object(factory)) return 2;
    MalValue roots[128];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan carrier_span;
    mal_gc_root(&carrier_span, roots, (i32) countof(roots));
    MalValue temporary = mal_value_new_undefined();
    MalRootSpan temporary_span;
    mal_gc_root(&temporary_span, &temporary, 1);
    MalCompletion created = mal_vm_call_value(
        &vm, factory, mal_value_new_undefined(), nullptr, 0);
    if (created.kind != MAL_COMPLETION_NORMAL ||
        !mal_value_is_generator_object(created.value)) return 3;
    temporary = created.value;
    MalGeneratorObject *generator = (MalGeneratorObject *) mal_value_to_object(temporary);
    mal_vm_resume_generator(&vm, generator, mal_value_new_undefined(),
                            MAL_GENERATOR_RESUME_NEXT);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL ||
        generator->state != MAL_GENERATOR_SUSPENDED_YIELD ||
        !frame_roots_token(&generator->frame)) {
        fprintf(stderr, "generator frame: state=%d completion=%d compiled=%d registers=%p token=%p\n",
                generator->state, vm.completion.kind,
                generator->frame.function != nullptr && generator->frame.function->compiled != nullptr,
                (void *) generator->frame.registers,
                (void *) token);
        return 4;
    }

    MalEnv *envs[128];
    for (usize i = 0; i < countof(roots); i++) {
        envs[i] = mal_env_new(&vm, nullptr, (i32) i, 1);
        envs[i]->slots[0] = temporary;
        roots[i] = mal_value_from_heap(&envs[i]->header);
    }
    carriers = envs;
    carrier_count = countof(envs);
    mal_gc_unroot(&temporary_span);
    vm.completion.value = mal_value_new_undefined();
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    mal_gc_test_trace_env_hook = pause_carrier;

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 5;
    mal_gc_safepoint(&vm);
    pthread_mutex_lock(&gate_mutex);
    struct timespec deadline;
    timespec_get(&deadline, TIME_UTC);
    deadline.tv_sec += 30;
    while (!worker_entered) {
        if (pthread_cond_timedwait(&gate_cond, &gate_mutex, &deadline) != 0) {
            pthread_mutex_unlock(&gate_mutex);
            return 6;
        }
    }
    pthread_mutex_unlock(&gate_mutex);

    int failure = 0;
    if (mal_heap_mark_is_current(generator->object.header.mark, vm.heap.mark_color) ||
        mal_heap_mark_is_current(token->header.mark, vm.heap.mark_color)) {
        failure = 7;
        goto done;
    }
    vm.heap.next_gc_at = SIZE_MAX;
    mal_gc_poll = false;
    mal_vm_resume_generator(&vm, generator, mal_value_new_undefined(),
                            MAL_GENERATOR_RESUME_NEXT);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL ||
        !mal_value_is_int32(vm.completion.value) ||
        mal_value_to_i32(vm.completion.value) != 181 ||
        generator->state != MAL_GENERATOR_COMPLETED ||
        generator->frame.registers != nullptr ||
        generator->frame.arguments != nullptr) failure = 8;

done:
    release_carrier();
    if (failure == 0 && (!mal_gc_finish_pending_cycle(&vm) || token_finalized != 0)) {
        failure = 9;
    }
    if (failure == 0) {
        vm.completion.value = mal_value_new_undefined();
        mal_gc_collect(&vm);
        if (token_finalized != 1) failure = 10;
    }
    mal_gc_test_trace_env_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_unroot(&carrier_span);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    if (failure != 0) return failure;
    puts("gc-generator-overlap PASS");
    return 0;
}
