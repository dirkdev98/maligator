#include <stdio.h>

#include "builtin_weak_ref.h"
#include "gc.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "object.h"
#include "value.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static MalValue global_property(MalVm *vm, const byte *name) {
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    MalPropertyLookup lookup = mal_object_get_own(
        global, mal_intrinsic_string_key(vm, name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static i32 dead_register_slot(const MalVmFrame *frame) {
    const MalFunction *function = frame->function;
    if (function == nullptr || !function->gc_safepoints_trusted ||
        frame->gc_safepoint_ip < 0) return -1;
    const i32 *row = function->gc_safepoints;
    for (i32 index = 0; index < function->gc_safepoint_count; index++) {
        i32 ip = *row++;
        i32 root_count = *row++;
        const i32 *roots = row;
        row += root_count;
        i32 clear_count = *row++;
        if (ip == frame->gc_safepoint_ip) {
            for (i32 candidate_ip = ip - 1; candidate_ip >= 0; candidate_ip--) {
                const MalInstruction *instruction = &function->instructions[candidate_ip];
                i32 candidate;
                if (instruction->opcode == MAL_OP_CREATE_OBJECT) {
                    candidate = instruction->as.create_object.dst;
                } else if (instruction->opcode == MAL_OP_CREATE_OBJECT_SHAPED) {
                    candidate = instruction->as.create_object_shaped.dst;
                } else {
                    continue;
                }
                bool live = false;
                for (i32 root = 0; root < root_count; root++) {
                    if (candidate == roots[root]) live = true;
                }
                if (!live) return candidate;
            }
            return -1;
        }
        row += clear_count;
        if (ip > frame->gc_safepoint_ip) break;
    }
    return -1;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_vm_free_callable(callable);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;

    MalValue generator_value = global_property(&vm, "__satbGenerator");
    MalValue weak_value = global_property(&vm, "__satbWeak");
    if (!mal_value_is_generator_object(generator_value) ||
        !mal_value_is_weak_ref_object(weak_value)) return 2;
    MalGeneratorObject *generator =
        (MalGeneratorObject *) mal_value_to_object(generator_value);
    MalWeakRefObject *weak = mal_value_to_weak_ref_object(weak_value);
    if (mal_value_is_undefined(weak->target)) return 3;

    i32 stale_slot = dead_register_slot(&generator->frame);
    if (stale_slot < 0 || stale_slot >= generator->frame.function->register_count) {
        fprintf(stderr, "missing excluded object slot: ip=%d trusted=%d safepoints=%d registers=%d slot=%d\n",
                generator->frame.gc_safepoint_ip,
                generator->frame.function->gc_safepoints_trusted,
                generator->frame.function->gc_safepoint_count,
                generator->frame.function->register_count, stale_slot);
        return 8;
    }
    generator->frame.registers[stale_slot] = weak->target;

    mal_vm_clear_kept_objects(&vm);
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 4;

    mal_vm_resume_generator(&vm, generator, mal_value_new_undefined(),
                            MAL_GENERATOR_RESUME_NEXT);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL ||
        mal_value_to_i32(vm.completion.value) != 17) return 5;

    for (int steps = 0; steps < 1000 &&
         (mal_gc_marking_active || vm.heap.sweeping); steps++) {
        mal_gc_safepoint(&vm);
    }
    if (mal_gc_marking_active || vm.heap.sweeping) return 6;
    if (!mal_value_is_undefined(weak->target)) return 7;

    mal_vm_free(&vm);
    puts("safepoint-satb-incremental PASS");
    return 0;
}
