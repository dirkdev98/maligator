#include "rooted_collection.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "heap_string.h"
#include "vm.h"
#include "vm_ops.h"

static bool mal_rooted_collection_capacity(
    usize current, usize required, usize element_size, usize *capacity, usize *bytes
) {
    return mal_checked_size_growth(current, required, 8, INT32_MAX, capacity) &&
        mal_checked_size_multiply(*capacity, element_size, SIZE_MAX, bytes);
}

static void mal_rooted_key_snapshot_reserve(MalRootedKeySnapshot *snapshot) {
    if (snapshot->count < snapshot->capacity) {
        return;
    }

    usize capacity;
    usize keys_bytes;
    usize roots_bytes;
    if (!mal_rooted_collection_capacity(
            snapshot->capacity, snapshot->count + 1,
            sizeof(MalKey), &capacity, &keys_bytes) ||
        !mal_checked_size_multiply(
            capacity, sizeof(MalValue), SIZE_MAX, &roots_bytes)) {
        abort();
    }

    MalKey *keys = malloc(keys_bytes);
    MalValue *roots = malloc(roots_bytes);
    if (keys == nullptr || roots == nullptr) {
        free(roots);
        free(keys);
        abort();
    }
    if (snapshot->count != 0) {
        memcpy(keys, snapshot->keys, snapshot->count * sizeof(MalKey));
        memcpy(roots, snapshot->roots, snapshot->count * sizeof(MalValue));
    }

    free(snapshot->keys);
    free(snapshot->roots);
    snapshot->keys = keys;
    snapshot->roots = roots;
    snapshot->capacity = capacity;
    snapshot->root_span.slots = roots;
}

void mal_rooted_key_snapshot_init(MalRootedKeySnapshot *snapshot) {
    *snapshot = (MalRootedKeySnapshot) {0};
    mal_gc_root(&snapshot->root_span, nullptr, 0);
}

void mal_rooted_key_snapshot_append(MalRootedKeySnapshot *snapshot, MalKey key) {
    mal_rooted_key_snapshot_reserve(snapshot);
    snapshot->keys[snapshot->count] = key;
    snapshot->roots[snapshot->count] = key.value;
    snapshot->count++;
    snapshot->root_span.count = (i32) snapshot->count;
}

bool mal_rooted_key_snapshot_own_keys(
    MalVm *vm, MalValue object, MalRootedKeySnapshot *snapshot
) {
    MalValue keys;
    if (!mal_vm_own_property_keys(vm, object, &keys)) {
        return false;
    }
    MalRootSpan keys_span;
    mal_gc_root(&keys_span, &keys, 1);
    u32 count = mal_array_object_length(mal_value_to_array_object(keys));
    bool ok = true;
    for (u32 i = 0; i < count; i++) {
        MalValue key_value;
        MalKey key;
        if (!mal_vm_get_property(vm, keys, mal_key_index(i), &key_value) ||
            !mal_vm_value_to_property_key(vm, key_value, &key)) {
            ok = false;
            break;
        }
        mal_rooted_key_snapshot_append(snapshot, key);
    }
    mal_gc_unroot(&keys_span);
    return ok;
}

void mal_rooted_key_snapshot_dispose(MalRootedKeySnapshot *snapshot) {
    mal_gc_unroot(&snapshot->root_span);
    free(snapshot->roots);
    free(snapshot->keys);
    *snapshot = (MalRootedKeySnapshot) {0};
}

void mal_rooted_value_list_init(MalRootedValueList *list) {
    *list = (MalRootedValueList) {0};
    mal_gc_root(&list->root_span, nullptr, 0);
}

void mal_rooted_value_list_append(MalRootedValueList *list, MalValue value) {
    if (list->count == list->capacity) {
        usize capacity;
        usize bytes;
        if (!mal_rooted_collection_capacity(
                list->capacity, list->count + 1, sizeof(MalValue),
                &capacity, &bytes)) {
            abort();
        }
        MalValue *values = malloc(bytes);
        if (values == nullptr) {
            abort();
        }
        if (list->count != 0) {
            memcpy(values, list->values, list->count * sizeof(MalValue));
        }
        free(list->values);
        list->values = values;
        list->capacity = capacity;
        list->root_span.slots = values;
    }
    list->values[list->count++] = value;
    list->root_span.count = (i32) list->count;
}

void mal_rooted_value_list_dispose(MalRootedValueList *list) {
    mal_gc_unroot(&list->root_span);
    free(list->values);
    *list = (MalRootedValueList) {0};
}

static bool mal_rooted_string_parts_reserve(MalRootedStringParts *parts) {
    if (parts->count < parts->capacity) {
        return true;
    }

    usize capacity;
    usize parts_bytes;
    usize roots_bytes;
    if (!mal_rooted_collection_capacity(
            parts->capacity, parts->count + 1,
            sizeof(MalString *), &capacity, &parts_bytes) ||
        !mal_checked_size_multiply(
            capacity, sizeof(MalValue), SIZE_MAX, &roots_bytes)) {
        return false;
    }

    MalString **strings = malloc(parts_bytes);
    MalValue *roots = malloc(roots_bytes);
    if (strings == nullptr || roots == nullptr) {
        free(roots);
        free(strings);
        return false;
    }
    if (parts->count != 0) {
        memcpy(strings, parts->parts, parts->count * sizeof(MalString *));
        memcpy(roots, parts->roots, parts->count * sizeof(MalValue));
    }

    free(parts->parts);
    free(parts->roots);
    parts->parts = strings;
    parts->roots = roots;
    parts->capacity = capacity;
    parts->parts_span.slots = roots;
    return true;
}

bool mal_rooted_string_parts_init(
    MalRootedStringParts *parts, MalString *separator, usize expected_count
) {
    *parts = (MalRootedStringParts) {0};
    if (expected_count > INT32_MAX) {
        return false;
    }

    usize separator_count = expected_count == 0 ? 0 : expected_count - 1;
    if (!mal_checked_size_multiply(
            mal_string_length(separator), separator_count,
            MAL_STRING_MAX_CODE_UNITS, &parts->total_length)) {
        return false;
    }

    parts->separator = separator;
    parts->separator_root = mal_value_from_string(separator);
    parts->expected_count = expected_count;
    mal_gc_root(&parts->separator_span, &parts->separator_root, 1);
    mal_gc_root(&parts->parts_span, nullptr, 0);
    return true;
}

bool mal_rooted_string_parts_append(MalRootedStringParts *parts, MalString *part) {
    if (parts->count >= parts->expected_count ||
        !mal_checked_size_add(
            parts->total_length,
            part == nullptr ? 0 : mal_string_length(part),
            MAL_STRING_MAX_CODE_UNITS,
            &parts->total_length) ||
        !mal_rooted_string_parts_reserve(parts)) {
        return false;
    }

    parts->parts[parts->count] = part;
    parts->roots[parts->count] = part == nullptr
        ? mal_value_new_undefined()
        : mal_value_from_string(part);
    parts->count++;
    parts->parts_span.count = (i32) parts->count;
    return true;
}

bool mal_rooted_string_parts_flatten(
    MalVm *vm, MalRootedStringParts *parts, MalString **out
) {
    if (parts->count != parts->expected_count) {
        return false;
    }

    usize bytes;
    if (!mal_checked_size_multiply(
            sizeof(c16), parts->total_length, SIZE_MAX, &bytes)) {
        return false;
    }
    c16 *code_units = parts->total_length == 0 ? nullptr : malloc(bytes);
    if (parts->total_length != 0 && code_units == nullptr) {
        return false;
    }

    usize offset = 0;
    usize separator_length = mal_string_length(parts->separator);
    for (usize i = 0; i < parts->count; i++) {
        if (i != 0 && separator_length != 0) {
            memcpy(
                code_units + offset,
                mal_string_code_units(parts->separator),
                separator_length * sizeof(c16));
            offset += separator_length;
        }
        MalString *part = parts->parts[i];
        usize part_length = part == nullptr ? 0 : mal_string_length(part);
        if (part_length != 0) {
            memcpy(
                code_units + offset,
                mal_string_code_units(part),
                part_length * sizeof(c16));
            offset += part_length;
        }
    }

    *out = mal_string_new_copy(&vm->heap, code_units, parts->total_length);
    free(code_units);
    return true;
}

void mal_rooted_string_parts_dispose(MalRootedStringParts *parts) {
    mal_gc_unroot(&parts->parts_span);
    mal_gc_unroot(&parts->separator_span);
    free(parts->roots);
    free(parts->parts);
    *parts = (MalRootedStringParts) {0};
}
