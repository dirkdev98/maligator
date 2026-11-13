#include "node_net_blocklist.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object_ops.h"
#include "value_ops.h"
#include "vm_ops.h"

#define BLOCKLIST_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue blocklist_field(MalValue array, u32 index) {
    MalValue value = mal_value_new_undefined();
    (void) mal_array_object_dense_get(mal_value_to_array_object(array), index, &value);
    return value;
}

static MalValue blocklist_records(MalValue receiver, MalValue callee) {
    if (!mal_value_is_object(receiver)) return mal_value_new_undefined();
    MalValue brand = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    for (MalObject *object = mal_value_to_object(receiver); object != nullptr;
         object = mal_object_get_prototype(object)) {
        MalPropertyLookup found = mal_object_get_own(object, mal_key_from_value(brand));
        if (found.present) return mal_value_is_array_object(found.desc.value)
            ? found.desc.value : mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static bool blocklist_type(MalVm *vm, MalValue value, bool checking, int *family) {
    *family = AF_INET;
    if (mal_value_is_undefined(value)) return true;
    if (!mal_value_is_string(value)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The type argument must be a string", "ERR_INVALID_ARG_TYPE");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    if (mal_string_length(string) == 4) {
        const c16 *units = mal_string_code_units(string);
        if ((units[0] == 'i' || units[0] == 'I') && (units[1] == 'p' || units[1] == 'P')
            && (units[2] == 'v' || units[2] == 'V') && (units[3] == '4' || units[3] == '6')) {
            *family = units[3] == '4' ? AF_INET : AF_INET6;
            return true;
        }
    }
    if (!checking) mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "The type argument must be ipv4 or ipv6", "ERR_INVALID_ARG_VALUE");
    return false;
}

static bool blocklist_address(MalVm *vm, MalValue value, int family, bool checking, u8 out[16]) {
    if (!mal_value_is_string(value)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The address argument must be a string", "ERR_INVALID_ARG_TYPE");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    char text[INET6_ADDRSTRLEN];
    usize used = 0;
    bool valid = length > 0;
    for (usize i = 0; valid && i < length; i++) {
        if (family == AF_INET6 && units[i] == '%') {
            valid = i + 1 < length;
            for (usize zone = i + 1; valid && zone < length; zone++) {
                c16 c = units[zone];
                valid = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')
                    || (c >= 'A' && c <= 'Z') || c == '-' || c == '.' || c == ':';
            }
            break;
        }
        if (used + 1 >= sizeof(text) || units[i] == 0 || units[i] > 127) valid = false;
        else text[used++] = (char) units[i];
    }
    text[used] = '\0';
    memset(out, 0, 16);
    // A common mapped-address space lets IPv6 rules also match IPv4 peers.
    if (family == AF_INET) out[10] = out[11] = 255;
    valid = valid && used > 0 && inet_pton(family, text, out + (family == AF_INET ? 12 : 0)) == 1;
    if (!valid && !checking) mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Invalid socket address", "ERR_INVALID_ADDRESS");
    return valid;
}

static MalValue blocklist_constructor(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "BlockList requires new");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype;
    if (mal_vm_get_prototype_from_constructor(vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        roots[1] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
        roots[2] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
        MalPropertyDesc descriptor = {.value = roots[2], .flags = MAL_PROPERTY_NONE};
        mal_object_define_own(mal_value_to_object(roots[1]), mal_key_from_value(roots[0]), &descriptor);
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue blocklist_add(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    i32 kind = mal_value_to_i32(mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1));
    MalValue roots[] = {blocklist_records(receiver, callee),
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > (kind == 0 ? 1 : 2) ? args[kind == 0 ? 1 : 2] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_undefined(roots[0])) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid BlockList receiver", "ERR_INVALID_THIS");
        goto done;
    }
    int family;
    u8 first[16], last[16];
    if (!blocklist_type(vm, roots[3], false, &family)
        || !blocklist_address(vm, roots[1], family, false, first)) goto done;
    char address[INET6_ADDRSTRLEN], end[INET6_ADDRSTRLEN], label[2 * INET6_ADDRSTRLEN + 40];
    (void) inet_ntop(family, first + (family == AF_INET ? 12 : 0), address, sizeof(address));
    memcpy(last, first, 16);
    int prefix = family == AF_INET ? 32 : 128;
    if (kind == 1) {
        if (!blocklist_address(vm, roots[2], family, false, last)) goto done;
        if (memcmp(first, last, 16) > 0) {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The start address must come before end", "ERR_INVALID_ARG_VALUE");
            goto done;
        }
        (void) inet_ntop(family, last + (family == AF_INET ? 12 : 0), end, sizeof(end));
        snprintf(label, sizeof(label), "Range: IPv%d %s-%s", family == AF_INET ? 4 : 6, address, end);
    } else if (kind == 2) {
        if (!mal_ops_is_number(roots[2])) {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The prefix argument must be a number", "ERR_INVALID_ARG_TYPE");
            goto done;
        }
        f64 number = mal_ops_number_as_f64(roots[2]);
        if (!isfinite(number) || floor(number) != number || number < 0 || number > prefix) {
            mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "The prefix argument is out of range", "ERR_OUT_OF_RANGE");
            goto done;
        }
        prefix = (int) number;
        int bits = prefix + (family == AF_INET ? 96 : 0);
        for (int i = 0; i < 16; i++) {
            int remaining = bits - i * 8;
            u8 mask = remaining >= 8 ? 255 : remaining <= 0 ? 0 : (u8) (255 << (8 - remaining));
            first[i] &= mask;
            last[i] |= (u8) ~mask;
        }
        snprintf(label, sizeof(label), "Subnet: IPv%d %s/%d", family == AF_INET ? 4 : 6, address, prefix);
    } else snprintf(label, sizeof(label), "Address: IPv%d %s", family == AF_INET ? 4 : 6, address);
    roots[4] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) label));
    for (u32 i = 0; i < mal_array_object_length(mal_value_to_array_object(roots[0])); i++) {
        MalValue entry = blocklist_field(roots[0], i);
        if (mal_string_equals(mal_value_to_string(blocklist_field(entry, 2)), mal_value_to_string(roots[4]))) goto done;
    }
    roots[5] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, first, 16));
    roots[6] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, last, 16));
    roots[7] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalValue fields[] = {roots[5], roots[6], roots[4]};
    MalRootSpan fields_root;
    mal_gc_root(&fields_root, fields, countof(fields));
    bool built = mal_array_object_dense_build_values(mal_value_to_array_object(roots[7]), 0, fields, countof(fields));
    mal_gc_unroot(&fields_root);
    if (!built) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    MalArrayObject *records = mal_value_to_array_object(roots[0]);
    if (!mal_array_object_dense_build_values(records, mal_array_object_length(records), roots + 7, 1))
        mal_vm_throw_allocation_error(vm);
done:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static int blocklist_compare(const u8 address[16], MalValue encoded) {
    const c16 *units = mal_string_code_units(mal_value_to_string(encoded));
    for (usize i = 0; i < 16; i++) if (address[i] != units[i]) return address[i] < units[i] ? -1 : 1;
    return 0;
}

static MalValue blocklist_check(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalValue records = blocklist_records(receiver, callee);
    if (mal_value_is_undefined(records)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid BlockList receiver", "ERR_INVALID_THIS");
        return mal_value_new_undefined();
    }
    int family;
    u8 address[16];
    if (!blocklist_type(vm, argc > 1 ? args[1] : mal_value_new_undefined(), true, &family)
        || !blocklist_address(vm, argc > 0 ? args[0] : mal_value_new_undefined(), family, true, address))
        return mal_value_new_boolean(false);
    for (u32 i = 0; i < mal_array_object_length(mal_value_to_array_object(records)); i++) {
        MalValue entry = blocklist_field(records, i);
        if (blocklist_compare(address, blocklist_field(entry, 0)) >= 0
            && blocklist_compare(address, blocklist_field(entry, 1)) <= 0) return mal_value_new_boolean(true);
    }
    return mal_value_new_boolean(false);
}

static MalValue blocklist_rules(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target;
    MalValue roots[] = {blocklist_records(receiver, callee), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_undefined(roots[0])) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid BlockList receiver", "ERR_INVALID_THIS");
    } else {
        roots[1] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
        for (u32 i = 0; i < mal_array_object_length(mal_value_to_array_object(roots[0])); i++) {
            roots[2] = blocklist_field(blocklist_field(roots[0], i), 2);
            if (!mal_array_object_dense_build_values(mal_value_to_array_object(roots[1]), i, roots + 2, 1)) {
                mal_vm_throw_allocation_error(vm);
                break;
            }
        }
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue blocklist_is_blocklist(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) receiver; (void) new_target;
    return mal_value_new_boolean(!mal_value_is_undefined(
        blocklist_records(argc > 0 ? args[0] : mal_value_new_undefined(), callee)));
}

static MalValue blocklist_function(MalVm *vm, const char *name, i32 arity,
    MalNativeFunctionCallback callback, MalValue brand, i32 kind) {
    MalValue slots[] = {brand, mal_value_from_i32(kind)};
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), arity, callback, slots, countof(slots)));
}

void mal_node_net_blocklist_install(MalVm *vm, MalValue module) {
    MalValue roots[] = {module, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = blocklist_function(vm, "BlockList", 0, blocklist_constructor, roots[1], 0);
    MalNativeFunctionObject *constructor = mal_value_to_native_function_object(roots[3]);
    mal_native_function_object_set_constructor(constructor);
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[2], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "constructor", roots[3], BLOCKLIST_METHOD);
    static const char *names[] = {"addAddress", "addRange", "addSubnet", "check"};
    for (i32 i = 0; i < 4; i++) {
        roots[4] = blocklist_function(vm, names[i], i == 0 || i == 3 ? 1 : 2,
            i == 3 ? blocklist_check : blocklist_add, roots[1], i);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) names[i], roots[4], BLOCKLIST_METHOD);
    }
    roots[4] = blocklist_function(vm, "get rules", 0, blocklist_rules, roots[1], 0);
    MalPropertyDesc descriptor = {.flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .getter = roots[4], .setter = mal_value_new_undefined()};
    mal_object_define_own(mal_value_to_object(roots[2]), mal_intrinsic_string_key(vm, (const byte *) "rules"), &descriptor);
    roots[4] = blocklist_function(vm, "isBlockList", 1, blocklist_is_blocklist, roots[1], 0);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]), (const byte *) "isBlockList", roots[4], BLOCKLIST_METHOD);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "BlockList", roots[3],
        BLOCKLIST_METHOD | MAL_PROPERTY_ENUMERABLE);
    mal_gc_unroot(&root);
}

#endif
