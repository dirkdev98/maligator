#pragma once

#include "vm.h"

typedef struct MalBuiltinMember {
    const byte *key;
    MalNativeFunctionCallback callback;
    i32 length;
    void (*install)(MalVm *vm, MalObject *object);
} MalBuiltinMember;

typedef struct MalBuiltinMemberList {
    const MalBuiltinMember *const *members;
    i32 count;
    void (*install_all)(MalVm *vm, MalObject *object);
} MalBuiltinMemberList;

typedef enum MalBuiltinMemberGroup {
#define MAL_BUILTIN_MEMBER_GROUP(group, family) MAL_BUILTIN_MEMBER_##group,
#include "builtin_member_groups.h"
#undef MAL_BUILTIN_MEMBER_GROUP
    MAL_BUILTIN_MEMBER_GROUP_COUNT,
} MalBuiltinMemberGroup;

#define MAL_BUILTIN_MEMBER_GROUP(group, family) \
    extern const MalBuiltinMemberList mal_builtin_member_list_##group;
#include "builtin_member_groups.h"
#undef MAL_BUILTIN_MEMBER_GROUP

/* Every member has its own link reference. Lists preserve definition order when
 * an image can observe the complete descriptor graph. */
#define MAL_BUILTIN_MEMBER_DECLARE(symbol, property, arity, function) \
    const MalBuiltinMember mal_builtin_member_##symbol = { \
        .key = property, .callback = function, .length = arity, \
    };
#define MAL_BUILTIN_MEMBER_INSTALL(symbol, key, arity, function) \
    mal_intrinsic_define_method_n(vm, object, key, arity, function);
#define MAL_DEFINE_BUILTIN_MEMBER_GROUP(group, entries) \
    entries(MAL_BUILTIN_MEMBER_DECLARE) \
    static void mal_builtin_install_all_##group(MalVm *vm, MalObject *object) { \
        entries(MAL_BUILTIN_MEMBER_INSTALL) \
    } \
    const MalBuiltinMemberList mal_builtin_member_list_##group = { \
        .install_all = mal_builtin_install_all_##group, \
    };

#define MAL_CUSTOM_MEMBER_DECLARE(symbol, key, define, ...) \
    static void mal_install_member_##symbol(MalVm *vm, MalObject *object) { \
        define(vm, object, key, __VA_ARGS__); \
    } \
    const MalBuiltinMember mal_builtin_member_##symbol = { \
        .install = mal_install_member_##symbol, \
    };
#define MAL_CUSTOM_MEMBER_INSTALL(symbol, key, define, ...) \
    define(vm, object, key, __VA_ARGS__);
#define MAL_DEFINE_CUSTOM_MEMBER_GROUP(group, entries) \
    entries(MAL_CUSTOM_MEMBER_DECLARE) \
    static void mal_builtin_install_all_##group(MalVm *vm, MalObject *object) { \
        entries(MAL_CUSTOM_MEMBER_INSTALL) \
    } \
    const MalBuiltinMemberList mal_builtin_member_list_##group = { \
        .install_all = mal_builtin_install_all_##group, \
    };

void mal_builtin_members_define(MalVm *vm, MalObject *object, MalBuiltinMemberGroup group);
