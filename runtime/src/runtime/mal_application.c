#include "mal_application.h"

#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "workers.h"

#ifndef MAL_DEVELOPMENT_API
#define MAL_DEVELOPMENT_API 0
#endif

static MalValue application_ready(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
#if MAL_DEVELOPMENT_API
    return mal_value_new_boolean(mal_workers_application_ready(vm));
#else
    (void) vm;
    return mal_value_new_boolean(false);
#endif
}

static MalValue ready_function(MalVm *vm) {
    const char *identity = "maligator:application/ready";
    for (MalPreparedValue *entry = vm->prepared_values; entry != nullptr; entry = entry->next) {
        if (strcmp(entry->identity, identity) == 0) return entry->value;
    }
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue value = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, prototype, mal_intrinsic_ascii(vm, (const byte *) "ready"), 0, application_ready));
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalPreparedValue *entry = calloc(1, sizeof(*entry));
    if (entry != nullptr) {
        entry->identity = strdup(identity);
        entry->data = strdup("");
    }
    if (entry == nullptr || entry->identity == nullptr || entry->data == nullptr) {
        if (entry != nullptr) {
            free(entry->identity);
            free(entry->data);
            free(entry);
        }
        mal_vm_throw_allocation_error(vm);
    } else {
        entry->value = value;
        entry->next = vm->prepared_values;
        vm->prepared_values = entry;
    }
    mal_gc_unroot(&root);
    return value;
}

void mal_host_install_maligator_application(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "ready") != 0) continue;
        MalValue value = ready_function(vm);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        vm->globals[slots[i].slot] = value;
    }
}
