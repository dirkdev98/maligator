#include "node_url.h"

#if MAL_NODE

#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "ascii.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "u16_buffer.h"
#include "utf8.h"
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

static void url_buffer_ascii(UrlBuffer *buffer, const char *ascii) {
    mal_u16_buffer_append_ascii(buffer, (const byte *) ascii);
}

static void url_append_file_path(UrlBuffer *buffer, const c16 *units, usize length) {
    for (usize i = 0; i < length; i++) {
        switch (units[i]) {
            case '%':
                url_buffer_ascii(buffer, "%25");
                break;
            case '#':
                url_buffer_ascii(buffer, "%23");
                break;
            case '?':
                url_buffer_ascii(buffer, "%3F");
                break;
            default:
                url_buffer_char(buffer, units[i]);
                break;
        }
    }
}

static MalValue url_path_to_file_url(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The path argument must be a string");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(
            vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "pathToFileURL requires URL support");
        return mal_value_new_undefined();
    }

    MalString *path = mal_value_to_string(args[0]);
    const c16 *path_units = mal_string_code_units(path);
    usize path_length = mal_string_length(path);
    bool absolute = path_length > 0 && path_units[0] == '/';
    UrlBuffer buffer = {0};
    url_buffer_ascii(&buffer, "file://");
    if (!absolute) {
        char *cwd = getcwd(nullptr, 0);
        if (cwd == nullptr) {
            mal_u16_buffer_dispose(&buffer);
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "Could not resolve the current working directory");
            return mal_value_new_undefined();
        }
        MalString *cwd_string = mal_string_from_utf8(
            &vm->heap, (const byte *) cwd, strlen(cwd));
        free(cwd);
        if (cwd_string == nullptr) {
            mal_u16_buffer_dispose(&buffer);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        url_append_file_path(&buffer, mal_string_code_units(cwd_string),
            mal_string_length(cwd_string));
        url_buffer_char(&buffer, '/');
    }
    url_append_file_path(&buffer, path_units, path_length);
    if (buffer.status != MAL_U16_BUFFER_OK) {
        mal_u16_buffer_dispose(&buffer);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue source = mal_value_from_string(
        mal_u16_buffer_finish(&vm->heap, &buffer));
    MalRootSpan root;
    mal_gc_root(&root, &source, 1);
    MalCompletion completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR], &source, 1);
    mal_gc_unroot(&root);
    return completion.value;
}

static i32 url_hex_value(byte unit) {
    if (unit >= '0' && unit <= '9') return unit - '0';
    if (unit >= 'a' && unit <= 'f') return unit - 'a' + 10;
    if (unit >= 'A' && unit <= 'F') return unit - 'A' + 10;
    return -1;
}

static bool url_file_path_error(
    MalVm *vm, bool silent, MalIntrinsic intrinsic, const char *message) {
    if (!silent) mal_vm_throw_error(vm, intrinsic, message);
    return false;
}

bool mal_node_file_url_to_path_bytes(
    MalVm *vm, MalValue value, bool silent, char **out, usize *out_length) {
    *out = nullptr;
    *out_length = 0;
    if (!mal_value_is_url_object(value)) {
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The path argument must be a string or URL");
    }

    MalValue roots[] = {
        value,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    static const char *names[] = {"protocol", "hostname", "pathname"};
    for (usize i = 0; i < countof(names); i++) {
        if (!mal_vm_get_property(vm, roots[0],
                mal_intrinsic_string_key(vm, (const byte *) names[i]), &roots[i + 1])) {
            mal_gc_unroot(&root);
            return false;
        }
    }
    if (!mal_value_is_string(roots[1]) ||
        !mal_string_equals_ascii_ci(mal_value_to_string(roots[1]), "file:")) {
        mal_gc_unroot(&root);
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The URL must use the file: scheme");
    }
    if (!mal_value_is_string(roots[2]) ||
        (mal_string_length(mal_value_to_string(roots[2])) != 0 &&
            !mal_string_equals_ascii_ci(mal_value_to_string(roots[2]), "localhost"))) {
        mal_gc_unroot(&root);
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "File URL host must be empty or localhost");
    }
    if (!mal_value_is_string(roots[3])) {
        mal_gc_unroot(&root);
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "File URL pathname must be a string");
    }

    usize encoded_length;
    byte *encoded = mal_string_to_utf8(
        mal_value_to_string(roots[3]), &encoded_length);
    if (encoded == nullptr) {
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    byte *decoded = malloc(encoded_length + 1);
    if (decoded == nullptr) {
        free(encoded);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize decoded_length = 0;
    for (usize i = 0; i < encoded_length; i++) {
        if (encoded[i] != '%') {
            decoded[decoded_length++] = encoded[i];
            continue;
        }
        if (i + 2 >= encoded_length) {
            free(decoded);
            free(encoded);
            mal_gc_unroot(&root);
            return url_file_path_error(
                vm, silent, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
        }
        i32 high = url_hex_value(encoded[i + 1]);
        i32 low = url_hex_value(encoded[i + 2]);
        if (high < 0 || low < 0 || (high * 16 + low) == '/') {
            free(decoded);
            free(encoded);
            mal_gc_unroot(&root);
            return url_file_path_error(vm, silent,
                (high < 0 || low < 0) ? MAL_INTRINSIC_URI_ERROR_PROTOTYPE
                                      : MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (high < 0 || low < 0) ? "URI malformed"
                                      : "File URL path must not include encoded / characters");
        }
        decoded[decoded_length++] = (byte) (high * 16 + low);
        i += 2;
    }
    free(encoded);

    usize code_unit_count;
    bool malformed;
    c16 *code_units = mal_utf8_decode_report(
        decoded, decoded_length, &code_unit_count, &malformed);
    if (code_units == nullptr) {
        free(decoded);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    free(code_units);
    if (malformed) {
        free(decoded);
        mal_gc_unroot(&root);
        return url_file_path_error(
            vm, silent, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
    }
    decoded[decoded_length] = '\0';
    *out = (char *) decoded;
    *out_length = decoded_length;
    mal_gc_unroot(&root);
    return true;
}

static MalValue url_file_url_to_path(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || (!mal_value_is_string(args[0]) &&
            !mal_value_is_url_object(args[0]))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The path argument must be a string or URL");
        return mal_value_new_undefined();
    }
    MalValue source = args[0];
    MalRootSpan root;
    mal_gc_root(&root, &source, 1);
    if (mal_value_is_string(source)) {
        MalCompletion completion = mal_vm_construct_value(
            vm, vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR], &source, 1);
        if (completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        source = completion.value;
    }
    char *decoded;
    usize decoded_length;
    if (!mal_node_file_url_to_path_bytes(
            vm, source, false, &decoded, &decoded_length)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalString *result_string = mal_string_from_utf8(
        &vm->heap, (const byte *) decoded, decoded_length);
    free(decoded);
    mal_gc_unroot(&root);
    if (result_string == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE,
            "URI malformed");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(result_string);
}

static MalValue url_to_http_options_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Converting URL objects to HTTP options is not supported by this host");
    return mal_value_new_undefined();
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
            mal_value_new_undefined(),
            mal_value_new_undefined(),
			mal_value_new_undefined(), mal_value_new_undefined(),
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
        roots[5] = mal_intrinsic_define_method_n(
            vm, mal_value_to_object(roots[0]), (const byte *) "pathToFileURL", 1,
            url_path_to_file_url);
        roots[6] = mal_intrinsic_define_method_n(
            vm, mal_value_to_object(roots[0]), (const byte *) "fileURLToPath", 1,
            url_file_url_to_path);
		roots[7] = vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR];
		roots[8] = mal_intrinsic_define_method_n(
			vm, mal_value_to_object(roots[0]), (const byte *) "urlToHttpOptions", 1,
			url_to_http_options_unavailable);
        static const char *names[] = {
			"Url", "parse", "format", "pathToFileURL", "fileURLToPath", "URL",
			"urlToHttpOptions",
        };
		MalValue values[] = {
			roots[2], roots[3], roots[4], roots[5], roots[6], roots[7], roots[8],
		};
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
