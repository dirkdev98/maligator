#include <stdio.h>
#include <pthread.h>
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static bool load(MalVm *vm, const byte *name, MalValue *out) {
    return mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], mal_intrinsic_string_key(vm, name), out);
}

static bool run_entry(MalVm *vm) {
    mal_vm_init(vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(vm, 0);
    mal_vm_run(vm, entry);
    mal_vm_free_callable(entry);
    return vm->completion.kind == MAL_COMPLETION_NORMAL;
}

static bool test_owned_callbacks(MalVm *vm, MalValue unowned, MalRealm *unowned_realm) {
    MalValue roots[4] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    bool ok = false;
    MalRealm *initial = vm->current_realm;
    MalRealm *owned = mal_realm_create(vm, nullptr, nullptr);
    MalExactScriptCall exact;
    if (!load(vm, "ownedSloppy", &roots[0])) goto done;
    i32 index = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
    if (index != mal_function_object_function_index(mal_value_to_function_object(unowned)) ||
        mal_vm_prepare_builtin_callback(vm, unowned, &exact) ||
        mal_vm_owns_realm(vm, unowned_realm) || mal_vm_owns_realm(vm, nullptr) ||
        !mal_vm_owns_realm(vm, owned)) goto done;
    MalFunctionObject *unstamped = mal_value_to_function_object(roots[0]);
    MalRealm *stamp = unstamped->realm;
    unstamped->realm = nullptr;
    bool accepted_unstamped = mal_vm_prepare_builtin_callback(vm, roots[0], &exact);
    unstamped->realm = stamp;
    if (accepted_unstamped) goto done;
    const byte *names[] = {"ownedSloppy", "ownedStrict", "ownedThrow"};
    for (i32 kind = 0; kind < 3; kind++) {
        if (!load(vm, names[kind], &roots[0])) goto done;
        index = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
        mal_realm_switch(vm, owned);
        roots[1] = mal_vm_op_create_function(vm, index, nullptr);
        mal_realm_switch(vm, initial);
        if (!mal_vm_prepare_builtin_callback(vm, roots[1], &exact) ||
            exact.function_index != index || exact.numeric_reduce_callback != nullptr ||
            exact.numeric_sort_comparator != nullptr || exact.numeric_sort_kernel != nullptr) goto done;
        vm->exact_script_call = &exact;
        MalCompletion result = mal_vm_call_builtin_callback(vm, roots[1], mal_value_from_i32(7), nullptr, 0);
        vm->exact_script_call = exact.previous;
        roots[2] = result.value;
        if (vm->current_realm != initial) goto done;
        if (kind == 2) {
            if (result.kind != MAL_COMPLETION_THROW || !mal_value_is_object(result.value) ||
                mal_object_prototype(mal_value_to_object(result.value)) != mal_value_to_object(owned->intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE])) goto done;
            vm->completion = (MalCompletion){.kind=MAL_COMPLETION_NORMAL,.value=mal_value_new_undefined()};
        } else if (kind == 1) {
            if (result.kind != MAL_COMPLETION_NORMAL || result.value != mal_value_from_i32(7)) goto done;
        } else {
            if (result.kind != MAL_COMPLETION_NORMAL || !mal_value_is_object(result.value) ||
                mal_object_prototype(mal_value_to_object(result.value)) != mal_value_to_object(owned->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE])) goto done;
            vm->exact_script_call = &exact;
            result = mal_vm_call_builtin_callback(vm, roots[1], mal_value_new_undefined(), nullptr, 0);
            vm->exact_script_call = exact.previous;
            if (result.kind != MAL_COMPLETION_NORMAL || result.value != owned->intrinsics[MAL_INTRINSIC_GLOBAL_THIS] || vm->current_realm != initial) goto done;
        }
        mal_gc_collect(vm);
    }
    ok = true;
done:
    mal_realm_switch(vm, initial);
    mal_gc_unroot(&span);
    return ok;
}

typedef struct ForeignVm {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    bool ready;
    bool release;
    bool ok;
    MalValue callback;
    MalRealm *realm;
} ForeignVm;

static void *foreign_vm_main(void *data) {
    ForeignVm *foreign = data;
    MalVm vm;
    bool ok = run_entry(&vm);
    MalValue callback = mal_value_new_undefined();
    if (ok) ok = load(&vm, "ownedSloppy", &callback);
    pthread_mutex_lock(&foreign->mutex);
    foreign->ok = ok;
    foreign->callback = callback;
    foreign->realm = vm.initial_realm;
    foreign->ready = true;
    pthread_cond_signal(&foreign->condition);
    // Its owning thread keeps the foreign heap stationary until the rejection check ends.
    while (!foreign->release) pthread_cond_wait(&foreign->condition, &foreign->mutex);
    pthread_mutex_unlock(&foreign->mutex);
    mal_vm_free(&vm);
    return nullptr;
}

int main(void) {
    MalVm vm;
    bool first = run_entry(&vm);
    ForeignVm foreign = {.mutex=PTHREAD_MUTEX_INITIALIZER,.condition=PTHREAD_COND_INITIALIZER};
    pthread_t thread;
    pthread_attr_t attributes;
    if (pthread_attr_init(&attributes) != 0) {
        mal_vm_free(&vm);
        return 1;
    }
    // The VM's native-stack reserve consumes macOS's default pthread stack.
    int spawn = pthread_attr_setstacksize(&attributes, 16u << 20);
    if (spawn == 0) spawn = pthread_create(&thread, &attributes, foreign_vm_main, &foreign);
    pthread_attr_destroy(&attributes);
    if (spawn != 0) {
        mal_vm_free(&vm);
        return 1;
    }
    pthread_mutex_lock(&foreign.mutex);
    while (!foreign.ready) pthread_cond_wait(&foreign.condition, &foreign.mutex);
    bool ok = first && foreign.ok && test_owned_callbacks(&vm, foreign.callback, foreign.realm);
    foreign.release = true;
    pthread_cond_signal(&foreign.condition);
    pthread_mutex_unlock(&foreign.mutex);
    pthread_join(thread, nullptr);
    pthread_cond_destroy(&foreign.condition);
    pthread_mutex_destroy(&foreign.mutex);
    mal_vm_free(&vm);
    if (!ok) { fputs("owned-realm-callback failure\n", stderr); return 1; }
    puts("owned-realm-callback PASS");
    return 0;
}
