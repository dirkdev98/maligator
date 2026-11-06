#include "vm.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#include "gc.h"
#include "host.h"
#include "intrinsics.h"
#include "object.h"
#include "personality.h"
#include "web_host_timer.h"
#include "workers.h"

extern const MalRuntimeImage mal_runtime_image;
extern void mal_register_compiled_worker_entries(void);

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_changed = PTHREAD_COND_INITIALIZER;
static pthread_t other_root;
static bool root_ready;
static bool check_root;
static bool root_joined;

static void *run_other_root(void *data) {
    (void) data;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalKey key = mal_intrinsic_string_key(&vm, "marker");
    MalValue value = mal_value_from_object(mal_object_new(&vm.heap, nullptr));
    if (!mal_object_set(mal_value_to_object(value), key, mal_value_from_i32(173))) abort();
    MalRootSpan span;
    mal_gc_root(&span, &value, 1);
    mal_gc_set_mutator_busy(&vm, false);

    pthread_mutex_lock(&gate_mutex);
    root_ready = true;
    pthread_cond_broadcast(&gate_changed);
    while (!check_root) pthread_cond_wait(&gate_changed, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);

    if (mal_isolate_locals() != vm.isolate) {
        fputs("independent root selected another isolate after worker join\n", stderr);
        _Exit(1);
    }
    mal_gc_set_mutator_busy(&vm, true);
    mal_gc_collect(&vm);
    MalPropertyLookup marker = mal_object_get_own(mal_value_to_object(value), key);
    if (!marker.present || !mal_value_is_int32(marker.desc.value) ||
            mal_value_to_i32(marker.desc.value) != 173) abort();
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    return nullptr;
}

static MalValue start_other_root(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) new_target; (void) callee;
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setstacksize(&attributes, 16u << 20);
    if (pthread_create(&other_root, &attributes, run_other_root, nullptr) != 0) abort();
    pthread_attr_destroy(&attributes);
    mal_gc_set_mutator_busy(vm, false);
    pthread_mutex_lock(&gate_mutex);
    while (!root_ready) pthread_cond_wait(&gate_changed, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);
    mal_gc_set_mutator_busy(vm, true);
    return mal_value_new_undefined();
}

static MalValue check_other_root(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) new_target; (void) callee;
    if (mal_workers_live_count() != 0) abort();
    pthread_mutex_lock(&gate_mutex);
    check_root = true;
    pthread_cond_broadcast(&gate_changed);
    pthread_mutex_unlock(&gate_mutex);
    mal_gc_set_mutator_busy(vm, false);
    int joined = pthread_join(other_root, nullptr);
    mal_gc_set_mutator_busy(vm, true);
    if (joined != 0) abort();
    root_joined = true;
    return mal_value_new_undefined();
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_register_compiled_worker_entries();
    if (mal_host_attach(&vm) == nullptr) return 2;
    mal_runtime_personality_install(&vm, true, false);
    const MalHostLaunchContext launch = {.script_path = mal_runtime_image.entry_path};
    mal_vm_run_host_installs(&vm, &launch);
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_method(&vm, global, "startOtherRoot", start_other_root);
    mal_intrinsic_define_method(&vm, global, "checkOtherRoot", check_other_root);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_host_run_event_loop(&vm);
    int code = mal_host_finish_process(&vm, vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0);
    if (code == 0 && !root_joined) {
        fputs("independent root checker did not complete\n", stderr);
        code = 1;
    }
    mal_vm_free_callable(callable);
    mal_workers_shutdown(&vm);
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    if (code != 0) return code;
    puts("isolate roots PASS");
    return 0;
}
