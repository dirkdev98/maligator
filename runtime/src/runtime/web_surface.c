#include "web_surface.h"

#include "array_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "vm_ops.h"

static_assert(MAL_INTRINSIC_WEB_GROUP_FETCH_CLIENT - MAL_INTRINSIC_WEB_GROUP_EVENTS + 1 == MAL_WEB_GROUP_COUNT,
    "one intrinsic slot per web group");

MalObject *mal_web_group_ensure(MalVm *vm, MalWebGroup group, MalWebGroupBuild build) {
    MalValue *slot = &vm->intrinsics[MAL_INTRINSIC_WEB_GROUP_EVENTS + group];
    if (mal_value_is_object(*slot)) return mal_value_to_object(*slot);
    MalObject *exports = mal_intrinsic_new_object(vm);
    // The intrinsic slot roots the exports while the group allocates its classes.
    *slot = mal_value_from_object(exports);
    if (!build(vm, exports) || vm->completion.kind == MAL_COMPLETION_THROW) {
        *slot = mal_value_new_undefined();
        return nullptr;
    }
    return exports;
}

void mal_web_group_publish(MalVm *vm, MalWebGroup group, MalWebGroupBuild build) {
    if ((vm->web_groups_published & (1u << group)) != 0) return;
    MalObject *exports = mal_web_group_ensure(vm, group, build);
    if (exports == nullptr) return;
    vm->web_groups_published |= (u16) (1u << group);
    MalValue keys = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &keys, 1);
    if (mal_vm_own_property_keys(vm, mal_value_from_object(exports), &keys)) {
        MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
        MalArrayObject *list = mal_value_to_array_object(keys);
        for (u32 index = 0; index < mal_array_object_length(list); index++) {
            MalValue value;
            MalKey key;
            bool present = false;
            MalPropertyDesc desc;
            // Native methods materialize lazily, so read through [[GetOwnProperty]].
            if (!mal_array_object_dense_get(list, index, &value)
                || !mal_vm_to_property_key(vm, value, &key)
                || !mal_vm_get_own_property(vm, mal_value_from_object(exports), key, &present, &desc))
                break;
            if (present) (void) mal_object_define_own(global, key, &desc);
        }
    }
    mal_gc_unroot(&root);
}

MalValue mal_web_group_export(MalVm *vm, const MalObject *exports, const char *name) {
    bool present = false;
    MalPropertyDesc desc;
    if (!mal_vm_get_own_property(vm, mal_value_from_object((MalObject *) exports),
            mal_intrinsic_string_key(vm, (const byte *) name), &present, &desc))
        return mal_value_new_undefined();
    return present && (desc.flags & MAL_PROPERTY_ACCESSOR) == 0 ? desc.value : mal_value_new_undefined();
}
