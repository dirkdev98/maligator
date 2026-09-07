#include "mal_process.h"

#include <stdlib.h>
#include <string.h>

#include "builtin_json.h"
#include "builtin_object.h"
#include "gc.h"
#include "heap_string.h"
#include "utf8.h"
#include "rooted_collection.h"
#include "vm_ops.h"

static bool freeze_prepared_data(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) return true;
    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    bool ok = mal_rooted_key_snapshot_own_keys(vm, value, &keys);
    for (usize i = 0; ok && i < keys.count; i++) {
        bool present;
        MalPropertyDesc desc;
        ok = mal_vm_get_own_property(vm, value, keys.keys[i], &present, &desc);
        if (ok && present) ok = freeze_prepared_data(vm, desc.value);
    }
    mal_rooted_key_snapshot_dispose(&keys);
    return ok && mal_builtin_object_set_integrity(vm, value, true);
}

static MalValue prepared_value(MalVm *vm, const char *identity, const char *data) {
    if (data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Missing prepared platform export data");
        return mal_value_new_undefined();
    }
    for (MalPreparedValue *entry = vm->prepared_values; entry != nullptr; entry = entry->next) {
        if (strcmp(entry->identity, identity) != 0) continue;
        if (strcmp(entry->data, data) != 0) continue;
        return entry->value;
    }
    MalString *text = mal_string_from_utf8(&vm->heap, (const byte *) data, strlen(data));
    if (text == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue value = mal_value_from_string(text);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    value = mal_builtin_json_parse_intrinsic(vm, value);
    if (vm->completion.kind != MAL_COMPLETION_THROW && freeze_prepared_data(vm, value)) {
        MalPreparedValue *entry = calloc(1, sizeof(*entry));
        if (entry != nullptr) {
            entry->identity = strdup(identity);
            entry->data = strdup(data);
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
    }
    mal_gc_unroot(&root);
    return value;
}

void mal_host_install_maligator_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "execution") != 0) continue;
        MalValue value = prepared_value(vm, "maligator:process/execution", slots[i].data);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        vm->globals[slots[i].slot] = value;
    }
}
