#include "vm.h"

#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"

extern const MalProgramImage mal_vm_definition;

enum {
    BUFFER_IDENTITY_COUNT = 3,
    EVENT_IDENTITY_COUNT = 2,
    STREAM_IDENTITY_COUNT = 10,
};

static const MalIntrinsic buffer_identity_slots[BUFFER_IDENTITY_COUNT] = {
    MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE,
    MAL_INTRINSIC_NODE_BUFFER_MODULE,
};

static const MalIntrinsic stream_identity_slots[STREAM_IDENTITY_COUNT] = {
    MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_STREAM_PROTOTYPE,
    MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_READABLE_PROTOTYPE,
    MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_WRITABLE_PROTOTYPE,
    MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_DUPLEX_PROTOTYPE,
    MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_TRANSFORM_PROTOTYPE,
};

static const MalIntrinsic event_identity_slots[EVENT_IDENTITY_COUNT] = {
    MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE,
};

static MalValue own_property(MalVm *vm, MalValue object, const byte *name) {
    MalPropertyLookup lookup = mal_object_get_own(
        mal_value_to_object(object), mal_intrinsic_string_key(vm, name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void read_identities(
    MalVm *vm, const MalIntrinsic *slots, usize count, MalValue *values) {
    for (usize i = 0; i < count; i++) values[i] = vm->intrinsics[slots[i]];
}

static bool identities_equal(
    const MalValue *left, const MalValue *right, usize count) {
    for (usize i = 0; i < count; i++) {
        if (left[i] != right[i]) return false;
    }
    return true;
}

static bool identities_distinct(
    const MalValue *left, const MalValue *right, usize count) {
    for (usize i = 0; i < count; i++) {
        if (left[i] == right[i]) return false;
    }
    return true;
}

static bool buffer_graph_matches(MalVm *vm, const MalValue *identities) {
    MalValue constructor = identities[0];
    MalValue prototype = identities[1];
    MalValue module = identities[2];
    return !mal_value_is_undefined(constructor)
        && own_property(vm, constructor, "prototype") == prototype
        && own_property(vm, module, "Buffer") == constructor
        && own_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], "Buffer")
            == constructor;
}

static bool direct_prototype_is(MalValue object, MalValue prototype) {
    return mal_object_get_prototype(mal_value_to_object(object))
        == mal_value_to_object(prototype);
}

static bool event_graph_matches(MalVm *vm, const MalValue *identities) {
    return !mal_value_is_undefined(identities[0])
        && own_property(vm, identities[0], "prototype") == identities[1];
}

static bool stream_graph_matches(
    MalVm *vm, const MalValue *identities, const MalValue *events) {
    for (usize i = 0; i < STREAM_IDENTITY_COUNT; i += 2) {
        if (mal_value_is_undefined(identities[i])
            || own_property(vm, identities[i], "prototype") != identities[i + 1]) {
            return false;
        }
    }
    static const char *export_names[] = {
        "Stream", "Readable", "Writable", "Duplex", "Transform",
    };
    for (usize i = 0; i < countof(export_names); i++) {
        if (own_property(vm, identities[0], (const byte *) export_names[i])
            != identities[i * 2]) {
            return false;
        }
    }
    return direct_prototype_is(identities[2], identities[0])
        && direct_prototype_is(identities[4], identities[0])
        && direct_prototype_is(identities[6], identities[2])
        && direct_prototype_is(identities[8], identities[6])
        && direct_prototype_is(identities[1], events[1])
        && direct_prototype_is(identities[3], identities[1])
        && direct_prototype_is(identities[5], identities[1])
        && direct_prototype_is(identities[7], identities[3])
        && direct_prototype_is(identities[9], identities[7]);
}

static void install_fragmented(
    MalVm *vm, const MalHostLaunchContext *launch, bool reverse) {
    const MalProgramImage *definition = vm->definition;
    for (i32 step = 0; step < definition->host_install_count; step++) {
        i32 index = reverse ? definition->host_install_count - step - 1 : step;
        const MalHostInstall *install = &definition->host_installs[index];
        if (install->installer == nullptr) continue;
        if (install->slot_count == 0) {
            install->installer(vm, nullptr, 0, launch);
            continue;
        }
        for (i32 slot_step = 0; slot_step < install->slot_count; slot_step++) {
            i32 slot_index = reverse ? install->slot_count - slot_step - 1 : slot_step;
            install->installer(vm, &install->slots[slot_index], 1, launch);
        }
    }
}

#if MAL_REALMS
typedef struct RealmInstallCheck {
    const MalHostLaunchContext *launch;
    MalValue initial_buffer[BUFFER_IDENTITY_COUNT];
    MalValue initial_event[EVENT_IDENTITY_COUNT];
    MalValue initial_stream[STREAM_IDENTITY_COUNT];
    bool ok;
} RealmInstallCheck;

static void install_second_realm(MalVm *vm, void *data) {
    RealmInstallCheck *check = data;
    install_fragmented(vm, check->launch, false);
    MalValue buffer[BUFFER_IDENTITY_COUNT];
    MalValue events[EVENT_IDENTITY_COUNT];
    MalValue stream[STREAM_IDENTITY_COUNT];
    read_identities(vm, buffer_identity_slots, BUFFER_IDENTITY_COUNT, buffer);
    read_identities(vm, event_identity_slots, EVENT_IDENTITY_COUNT, events);
    read_identities(vm, stream_identity_slots, STREAM_IDENTITY_COUNT, stream);
    install_fragmented(vm, check->launch, true);
    MalValue repeated_buffer[BUFFER_IDENTITY_COUNT];
    MalValue repeated_events[EVENT_IDENTITY_COUNT];
    MalValue repeated_stream[STREAM_IDENTITY_COUNT];
    read_identities(
        vm, buffer_identity_slots, BUFFER_IDENTITY_COUNT, repeated_buffer);
    read_identities(
        vm, event_identity_slots, EVENT_IDENTITY_COUNT, repeated_events);
    read_identities(
        vm, stream_identity_slots, STREAM_IDENTITY_COUNT, repeated_stream);
    check->ok = identities_equal(
            buffer, repeated_buffer, BUFFER_IDENTITY_COUNT)
        && identities_equal(events, repeated_events, EVENT_IDENTITY_COUNT)
        && identities_equal(stream, repeated_stream, STREAM_IDENTITY_COUNT)
        && identities_distinct(
            buffer, check->initial_buffer, BUFFER_IDENTITY_COUNT)
        && identities_distinct(
            events, check->initial_event, EVENT_IDENTITY_COUNT)
        && identities_distinct(
            stream, check->initial_stream, STREAM_IDENTITY_COUNT)
        && buffer_graph_matches(vm, buffer)
        && event_graph_matches(vm, events)
        && stream_graph_matches(vm, stream, events);
}
#endif

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    bool reverse = getenv("MAL_NODE_INSTALL_REVERSE") != nullptr;

    if (!mal_value_is_undefined(
            vm.intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR])) {
        return 2;
    }
    byte *bytes = malloc(4);
    if (bytes == nullptr) return 3;
    memcpy(bytes, "zlib", 4);
    MalValue owned_buffer = mal_node_buffer_from_owned_bytes(&vm, bytes, 4);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 4;
    MalRootSpan owned_root;
    mal_gc_root(&owned_root, &owned_buffer, 1);

    MalValue preinstall_buffer[BUFFER_IDENTITY_COUNT];
    read_identities(
        &vm, buffer_identity_slots, BUFFER_IDENTITY_COUNT, preinstall_buffer);
    if (!buffer_graph_matches(&vm, preinstall_buffer)) return 5;

    byte *unreachable_bytes = malloc(7);
    if (unreachable_bytes == nullptr) return 6;
    memcpy(unreachable_bytes, "collect", 7);
    (void) mal_node_buffer_from_owned_bytes(&vm, unreachable_bytes, 7);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 7;
    mal_gc_collect(&vm);

    install_fragmented(&vm, &launch, reverse);
    install_fragmented(&vm, &launch, reverse);
    MalValue installed_buffer[BUFFER_IDENTITY_COUNT];
    read_identities(
        &vm, buffer_identity_slots, BUFFER_IDENTITY_COUNT, installed_buffer);
    if (!identities_equal(
            preinstall_buffer, installed_buffer, BUFFER_IDENTITY_COUNT)
        || !buffer_graph_matches(&vm, installed_buffer)) {
        return 8;
    }

#if MAL_REALMS
    RealmInstallCheck check = {
        .launch = &launch,
        .ok = false,
    };
    read_identities(
        &vm, buffer_identity_slots, BUFFER_IDENTITY_COUNT, check.initial_buffer);
    read_identities(
        &vm, event_identity_slots, EVENT_IDENTITY_COUNT, check.initial_event);
    read_identities(
        &vm, stream_identity_slots, STREAM_IDENTITY_COUNT, check.initial_stream);
    mal_realm_create(&vm, install_second_realm, &check);
    if (!check.ok) return 9;
#endif

    mal_intrinsic_define_data(
        &vm, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]),
        "__ownedBuffer", owned_buffer, MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&owned_root);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
        mal_vm_free(&vm);
    }
    return code;
}
