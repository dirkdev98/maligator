#include "vm.h"

#include <stdlib.h>

#include "intrinsics.h"

extern const MalVmDefinition mal_vm_definition;

static const MalIntrinsic companion_slots[] = {
    MAL_INTRINSIC_NODE_URL_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_URL_PROTOTYPE,
    MAL_INTRINSIC_NODE_URL_MODULE,
    MAL_INTRINSIC_NODE_QUERYSTRING_MODULE,
    MAL_INTRINSIC_NODE_NET_MODULE,
};

static void install_fragmented(
    MalVm *vm, const MalHostLaunchContext *launch, bool reverse) {
    for (i32 step = 0; step < vm->definition->host_install_count; step++) {
        i32 index = reverse ? vm->definition->host_install_count - step - 1 : step;
        const MalHostInstall *install = &vm->definition->host_installs[index];
        for (i32 slot_step = 0; slot_step < install->slot_count; slot_step++) {
            i32 slot = reverse ? install->slot_count - slot_step - 1 : slot_step;
            install->installer(vm, &install->slots[slot], 1, launch);
        }
    }
}

static void read_companions(MalVm *vm, MalValue *values) {
    for (usize i = 0; i < countof(companion_slots); i++) {
        values[i] = vm->intrinsics[companion_slots[i]];
    }
}

static bool same_companions(const MalValue *left, const MalValue *right) {
    for (usize i = 0; i < countof(companion_slots); i++) {
        if (mal_value_is_undefined(left[i]) || left[i] != right[i]) return false;
    }
    return true;
}

#if MAL_REALMS
typedef struct CompanionRealmCheck {
    const MalHostLaunchContext *launch;
    MalValue initial[countof(companion_slots)];
    bool reverse;
    bool ok;
} CompanionRealmCheck;

static void check_second_realm(MalVm *vm, void *data) {
    CompanionRealmCheck *check = data;
    MalValue first[countof(companion_slots)];
    MalValue repeated[countof(companion_slots)];
    install_fragmented(vm, check->launch, check->reverse);
    read_companions(vm, first);
    install_fragmented(vm, check->launch, !check->reverse);
    read_companions(vm, repeated);
    check->ok = same_companions(first, repeated);
    for (usize i = 0; i < countof(companion_slots); i++) {
        check->ok = check->ok && first[i] != check->initial[i];
    }
}
#endif

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    bool reverse = getenv("MAL_NODE_INSTALL_REVERSE") != nullptr;
    MalValue first[countof(companion_slots)];
    MalValue repeated[countof(companion_slots)];
    install_fragmented(&vm, &launch, reverse);
    read_companions(&vm, first);
    install_fragmented(&vm, &launch, !reverse);
    read_companions(&vm, repeated);
    if (!same_companions(first, repeated)) return 2;

#if MAL_REALMS
    CompanionRealmCheck check = {.launch = &launch, .reverse = reverse, .ok = false};
    read_companions(&vm, check.initial);
    mal_realm_create(&vm, check_second_realm, &check);
    if (!check.ok) return 3;
#endif

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    return vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
}
