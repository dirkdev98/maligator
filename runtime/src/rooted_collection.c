#include "rooted_collection.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "heap_string.h"
#include "intrinsics.h"
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

    usize roots_bytes;
    if (!mal_checked_size_multiply(
            expected_count, sizeof(MalValue), SIZE_MAX, &roots_bytes)) {
        return false;
    }
    MalValue *roots = expected_count == 0 ? nullptr : malloc(roots_bytes);
    if (expected_count != 0 && roots == nullptr) {
        return false;
    }

    parts->separator_root = mal_value_from_string(separator);
    parts->roots = roots;
    parts->expected_count = expected_count;
    mal_gc_root(&parts->separator_span, &parts->separator_root, 1);
    mal_gc_root(&parts->parts_span, roots, 0);
    return true;
}

bool mal_rooted_string_parts_append(MalRootedStringParts *parts, MalString *part) {
    if (parts->count >= parts->expected_count ||
        !mal_checked_size_add(
            parts->total_length,
            part == nullptr ? 0 : mal_string_length(part),
            MAL_STRING_MAX_CODE_UNITS,
            &parts->total_length)) {
        return false;
    }

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

    if (parts->count == 1 && !mal_value_is_undefined(parts->roots[0])) {
        *out = mal_value_to_string(parts->roots[0]);
        return true;
    }
    if (parts->total_length == 0) {
        *out = mal_intrinsic_ascii(vm, "");
        return true;
    }

    MalString *separator = mal_value_to_string(parts->separator_root);
    usize separator_length = mal_string_length(separator);
    if (separator_length == 0) {
        // Joining empty parts around one full non-empty part is already flat.
        for (usize i = 0; i < parts->count; i++) {
            MalString *part = mal_value_is_undefined(parts->roots[i])
                ? nullptr
                : mal_value_to_string(parts->roots[i]);
            if (part != nullptr && mal_string_length(part) == parts->total_length) {
                *out = part;
                return true;
            }
        }
    }

    usize bytes;
    if (!mal_checked_size_multiply(
            sizeof(c16), parts->total_length, SIZE_MAX, &bytes)) {
        return false;
    }
    c16 *code_units = mal_heap_try_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    if (code_units == nullptr) {
        return false;
    }

    separator = mal_value_to_string(parts->separator_root);
    const c16 *separator_units = separator_length == 0
        ? nullptr
        : mal_string_code_units(separator);
    usize offset = 0;
    for (usize i = 0; i < parts->count; i++) {
        if (i != 0 && separator_length != 0) {
            memcpy(
                code_units + offset,
                separator_units,
                separator_length * sizeof(c16));
            offset += separator_length;
        }
        MalString *part = mal_value_is_undefined(parts->roots[i])
            ? nullptr
            : mal_value_to_string(parts->roots[i]);
        usize part_length = part == nullptr ? 0 : mal_string_length(part);
        if (part_length != 0) {
            memcpy(
                code_units + offset,
                mal_string_code_units(part),
                part_length * sizeof(c16));
            offset += part_length;
        }
    }

    *out = mal_string_new_owned(&vm->heap, code_units, parts->total_length);
    return true;
}

void mal_rooted_string_parts_dispose(MalRootedStringParts *parts) {
    mal_gc_unroot(&parts->parts_span);
    mal_gc_unroot(&parts->separator_span);
    free(parts->roots);
    *parts = (MalRootedStringParts) {0};
}
