#include "vm.h"

#include <stdlib.h>

#include "intrinsics.h"
#include "object.h"

extern const MalProgramImage mal_vm_definition;

enum { HTTP_IDENTITY_COUNT = 7 };

static const MalIntrinsic http_slots[HTTP_IDENTITY_COUNT] = {
    MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_PROTOTYPE,
    MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_PROTOTYPE,
    MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_HTTP_SERVER_PROTOTYPE,
    MAL_INTRINSIC_NODE_HTTP_MODULE,
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

static void read_http(MalVm *vm, MalValue *values) {
    for (usize i = 0; i < HTTP_IDENTITY_COUNT; i++) {
        values[i] = vm->intrinsics[http_slots[i]];
    }
}

static bool same_http(const MalValue *left, const MalValue *right) {
    for (usize i = 0; i < HTTP_IDENTITY_COUNT; i++) {
        if (left[i] != right[i]) return false;
    }
    return true;
}

#if MAL_REALMS
typedef struct HttpRealmCheck {
    const MalHostLaunchContext *launch;
    MalValue initial[HTTP_IDENTITY_COUNT];
    bool reverse;
    bool ok;
} HttpRealmCheck;

static void check_second_realm(MalVm *vm, void *data) {
    HttpRealmCheck *check = data;
    MalValue first[HTTP_IDENTITY_COUNT];
    MalValue repeated[HTTP_IDENTITY_COUNT];
    install_fragmented(vm, check->launch, check->reverse);
    read_http(vm, first);
    install_fragmented(vm, check->launch, !check->reverse);
    read_http(vm, repeated);
    check->ok = same_http(first, repeated);
    for (usize i = 0; i < HTTP_IDENTITY_COUNT; i++) {
        check->ok = check->ok && !mal_value_is_undefined(first[i])
            && first[i] != check->initial[i];
    }
}
#endif

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    bool reverse = getenv("MAL_NODE_INSTALL_REVERSE") != nullptr;
    MalValue first[HTTP_IDENTITY_COUNT];
    MalValue repeated[HTTP_IDENTITY_COUNT];
    install_fragmented(&vm, &launch, reverse);
    read_http(&vm, first);
    install_fragmented(&vm, &launch, !reverse);
    read_http(&vm, repeated);
    if (!same_http(first, repeated)) return 2;

#if MAL_REALMS
    HttpRealmCheck check = {.launch = &launch, .reverse = reverse, .ok = false};
    read_http(&vm, check.initial);
    mal_realm_create(&vm, check_second_realm, &check);
    if (!check.ok) return 3;
#endif

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    return vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
}
