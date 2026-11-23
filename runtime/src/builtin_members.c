#include "builtin_members.h"

#include "intrinsics.h"

void mal_builtin_members_define(MalVm *vm, MalObject *object, MalBuiltinMemberGroup group) {
    const MalBuiltinMemberList *const *lists = vm->runtime_image->builtin_member_lists;
    if (lists == nullptr) return;
    const MalBuiltinMemberList *list = lists[group];
    if (list == nullptr) return;
    if (list->install_all != nullptr) {
        list->install_all(vm, object);
        return;
    }
    for (i32 i = 0; i < list->count; i++) {
        const MalBuiltinMember *member = list->members[i];
        if (member->install != nullptr) member->install(vm, object);
        else mal_intrinsic_define_method_n(vm, object, member->key, member->length, member->callback);
    }
}
