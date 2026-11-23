#pragma once

#include "./defaults.h"
#include "builtin_object.h"
#include "object.h"
#include "table.h"
#include "vm.h"

typedef struct MalVm MalVm;

/**
 * A Proxy exotic object. Holds the [[ProxyTarget]] and [[ProxyHandler]]
 * internal slots; revoking sets both to null (the `revoked` flag mirrors that,
 * so a revoked proxy throws a TypeError on every meta-object operation).
 *
 * The base object's prototype/extensible/property-table fields are unused: a
 * proxy never resolves ordinary own properties; all of its meta-object-protocol
 * goes through the handler traps (or falls back to the target). Callability and
 * constructability are fixed from the target when the proxy is created.
 */
typedef struct MalProxyObject {
    MalObject object;
    MalObjectDeferredStorage object_storage;
    MalValue target;
    MalValue handler;
    bool callable;
    bool constructor;
    bool revoked;
} MalProxyObject;

static_assert(sizeof(MalProxyObject) <= 48, "Proxy object outgrew its allocation class");

static inline bool mal_value_is_proxy_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_PROXY_OBJECT);
}
static inline MalProxyObject *mal_value_to_proxy_object(MalValue value) {
    return (MalProxyObject *) mal_value_to_heap(value);
}

static inline MalValue mal_value_from_proxy_object(MalProxyObject *proxy) {
    return mal_value_from_heap((MalHeapHeader *) proxy);
}

/**
 * Allocate a proxy over (target, handler). Both must be objects (the caller has
 * validated this); the proxy starts non-revoked.
 */
MalProxyObject *mal_proxy_object_new(MalVm *vm, MalValue target, MalValue handler);

/**
 * Resolve a proxy to its [[ProxyTarget]], unwrapping nested proxies. Used by the
 * call/construct dispatchers to reach the eventual non-proxy target. Returns the
 * value unchanged if not a proxy.
 */
static inline MalValue mal_proxy_unwrap_target(MalValue value) {
    while (mal_value_is_proxy_object(value)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(value);
        if (proxy->revoked) {
            return value;
        }
        value = proxy->target;
    }
    return value;
}

/**
 * Whether a (possibly proxy) value has [[Call]]. Proxy callability is fixed when
 * the proxy is created and survives revocation; invoking a revoked callable proxy
 * still reaches its [[Call]] path and throws.
 */
static inline bool mal_proxy_target_is_callable(MalValue value) {
    if (mal_value_is_proxy_object(value)) {
        return mal_value_to_proxy_object(value)->callable;
    }
    return mal_value_is_callable(value);
}

/**
 * A proxy can exist only after its component has been linked. Trap dispatch
 * uses that component's table after the caller has checked the heap tag.
 */
typedef struct MalProxyOperations {
    bool (*get)(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue receiver, MalValue *out);
    bool (*set)(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue value, MalValue receiver);
    bool (*has)(MalVm *vm, MalProxyObject *proxy, MalKey key);
    bool (*delete)(MalVm *vm, MalProxyObject *proxy, MalKey key);
    bool (*get_own_property_descriptor)(MalVm *vm, MalProxyObject *proxy, MalKey key, bool *present_out, MalPropertyDesc *desc_out);
    bool (*define_own_property)(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue descriptor_value);
    bool (*define_own_property_parsed)(
    MalVm *vm, MalProxyObject *proxy, MalKey key,
    const MalPropertyDescriptorParse *parsed);
    bool (*own_property_keys)(MalVm *vm, MalProxyObject *proxy, MalValue *out_array);
    bool (*get_prototype_of)(MalVm *vm, MalProxyObject *proxy, MalValue *out);
    bool (*set_prototype_of)(MalVm *vm, MalProxyObject *proxy, MalValue proto, bool *success_out);
    bool (*is_extensible)(MalVm *vm, MalProxyObject *proxy, bool *out);
    bool (*prevent_extensions)(MalVm *vm, MalProxyObject *proxy, bool *out);
    MalCompletion (*apply)(MalVm *vm, MalProxyObject *proxy, MalValue this_value, const MalValue *args, i32 arg_count);
    MalCompletion (*construct)(MalVm *vm, MalProxyObject *proxy, const MalValue *args, i32 arg_count, MalValue new_target);
} MalProxyOperations;

extern MalProxyOperations mal_proxy_traps;
