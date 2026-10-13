#include <stdio.h>
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "microtask.h"
#include "promise_object.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static bool get(MalVm *vm, const byte *name, MalValue *out) {
    return mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], mal_intrinsic_string_key(vm, name), out);
}

static bool call_global(MalVm *vm, const byte *name, const MalValue *args, i32 count, MalValue *out) {
    MalValue fn;
    if (!get(vm, name, &fn)) return false;
    MalCompletion result = mal_vm_call_value(vm, fn, mal_value_new_undefined(), args, count);
    *out = result.value;
    return result.kind == MAL_COMPLETION_NORMAL;
}

static bool boundary(MalVm *vm, bool array_like, bool limit, f64 start) {
    MalValue roots[3] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    bool ok = false;
    MalValue args[2] = {mal_value_new_boolean(array_like), mal_value_new_boolean(limit)};
    if (!call_global(vm, "startBoundary", args, 2, &roots[0]) ||
        !get(vm, "pendingNext", &roots[0]) || !mal_value_is_promise_object(roots[0])) goto done;
    MalPromiseReaction *reaction = mal_value_to_promise_object(roots[0])->reactions_head;
    if (reaction == nullptr || !mal_value_is_native_function_object(reaction->on_fulfilled)) goto done;
    roots[1] = reaction->on_fulfilled;
    MalNativeFunctionObject *step = mal_value_to_native_function_object(roots[1]);
    // Seed the retained index ABI, then exercise real next/map/define/close reactions without billions of iterations.
    f64 index;
    if (step->slot_count != 15 || !mal_ops_try_number_as_f64(mal_native_function_object_get_slot(step, 1), &index) || index != 0) goto done;
    mal_native_function_object_set_slot(step, 1, mal_value_from_f64(start));
    mal_gc_collect(vm);
    if (!call_global(vm, "finishFirst", nullptr, 0, &roots[2])) goto done;
    mal_vm_drain_microtasks(vm);
    mal_gc_collect(vm);
    if (vm->completion.kind != MAL_COMPLETION_NORMAL || vm->exact_script_call != nullptr ||
        !call_global(vm, "checkBoundary", nullptr, 0, &roots[2]) || !mal_value_is_truthy(roots[2])) goto done;
    if (limit) {
        if (!call_global(vm, "finishClose", nullptr, 0, &roots[2])) goto done;
        mal_vm_drain_microtasks(vm);
        if (!call_global(vm, "checkClosed", nullptr, 0, &roots[2]) || !mal_value_is_truthy(roots[2]) ||
            !mal_value_is_undefined(mal_native_function_object_get_slot(step, 14))) goto done;
    }
    ok = true;
done:
    mal_gc_unroot(&span);
    return ok;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    mal_vm_free_callable(entry);
    bool ok = vm.completion.kind == MAL_COMPLETION_NORMAL &&
        boundary(&vm, false, false, 4294967296.0) &&
        boundary(&vm, true, false, 4294967295.0) &&
        boundary(&vm, false, true, 9007199254740990.0);
    mal_vm_free(&vm);
    if (!ok) { fputs("fromAsync boundary failure\n", stderr); return 1; }
    puts("from-async-boundaries PASS");
    return 0;
}
