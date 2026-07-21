#include "node_url.h"

#if MAL_NODE

#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "u16_buffer.h"
#include "vm_ops.h"

#define URL_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define URL_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

typedef MalU16Buffer UrlBuffer;

static void url_buffer_append(UrlBuffer *buffer, const c16 *units, usize length) {
    mal_u16_buffer_append_units(buffer, units, length);
}

static void url_buffer_char(UrlBuffer *buffer, c16 unit) {
    mal_u16_buffer_push(buffer, unit);
}

static MalValue url_slice(MalVm *vm, MalString *source, usize start, usize end) {
    return mal_value_from_string(mal_string_new_slice(
        &vm->heap, source, start, end - start));
}

static void url_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, mal_value_to_object(object),
                              (const byte *) name, value, URL_VISIBLE);
}

static void url_initialize(MalVm *vm, MalValue object) {
    static const char *names[] = {
        "protocol", "slashes", "auth", "host", "port", "hostname", "hash",
        "search", "query", "pathname", "path", "href",
    };
    for (usize i = 0; i < countof(names); i++) {
        url_set(vm, object, names[i], mal_value_new_null());
    }
}

static MalValue url_new_instance(MalVm *vm, MalValue prototype) {
    MalObject *parent = mal_value_is_object(prototype)
        ? mal_value_to_object(prototype)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue object = mal_value_from_object(mal_object_new(&vm->heap, parent));
    MalRootSpan root;
    mal_gc_root(&root, &object, 1);
    url_initialize(vm, object);
    mal_gc_unroot(&root);
    return object;
}

static MalValue url_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    if (mal_value_is_undefined(new_target) && mal_value_is_object(receiver)) {
        url_initialize(vm, receiver);
        return receiver;
    }
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    return url_new_instance(vm, mal_vm_function_prototype(vm, target));
}

static bool url_protocol_char(c16 unit, bool first) {
    if ((unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z')) return true;
    return !first && ((unit >= '0' && unit <= '9') || unit == '+' || unit == '-' || unit == '.');
}

static MalValue url_parse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"url\" argument must be of type string.");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        args[0], url_new_instance(vm, vm->intrinsics[MAL_INTRINSIC_NODE_URL_PROTOTYPE]),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalString *source = mal_value_to_string(roots[0]);
    const c16 *units = mal_string_code_units(source);
    usize length = mal_string_length(source);
    usize start = 0;
    while (start < length && (units[start] == ' ' || units[start] == '\t' ||
                              units[start] == '\n' || units[start] == '\r')) start++;
    while (length > start && (units[length - 1] == ' ' || units[length - 1] == '\t' ||
                              units[length - 1] == '\n' || units[length - 1] == '\r')) length--;
    usize cursor = start;
    usize colon = cursor;
    while (colon < length && units[colon] != ':' && url_protocol_char(units[colon], colon == cursor)) colon++;
    bool protocol = colon < length && units[colon] == ':' && colon > cursor;
    if (protocol) {
        roots[2] = url_slice(vm, source, cursor, colon + 1);
        url_set(vm, roots[1], "protocol", roots[2]);
        cursor = colon + 1;
    }
    bool slashes = cursor + 1 < length && units[cursor] == '/' && units[cursor + 1] == '/'
        && (protocol || (argc > 2 && mal_value_is_truthy(args[2])));
    if (slashes) {
        url_set(vm, roots[1], "slashes", mal_value_new_boolean(true));
        cursor += 2;
        usize authority_end = cursor;
        while (authority_end < length && units[authority_end] != '/' &&
               units[authority_end] != '?' && units[authority_end] != '#') authority_end++;
        usize host_start = cursor;
        for (usize i = cursor; i < authority_end; i++) {
            if (units[i] == '@') {
                roots[2] = url_slice(vm, source, cursor, i);
                url_set(vm, roots[1], "auth", roots[2]);
                host_start = i + 1;
            }
        }
        roots[2] = url_slice(vm, source, host_start, authority_end);
        url_set(vm, roots[1], "host", roots[2]);
        usize hostname_end = authority_end;
        usize port_start = authority_end;
        if (host_start < authority_end && units[host_start] == '[') {
            for (usize i = host_start + 1; i < authority_end; i++) {
                if (units[i] == ']') {
                    hostname_end = i + 1;
                    if (i + 1 < authority_end && units[i + 1] == ':') port_start = i + 2;
                    break;
                }
            }
        } else {
            for (usize i = authority_end; i > host_start; i--) {
                if (units[i - 1] == ':') {
                    hostname_end = i - 1;
                    port_start = i;
                    break;
                }
            }
        }
        roots[2] = url_slice(vm, source, host_start, hostname_end);
        url_set(vm, roots[1], "hostname", roots[2]);
        if (port_start < authority_end) {
            roots[2] = url_slice(vm, source, port_start, authority_end);
            url_set(vm, roots[1], "port", roots[2]);
        }
        cursor = authority_end;
    }
    usize hash = cursor;
    while (hash < length && units[hash] != '#') hash++;
    usize query = cursor;
    while (query < hash && units[query] != '?') query++;
    if (query > cursor) {
        roots[2] = url_slice(vm, source, cursor, query);
        url_set(vm, roots[1], "pathname", roots[2]);
    } else if (slashes && cursor == length) {
        roots[2] = url_slice(vm, source, cursor, cursor);
        url_set(vm, roots[1], "pathname", roots[2]);
    }
    if (query < hash) {
        roots[2] = url_slice(vm, source, query, hash);
        url_set(vm, roots[1], "search", roots[2]);
        roots[3] = url_slice(vm, source, query + 1, hash);
        url_set(vm, roots[1], "query", roots[3]);
    }
    if (hash < length) {
        roots[2] = url_slice(vm, source, hash, length);
        url_set(vm, roots[1], "hash", roots[2]);
    }
    if (cursor < hash) {
        roots[2] = url_slice(vm, source, cursor, hash);
        url_set(vm, roots[1], "path", roots[2]);
    }
    roots[2] = url_slice(vm, source, start, length);
    url_set(vm, roots[1], "href", roots[2]);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static bool url_get_string(MalVm *vm, MalValue object, const char *name, MalString **out) {
    MalValue value;
    if (!mal_vm_get_property(vm, object,
            mal_intrinsic_string_key(vm, (const byte *) name), &value)) return false;
    if (mal_value_is_null(value) || mal_value_is_undefined(value)) return true;
    if (!mal_vm_to_string(vm, value, out)) return false;
    return true;
}

static void url_append_property(
    MalVm *vm, MalValue object, const char *name, UrlBuffer *buffer) {
    MalString *string = nullptr;
    if (!url_get_string(vm, object, name, &string) || string == nullptr) return;
    url_buffer_append(buffer, mal_string_code_units(string), mal_string_length(string));
}

static MalValue url_format(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"urlObject\" argument must be of type object.");
        return mal_value_new_undefined();
    }
    MalValue object = args[0];
    UrlBuffer buffer = {0};
    url_append_property(vm, object, "protocol", &buffer);
    MalValue slashes;
    bool has_slashes = mal_vm_get_property(vm, object,
        mal_intrinsic_string_key(vm, (const byte *) "slashes"), &slashes) &&
        mal_value_is_truthy(slashes);
    MalString *host = nullptr;
    url_get_string(vm, object, "host", &host);
    if (has_slashes || host != nullptr) {
        url_buffer_char(&buffer, '/');
        url_buffer_char(&buffer, '/');
    }
    if (host != nullptr) {
        url_buffer_append(&buffer, mal_string_code_units(host), mal_string_length(host));
    } else {
        url_append_property(vm, object, "hostname", &buffer);
        MalString *port = nullptr;
        url_get_string(vm, object, "port", &port);
        if (port != nullptr && mal_string_length(port) != 0) {
            url_buffer_char(&buffer, ':');
            url_buffer_append(&buffer, mal_string_code_units(port), mal_string_length(port));
        }
    }
    url_append_property(vm, object, "pathname", &buffer);
    MalString *search = nullptr;
    url_get_string(vm, object, "search", &search);
    if (search != nullptr && mal_string_length(search) != 0) {
        if (mal_string_code_units(search)[0] != '?') url_buffer_char(&buffer, '?');
        url_buffer_append(&buffer, mal_string_code_units(search), mal_string_length(search));
    }
    MalString *hash = nullptr;
    url_get_string(vm, object, "hash", &hash);
    if (hash != nullptr && mal_string_length(hash) != 0) {
        if (mal_string_code_units(hash)[0] != '#') url_buffer_char(&buffer, '#');
        url_buffer_append(&buffer, mal_string_code_units(hash), mal_string_length(hash));
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_u16_buffer_dispose(&buffer);
        return mal_value_new_undefined();
    }
    if (buffer.status != MAL_U16_BUFFER_OK) {
        MalU16BufferStatus status = buffer.status;
        mal_u16_buffer_dispose(&buffer);
        if (status == MAL_U16_BUFFER_LENGTH_OVERFLOW) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        } else {
            mal_vm_throw_allocation_error(vm);
        }
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_u16_buffer_finish(&vm->heap, &buffer));
}

void mal_host_install_node_url(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_URL_MODULE];
    if (mal_value_is_undefined(module)) {
        MalValue roots[] = {
            mal_value_from_object(mal_intrinsic_new_object(vm)),
            mal_value_from_object(mal_object_new(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]))),
            mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "Url"), 0, url_constructor);
        mal_native_function_object_set_constructor(constructor);
        roots[2] = mal_value_from_native_function_object(constructor);
        mal_intrinsic_define_data(vm, (MalObject *) constructor,
                                  (const byte *) "prototype", roots[1], MAL_PROPERTY_WRITABLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]),
                                  (const byte *) "constructor", roots[2], URL_METHOD);
        roots[3] = mal_intrinsic_define_method_n(
            vm, mal_value_to_object(roots[0]), (const byte *) "parse", 3, url_parse);
        roots[4] = mal_intrinsic_define_method_n(
            vm, mal_value_to_object(roots[0]), (const byte *) "format", 1, url_format);
        static const char *names[] = {"Url", "parse", "format"};
        MalValue values[] = {roots[2], roots[3], roots[4]};
        for (usize i = 0; i < countof(names); i++) {
            mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                                      (const byte *) names[i], values[i], URL_VISIBLE);
        }
        vm->intrinsics[MAL_INTRINSIC_NODE_URL_CONSTRUCTOR] = roots[2];
        vm->intrinsics[MAL_INTRINSIC_NODE_URL_PROTOTYPE] = roots[1];
        vm->intrinsics[MAL_INTRINSIC_NODE_URL_MODULE] = roots[0];
        module = roots[0];
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
