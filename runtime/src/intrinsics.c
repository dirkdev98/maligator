#include "intrinsics.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_array.h"
#include "builtin_array_buffer.h"
#include "builtin_async_generator.h"
#include "builtin_eval.h"
#include "builtin_bigint.h"
#include "builtin_boolean.h"
#include "builtin_console.h"
#include "builtin_data_view.h"
#include "builtin_date.h"
#if MAL_TEMPORAL
#include "builtin_temporal.h"
#endif
#include "builtin_intl.h"
#include "builtin_typed_array.h"
#include "builtin_atomics.h"
#include "builtin_error.h"
#include "builtin_function.h"
#include "builtin_generator.h"
#include "builtin_iterator.h"
#include "builtin_iterator_helpers.h"
#include "builtin_json.h"
#include "builtin_map.h"
#include "builtin_math.h"
#include "builtin_number.h"
#include "builtin_object.h"
#include "builtin_promise.h"
#include "builtin_proxy.h"
#include "builtin_regexp.h"
#include "builtin_reflect.h"
#include "builtin_finalization_registry.h"
#include "builtin_set.h"
#include "builtin_weak_ref.h"
#include "builtin_string.h"
#include "builtin_symbol.h"
#if MAL_REALMS
#include "builtin_shadow_realm.h"
#endif
#include "builtin_uri.h"
#include "gc.h"
#include "heap_string.h"
#include "perf_stats.h"
#include "primordials.h"
#include "table.h"
#include "typed_array_object.h"
#include "vm.h"

// Longest internal key in the codebase is well under this; longer names fall
// back to a heap-converted probe buffer.
#define MAL_INTERN_STACK_MAX 64

#define MAL_HOT_KEY_SIGNATURE(length, first, last) \
    ((u32) (length) | ((u32) (u8) (first) << 8) | ((u32) (u8) (last) << 16))

static const byte *const mal_hot_intrinsic_names[MAL_HOT_KEY_COUNT] = {
    [MAL_HOT_KEY_EMPTY] = (const byte *) "",
    [MAL_HOT_KEY_LENGTH] = (const byte *) "length",
    [MAL_HOT_KEY_NAME] = (const byte *) "name",
    [MAL_HOT_KEY_LAST_INDEX] = (const byte *) "lastIndex",
    [MAL_HOT_KEY_EVENTS] = (const byte *) "_events",
    [MAL_HOT_KEY_EVENTS_COUNT] = (const byte *) "_eventsCount",
    [MAL_HOT_KEY_PROTOTYPE] = (const byte *) "prototype",
    [MAL_HOT_KEY_GROUPS] = (const byte *) "groups",
    [MAL_HOT_KEY_INDEX] = (const byte *) "index",
    [MAL_HOT_KEY_INPUT] = (const byte *) "input",
    [MAL_HOT_KEY_VALUE] = (const byte *) "value",
    [MAL_HOT_KEY_DONE] = (const byte *) "done",
    [MAL_HOT_KEY_CONSTRUCTOR] = (const byte *) "constructor",
    [MAL_HOT_KEY_THEN] = (const byte *) "then",
    [MAL_HOT_KEY_NEXT] = (const byte *) "next",
    [MAL_HOT_KEY_CALLEE] = (const byte *) "callee",
    [MAL_HOT_KEY_EXEC] = (const byte *) "exec",
    [MAL_HOT_KEY_READABLE_STATE] = (const byte *) "_readableState",
    [MAL_HOT_KEY_DESTROYED] = (const byte *) "destroyed",
    [MAL_HOT_KEY_ENDED] = (const byte *) "ended",
    [MAL_HOT_KEY_EMIT] = (const byte *) "emit",
    [MAL_HOT_KEY_PENDING] = (const byte *) "pending",
    [MAL_HOT_KEY_DATA] = (const byte *) "data",
    [MAL_HOT_KEY_READABLE_QUEUE] = (const byte *) "_malReadableQueue",
    [MAL_HOT_KEY_READABLE_INDEX] = (const byte *) "_malReadableIndex",
    [MAL_HOT_KEY_ENCODING] = (const byte *) "encoding",
    [MAL_HOT_KEY_FLOWING] = (const byte *) "_malFlowing",
    [MAL_HOT_KEY_NEW_LISTENER] = (const byte *) "newListener",
    [MAL_HOT_KEY_REMOVE_LISTENER] = (const byte *) "removeListener",
    [MAL_HOT_KEY_READABLE_ENDED] = (const byte *) "readableEnded",
    [MAL_HOT_KEY_PAUSED] = (const byte *) "_malPaused",
    [MAL_HOT_KEY_READABLE] = (const byte *) "readable",
    [MAL_HOT_KEY_FLAGS] = (const byte *) "flags",
    [MAL_HOT_KEY_UNICODE_SETS] = (const byte *) "unicodeSets",
    [MAL_HOT_KEY_MULTILINE] = (const byte *) "multiline",
    [MAL_HOT_KEY_IGNORE_CASE] = (const byte *) "ignoreCase",
    [MAL_HOT_KEY_HAS_INDICES] = (const byte *) "hasIndices",
    [MAL_HOT_KEY_STICKY] = (const byte *) "sticky",
    [MAL_HOT_KEY_DOT_ALL] = (const byte *) "dotAll",
    [MAL_HOT_KEY_GLOBAL] = (const byte *) "global",
    [MAL_HOT_KEY_UNICODE] = (const byte *) "unicode",
    [MAL_HOT_KEY_PUSH] = (const byte *) "push",
    [MAL_HOT_KEY_ERROR] = (const byte *) "error",
    [MAL_HOT_KEY_TO_JSON] = (const byte *) "toJSON",
    [MAL_HOT_KEY_SEARCH] = (const byte *) "search",
};

static MalHotIntrinsicKey mal_hot_intrinsic_key(const byte *name, usize length) {
    if (length == 0) return MAL_HOT_KEY_EMPTY;
    if (length > 255) return MAL_HOT_KEY_COUNT;

    u32 signature = MAL_HOT_KEY_SIGNATURE(length, name[0], name[length - 1]);
    switch (signature) {
        case MAL_HOT_KEY_SIGNATURE(6, 'l', 'h'):
            return memcmp(name, "length", 6) == 0 ? MAL_HOT_KEY_LENGTH : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'n', 'e'):
            return memcmp(name, "name", 4) == 0 ? MAL_HOT_KEY_NAME : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(9, 'l', 'x'):
            return memcmp(name, "lastIndex", 9) == 0 ? MAL_HOT_KEY_LAST_INDEX : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(7, '_', 's'):
            return memcmp(name, "_events", 7) == 0 ? MAL_HOT_KEY_EVENTS : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(12, '_', 't'):
            return memcmp(name, "_eventsCount", 12) == 0 ? MAL_HOT_KEY_EVENTS_COUNT : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(9, 'p', 'e'):
            return memcmp(name, "prototype", 9) == 0 ? MAL_HOT_KEY_PROTOTYPE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 'g', 's'):
            return memcmp(name, "groups", 6) == 0 ? MAL_HOT_KEY_GROUPS : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(5, 'i', 'x'):
            return memcmp(name, "index", 5) == 0 ? MAL_HOT_KEY_INDEX : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(5, 'i', 't'):
            return memcmp(name, "input", 5) == 0 ? MAL_HOT_KEY_INPUT : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(5, 'v', 'e'):
            return memcmp(name, "value", 5) == 0 ? MAL_HOT_KEY_VALUE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'd', 'e'):
            return memcmp(name, "done", 4) == 0 ? MAL_HOT_KEY_DONE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(11, 'c', 'r'):
            return memcmp(name, "constructor", 11) == 0 ? MAL_HOT_KEY_CONSTRUCTOR : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 't', 'n'):
            return memcmp(name, "then", 4) == 0 ? MAL_HOT_KEY_THEN : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'n', 't'):
            return memcmp(name, "next", 4) == 0 ? MAL_HOT_KEY_NEXT : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 'c', 'e'):
            return memcmp(name, "callee", 6) == 0 ? MAL_HOT_KEY_CALLEE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'e', 'c'):
            return memcmp(name, "exec", 4) == 0 ? MAL_HOT_KEY_EXEC : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(14, '_', 'e'):
            return memcmp(name, "_readableState", 14) == 0 ? MAL_HOT_KEY_READABLE_STATE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(9, 'd', 'd'):
            return memcmp(name, "destroyed", 9) == 0 ? MAL_HOT_KEY_DESTROYED : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(5, 'e', 'd'):
            return memcmp(name, "ended", 5) == 0 ? MAL_HOT_KEY_ENDED : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'e', 't'):
            return memcmp(name, "emit", 4) == 0 ? MAL_HOT_KEY_EMIT : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(7, 'p', 'g'):
            return memcmp(name, "pending", 7) == 0 ? MAL_HOT_KEY_PENDING : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'd', 'a'):
            return memcmp(name, "data", 4) == 0 ? MAL_HOT_KEY_DATA : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(17, '_', 'e'):
            return memcmp(name, "_malReadableQueue", 17) == 0 ? MAL_HOT_KEY_READABLE_QUEUE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(17, '_', 'x'):
            return memcmp(name, "_malReadableIndex", 17) == 0 ? MAL_HOT_KEY_READABLE_INDEX : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(8, 'e', 'g'):
            return memcmp(name, "encoding", 8) == 0 ? MAL_HOT_KEY_ENCODING : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(11, '_', 'g'):
            return memcmp(name, "_malFlowing", 11) == 0 ? MAL_HOT_KEY_FLOWING : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(11, 'n', 'r'):
            return memcmp(name, "newListener", 11) == 0 ? MAL_HOT_KEY_NEW_LISTENER : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(14, 'r', 'r'):
            return memcmp(name, "removeListener", 14) == 0 ? MAL_HOT_KEY_REMOVE_LISTENER : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(13, 'r', 'd'):
            return memcmp(name, "readableEnded", 13) == 0 ? MAL_HOT_KEY_READABLE_ENDED : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(10, '_', 'd'):
            return memcmp(name, "_malPaused", 10) == 0 ? MAL_HOT_KEY_PAUSED : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(8, 'r', 'e'):
            return memcmp(name, "readable", 8) == 0 ? MAL_HOT_KEY_READABLE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(5, 'f', 's'):
            return memcmp(name, "flags", 5) == 0 ? MAL_HOT_KEY_FLAGS : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(11, 'u', 's'):
            return memcmp(name, "unicodeSets", 11) == 0 ? MAL_HOT_KEY_UNICODE_SETS : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(9, 'm', 'e'):
            return memcmp(name, "multiline", 9) == 0 ? MAL_HOT_KEY_MULTILINE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(10, 'i', 'e'):
            return memcmp(name, "ignoreCase", 10) == 0 ? MAL_HOT_KEY_IGNORE_CASE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(10, 'h', 's'):
            return memcmp(name, "hasIndices", 10) == 0 ? MAL_HOT_KEY_HAS_INDICES : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 's', 'y'):
            return memcmp(name, "sticky", 6) == 0 ? MAL_HOT_KEY_STICKY : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 'd', 'l'):
            return memcmp(name, "dotAll", 6) == 0 ? MAL_HOT_KEY_DOT_ALL : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 'g', 'l'):
            return memcmp(name, "global", 6) == 0 ? MAL_HOT_KEY_GLOBAL : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(7, 'u', 'e'):
            return memcmp(name, "unicode", 7) == 0 ? MAL_HOT_KEY_UNICODE : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(4, 'p', 'h'):
            return memcmp(name, "push", 4) == 0 ? MAL_HOT_KEY_PUSH : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(5, 'e', 'r'):
            return memcmp(name, "error", 5) == 0 ? MAL_HOT_KEY_ERROR : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 't', 'N'):
            return memcmp(name, "toJSON", 6) == 0 ? MAL_HOT_KEY_TO_JSON : MAL_HOT_KEY_COUNT;
        case MAL_HOT_KEY_SIGNATURE(6, 's', 'h'):
            return memcmp(name, "search", 6) == 0 ? MAL_HOT_KEY_SEARCH : MAL_HOT_KEY_COUNT;
        default:
            return MAL_HOT_KEY_COUNT;
    }
}

static u32 mal_ascii_atom_cache_hash(const byte *name, usize length) {
    u32 hash = 2166136261u;
    for (usize i = 0; i < length; i++) {
        hash ^= name[i];
        hash *= 16777619u;
    }
    return hash;
}

static bool mal_ascii_atom_cache_matches(
    const MalString *atom, const byte *name, usize length
) {
    if (atom->length != length) return false;
    const c16 *units = mal_string_code_units(atom);
    for (usize i = 0; i < length; i++) {
        if (units[i] != (c16) name[i]) return false;
    }
    return true;
}

MalString *mal_intrinsic_ascii(MalVm *vm, const byte *name) {
    usize length = 0;
    while (name[length] != '\0') {
        length++;
    }
    MAL_PERF_COUNT(intrinsic_ascii_calls);
    MAL_PERF_ADD(intrinsic_ascii_bytes, length);
    mal_perf_intrinsic_name(name, length);

    MalHotIntrinsicKey hot_key = mal_hot_intrinsic_key(name, length);
    if (hot_key != MAL_HOT_KEY_COUNT && vm->hot_intrinsic_keys[hot_key] != nullptr) {
        MAL_PERF_COUNT(intrinsic_ascii_cache_hits);
        return vm->hot_intrinsic_keys[hot_key];
    }

    u32 cache_hash = mal_ascii_atom_cache_hash(name, length);
    MalAsciiAtomCacheEntry *cache = &vm->ascii_atom_cache[
        cache_hash & (MAL_ASCII_ATOM_CACHE_CAPACITY - 1)];
    if (cache->atom != nullptr && cache->hash == cache_hash &&
        mal_ascii_atom_cache_matches(cache->atom, name, length)) {
        MAL_PERF_COUNT(intrinsic_ascii_cache_hits);
        return cache->atom;
    }

    // Probe the atom table with a stack-allocated (or, for rare long names,
    // throwaway-heap) external key string so a hit costs no allocation. On a
    // miss, allocate the canonical atom once and store it as its own key.
    c16 stack_units[MAL_INTERN_STACK_MAX];
    c16 *heap_units = length > MAL_INTERN_STACK_MAX ? malloc(sizeof(c16) * length) : nullptr;
    c16 *units = heap_units != nullptr ? heap_units : stack_units;
    for (usize i = 0; i < length; i++) {
        units[i] = (u8) name[i];
    }

    MalString probe;
    mal_string_init_external(&probe, units, length);
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(&probe)};

    MalTableLookup lookup = mal_table_lookup(vm->atoms, key);
    MalString *atom;
    if (lookup.present) {
        MAL_PERF_COUNT(intrinsic_ascii_hits);
        atom = mal_value_to_string(mal_table_entry_key(vm->atoms, lookup.entry).value);
        atom->property_atom = true;
    } else {
        MAL_PERF_COUNT(intrinsic_ascii_misses);
        atom = mal_string_new_ascii(&vm->heap, name, length);
        atom->property_atom = true;
        MalKey atom_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(atom)};
        (void) mal_table_upsert_entry(vm->atoms, atom_key, nullptr);
    }
    if (hot_key != MAL_HOT_KEY_COUNT) {
        vm->hot_intrinsic_keys[hot_key] = atom;
        MAL_PERF_COUNT(intrinsic_ascii_cache_fills);
    }
    *cache = (MalAsciiAtomCacheEntry) {.hash = cache_hash, .atom = atom};
    MAL_PERF_COUNT(intrinsic_ascii_cache_fills);

    free(heap_units);
    return atom;
}

MalString *mal_property_atomize_string(MalVm *vm, MalString *string) {
    if (string->property_atom) {
        return string;
    }
    bool tiny_cache_entry =
        string->length <= MAL_STRING_INLINE_CODE_UNITS
        && string->hash_valid
        && vm->tiny_string_cache != nullptr
        && vm->tiny_string_cache[
            (usize) string->hash & (MAL_TINY_STRING_CACHE_CAPACITY - 1)]
            == string;
    MalKey key = {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(string),
    };
    MalTableLookup lookup = mal_table_lookup(vm->atoms, key);
    if (lookup.present) {
        MalString *atom =
            mal_value_to_string(mal_table_entry_key(vm->atoms, lookup.entry).value);
        atom->property_atom = true;
        if (tiny_cache_entry) {
            mal_string_tiny_cache_promote(&vm->heap, atom);
        }
        return atom;
    }
    string->property_atom = true;
    (void) mal_table_upsert_entry(vm->atoms, key, nullptr);
    return string;
}

MalString *mal_intrinsic_code_unit(MalVm *vm, c16 code_unit) {
    if (code_unit > UINT8_MAX) {
        return mal_string_new_copy(&vm->heap, &code_unit, 1);
    }

    MalString *cached = vm->code_unit_strings[code_unit];
    if (cached != nullptr) {
        return cached;
    }

    MalString probe;
    mal_string_init_external(&probe, &code_unit, 1);
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(&probe)};
    MalTableLookup lookup = mal_table_lookup(vm->atoms, key);
    if (lookup.present) {
        cached = mal_value_to_string(mal_table_entry_key(vm->atoms, lookup.entry).value);
        cached->property_atom = true;
    } else {
        cached = mal_string_new_copy(&vm->heap, &code_unit, 1);
        cached->property_atom = true;
        MalKey atom_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(cached)};
        (void) mal_table_upsert_entry(vm->atoms, atom_key, nullptr);
    }
    vm->code_unit_strings[code_unit] = cached;
    return cached;
}

MalString *mal_intrinsic_hot_ascii(MalVm *vm, MalHotIntrinsicKey key) {
    MAL_PERF_COUNT(intrinsic_hot_direct_calls);
    MalString *atom = vm->hot_intrinsic_keys[key];
    if (atom != nullptr) {
        MAL_PERF_COUNT(intrinsic_hot_direct_hits);
        return atom;
    }
    return mal_intrinsic_ascii(vm, mal_hot_intrinsic_names[key]);
}

MalKey mal_intrinsic_string_key(MalVm *vm, const byte *name) {
    return (MalKey) {.kind = MAL_KEY_STRING, .value = mal_value_from_string(mal_intrinsic_ascii(vm, name))};
}

MalKey mal_intrinsic_hot_string_key(MalVm *vm, MalHotIntrinsicKey key) {
    return (MalKey) {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(mal_intrinsic_hot_ascii(vm, key)),
    };
}

MalKey mal_intrinsic_symbol_key(MalVm *vm, MalIntrinsic symbol_slot) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = vm->intrinsics[symbol_slot]};
}

MalValue mal_intrinsic_define_symbol_method(
    MalVm *vm,
    MalObject *object,
    MalIntrinsic symbol_slot,
    const byte *display_name,
    MalNativeFunctionCallback callback
) {
    MalNativeFunctionObject *function = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, display_name),
        callback
    );
    MalValue value = mal_value_from_native_function_object(function);
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, symbol_slot), &desc);
    return value;
}

MalPropertyDesc mal_intrinsic_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc) {
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

MalPropertyDesc mal_intrinsic_accessor_desc(
    MalValue getter, MalValue setter, MalPropertyFlags flags) {
    return (MalPropertyDesc) {
        .flags = flags | MAL_PROPERTY_ACCESSOR,
        .value = mal_value_new_undefined(),
        .getter = getter,
        .setter = setter,
    };
}

void mal_intrinsic_define_accessor_n(
    MalVm *vm,
    MalObject *object,
    MalKey key,
    const byte *getter_name,
    i32 getter_length,
    MalNativeFunctionCallback getter,
    const byte *setter_name,
    i32 setter_length,
    MalNativeFunctionCallback setter,
    MalPropertyFlags flags
) {
    MalValue accessors[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, accessors, countof(accessors));
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    if (getter != nullptr) {
        accessors[0] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap, function_prototype, mal_intrinsic_ascii(vm, getter_name),
                getter_length, getter));
    }
    if (setter != nullptr) {
        accessors[1] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap, function_prototype, mal_intrinsic_ascii(vm, setter_name),
                setter_length, setter));
    }
    MalPropertyDesc desc = mal_intrinsic_accessor_desc(accessors[0], accessors[1], flags);
    mal_object_define_own(object, key, &desc);
    mal_gc_unroot(&root);
}

void mal_intrinsic_define_getter(
    MalVm *vm,
    MalObject *object,
    const byte *name,
    const byte *getter_name,
    MalNativeFunctionCallback getter,
    MalPropertyFlags flags
) {
    mal_intrinsic_define_accessor_n(
        vm, object, mal_intrinsic_string_key(vm, name), getter_name, 0, getter,
        nullptr, 0, nullptr, flags);
}

void mal_intrinsic_define_data(MalVm *vm, MalObject *object, const byte *name, MalValue value, MalPropertyFlags flags) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    mal_object_define_own(object, mal_intrinsic_string_key(vm, name), &desc);
}

MalValue mal_intrinsic_define_method(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback callback) {
    return mal_intrinsic_define_method_n(vm, object, name, 0, callback);
}

MalValue mal_intrinsic_define_method_n(MalVm *vm, MalObject *object, const byte *name, i32 length, MalNativeFunctionCallback callback) {
    MalNativeFunctionObject *function = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        length,
        callback
    );
    MalValue value = mal_value_from_native_function_object(function);
    mal_intrinsic_define_data(vm, object, name, value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return value;
}

MalValue mal_intrinsic_species_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    return this_value;
}

void mal_intrinsic_define_species(MalVm *vm, MalObject *constructor) {
    mal_intrinsic_define_accessor_n(
        vm, constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES),
        "get [Symbol.species]", 0, mal_intrinsic_species_getter,
        nullptr, 0, nullptr, MAL_PROPERTY_CONFIGURABLE);
}

MalObject *mal_intrinsic_new_object(MalVm *vm) {
    return mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
}

MalArrayObject *mal_intrinsic_new_array(MalVm *vm, u32 length) {
    MalArrayObject *array = mal_array_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]));
    mal_array_object_set_length(array, length);
    return array;
}

MalArrayObject *mal_intrinsic_new_dense_array(MalVm *vm, u32 length) {
    MalArrayObject *array = mal_intrinsic_new_array(vm, length);
    mal_array_object_dense_reserve_exact(array, length);
    return array;
}

static void mal_intrinsics_init_global_this(MalVm *vm);

/**
 * %Function.prototype% is itself a function that accepts any arguments and
 * returns undefined, but has no [[Construct]].
 */
static MalValue mal_intrinsic_function_prototype_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype is not a constructor");
    }

    return mal_value_new_undefined();
}

/**
 * The CommonJS `require` handed to module wrappers. The compiler resolves a
 * static `require("specifier")` to its module id and calls this with that
 * (int32) id; a non-id argument means an unresolved/dynamic require, which this
 * build does not support.
 */
static MalValue mal_intrinsic_cjs_require_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    if (arg_count < 1 || !mal_value_is_int32(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "dynamic require is not supported");
        return mal_value_new_undefined();
    }

    return mal_vm_cjs_require(vm, mal_value_to_i32(args[0]));
}

void mal_intrinsics_init(MalVm *vm) {
    // The prototypes are created upfront, so the builtin install passes can
    // reference them in any order.
    MalObject *object_prototype = mal_object_new(&vm->heap, nullptr);
    MalObject *function_prototype = (MalObject *) mal_native_function_object_new(
        &vm->heap,
        object_prototype,
        mal_string_new_ascii(&vm->heap, "", 0),
        mal_intrinsic_function_prototype_callback
    );
    MalObject *array_prototype = (MalObject *) mal_array_object_new(&vm->heap, object_prototype);

    vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE] = mal_value_from_object(object_prototype);
    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE] = mal_value_from_object(function_prototype);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE] = mal_value_from_object(array_prototype);

    // Watch %Array.prototype% and %Object.prototype% for the array fast-elements
    // protector: an integer-index define on, or reparenting of, either invalidates it
    // (see mal_array_elements_protector). Their builtin methods are string-keyed, so
    // installing them below does not trip the protector.
    object_prototype->fast_elements_proto = true;
    array_prototype->fast_elements_proto = true;
    // Cache %Array.prototype% for the inline array store fast path (default-proto
    // check). The cache is process-global, so it cannot identify the default
    // prototype after a second realm is initialized; disable that fast path then.
#if MAL_REALMS
    mal_array_prototype_object = vm->current_realm == vm->initial_realm ? array_prototype : nullptr;
#else
    mal_array_prototype_object = array_prototype;
#endif

    mal_builtin_object_install(vm);
    // Well-known symbols install before any pass that defines symbol-keyed
    // properties (Function.prototype[@@hasInstance], iterator wiring,
    // toStringTag); the iterator prototypes install before the passes that
    // expose iteration methods over them.
    mal_builtin_symbol_install(vm);
    mal_builtin_bigint_install(vm);
    mal_builtin_function_install(vm);
#if MAL_REALMS
    mal_builtin_shadow_realm_install(
        vm,
        MAL_INTRINSIC_SHADOW_REALM_CONSTRUCTOR,
        MAL_INTRINSIC_SHADOW_REALM_PROTOTYPE
    );
#endif
    mal_builtin_iterator_install(vm);
    mal_builtin_iterator_helpers_install(vm);
    mal_builtin_generator_install(vm);
    mal_builtin_async_generator_install(vm);
    mal_builtin_array_install(vm);
    mal_builtin_map_install(vm);
    mal_builtin_set_install(vm);
    mal_builtin_weak_ref_install(vm);
    mal_builtin_finalization_registry_install(vm);
    mal_builtin_array_buffer_install(vm);
    mal_builtin_typed_array_install(vm);
    mal_builtin_data_view_install(vm);
    mal_builtin_error_install(vm);
#if MAL_PROFILE && MAL_PERF_STATS
    vm->heap.profile_native_category = MAL_PROFILE_SITE_RUNTIME_STRING;
#endif
    mal_builtin_string_install(vm);
#if MAL_PROFILE && MAL_PERF_STATS
    vm->heap.profile_native_category = 0;
#endif
    mal_builtin_number_install(vm);
    mal_builtin_boolean_install(vm);
    mal_builtin_math_install(vm);
    mal_builtin_json_install(vm);
    mal_builtin_atomics_install(vm);
    mal_builtin_reflect_install(vm);
    mal_builtin_proxy_install(vm);
    mal_builtin_console_install(vm);
    mal_builtin_promise_install(vm);
    mal_builtin_date_install(vm);
#if MAL_TEMPORAL
    mal_builtin_temporal_install(vm);
#endif
#if MAL_PROFILE && MAL_PERF_STATS
    vm->heap.profile_native_category = MAL_PROFILE_SITE_RUNTIME_REGEXP;
#endif
    mal_builtin_regexp_install(vm);
#if MAL_PROFILE && MAL_PERF_STATS
    vm->heap.profile_native_category = 0;
#endif
    mal_builtin_intl_install(vm);
    mal_builtin_uri_install(vm);

    // Flag the built-in constructors as implementing [[Construct]]. Everything
    // else (prototype methods, accessors, plain functions like parseInt) is a
    // non-constructor, so `new method()` throws and IsConstructor reports false.
    static const MalIntrinsic constructor_slots[] = {
        MAL_INTRINSIC_OBJECT_CONSTRUCTOR,
        MAL_INTRINSIC_ARRAY_CONSTRUCTOR,
        MAL_INTRINSIC_FUNCTION_CONSTRUCTOR,
        MAL_INTRINSIC_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_SUPPRESSED_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_STRING_CONSTRUCTOR,
        MAL_INTRINSIC_NUMBER_CONSTRUCTOR,
        MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR,
        MAL_INTRINSIC_SYMBOL_CONSTRUCTOR,
        MAL_INTRINSIC_BIGINT_CONSTRUCTOR,
        MAL_INTRINSIC_MAP_CONSTRUCTOR,
        MAL_INTRINSIC_SET_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR,
        MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR,
        MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR,
        MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR,
        MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR,
        MAL_INTRINSIC_TYPED_ARRAY_CONSTRUCTOR,
        MAL_INTRINSIC_PROMISE_CONSTRUCTOR,
        MAL_INTRINSIC_DATE_CONSTRUCTOR,
#if MAL_TEMPORAL
        MAL_INTRINSIC_TEMPORAL_DURATION_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_INSTANT_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_CONSTRUCTOR,
#endif
        MAL_INTRINSIC_REGEXP_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_PLURAL_RULES_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_LIST_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_DISPLAY_NAMES_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_SEGMENTER_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_DURATION_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_ITERATOR_CONSTRUCTOR,
        MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR,
        MAL_INTRINSIC_GENERATOR_FUNCTION_CONSTRUCTOR,
        MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR,
        MAL_INTRINSIC_ASYNC_FUNCTION_CONSTRUCTOR,
    };
    for (usize i = 0; i < countof(constructor_slots); i++) {
        MalValue value = vm->intrinsics[constructor_slots[i]];
        if (mal_value_is_native_function_object(value)) {
            mal_native_function_object_set_constructor(mal_value_to_native_function_object(value));
        }
    }
    // The per-kind TypedArray constructors are contiguous in MalTypedArrayKind order.
    for (i32 kind = 0; kind < MAL_TA_KIND_COUNT; kind++) {
        MalValue value = vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + kind];
        if (mal_value_is_native_function_object(value)) {
            mal_native_function_object_set_constructor(mal_value_to_native_function_object(value));
        }
    }

    vm->intrinsics[MAL_INTRINSIC_NAN_VALUE] = mal_value_new_nan();
    vm->intrinsics[MAL_INTRINSIC_INFINITY_VALUE] = mal_value_from_f64_convert_nan(INFINITY);

    // The CommonJS `require` native (not exposed on globalThis); passed to module
    // wrappers by mal_vm_cjs_require.
    vm->intrinsics[MAL_INTRINSIC_CJS_REQUIRE] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "require"),
            1,
            mal_intrinsic_cjs_require_callback
        )
    );

    mal_intrinsics_init_global_this(vm);

    // All builtin prototypes/constructors are now fully populated. Watch the objects
    // the primitive-method + intrinsic-own-property inline cache reads from, so any
    // later user mutation invalidates the cache; the protector holds until then. Do
    // this after the init-time method installs above so they do not trip it. The
    // process-global protector is monotonic: initialization of a later realm must not
    // re-enable it after an earlier realm invalidated it.
    //   - the primitive prototypes + %Object.prototype% (the chain a primitive
    //     receiver walks) — for `str.method()` / `num.method()`;
    //   - the namespaces Math/JSON/Reflect/Atomics and every builtin constructor —
    //     their static/namespace methods (`Math.floor`, `String.fromCharCode`,
    //     `Object.keys`, …) live in the overflow table and are otherwise re-hashed
    //     every call.
    static const MalIntrinsic watched_lookup_objects[] = {
        MAL_INTRINSIC_OBJECT_PROTOTYPE,
        MAL_INTRINSIC_STRING_PROTOTYPE,
        MAL_INTRINSIC_NUMBER_PROTOTYPE,
        MAL_INTRINSIC_BOOLEAN_PROTOTYPE,
        MAL_INTRINSIC_SYMBOL_PROTOTYPE,
        MAL_INTRINSIC_BIGINT_PROTOTYPE,
        MAL_INTRINSIC_ARRAY_PROTOTYPE,
        MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE,
        MAL_INTRINSIC_MAP_PROTOTYPE,
        MAL_INTRINSIC_SET_PROTOTYPE,
        MAL_INTRINSIC_WEAK_MAP_PROTOTYPE,
        MAL_INTRINSIC_WEAK_SET_PROTOTYPE,
        MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
        MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE,
        MAL_INTRINSIC_DATA_VIEW_PROTOTYPE,
        MAL_INTRINSIC_TYPED_ARRAY_PROTOTYPE,
        MAL_INTRINSIC_PROMISE_PROTOTYPE,
        MAL_INTRINSIC_DATE_PROTOTYPE,
        MAL_INTRINSIC_REGEXP_PROTOTYPE,
        MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE,
        MAL_INTRINSIC_INTL_COLLATOR_PROTOTYPE,
        MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE,
        MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_PROTOTYPE,
        MAL_INTRINSIC_INTL_PLURAL_RULES_PROTOTYPE,
        MAL_INTRINSIC_INTL_LIST_FORMAT_PROTOTYPE,
        MAL_INTRINSIC_INTL_DISPLAY_NAMES_PROTOTYPE,
        MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_PROTOTYPE,
        MAL_INTRINSIC_INTL_SEGMENTER_PROTOTYPE,
        MAL_INTRINSIC_INTL_DURATION_FORMAT_PROTOTYPE,
        MAL_INTRINSIC_MATH,
        MAL_INTRINSIC_JSON,
        MAL_INTRINSIC_REFLECT,
        MAL_INTRINSIC_ATOMICS,
    };
    for (usize i = 0; i < countof(watched_lookup_objects); i++) {
        MalValue obj = vm->intrinsics[watched_lookup_objects[i]];
        if (mal_value_is_object(obj)) {
            mal_value_to_object(obj)->watched_method_proto = true;
        }
    }
    // Every builtin constructor (their static methods live in the overflow table).
    for (usize i = 0; i < countof(constructor_slots); i++) {
        MalValue value = vm->intrinsics[constructor_slots[i]];
        if (mal_value_is_object(value)) {
            mal_value_to_object(value)->watched_method_proto = true;
        }
    }
    for (i32 kind = 0; kind < MAL_TA_KIND_COUNT; kind++) {
        MalValue value = vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + kind];
        if (mal_value_is_object(value)) {
            mal_value_to_object(value)->watched_method_proto = true;
        }
        value = vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind];
        if (mal_value_is_object(value)) {
            mal_value_to_object(value)->watched_method_proto = true;
        }
    }
}

/**
 * Host-provided forced-collection hook for the test262 harness's `$262.gc()`.
 * Installed on globalThis only under MAL_HOST_GC (see
 * mal_intrinsics_init_global_this); the harness prelude captures it into the
 * `$262.gc` closure and then deletes the global, so test bodies see a clean
 * global object.
 */
static MalValue mal_intrinsic_host_gc(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    mal_gc_collect(vm);
    return mal_value_new_undefined();
}

/**
 * Diagnostic: the heap's surviving-byte count from the last collection (updated
 * by the sweep). Lets GC unit tests assert reclamation quantitatively. Installed
 * alongside the gc hook under MAL_HOST_GC; the harness prelude deletes it.
 */
static MalValue mal_intrinsic_gc_live_bytes(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_value_from_f64((f64) vm->heap.live_bytes);
}

static MalValue mal_intrinsic_fail_next_cell_allocation(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    vm->heap.fail_next_cell_allocation = true;
    return MAL_VALUE_UNDEFINED;
}

/** Benchmark-only hook: begin a fresh attribution window after framework warmup. */
static MalValue mal_intrinsic_perf_stats_reset(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    mal_perf_stats_reset();
    return MAL_VALUE_UNDEFINED;
}

/**
 * Expose the intrinsics as properties of a globalThis namespace object.
 */
static void mal_intrinsics_init_global_this(MalVm *vm) {
    MalObject *global_this = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS] = mal_value_from_object(global_this);

    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, global_this, "globalThis", vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], flags);
    mal_intrinsic_define_data(vm, global_this, "Object", vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Array", vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Function", vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Error", vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "TypeError", vm->intrinsics[MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "RangeError", vm->intrinsics[MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "ReferenceError", vm->intrinsics[MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SyntaxError", vm->intrinsics[MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "EvalError", vm->intrinsics[MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "URIError", vm->intrinsics[MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "String", vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Number", vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Boolean", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Symbol", vm->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigInt", vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Map", vm->intrinsics[MAL_INTRINSIC_MAP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Set", vm->intrinsics[MAL_INTRINSIC_SET_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakMap", vm->intrinsics[MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakSet", vm->intrinsics[MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakRef", vm->intrinsics[MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "FinalizationRegistry", vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "ArrayBuffer", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SharedArrayBuffer", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int8Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint8Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint8ClampedArray", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int16Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint16Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Float32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Float64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigInt64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigUint64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "DataView", vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "parseInt", vm->intrinsics[MAL_INTRINSIC_PARSE_INT], flags);
    mal_intrinsic_define_data(vm, global_this, "parseFloat", vm->intrinsics[MAL_INTRINSIC_PARSE_FLOAT], flags);
    mal_intrinsic_define_data(vm, global_this, "isNaN", vm->intrinsics[MAL_INTRINSIC_IS_NAN], flags);
    mal_intrinsic_define_data(vm, global_this, "isFinite", vm->intrinsics[MAL_INTRINSIC_IS_FINITE], flags);
    mal_intrinsic_define_data(vm, global_this, "Math", vm->intrinsics[MAL_INTRINSIC_MATH], flags);
    mal_intrinsic_define_data(vm, global_this, "JSON", vm->intrinsics[MAL_INTRINSIC_JSON], flags);
    mal_intrinsic_define_data(vm, global_this, "Atomics", vm->intrinsics[MAL_INTRINSIC_ATOMICS], flags);
    mal_intrinsic_define_data(vm, global_this, "Reflect", vm->intrinsics[MAL_INTRINSIC_REFLECT], flags);
    mal_intrinsic_define_data(vm, global_this, "Proxy", vm->intrinsics[MAL_INTRINSIC_PROXY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "console", vm->intrinsics[MAL_INTRINSIC_CONSOLE], flags);
    mal_intrinsic_define_data(vm, global_this, "Promise", vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Date", vm->intrinsics[MAL_INTRINSIC_DATE_CONSTRUCTOR], flags);
#if MAL_TEMPORAL
    mal_intrinsic_define_data(vm, global_this, "Temporal", vm->intrinsics[MAL_INTRINSIC_TEMPORAL], flags);
#endif
    mal_intrinsic_define_data(vm, global_this, "RegExp", vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Intl", vm->intrinsics[MAL_INTRINSIC_INTL], flags);
    mal_intrinsic_define_data(vm, global_this, "AggregateError", vm->intrinsics[MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SuppressedError", vm->intrinsics[MAL_INTRINSIC_SUPPRESSED_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Iterator", vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "AsyncIterator", vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR], flags);
#if MAL_REALMS
    mal_intrinsic_define_data(vm, global_this, "ShadowRealm", vm->intrinsics[MAL_INTRINSIC_SHADOW_REALM_CONSTRUCTOR], flags);
#endif
    mal_intrinsic_define_data(vm, global_this, "decodeURI", vm->intrinsics[MAL_INTRINSIC_DECODE_URI], flags);
    mal_intrinsic_define_data(vm, global_this, "decodeURIComponent", vm->intrinsics[MAL_INTRINSIC_DECODE_URI_COMPONENT], flags);
    mal_intrinsic_define_data(vm, global_this, "encodeURI", vm->intrinsics[MAL_INTRINSIC_ENCODE_URI], flags);
    mal_intrinsic_define_data(vm, global_this, "encodeURIComponent", vm->intrinsics[MAL_INTRINSIC_ENCODE_URI_COMPONENT], flags);
    mal_builtin_uri_install_legacy_globals(vm, global_this);
    mal_intrinsic_define_data(vm, global_this, "NaN", vm->intrinsics[MAL_INTRINSIC_NAN_VALUE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, global_this, "Infinity", vm->intrinsics[MAL_INTRINSIC_INFINITY_VALUE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, global_this, "undefined", mal_value_new_undefined(), MAL_PROPERTY_NONE);

    // NB: host globals (setTimeout/clearTimeout) are NOT installed here — they are a
    // host concern, not an ECMAScript intrinsic, so the bare test262 environment
    // stays free of them. The host entry installs them via mal_host_timers_install.

    // Runtime eval / new Function: a baked self-hosted compiler spliced on first
    // use (builtin_eval.c).
    mal_intrinsics_init_eval(vm, global_this);

    // Host forced-collection hook for the test262 `$262.gc()`. Only present when
    // the harness asks (MAL_HOST_GC); the prelude captures it then deletes the
    // global, so it never pollutes a test body's global object.
    if (getenv("MAL_HOST_GC") != nullptr) {
        mal_intrinsic_define_method(vm, global_this, "__mal_collect_garbage", mal_intrinsic_host_gc);
        mal_intrinsic_define_method(vm, global_this, "__mal_gc_live_bytes", mal_intrinsic_gc_live_bytes);
    }
    if (getenv("MAL_ALLOC_FAIL_TEST") != nullptr) {
        mal_intrinsic_define_method(
            vm, global_this, "__mal_fail_next_cell_allocation",
            mal_intrinsic_fail_next_cell_allocation);
    }
    // Kept behind both compile/runtime perf instrumentation and an explicit
    // control flag: production globals remain unchanged, while the HTTP profiler
    // can discard framework startup and warmup activity before measurement.
    if (mal_perf_stats_enabled && getenv("MAL_PERF_CONTROL") != nullptr) {
        mal_intrinsic_define_method(
            vm, global_this, "__mal_reset_perf_stats",
            mal_intrinsic_perf_stats_reset);
    }

    mal_primordials_lock(vm);
}
