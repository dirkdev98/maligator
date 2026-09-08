#include "vm.h"
#include "vm_ops.h"
#include "intrinsics.h"
#include "rooted_collection.h"
#include "object_ops.h"
#include "function_object.h"
#include "heap_symbol.h"
#include "heap_bigint.h"
#include "host.h"
#include "web_events_object.h"
#include "web_fetch.h"
#include "node_immediate.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_url_object.h"
#include "web_globals.h"

#include <stdio.h>
#include <inttypes.h>
#include <string.h>

extern const MalRuntimeImage mal_runtime_image;

typedef struct InventoryRoot {
    const char *name;
    i32 slot;
} InventoryRoot;

static const InventoryRoot inventory_roots[] = {
    // The test driver replaces this marker from the actual conditional intrinsic enum.
    MAL_INVENTORY_ROOTS
};

static MalRootedValueList inventory_values;
static MalNativeFunctionCallback *inventory_callbacks;
static usize inventory_callback_count;
static MalValue inventory_sentinel;

static MalValue inventory_forbidden_accessor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    abort();
}

static void inventory_string(MalString *string) {
    if (string == nullptr) { fputs("null", stdout); return; }
    putchar('"');
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        printf("\\u%04x", (unsigned) units[i]);
    }
    putchar('"');
}

static usize inventory_identity(MalValue value) {
    for (usize i = 0; i < inventory_values.count; i++) {
        if (inventory_values.values[i] == value) return i;
    }
    mal_rooted_value_list_append(&inventory_values, value);
    return inventory_values.count - 1;
}

static void inventory_value(MalValue value) {
    if (mal_value_is_object(value) || mal_value_is_symbol(value)) {
        printf("{\"ref\":%zu}", inventory_identity(value));
    } else if (mal_value_is_string(value)) {
        fputs("{\"string\":", stdout);
        inventory_string(mal_value_to_string(value));
        putchar('}');
    } else if (mal_value_is_bigint(value)) {
        u128 bits = (u128) mal_bigint_value(mal_value_to_bigint(value));
        printf("{\"bigint\":\"%016" PRIx64 "%016" PRIx64 "\"}", (uint64_t) (bits >> 64), (uint64_t) bits);
    } else {
        // Raw primitive bits distinguish -0, NaN and undefined without invoking conversion.
        printf("{\"bits\":\"%016" PRIx64 "\"}", (uint64_t) value);
    }
}

static void inventory_key(MalKey key) {
    if (key.kind == MAL_KEY_STRING) {
        fputs("{\"string\":", stdout);
        inventory_string(mal_value_to_string(key.value));
        putchar('}');
    } else if (key.kind == MAL_KEY_INDEX) {
        printf("{\"string\":\"%u\"}", mal_key_index_value(key));
    } else if (key.kind == MAL_KEY_SYMBOL) {
        printf("{\"symbol\":%zu}", inventory_identity(key.value));
    } else abort();
}

static void inventory_node(MalVm *vm, usize id) {
    MalValue value = inventory_values.values[id];
    printf("{\"type\":\"node\",\"id\":%zu", id);
    if (mal_value_is_symbol(value)) {
        fputs(",\"kind\":\"symbol\",\"description\":", stdout);
        inventory_string(mal_symbol_description(mal_value_to_symbol(value)));
        puts("}");
        return;
    }
    MalObject *object = mal_value_to_object(value);
    printf(",\"kind\":\"object\",\"locked\":%s,\"prototype\":",
           object->primordial_locked ? "true" : "false");
    MalObject *prototype = mal_object_get_prototype(object);
    inventory_value(prototype == nullptr ? mal_value_new_null() : mal_value_from_object(prototype));
    if (mal_value_is_native_function_object(value)) {
        MalNativeFunctionObject *fn = mal_value_to_native_function_object(value);
        usize callback = 0;
        while (callback < inventory_callback_count && inventory_callbacks[callback] != fn->callback) callback++;
        if (callback == inventory_callback_count) {
            inventory_callbacks = realloc(inventory_callbacks, (++inventory_callback_count) * sizeof(*inventory_callbacks));
            if (inventory_callbacks == nullptr) abort();
            inventory_callbacks[callback] = fn->callback;
        }
        printf(",\"implementation\":%zu,\"callable\":true,\"constructable\":%s,\"slots\":%d",
               callback, fn->is_constructor ? "true" : "false", fn->slot_count);
    }
    puts("}");
    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    if (!mal_rooted_key_snapshot_own_keys(vm, value, &keys)) abort();
    for (usize i = 0; i < keys.count; i++) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, value, keys.keys[i], &present, &desc)) abort();
        if (!present) abort();
        printf("{\"type\":\"descriptor\",\"owner\":%zu,\"key\":", id);
        inventory_key(keys.keys[i]);
        printf(",\"flags\":%u", (unsigned) desc.flags);
        if (desc.flags & MAL_PROPERTY_ACCESSOR) {
            fputs(",\"get\":", stdout); inventory_value(desc.getter);
            fputs(",\"set\":", stdout); inventory_value(desc.setter);
        } else {
            fputs(",\"value\":", stdout); inventory_value(desc.value);
        }
        puts("}");
    }
    mal_rooted_key_snapshot_dispose(&keys);
}

static void inventory_snapshot(MalVm *vm, const char *phase) {
    printf("{\"type\":\"phase\",\"name\":\"%s\"}\n", phase);
    mal_rooted_value_list_init(&inventory_values);
    for (usize i = 0; i < countof(inventory_roots); i++) {
        printf("{\"type\":\"root\",\"name\":\"%s\",\"value\":", inventory_roots[i].name);
        inventory_value(vm->intrinsics[inventory_roots[i].slot]);
        puts("}");
    }
    if (!mal_value_is_undefined(inventory_sentinel)) {
        fputs("{\"type\":\"root\",\"name\":\"test:sentinel\",\"value\":", stdout);
        inventory_value(inventory_sentinel);
        puts("}");
    }
    for (i32 i = 0; i < vm->runtime_image->host_install_count; i++) {
        const MalHostInstall *install = &vm->runtime_image->host_installs[i];
        for (i32 j = 0; j < install->slot_count; j++) {
            const MalHostInstallSlot *slot = &install->slots[j];
            printf("{\"type\":\"host-root\",\"installer\":%d,\"name\":\"%s\",\"value\":", i, slot->name);
            inventory_value(vm->globals[slot->slot]);
            puts("}");
        }
    }
    for (usize i = 0; i < inventory_values.count; i++) inventory_node(vm, i);
    mal_rooted_value_list_dispose(&inventory_values);
    free(inventory_callbacks);
    inventory_callbacks = nullptr;
    inventory_callback_count = 0;
}

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    inventory_sentinel = mal_value_new_undefined();
    MalRootSpan sentinel_root;
    mal_gc_root(&sentinel_root, &inventory_sentinel, 1);
    if (argc > 1 && strcmp(argv[1], "--check-no-getter") == 0) {
        inventory_sentinel = mal_value_from_object(mal_object_new(&vm.heap, nullptr));
        MalValue getter = mal_value_from_object((MalObject *) mal_native_function_object_new(
            &vm.heap, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(&vm, "forbidden"), inventory_forbidden_accessor));
        MalRootSpan getter_root;
        mal_gc_root(&getter_root, &getter, 1);
        MalPropertyDesc desc = mal_intrinsic_accessor_desc(getter, getter, MAL_PROPERTY_CONFIGURABLE);
        if (mal_object_define_own(mal_value_to_object(inventory_sentinel), mal_intrinsic_string_key(&vm, "trap"), &desc) != MAL_DEFINE_OWN_APPLIED) abort();
        mal_gc_unroot(&getter_root);
    }
    inventory_snapshot(&vm, "language-initialized");
    MAL_INVENTORY_HOST_INSTALLS
    inventory_snapshot(&vm, "host-installed");
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_gc_unroot(&sentinel_root);
    mal_vm_free(&vm);
    return 0;
}
