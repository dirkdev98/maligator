#include "personality.h"

#include "atomics_async.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_immediate.h"
#include "web_events_object.h"
#include "web_fetch.h"
#include "web_globals.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_url_object.h"

void mal_runtime_events_ensure(MalVm *vm) {
    if (!mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE])) return;
    MalObject *target = mal_intrinsic_new_object(vm);
    MalValue rooted = mal_value_from_object(target);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    mal_events_install(vm, target);
    mal_gc_unroot(&root);
}

void mal_runtime_events_install_globals(MalVm *vm) {
    mal_runtime_events_ensure(vm);
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    const struct { const byte *name; i32 intrinsic; } constructors[] = {
        {(const byte *) "Event", MAL_INTRINSIC_EVENT_CONSTRUCTOR},
        {(const byte *) "CustomEvent", MAL_INTRINSIC_CUSTOM_EVENT_CONSTRUCTOR},
        {(const byte *) "EventTarget", MAL_INTRINSIC_EVENT_TARGET_CONSTRUCTOR},
        {(const byte *) "DOMException", MAL_INTRINSIC_DOM_EXCEPTION_CONSTRUCTOR},
        {(const byte *) "AbortSignal", MAL_INTRINSIC_ABORT_SIGNAL_CONSTRUCTOR},
        {(const byte *) "AbortController", MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR},
    };
    for (usize i = 0; i < countof(constructors); i++) {
        mal_intrinsic_define_data(vm, global_this, constructors[i].name,
            vm->intrinsics[constructors[i].intrinsic], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
}

void mal_runtime_personality_install(MalVm *vm, bool web_platform, bool node) {
    vm->host_web_platform = web_platform;
    vm->host_node = node;
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_atomics_async_install(vm);
    if (web_platform || node) {
        if (node) mal_host_timers_install_node(vm, global_this);
        else mal_host_timers_install(vm, global_this);
    }
#if MAL_NODE
    if (node) {
        mal_node_immediates_install(vm, global_this);
        if (!web_platform) {
            mal_text_encoding_globals_install(vm, global_this);
            mal_structured_clone_global_install(vm, global_this);
            mal_navigator_global_install(vm, global_this);
            mal_events_install(vm, global_this);
        }
    }
#endif
#if MAL_URL
    if (web_platform || node) mal_url_install(vm, global_this);
#endif
#if MAL_WEB_PLATFORM
    if (web_platform) {
        mal_fetch_install(vm, global_this);
        mal_events_install(vm, global_this);
        mal_web_globals_install(vm, global_this);
        mal_readable_stream_install(vm, global_this);
        mal_writable_stream_install(vm, global_this);
    }
#endif
}
