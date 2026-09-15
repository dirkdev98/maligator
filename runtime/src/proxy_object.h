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
 * constructability are decided by the target at use sites (mal_value_is_callable
 * / the call/construct dispatchers).
 */
typedef struct MalProxyObject {
    MalObject object;
    MalValue target;
    MalValue handler;
    bool callable;
    bool constructor;
    bool revoked;
} MalProxyObject;

static inline bool mal_value_is_proxy_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_PROXY_OBJECT);
}
MalProxyObject *mal_value_to_proxy_object(MalValue value);
MalValue mal_value_from_proxy_object(MalProxyObject *proxy);

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
MalValue mal_proxy_unwrap_target(MalValue value);

/**
 * Whether a (possibly proxy) value has [[Call]]. Proxy callability is fixed when
 * the proxy is created and survives revocation; invoking a revoked callable proxy
 * still reaches its [[Call]] path and throws.
 */
bool mal_proxy_target_is_callable(MalValue value);

/**
 * Proxy meta-object-protocol operations. Each consults handler[trap]; on an
 * absent trap it performs the default operation on the target via the ordinary
 * MOP helpers, and otherwise calls the trap and enforces the spec invariants.
 * A pending throw is left in vm->completion.
 */
bool mal_proxy_get(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue receiver, MalValue *out);
bool mal_proxy_set(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue value, MalValue receiver);
bool mal_proxy_has(MalVm *vm, MalProxyObject *proxy, MalKey key);
bool mal_proxy_delete(MalVm *vm, MalProxyObject *proxy, MalKey key);
bool mal_proxy_get_own_property_descriptor(MalVm *vm, MalProxyObject *proxy, MalKey key, bool *present_out, MalPropertyDesc *desc_out);
bool mal_proxy_define_own_property(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue descriptor_value);
bool mal_proxy_define_own_property_parsed(
    MalVm *vm, MalProxyObject *proxy, MalKey key,
    const MalPropertyDescriptorParse *parsed);
bool mal_proxy_own_property_keys(MalVm *vm, MalProxyObject *proxy, MalValue *out_array);
bool mal_proxy_get_prototype_of(MalVm *vm, MalProxyObject *proxy, MalValue *out);
bool mal_proxy_set_prototype_of(MalVm *vm, MalProxyObject *proxy, MalValue proto, bool *success_out);
bool mal_proxy_is_extensible(MalVm *vm, MalProxyObject *proxy, bool *out);
bool mal_proxy_prevent_extensions(MalVm *vm, MalProxyObject *proxy, bool *out);

/**
 * Proxy [[Call]]: invoke handler.apply(target, thisArg, argArray), or call the
 * target directly when the trap is absent. Returns the call completion (a throw
 * is carried in the completion).
 */
MalCompletion mal_proxy_apply(MalVm *vm, MalProxyObject *proxy, MalValue this_value, const MalValue *args, i32 arg_count);

/**
 * Proxy [[Construct]]: invoke handler.construct(target, argArray, newTarget), or
 * construct the target directly when the trap is absent. The trap result must be
 * an object. Returns the construct completion.
 */
MalCompletion mal_proxy_construct(MalVm *vm, MalProxyObject *proxy, const MalValue *args, i32 arg_count, MalValue new_target);
