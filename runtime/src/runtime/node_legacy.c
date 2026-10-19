#include "node_legacy.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_crypto.h"
#include "node_fs.h"
#include "node_module.h"
#include "node_os.h"
#include "node_util.h"
#include "object.h"
#include "property_iter.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"

#define LEGACY_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue legacy_get(MalVm *vm, MalValue object, const char *name) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(object)) {
        mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), &value);
    }
    return value;
}

/* Copies `source`'s own enumerable data properties onto `target`, as Object.assign would. */
static void legacy_assign(MalVm *vm, MalObject *target, MalValue source) {
    if (!mal_value_is_object(source)) return;
    MalRootSpan root;
    mal_gc_root(&root, &source, 1);
    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL || (desc.flags & MAL_PROPERTY_ACCESSOR) != 0) continue;
        MalPropertyDesc copy = mal_intrinsic_data_desc(desc.value, LEGACY_VISIBLE);
        mal_object_define_own(target, key, &copy);
    }
    mal_gc_unroot(&root);
}

/* lib/constants.js: os.dlopen, errno, priority and signals, then fs and crypto, frozen. */
void mal_host_install_node_constants(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:constants", slots, count)) return;
    static const char *const sources[] = {"node:os", "node:fs", "node:crypto"};
    mal_host_install_node_os(vm, nullptr, 0, launch);
    mal_host_install_node_fs(vm, nullptr, 0, launch);
    mal_host_install_node_crypto(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *constants = mal_value_to_object(roots[0]);
    roots[1] = legacy_get(vm, mal_node_module_get_cached(vm, sources[0]), "constants");
    static const char *const os_groups[] = {"dlopen", "errno", "priority", "signals"};
    for (usize i = 0; i < countof(os_groups); i++) {
        legacy_assign(vm, constants, legacy_get(vm, roots[1], os_groups[i]));
    }
    for (usize i = 1; i < countof(sources); i++) {
        legacy_assign(vm, constants, legacy_get(vm, mal_node_module_get_cached(vm, sources[i]), "constants"));
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_builtin_object_set_integrity(vm, roots[0], true);
        mal_node_module_publish(vm, "node:constants", slots, count, roots[0]);
    }
    mal_gc_unroot(&root);
}

/* node:sys is node:util under its pre-0.3 name. */
void mal_host_install_node_sys(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:sys", slots, count)) return;
    mal_host_install_node_util(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    mal_node_module_publish(vm, "node:sys", slots, count, mal_node_module_get_cached(vm, "node:util"));
}

/* punycode.js 2.1.0, which Node bundles as node:punycode (RFC 3492 with Bootstring parameters). */
enum {
    PUNY_BASE = 36,
    PUNY_TMIN = 1,
    PUNY_TMAX = 26,
    PUNY_SKEW = 38,
    PUNY_DAMP = 700,
    PUNY_INITIAL_BIAS = 72,
    PUNY_INITIAL_N = 128,
};
#define PUNY_MAX_INT 2147483647u

typedef struct PunyCodePoints {
    u32 *items;
    usize length;
    usize capacity;
} PunyCodePoints;

static bool puny_push(PunyCodePoints *list, u32 value) {
    if (list->length == list->capacity) {
        usize capacity = list->capacity == 0 ? 32 : list->capacity * 2;
        u32 *grown = realloc(list->items, capacity * sizeof *grown);
        if (grown == nullptr) return false;
        list->items = grown;
        list->capacity = capacity;
    }
    list->items[list->length++] = value;
    return true;
}

static void puny_error(MalVm *vm, const char *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) message);
}

static u32 puny_adapt(u32 delta, u32 points, bool first) {
    u32 k = 0;
    delta = first ? delta / PUNY_DAMP : delta >> 1;
    delta += delta / points;
    for (; delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1; k += PUNY_BASE) {
        delta /= PUNY_BASE - PUNY_TMIN;
    }
    return k + (PUNY_BASE - PUNY_TMIN + 1) * delta / (delta + PUNY_SKEW);
}

static u32 puny_basic_to_digit(c16 unit) {
    if (unit >= 0x30 && unit < 0x3a) return 26 + (u32) (unit - 0x30);
    if (unit >= 0x41 && unit < 0x5b) return (u32) (unit - 0x41);
    if (unit >= 0x61 && unit < 0x7b) return (u32) (unit - 0x61);
    return PUNY_BASE;
}

static c16 puny_digit_to_basic(u32 digit) {
    return (c16) (digit + 22 + 75 * (digit < 26));
}

static u32 puny_threshold(u32 k, u32 bias) {
    return k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
}

static void puny_ucs2_decode(MalString *string, usize start, usize end, PunyCodePoints *out, bool *ok) {
    for (usize i = start; i < end && *ok; i++) {
        u32 value = mal_string_code_unit_at(string, i);
        if (value >= 0xd800 && value <= 0xdbff && i + 1 < end) {
            u32 extra = mal_string_code_unit_at(string, i + 1);
            if ((extra & 0xfc00) == 0xdc00) {
                value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
                i++;
            }
        }
        *ok = puny_push(out, value);
    }
}

/* Appends code points as UTF-16, rejecting values String.fromCodePoint would. */
static bool puny_append_utf16(MalVm *vm, c16 **units, usize *length, usize *capacity, const PunyCodePoints *points) {
    for (usize i = 0; i < points->length; i++) {
        u32 value = points->items[i];
        if (value > 0x10ffff) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "Invalid code point");
            return false;
        }
        if (*length + 2 > *capacity) {
            usize grown_capacity = *capacity == 0 ? 64 : *capacity * 2;
            c16 *grown = realloc(*units, grown_capacity * sizeof *grown);
            if (grown == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return false;
            }
            *units = grown;
            *capacity = grown_capacity;
        }
        if (value >= 0x10000) {
            value -= 0x10000;
            (*units)[(*length)++] = (c16) (0xd800 + (value >> 10));
            (*units)[(*length)++] = (c16) (0xdc00 + (value & 0x3ff));
        } else {
            (*units)[(*length)++] = (c16) value;
        }
    }
    return true;
}

/* Decodes string[start, end) (lowercased first when `lower`) into code points. */
static bool puny_decode_range(MalVm *vm, MalString *string, usize start, usize end, bool lower, PunyCodePoints *out) {
    usize basic = start;
    for (usize i = end; i > start; i--) {
        if (mal_string_code_unit_at(string, i - 1) == '-') {
            basic = i - 1;
            break;
        }
    }
    for (usize j = start; j < basic; j++) {
        c16 unit = mal_string_code_unit_at(string, j);
        if (unit >= 0x80) {
            puny_error(vm, "Illegal input >= 0x80 (not a basic code point)");
            return false;
        }
        if (lower && unit >= 'A' && unit <= 'Z') unit = (c16) (unit + 32);
        if (!puny_push(out, unit)) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
    }
    u32 i = 0, n = PUNY_INITIAL_N, bias = PUNY_INITIAL_BIAS;
    for (usize index = basic > start ? basic + 1 : start; index < end;) {
        u32 old_i = i;
        for (u32 w = 1, k = PUNY_BASE;; k += PUNY_BASE) {
            if (index >= end) {
                puny_error(vm, "Invalid input");
                return false;
            }
            c16 unit = mal_string_code_unit_at(string, index++);
            if (lower && unit >= 'A' && unit <= 'Z') unit = (c16) (unit + 32);
            u32 digit = puny_basic_to_digit(unit);
            if (digit >= PUNY_BASE) {
                puny_error(vm, "Invalid input");
                return false;
            }
            if (digit > (PUNY_MAX_INT - i) / w) {
                puny_error(vm, "Overflow: input needs wider integers to process");
                return false;
            }
            i += digit * w;
            u32 t = puny_threshold(k, bias);
            if (digit < t) break;
            if (w > PUNY_MAX_INT / (PUNY_BASE - t)) {
                puny_error(vm, "Overflow: input needs wider integers to process");
                return false;
            }
            w *= PUNY_BASE - t;
        }
        u32 out_length = (u32) out->length + 1;
        bias = puny_adapt(i - old_i, out_length, old_i == 0);
        if (i / out_length > PUNY_MAX_INT - n) {
            puny_error(vm, "Overflow: input needs wider integers to process");
            return false;
        }
        n += i / out_length;
        i %= out_length;
        if (!puny_push(out, 0)) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        memmove(out->items + i + 1, out->items + i, (out->length - 1 - i) * sizeof *out->items);
        out->items[i++] = n;
    }
    return true;
}

/* Encodes code points, appending ASCII output units. */
static bool puny_encode_points(MalVm *vm, const PunyCodePoints *input, c16 **units, usize *length, usize *capacity) {
    PunyCodePoints output = {0};
    bool ok = true;
    for (usize i = 0; i < input->length && ok; i++) {
        if (input->items[i] < 0x80) ok = puny_push(&output, input->items[i]);
    }
    u32 basic_length = (u32) output.length;
    u32 handled = basic_length;
    if (basic_length > 0 && ok) ok = puny_push(&output, '-');
    u32 n = PUNY_INITIAL_N, delta = 0, bias = PUNY_INITIAL_BIAS;
    while (ok && handled < input->length) {
        u32 m = PUNY_MAX_INT;
        for (usize i = 0; i < input->length; i++) {
            if (input->items[i] >= n && input->items[i] < m) m = input->items[i];
        }
        u32 handled_plus_one = handled + 1;
        if (m - n > (PUNY_MAX_INT - delta) / handled_plus_one) {
            puny_error(vm, "Overflow: input needs wider integers to process");
            ok = false;
            break;
        }
        delta += (m - n) * handled_plus_one;
        n = m;
        for (usize i = 0; i < input->length && ok; i++) {
            u32 current = input->items[i];
            if (current < n && ++delta > PUNY_MAX_INT) {
                puny_error(vm, "Overflow: input needs wider integers to process");
                ok = false;
                break;
            }
            if (current != n) continue;
            u32 q = delta;
            for (u32 k = PUNY_BASE;; k += PUNY_BASE) {
                u32 t = puny_threshold(k, bias);
                if (q < t) break;
                u32 q_minus_t = q - t, base_minus_t = PUNY_BASE - t;
                ok = puny_push(&output, puny_digit_to_basic(t + q_minus_t % base_minus_t));
                if (!ok) break;
                q = q_minus_t / base_minus_t;
            }
            if (ok) ok = puny_push(&output, puny_digit_to_basic(q));
            bias = puny_adapt(delta, handled_plus_one, handled == basic_length);
            delta = 0;
            handled++;
        }
        delta++;
        n++;
    }
    if (ok) ok = puny_append_utf16(vm, units, length, capacity, &output);
    else if (vm->completion.kind != MAL_COMPLETION_THROW) mal_vm_throw_allocation_error(vm);
    free(output.items);
    return ok;
}

static MalValue puny_string(MalVm *vm, c16 *units, usize length) {
    MalString *string = mal_string_new_copy(&vm->heap, units, length);
    free(units);
    return mal_value_from_string(string);
}

static MalString *puny_argument(MalVm *vm, const MalValue *args, i32 argc) {
    MalString *string;
    if (!mal_vm_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &string)) return nullptr;
    return string;
}

static MalValue puny_decode(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver, (void) nt, (void) callee;
    MalString *input = puny_argument(vm, args, argc);
    if (input == nullptr) return mal_value_new_undefined();
    PunyCodePoints points = {0};
    c16 *units = nullptr;
    usize length = 0, capacity = 0;
    bool ok = puny_decode_range(vm, input, 0, mal_string_length(input), false, &points)
        && puny_append_utf16(vm, &units, &length, &capacity, &points);
    free(points.items);
    if (!ok) {
        free(units);
        return mal_value_new_undefined();
    }
    return puny_string(vm, units, length);
}

static MalValue puny_encode(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver, (void) nt, (void) callee;
    MalString *input = puny_argument(vm, args, argc);
    if (input == nullptr) return mal_value_new_undefined();
    PunyCodePoints points = {0};
    bool ok = true;
    puny_ucs2_decode(input, 0, mal_string_length(input), &points, &ok);
    c16 *units = nullptr;
    usize length = 0, capacity = 0;
    ok = ok && puny_encode_points(vm, &points, &units, &length, &capacity);
    free(points.items);
    if (!ok) {
        free(units);
        return mal_value_new_undefined();
    }
    return puny_string(vm, units, length);
}

static bool puny_is_separator(c16 unit) {
    return unit == 0x2e || unit == 0x3002 || unit == 0xff0e || unit == 0xff61;
}

static bool puny_append_units(MalVm *vm, c16 **units, usize *length, usize *capacity, MalString *source,
    usize start, usize end) {
    for (usize i = start; i < end; i++) {
        if (*length + 1 > *capacity) {
            usize grown_capacity = *capacity == 0 ? 64 : *capacity * 2;
            c16 *grown = realloc(*units, grown_capacity * sizeof *grown);
            if (grown == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return false;
            }
            *units = grown;
            *capacity = grown_capacity;
        }
        c16 unit = mal_string_code_unit_at(source, i);
        (*units)[(*length)++] = puny_is_separator(unit) ? '.' : unit;
    }
    return true;
}

/* mapDomain: keep any "local@" prefix, normalise label separators, convert each label. */
static MalValue puny_map_domain(MalVm *vm, const MalValue *args, i32 argc, bool to_ascii) {
    MalString *input = puny_argument(vm, args, argc);
    if (input == nullptr) return mal_value_new_undefined();
    MalValue rooted = mal_value_from_string(input);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    usize total = mal_string_length(input);
    usize domain_start = 0;
    usize at_count = 0, first_at = 0, second_at = total;
    for (usize i = 0; i < total; i++) {
        if (mal_string_code_unit_at(input, i) != '@') continue;
        if (at_count == 0) first_at = i;
        else if (at_count == 1) second_at = i;
        at_count++;
    }
    c16 *units = nullptr;
    usize length = 0, capacity = 0;
    bool ok = true;
    usize domain_end = total;
    if (at_count > 0) {
        // split('@') keeps parts[0] + '@' and maps parts[1]; later parts are dropped.
        ok = puny_append_units(vm, &units, &length, &capacity, input, 0, first_at + 1);
        domain_start = first_at + 1;
        domain_end = second_at;
    }
    for (usize label = domain_start; ok && label <= domain_end;) {
        usize label_end = label;
        while (label_end < domain_end && !puny_is_separator(mal_string_code_unit_at(input, label_end))) label_end++;
        bool convert = false;
        if (to_ascii) {
            for (usize i = label; i < label_end && !convert; i++) convert = mal_string_code_unit_at(input, i) >= 0x80;
        } else {
            convert = label_end - label >= 4 && mal_string_code_unit_at(input, label) == 'x'
                && mal_string_code_unit_at(input, label + 1) == 'n' && mal_string_code_unit_at(input, label + 2) == '-'
                && mal_string_code_unit_at(input, label + 3) == '-';
        }
        if (!convert) {
            ok = puny_append_units(vm, &units, &length, &capacity, input, label, label_end);
        } else if (to_ascii) {
            PunyCodePoints points = {0};
            puny_ucs2_decode(input, label, label_end, &points, &ok);
            static const c16 prefix[] = {'x', 'n', '-', '-'};
            for (usize i = 0; ok && i < countof(prefix); i++) {
                PunyCodePoints one = {.items = (u32[]) {prefix[i]}, .length = 1, .capacity = 1};
                ok = puny_append_utf16(vm, &units, &length, &capacity, &one);
            }
            ok = ok && puny_encode_points(vm, &points, &units, &length, &capacity);
            free(points.items);
        } else {
            PunyCodePoints points = {0};
            ok = puny_decode_range(vm, input, label + 4, label_end, true, &points)
                && puny_append_utf16(vm, &units, &length, &capacity, &points);
            free(points.items);
        }
        if (label_end >= domain_end) break;
        if (ok) {
            PunyCodePoints dot = {.items = (u32[]) {'.'}, .length = 1, .capacity = 1};
            ok = puny_append_utf16(vm, &units, &length, &capacity, &dot);
        }
        label = label_end + 1;
    }
    mal_gc_unroot(&root);
    if (!ok) {
        free(units);
        return mal_value_new_undefined();
    }
    return puny_string(vm, units, length);
}

static MalValue puny_to_ascii(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver, (void) nt, (void) callee;
    return puny_map_domain(vm, args, argc, true);
}

static MalValue puny_to_unicode(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver, (void) nt, (void) callee;
    return puny_map_domain(vm, args, argc, false);
}

static MalValue puny_ucs2_decode_fn(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver, (void) nt, (void) callee;
    MalString *input = puny_argument(vm, args, argc);
    if (input == nullptr) return mal_value_new_undefined();
    PunyCodePoints points = {0};
    bool ok = true;
    puny_ucs2_decode(input, 0, mal_string_length(input), &points, &ok);
    if (!ok) {
        free(points.items);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, 0);
    for (usize i = 0; i < points.length; i++) {
        mal_array_object_store(array, mal_key_index((u32) i), mal_value_from_u32(points.items[i]));
    }
    free(points.items);
    return mal_value_from_array_object(array);
}

/* ucs2.encode is String.fromCodePoint(...codePoints). */
static MalValue puny_ucs2_encode_fn(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver, (void) nt, (void) callee;
    MalValue list = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue from_code_point = legacy_get(vm, vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], "fromCodePoint");
    MalValue apply_args[] = {mal_value_new_undefined(), list};
    MalValue apply = legacy_get(vm, from_code_point, "apply");
    if (!mal_value_is_callable(apply)) return mal_value_new_undefined();
    MalCompletion completion = mal_vm_call_value(vm, apply, from_code_point, apply_args, 2);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }
    return completion.value;
}

void mal_host_install_node_punycode(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:punycode", slots, count)) return;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *module = mal_value_to_object(roots[0]);
    mal_intrinsic_define_data(vm, module, (const byte *) "version",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "2.1.0")), LEGACY_VISIBLE);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]), (const byte *) "decode", 1, puny_ucs2_decode_fn);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]), (const byte *) "encode", 1, puny_ucs2_encode_fn);
    mal_intrinsic_define_data(vm, module, (const byte *) "ucs2", roots[1], LEGACY_VISIBLE);
    static const struct {
        const char *name;
        MalNativeFunctionCallback callback;
    } functions[] = {
        {"decode", puny_decode}, {"encode", puny_encode},
        {"toASCII", puny_to_ascii}, {"toUnicode", puny_to_unicode},
    };
    for (usize i = 0; i < countof(functions); i++) {
        MalValue function = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) functions[i].name), 1, functions[i].callback));
        MalRootSpan function_root;
        mal_gc_root(&function_root, &function, 1);
        mal_intrinsic_define_data(vm, module, (const byte *) functions[i].name, function, LEGACY_VISIBLE);
        mal_gc_unroot(&function_root);
    }
    mal_node_module_publish(vm, "node:punycode", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
