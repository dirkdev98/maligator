#include "node_querystring.h"

#if MAL_NODE

#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "web_text_encoding.h"
#include "vm_ops.h"

#define QS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static i32 qs_hex(byte value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

static MalValue qs_decode(MalVm *vm, MalString *source, usize start, usize length) {
    const c16 *units = mal_string_code_units(source) + start;
    usize utf8_length;
    byte *utf8 = mal_utf8_encode(units, length, &utf8_length);
    byte *decoded = malloc(utf8_length == 0 ? 1 : utf8_length);
    usize output = 0;
    for (usize i = 0; i < utf8_length; i++) {
        if (utf8[i] == '+') {
            decoded[output++] = ' ';
        } else if (utf8[i] == '%' && i + 2 < utf8_length) {
            i32 high = qs_hex(utf8[i + 1]);
            i32 low = qs_hex(utf8[i + 2]);
            if (high >= 0 && low >= 0) {
                decoded[output++] = (byte) ((high << 4) | low);
                i += 2;
            } else {
                decoded[output++] = utf8[i];
            }
        } else {
            decoded[output++] = utf8[i];
        }
    }
    free(utf8);
    usize unit_count;
    c16 *decoded_units = mal_utf8_decode(decoded, output, &unit_count);
    free(decoded);
    MalValue value = mal_value_from_string(
        mal_string_new_copy(&vm->heap, decoded_units, unit_count));
    free(decoded_units);
    return value;
}

static MalValue qs_parse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_gc_unroot(&root);
        return roots[0];
    }
    roots[3] = args[0];
    MalString *source = mal_value_to_string(roots[3]);
    const c16 *units = mal_string_code_units(source);
    usize length = mal_string_length(source);
    if (length == 0) {
        MalValue result = roots[0];
        mal_gc_unroot(&root);
        return result;
    }
    usize start = 0;
    i32 pairs = 0;
    while (start <= length && pairs < 1000) {
        usize end = start;
        while (end < length && units[end] != '&') end++;
        usize equal = start;
        while (equal < end && units[equal] != '=') equal++;
        roots[1] = qs_decode(vm, source, start, equal - start);
        roots[2] = qs_decode(vm, source, equal < end ? equal + 1 : end,
                             end - (equal < end ? equal + 1 : end));
        MalKey key = {.kind = MAL_KEY_STRING, .value = roots[1]};
        MalPropertyLookup prior = mal_object_get_own(mal_value_to_object(roots[0]), key);
        if (!prior.present) {
            MalPropertyDesc desc = {.flags = QS_VISIBLE, .value = roots[2]};
            mal_object_define_own(mal_value_to_object(roots[0]), key, &desc);
        } else if (mal_value_is_array_object(prior.desc.value)) {
            MalArrayObject *array = mal_value_to_array_object(prior.desc.value);
            mal_array_object_store(array,
                (MalKey) {.kind = MAL_KEY_INDEX,
                          .value = mal_value_from_i32((i32) mal_array_object_length(array))},
                roots[2]);
        } else {
            MalArrayObject *array = mal_intrinsic_new_dense_array(vm, 2);
            MalValue array_value = mal_value_from_array_object(array);
            mal_array_object_store(array,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)},
                prior.desc.value);
            mal_array_object_store(array,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, roots[2]);
            MalPropertyDesc desc = {.flags = QS_VISIBLE, .value = array_value};
            mal_object_define_own(mal_value_to_object(roots[0]), key, &desc);
        }
        pairs++;
        if (end == length) break;
        start = end + 1;
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static void qs_publish(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
        } else {
            MalPropertyLookup found = mal_object_get_own(
                mal_value_to_object(module),
                mal_intrinsic_string_key(vm, (const byte *) slots[i].name));
            if (found.present) vm->globals[slots[i].slot] = found.desc.value;
        }
    }
}

void mal_host_install_node_querystring(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_QUERYSTRING_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        MalValue parse = mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "parse", 1, qs_parse);
        mal_intrinsic_define_data(vm, mal_value_to_object(module),
                                  (const byte *) "parse", parse, QS_VISIBLE);
        vm->intrinsics[MAL_INTRINSIC_NODE_QUERYSTRING_MODULE] = module;
        mal_gc_unroot(&root);
    }
    qs_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
