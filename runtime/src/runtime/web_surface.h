#pragma once

#include "vm.h"

/*
 * Web platform globals, installed by use. The compiler retains a group's installer
 * only when the program reads one of its globals, or observes the global object in
 * a way it cannot follow, so a program that never names the Fetch API neither
 * defines nor links it. Each group builds its classes once per isolate on an
 * exports object; installing the group copies those onto the global object.
 *
 * Runtime code that needs another group's classes, such as a Response body's
 * ReadableStream, ensures that group instead of reading the global object: the
 * program may not have named it, or may have replaced it. Each group's ensure and
 * installer live in the group's own file, so linking one group links only the
 * groups it depends on.
 */
typedef enum MalWebGroup {
    MAL_WEB_GROUP_EVENTS,
    MAL_WEB_GROUP_ENCODING,
    MAL_WEB_GROUP_STREAMS,
    MAL_WEB_GROUP_URL,
    MAL_WEB_GROUP_FETCH,
    MAL_WEB_GROUP_BASICS,
    MAL_WEB_GROUP_PERFORMANCE,
    MAL_WEB_GROUP_CRYPTO,
    MAL_WEB_GROUP_FETCH_CLIENT,
    MAL_WEB_GROUP_COUNT,
} MalWebGroup;

/* Defines the group's classes on `exports`; false after throwing. */
typedef bool (*MalWebGroupBuild)(MalVm *vm, MalObject *exports);

/* The group's exports object, built on first use; null after throwing. */
MalObject *mal_web_group_ensure(MalVm *vm, MalWebGroup group, MalWebGroupBuild build);

/* Define the group's globals on the global object once per isolate. */
void mal_web_group_publish(MalVm *vm, MalWebGroup group, MalWebGroupBuild build);

/* An own data property of a group's exports, or undefined. */
MalValue mal_web_group_export(MalVm *vm, const MalObject *exports, const char *name);

#define MAL_WEB_GROUP_DEFINE(name, group, build)                                          \
    MalObject *mal_web_##name##_ensure(MalVm *vm) {                                       \
        return mal_web_group_ensure(vm, group, build);                                    \
    }                                                                                     \
    void mal_host_install_web_##name(MalVm *vm, const MalHostInstallSlot *slots,         \
        i32 count, const MalHostLaunchContext *launch) {                                  \
        (void) slots;                                                                     \
        (void) count;                                                                     \
        (void) launch;                                                                    \
        mal_web_group_publish(vm, group, build);                                          \
    }

#define MAL_WEB_GROUP_DECLARE(name)                                                       \
    MalObject *mal_web_##name##_ensure(MalVm *vm);                                        \
    void mal_host_install_web_##name(MalVm *vm, const MalHostInstallSlot *slots,         \
        i32 count, const MalHostLaunchContext *launch);

MAL_WEB_GROUP_DECLARE(events)
MAL_WEB_GROUP_DECLARE(encoding)
MAL_WEB_GROUP_DECLARE(streams)
MAL_WEB_GROUP_DECLARE(url)
MAL_WEB_GROUP_DECLARE(fetch)
MAL_WEB_GROUP_DECLARE(basics)
MAL_WEB_GROUP_DECLARE(performance)
MAL_WEB_GROUP_DECLARE(crypto)
MAL_WEB_GROUP_DECLARE(fetch_client)

/* maligator:internal/fetch: the fetch_client group's `fetch` for `maligator:http`,
 * without defining the global. */
void mal_host_install_maligator_internal_fetch(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
