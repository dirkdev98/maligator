#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "builtin_iterator_helpers.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static bool get_global(MalVm *vm, const byte *name, MalValue *out) {
    return mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], mal_intrinsic_string_key(vm, name), out);
}

static bool boundary(MalVm *vm, const byte *method, f64 start, const f64 expected[3]) {
    MalValue roots[4] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    bool ok = false;
    if (!get_global(vm, "createBoundaryHelper", &roots[0])) goto done;
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, method));
    MalCompletion made = mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), &roots[1], 1);
    if (made.kind != MAL_COMPLETION_NORMAL || !mal_value_is_iterator_helper_object(made.value)) goto done;
    roots[2] = made.value;
    MalIteratorHelperObject *helper = mal_value_to_iterator_helper_object(roots[2]);
    helper->counter = start;
    if (!mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, "next"), &roots[3])) goto done;
    MalIteratorRecord record = {.iterator = roots[2], .next_method = roots[3]};
    for (i32 step = 0; step < 3; step++) {
        if (step == 1) {
            // No frames are active: force physical relocation between two real resumes.
            usize bytes = (usize) vm->function_capacity * sizeof(MalFunction);
            MalFunction *moved = malloc(bytes);
            if (moved == nullptr) goto done;
            memcpy(moved, vm->live_runtime_image.functions, bytes);
            free((MalFunction *) vm->live_runtime_image.functions);
            vm->live_runtime_image.functions = moved;
            mal_gc_collect(vm);
        }
        MalValue value;
        bool finished;
        if (step == 1) {
            if (mal_builtin_iterator_helper_try_step(vm, &record, &value, &finished) != 1 || finished) goto done;
        } else {
            MalCompletion result = mal_vm_call_value(vm, roots[3], roots[2], nullptr, 0);
            if (result.kind != MAL_COMPLETION_NORMAL) goto done;
        }
        MalValue observed;
        f64 number;
        if (!get_global(vm, "observedIndex", &observed) ||
            !mal_ops_try_number_as_f64(observed, &number) || number != expected[step] ||
            vm->exact_script_call != nullptr) goto done;
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
    bool ok = vm.completion.kind == MAL_COMPLETION_NORMAL;
    const f64 i32_values[3] = {2147483647.0, 2147483648.0, 2147483649.0};
    const f64 rounded_values[3] = {9007199254740991.0, 9007199254740992.0, 9007199254740992.0};
    const byte *methods[] = {"map", "filter", "flatMap"};
    for (i32 kind = 0; kind < 3 && ok; kind++) {
        ok = boundary(&vm, methods[kind], i32_values[0], i32_values) &&
            boundary(&vm, methods[kind], rounded_values[0], rounded_values);
    }
    mal_vm_free(&vm);
    if (!ok) { fputs("iterator callback boundary failure\n", stderr); return 1; }
    puts("iterator-callback-boundaries PASS");
    return 0;
}
