// Portions derived from Node.js lib/url.js, lib/internal/querystring.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_url.h"

#if MAL_NODE

#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "ascii.h"
#include "builtin_uri.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "mal_url.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "text_buffer.h"
#include "utf8.h"
#include "vm_ops.h"

#define URL_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define URL_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

typedef MalTextBuffer UrlBuffer;

static void url_buffer_append(UrlBuffer *buffer, const c16 *units, usize length) {
    mal_text_buffer_append_units(buffer, units, length);
}

static void url_buffer_char(UrlBuffer *buffer, c16 unit) {
    mal_text_buffer_push(buffer, unit);
}

static MalValue url_slice(MalVm *vm, MalString *source, usize start, usize end) {
    return mal_value_from_string(mal_string_new_slice(
        &vm->heap, source, start, end - start));
}

static void url_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, mal_value_to_object(object),
                              (const byte *) name, value, URL_VISIBLE);
}

static const char *const url_field_names[] = {
    "protocol", "slashes", "auth", "host", "port", "hostname", "hash",
    "search", "query", "pathname", "path", "href",
};

static_assert(countof(url_field_names) <= MAL_SHAPE_MAX_INLINE_SLOTS,
              "Legacy URL fields exceed inline shape capacity");

static void url_initialize(MalVm *vm, MalValue object) {
    for (usize i = 0; i < countof(url_field_names); i++) {
        url_set(vm, object, url_field_names[i], mal_value_new_null());
    }
}

static MalShape *url_instance_shape(MalVm *vm) {
    if (vm->node_url_instance_shape == nullptr) {
        MalShape *shape = mal_shape_root(&vm->heap);
        for (usize i = 0; i < countof(url_field_names); i++) {
            shape = mal_shape_add_property(
                shape, mal_intrinsic_string_key(vm, (const byte *) url_field_names[i]),
                URL_VISIBLE);
        }
        vm->node_url_instance_shape = shape;
    }
    return vm->node_url_instance_shape;
}

static MalValue url_new_instance(MalVm *vm, MalValue prototype) {
    MalValue parent = mal_value_is_object(prototype)
        ? prototype : vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalRootSpan root;
    mal_gc_root(&root, &parent, 1);
    MalShape *shape = url_instance_shape(vm);
    MalValue values[countof(url_field_names)];
    for (usize i = 0; i < countof(values); i++) values[i] = mal_value_new_null();
    MalValue object = mal_value_from_object(mal_object_new_shaped(
        &vm->heap, mal_value_to_object(parent), shape, values, countof(values)));
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
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    return url_new_instance(vm, mal_value_from_object(prototype));
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

static MalValue url_parse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee);

static void url_buffer_ascii(UrlBuffer *buffer, const char *ascii);

/* lib/url.js noEscapeAuth: alphanumerics and ! - . _ ~ ' ( ) * : stay literal. */
static bool url_auth_literal(c16 unit) {
    return (unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z') || (unit >= '0' && unit <= '9')
        || unit == '!' || unit == '-' || unit == '.' || unit == '_' || unit == '~' || unit == '\''
        || unit == '(' || unit == ')' || unit == '*' || unit == ':';
}

static void url_percent_byte(UrlBuffer *buffer, u32 value) {
    static const char hex[] = "0123456789ABCDEF";
    url_buffer_char(buffer, '%');
    url_buffer_char(buffer, (c16) hex[(value >> 4) & 0xF]);
    url_buffer_char(buffer, (c16) hex[value & 0xF]);
}

/* lib/internal/querystring.js encodeStr with noEscapeAuth; false on a lone surrogate. */
static bool url_append_auth(UrlBuffer *buffer, MalString *auth) {
    const c16 *units = mal_string_code_units(auth);
    usize length = mal_string_length(auth);
    for (usize i = 0; i < length; i++) {
        u32 c = units[i];
        if (c < 0x80) {
            if (url_auth_literal((c16) c)) url_buffer_char(buffer, (c16) c);
            else url_percent_byte(buffer, c);
            continue;
        }
        if (c >= 0xD800 && c <= 0xDFFF) {
            if (c >= 0xDC00 || i + 1 >= length || units[i + 1] < 0xDC00 || units[i + 1] > 0xDFFF) return false;
            c = 0x10000 + ((c - 0xD800) << 10) + (units[++i] - 0xDC00);
        }
        if (c < 0x800) {
            url_percent_byte(buffer, 0xC0 | (c >> 6));
        } else if (c < 0x10000) {
            url_percent_byte(buffer, 0xE0 | (c >> 12));
            url_percent_byte(buffer, 0x80 | ((c >> 6) & 0x3F));
        } else {
            url_percent_byte(buffer, 0xF0 | (c >> 18));
            url_percent_byte(buffer, 0x80 | ((c >> 12) & 0x3F));
            url_percent_byte(buffer, 0x80 | ((c >> 6) & 0x3F));
        }
        url_percent_byte(buffer, 0x80 | (c & 0x3F));
    }
    return true;
}

static bool url_property_truthy(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), out)) return false;
    return mal_value_is_truthy(*out);
}

static void url_append_value(UrlBuffer *buffer, MalString *string) {
    if (string != nullptr) url_buffer_append(buffer, mal_string_code_units(string), mal_string_length(string));
}

static bool url_units_have(MalString *string, c16 unit) {
    if (string == nullptr) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        if (units[i] == unit) return true;
    }
    return false;
}

/* Url.prototype.format, translated from Node 26 lib/url.js. An object `query` is not
 * stringified here (querystring.stringify); `search` carries the query instead. */
static MalValue url_format(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc >= 1 && mal_value_is_string(args[0])) {
        MalValue parsed = url_parse(vm, mal_value_new_undefined(), args, 1, mal_value_new_undefined(),
            mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
        return url_format(vm, mal_value_new_undefined(), &parsed, 1, mal_value_new_undefined(),
            mal_value_new_undefined());
    }
    if (argc < 1 || !mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"urlObject\" argument must be of type object.");
        return mal_value_new_undefined();
    }
    MalValue object = args[0];
    MalValue values[8];
    for (usize i = 0; i < countof(values); i++) values[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalString *auth = nullptr, *protocol = nullptr, *pathname = nullptr, *hash = nullptr;
    MalString *host = nullptr, *hostname = nullptr, *port = nullptr, *search = nullptr;
    const char *names[] = {"auth", "protocol", "pathname", "hash", "host", "hostname", "port", "search"};
    MalString **strings[] = {&auth, &protocol, &pathname, &hash, &host, &hostname, &port, &search};
    bool slashes_value = false;
    for (usize i = 0; i < countof(names); i++) {
        if (url_property_truthy(vm, object, names[i], &values[i])) {
            if (!mal_vm_to_string(vm, values[i], strings[i])) break;
            values[i] = mal_value_from_string(*strings[i]);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
    }
    MalValue slashes = mal_value_new_undefined();
    if (vm->completion.kind != MAL_COMPLETION_THROW) slashes_value = url_property_truthy(vm, object, "slashes", &slashes);
    UrlBuffer buffer = {0};
    UrlBuffer host_buffer = {0};
    UrlBuffer path_buffer = {0};
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        if (protocol != nullptr) {
            url_append_value(&buffer, protocol);
            if (mal_string_code_units(protocol)[mal_string_length(protocol) - 1] != ':') url_buffer_char(&buffer, ':');
        }
        bool has_host = host != nullptr || hostname != nullptr;
        if (has_host && auth != nullptr) {
            if (!url_append_auth(&host_buffer, auth)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            } else {
                url_buffer_char(&host_buffer, '@');
            }
        }
        if (host != nullptr) {
            url_append_value(&host_buffer, host);
        } else if (hostname != nullptr) {
            usize length = mal_string_length(hostname);
            const c16 *units = mal_string_code_units(hostname);
            bool bracket = url_units_have(hostname, ':') && !(units[0] == '[' && units[length - 1] == ']');
            if (bracket) url_buffer_char(&host_buffer, '[');
            url_append_value(&host_buffer, hostname);
            if (bracket) url_buffer_char(&host_buffer, ']');
            if (port != nullptr) {
                url_buffer_char(&host_buffer, ':');
                url_append_value(&host_buffer, port);
            }
        }
        if (pathname != nullptr) {
            const c16 *units = mal_string_code_units(pathname);
            for (usize i = 0; i < mal_string_length(pathname); i++) {
                if (units[i] == '#') url_buffer_ascii(&path_buffer, "%23");
                else if (units[i] == '?') url_buffer_ascii(&path_buffer, "%3F");
                else url_buffer_char(&path_buffer, units[i]);
            }
        }
        // Only the slashed protocols get "//", unless the URL had them to begin with.
        bool slashed = false;
        if (protocol != nullptr) {
            static const char *const known[] = {"http:", "https:", "ftp:", "gopher:", "file:", "ws:", "wss:"};
            UrlBuffer copy = {0};
            url_append_value(&copy, protocol);
            if (mal_string_code_units(protocol)[mal_string_length(protocol) - 1] != ':') url_buffer_char(&copy, ':');
            for (usize i = 0; i < countof(known) && copy.status == MAL_TEXT_BUFFER_OK; i++) {
                usize known_length = strlen(known[i]);
                if (copy.length != known_length) continue;
                bool equal = true;
                for (usize j = 0; j < known_length && equal; j++) {
                    equal = mal_text_buffer_code_unit_at(&copy, j) == (c16) known[i][j];
                }
                slashed = slashed || equal;
            }
            mal_text_buffer_dispose(&copy);
        }
        bool has_host_text = host_buffer.length > 0;
        if (slashes_value || slashed) {
            if (slashes_value || has_host_text) {
                url_buffer_char(&buffer, '/');
                url_buffer_char(&buffer, '/');
                if (path_buffer.length > 0 && mal_text_buffer_code_unit_at(&path_buffer, 0) != '/') {
                    mal_text_buffer_append_buffer(&buffer, &host_buffer);
                    url_buffer_char(&buffer, '/');
                    mal_text_buffer_append_buffer(&buffer, &path_buffer);
                    goto appended;
                }
            } else if (protocol != nullptr && mal_string_length(protocol) >= 4
                && mal_string_code_units(protocol)[0] == 'f' && mal_string_code_units(protocol)[1] == 'i'
                && mal_string_code_units(protocol)[2] == 'l' && mal_string_code_units(protocol)[3] == 'e') {
                url_buffer_char(&buffer, '/');
                url_buffer_char(&buffer, '/');
            }
        }
        mal_text_buffer_append_buffer(&buffer, &host_buffer);
        mal_text_buffer_append_buffer(&buffer, &path_buffer);
    appended:
        if (search != nullptr) {
            if (mal_string_code_units(search)[0] != '?') url_buffer_char(&buffer, '?');
            const c16 *units = mal_string_code_units(search);
            for (usize i = 0; i < mal_string_length(search); i++) {
                if (units[i] == '#') url_buffer_ascii(&buffer, "%23");
                else url_buffer_char(&buffer, units[i]);
            }
        }
        if (hash != nullptr) {
            if (mal_string_code_units(hash)[0] != '#') url_buffer_char(&buffer, '#');
            url_append_value(&buffer, hash);
        }
    }
    mal_text_buffer_dispose(&host_buffer);
    mal_text_buffer_dispose(&path_buffer);
    mal_gc_unroot(&root);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_text_buffer_dispose(&buffer);
        return mal_value_new_undefined();
    }
    if (buffer.status != MAL_TEXT_BUFFER_OK) {
        MalTextBufferStatus status = buffer.status;
        mal_text_buffer_dispose(&buffer);
        if (status == MAL_TEXT_BUFFER_LENGTH_OVERFLOW) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        } else {
            mal_vm_throw_allocation_error(vm);
        }
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, &buffer));
}

static void url_buffer_ascii(UrlBuffer *buffer, const char *ascii) {
    mal_text_buffer_append_ascii(buffer, (const byte *) ascii);
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
            mal_text_buffer_dispose(&buffer);
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "Could not resolve the current working directory");
            return mal_value_new_undefined();
        }
        MalString *cwd_string = mal_string_from_utf8(
            &vm->heap, (const byte *) cwd, strlen(cwd));
        free(cwd);
        if (cwd_string == nullptr) {
            mal_text_buffer_dispose(&buffer);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        url_append_file_path(&buffer, mal_string_code_units(cwd_string),
            mal_string_length(cwd_string));
        url_buffer_char(&buffer, '/');
    }
    url_append_file_path(&buffer, path_units, path_length);
    if (buffer.status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(&buffer);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue source = mal_value_from_string(
        mal_text_buffer_finish(&vm->heap, &buffer));
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
    MalVm *vm, bool silent, MalIntrinsic intrinsic, const char *message, const char *code) {
    if (!silent) {
        mal_vm_throw_error(vm, intrinsic, message);
        if (code != nullptr) {
            MalValue roots[] = {vm->completion.value,
                mal_value_from_string(mal_intrinsic_ascii(vm, code))};
            MalRootSpan root;
            mal_gc_root(&root, roots, countof(roots));
            mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), "code", roots[1], URL_VISIBLE);
            mal_gc_unroot(&root);
        }
    }
    return false;
}

bool mal_node_file_url_to_path_bytes(
    MalVm *vm, MalValue value, bool silent, char **out, usize *out_length) {
    *out = nullptr;
    *out_length = 0;
    if (!mal_value_is_url_object(value)) {
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The path argument must be a string or URL", "ERR_INVALID_ARG_TYPE");
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
            "The URL must use the file: scheme", "ERR_INVALID_URL_SCHEME");
    }
    if (!mal_value_is_string(roots[2]) ||
        (mal_string_length(mal_value_to_string(roots[2])) != 0 &&
            !mal_string_equals_ascii_ci(mal_value_to_string(roots[2]), "localhost"))) {
        mal_gc_unroot(&root);
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "File URL host must be empty or localhost", "ERR_INVALID_FILE_URL_HOST");
    }
    if (!mal_value_is_string(roots[3])) {
        mal_gc_unroot(&root);
        return url_file_path_error(vm, silent, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "File URL pathname must be a string", nullptr);
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
                vm, silent, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed", nullptr);
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
                                      : "File URL path must not include encoded / characters",
                (high < 0 || low < 0) ? nullptr : "ERR_INVALID_FILE_URL_PATH");
        }
        decoded[decoded_length++] = (byte) (high * 16 + low);
        i += 2;
    }
    free(encoded);

    if (!mal_utf8_is_valid(decoded, decoded_length)) {
        free(decoded);
        mal_gc_unroot(&root);
        return url_file_path_error(
            vm, silent, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed", nullptr);
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

static MalValue url_to_http_options(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) callee;
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
            return mal_value_new_undefined();
        }
    }
    enum {INPUT, HOSTNAME, PATHNAME, PORT, USERNAME, PASSWORD, SEARCH, OPTIONS, TEMP, LEFT, RIGHT, ROOT_COUNT};
    MalValue roots[ROOT_COUNT];
    for (usize index = 0; index < countof(roots); index++) roots[index] = mal_value_new_undefined();
    roots[INPUT] = argc > 0 ? args[0] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_object(roots[INPUT])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The url argument must be of type object");
        roots[TEMP] = vm->completion.value;
        roots[LEFT] = mal_value_from_string(mal_intrinsic_ascii(vm, "ERR_INVALID_ARG_TYPE"));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[TEMP]), "code", roots[LEFT], URL_VISIBLE);
        goto failed;
    }
    static const char *captured[] = {"hostname", "pathname", "port", "username", "password", "search"};
    for (usize index = 0; index < countof(captured); index++) {
        if (!mal_vm_get_property(vm, roots[INPUT], mal_intrinsic_string_key(vm, captured[index]), &roots[HOSTNAME + index])) goto failed;
    }
    roots[OPTIONS] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_vm_op_merge_data_properties(vm, roots[OPTIONS], roots[INPUT]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    if (!mal_vm_get_property(vm, roots[INPUT], mal_intrinsic_string_key(vm, "protocol"), &roots[TEMP])) goto failed;
    url_set(vm, roots[OPTIONS], "protocol", roots[TEMP]);
    if (mal_value_is_truthy(roots[HOSTNAME])) {
        if (!mal_vm_get_property(vm, roots[HOSTNAME], mal_key_index(0), &roots[TEMP])) goto failed;
        if (mal_value_is_string(roots[TEMP]) && mal_string_equals_ascii(mal_value_to_string(roots[TEMP]), "[")) {
            MalString *hostname;
            if (!mal_vm_to_string(vm, roots[HOSTNAME], &hostname)) goto failed;
            roots[TEMP] = mal_value_from_string(hostname);
            usize length = mal_string_length(hostname);
            usize start = length > 0 ? 1 : 0;
            usize end = length > 1 ? length - 1 : start;
            roots[HOSTNAME] = url_slice(vm, hostname, start, end);
        }
    }
    url_set(vm, roots[OPTIONS], "hostname", roots[HOSTNAME]);
    if (!mal_vm_get_property(vm, roots[INPUT], mal_intrinsic_string_key(vm, "hash"), &roots[TEMP])) goto failed;
    url_set(vm, roots[OPTIONS], "hash", roots[TEMP]);
    url_set(vm, roots[OPTIONS], "search", roots[SEARCH]);
    url_set(vm, roots[OPTIONS], "pathname", roots[PATHNAME]);
    MalString *left, *right, *joined;
    if (!mal_vm_to_string(vm, mal_value_is_truthy(roots[PATHNAME]) ? roots[PATHNAME]
            : mal_value_from_string(mal_intrinsic_ascii(vm, "")), &left)) goto failed;
    roots[LEFT] = mal_value_from_string(left);
    if (!mal_vm_to_string(vm, mal_value_is_truthy(roots[SEARCH]) ? roots[SEARCH]
            : mal_value_from_string(mal_intrinsic_ascii(vm, "")), &right)) goto failed;
    roots[RIGHT] = mal_value_from_string(right);
    roots[TEMP] = mal_vm_concat_strings_known(vm, mal_value_to_string(roots[LEFT]), right);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    url_set(vm, roots[OPTIONS], "path", roots[TEMP]);
    if (!mal_vm_get_property(vm, roots[INPUT], mal_intrinsic_string_key(vm, "href"), &roots[TEMP])) goto failed;
    url_set(vm, roots[OPTIONS], "href", roots[TEMP]);
    if (!mal_value_is_string(roots[PORT]) || mal_string_length(mal_value_to_string(roots[PORT])) != 0) {
        MalCompletion completion = mal_vm_call_value(vm, vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR],
            mal_value_new_undefined(), roots + PORT, 1);
        if (completion.kind == MAL_COMPLETION_THROW) goto failed;
        roots[TEMP] = completion.value;
        url_set(vm, roots[OPTIONS], "port", roots[TEMP]);
    }
    if (mal_value_is_truthy(roots[USERNAME]) || mal_value_is_truthy(roots[PASSWORD])) {
        if (!mal_vm_to_string(vm, roots[USERNAME], &left)) goto failed;
        roots[LEFT] = mal_value_from_string(left);
        roots[LEFT] = mal_builtin_uri_decode_known(vm, left, false);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
        if (!mal_vm_to_string(vm, roots[PASSWORD], &right)) goto failed;
        roots[RIGHT] = mal_value_from_string(right);
        roots[RIGHT] = mal_builtin_uri_decode_known(vm, right, false);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
        roots[TEMP] = mal_value_from_string(mal_intrinsic_ascii(vm, ":"));
        MalString *parts[] = {mal_value_to_string(roots[LEFT]), mal_value_to_string(roots[TEMP]), mal_value_to_string(roots[RIGHT])};
        if (!mal_string_new_flat_parts_checked(&vm->heap, parts, countof(parts), &joined)) goto overflow;
        roots[TEMP] = mal_value_from_string(joined);
        url_set(vm, roots[OPTIONS], "auth", roots[TEMP]);
    }
    MalValue result = roots[OPTIONS];
    mal_gc_unroot(&root);
    return result;
 overflow:
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* url.domainToASCII / domainToUnicode: `${domain}` through the URL host parser. */
static MalValue url_domain_convert(MalVm *vm, const MalValue *args, i32 argc, bool unicode) {
    if (argc < 1) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"domain\" argument must be specified", "ERR_MISSING_ARGS");
        return mal_value_new_undefined();
    }
    MalString *domain;
    if (!mal_vm_to_string(vm, args[0], &domain)) return mal_value_new_undefined();
    usize length = mal_string_length(domain);
    c16 *units = malloc(sizeof(c16) * (length == 0 ? 1 : length));
    if (units == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    for (usize i = 0; i < length; i++) units[i] = mal_string_code_unit_at(domain, i);
    u8 stack[256];
    u8 *out = stack;
    i32 written = mal_url_domain_convert(units, length, unicode, stack, (i32) sizeof stack);
    if (written > (i32) sizeof stack) {
        out = malloc((usize) written);
        if (out == nullptr) {
            free(units);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_url_domain_convert(units, length, unicode, out, written);
    }
    free(units);
    MalString *result = mal_string_from_utf8(&vm->heap, out, written < 0 ? 0 : (usize) written);
    if (out != stack) free(out);
    if (result == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(result);
}

static MalValue url_domain_to_ascii(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return url_domain_convert(vm, args, argc, false);
}

static MalValue url_domain_to_unicode(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return url_domain_convert(vm, args, argc, true);
}

/* Url.prototype.resolveObject, translated from Node 26 lib/url.js. Path lists are
 * rooted string arrays with a fixed capacity, so their root span never moves. */
typedef struct UrlPath {
    MalValue *items;
    i32 count;
} UrlPath;

static MalValue url_get(MalVm *vm, MalValue object, const char *name) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(object)) {
        mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), &value);
    }
    return value;
}

static void url_put(MalVm *vm, MalValue object, const char *name, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_vm_set_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), value, object);
    mal_gc_unroot(&root);
}

static bool url_truthy(MalValue value) {
    return mal_value_is_truthy(value);
}

static bool url_is(MalValue value, const char *ascii) {
    return mal_value_is_string(value) && mal_string_equals_ascii(mal_value_to_string(value), ascii);
}

static bool url_slashed_protocol(MalValue protocol) {
    static const char *const names[] = {"http", "http:", "https", "https:", "ftp", "ftp:", "gopher",
        "gopher:", "file", "file:", "ws", "ws:", "wss", "wss:"};
    for (usize i = 0; i < countof(names); i++) {
        if (url_is(protocol, names[i])) return true;
    }
    return false;
}

static bool url_hostless_protocol(MalValue protocol) {
    return url_is(protocol, "javascript") || url_is(protocol, "javascript:");
}

static bool url_starts_with_slash(MalValue value) {
    return mal_value_is_string(value) && mal_string_length(mal_value_to_string(value)) > 0
        && mal_string_code_units(mal_value_to_string(value))[0] == '/';
}

static void url_path_split(MalVm *vm, UrlPath *path, MalValue value) {
    path->count = 0;
    if (!url_truthy(value) || !mal_value_is_string(value)) return;
    MalString *string = mal_value_to_string(value);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize start = 0;
    for (usize i = 0; i <= length; i++) {
        if (i == length || units[i] == '/') {
            path->items[path->count++] = url_slice(vm, mal_value_to_string(value), start, i);
            string = mal_value_to_string(value);
            units = mal_string_code_units(string);
            start = i + 1;
        }
    }
}

static usize url_segments(MalValue value) {
    if (!mal_value_is_string(value)) return 0;
    MalString *string = mal_value_to_string(value);
    const c16 *units = mal_string_code_units(string);
    usize count = 1;
    for (usize i = 0; i < mal_string_length(string); i++) count += units[i] == '/';
    return count;
}

static void url_path_unshift(UrlPath *path, MalValue value) {
    memmove(path->items + 1, path->items, (usize) path->count * sizeof(MalValue));
    path->items[0] = value;
    path->count++;
}

static MalValue url_path_shift(UrlPath *path) {
    if (path->count == 0) return mal_value_new_undefined();
    MalValue first = path->items[0];
    memmove(path->items, path->items + 1, (usize) (path->count - 1) * sizeof(MalValue));
    path->items[--path->count] = mal_value_new_undefined();
    return first;
}

static void url_path_remove(UrlPath *path, i32 index) {
    memmove(path->items + index, path->items + index + 1, (usize) (path->count - index - 1) * sizeof(MalValue));
    path->items[--path->count] = mal_value_new_undefined();
}

static MalValue url_path_join(MalVm *vm, const UrlPath *path) {
    UrlBuffer buffer = {0};
    for (i32 i = 0; i < path->count; i++) {
        if (i > 0) url_buffer_char(&buffer, '/');
        MalValue item = path->items[i];
        if (mal_value_is_string(item)) {
            url_buffer_append(&buffer, mal_string_code_units(mal_value_to_string(item)),
                mal_string_length(mal_value_to_string(item)));
        }
    }
    if (buffer.status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(&buffer);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, &buffer));
}

static MalValue url_concat(MalVm *vm, MalValue left, MalValue right) {
    UrlBuffer buffer = {0};
    MalValue parts[] = {left, right};
    for (usize i = 0; i < countof(parts); i++) {
        if (mal_value_is_string(parts[i])) {
            url_buffer_append(&buffer, mal_string_code_units(mal_value_to_string(parts[i])),
                mal_string_length(mal_value_to_string(parts[i])));
        }
    }
    if (buffer.status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(&buffer);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, &buffer));
}

static bool url_assign(MalVm *vm, MalValue target, MalValue source) {
    MalValue assign = url_get(vm, vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], "assign");
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    MalValue args[] = {target, source};
    mal_vm_call_value(vm, assign, vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], args, 2);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

static MalValue url_finish(MalVm *vm, MalValue result) {
    MalValue argument = result;
    MalValue href = url_format(vm, mal_value_new_undefined(), &argument, 1, mal_value_new_undefined(),
        mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    url_put(vm, result, "href", href);
    return result;
}

/* "a@b" in a hostless host moves the user part into auth (lib/url.js authInHost). */
static void url_auth_in_host(MalVm *vm, MalValue result) {
    MalValue host = url_get(vm, result, "host");
    if (!url_truthy(host) || !mal_value_is_string(host)) return;
    MalString *string = mal_value_to_string(host);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize at = 0;
    while (at < length && units[at] != '@') at++;
    if (at == 0 || at == length) return;
    usize next = at + 1;
    while (next < length && units[next] != '@') next++;
    MalValue parts[] = {url_slice(vm, string, 0, at), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, parts, countof(parts));
    parts[1] = url_slice(vm, mal_value_to_string(host), at + 1, next);
    url_put(vm, result, "auth", parts[0]);
    url_put(vm, result, "hostname", parts[1]);
    url_put(vm, result, "host", parts[1]);
    mal_gc_unroot(&root);
}

static MalValue url_resolve_object_impl(MalVm *vm, MalValue self, MalValue relative_value) {
    MalValue roots[] = {self, relative_value, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result_value = mal_value_new_undefined();
    if (mal_value_is_string(roots[1])) {
        MalValue parse_args[] = {roots[1], mal_value_new_boolean(false), mal_value_new_boolean(true)};
        roots[1] = url_parse(vm, mal_value_new_undefined(), parse_args, 3, mal_value_new_undefined(),
            mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
#define SELF roots[0]
#define REL roots[1]
#define RESULT roots[2]
    RESULT = url_new_instance(vm, vm->intrinsics[MAL_INTRINSIC_NODE_URL_PROTOTYPE]);
    if (!url_assign(vm, RESULT, SELF)) goto done;
    url_put(vm, RESULT, "hash", url_get(vm, REL, "hash"));
    if (url_is(url_get(vm, REL, "href"), "")) {
        result_value = url_finish(vm, RESULT);
        goto done;
    }
    if (url_truthy(url_get(vm, REL, "slashes")) && !url_truthy(url_get(vm, REL, "protocol"))) {
        roots[3] = url_get(vm, RESULT, "protocol");
        if (!url_assign(vm, RESULT, REL)) goto done;
        url_put(vm, RESULT, "protocol", roots[3]);
        if (url_slashed_protocol(url_get(vm, RESULT, "protocol")) && url_truthy(url_get(vm, RESULT, "hostname"))
            && !url_truthy(url_get(vm, RESULT, "pathname"))) {
            roots[3] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "/"));
            url_put(vm, RESULT, "pathname", roots[3]);
            url_put(vm, RESULT, "path", roots[3]);
        }
        result_value = url_finish(vm, RESULT);
        goto done;
    }
    roots[3] = url_get(vm, REL, "protocol");
    if (url_truthy(roots[3]) && !mal_ops_strict_equal_bool(roots[3], url_get(vm, RESULT, "protocol"))) {
        if (!url_slashed_protocol(roots[3])) {
            if (!url_assign(vm, RESULT, REL)) goto done;
            result_value = url_finish(vm, RESULT);
            goto done;
        }
        url_put(vm, RESULT, "protocol", roots[3]);
        if (!url_truthy(url_get(vm, REL, "host")) && !url_is(roots[3], "file") && !url_is(roots[3], "file:")
            && !url_hostless_protocol(roots[3])) {
            MalValue pathname = url_get(vm, REL, "pathname");
            usize capacity = url_segments(pathname) + 4;
            MalValue *items = calloc(capacity, sizeof(MalValue));
            if (items == nullptr) {
                mal_vm_throw_allocation_error(vm);
                goto done;
            }
            for (usize i = 0; i < capacity; i++) items[i] = mal_value_new_undefined();
            MalRootSpan path_root;
            mal_gc_root(&path_root, items, (i32) capacity);
            UrlPath rel_path = {.items = items};
            if (url_truthy(pathname)) url_path_split(vm, &rel_path, pathname);
            else {
                rel_path.items[0] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ""));
                rel_path.count = 1;
            }
            MalValue host = mal_value_new_undefined();
            while (rel_path.count > 0) {
                host = url_path_shift(&rel_path);
                url_put(vm, REL, "host", host);
                if (url_truthy(host)) break;
            }
            MalValue empty = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ""));
            if (!url_truthy(url_get(vm, REL, "host"))) url_put(vm, REL, "host", empty);
            if (!url_truthy(url_get(vm, REL, "hostname"))) url_put(vm, REL, "hostname", empty);
            if (rel_path.count == 0 || !url_is(rel_path.items[0], "")) url_path_unshift(&rel_path, empty);
            if (rel_path.count < 2) url_path_unshift(&rel_path, empty);
            url_put(vm, RESULT, "pathname", url_path_join(vm, &rel_path));
            mal_gc_unroot(&path_root);
            free(items);
        } else {
            url_put(vm, RESULT, "pathname", url_get(vm, REL, "pathname"));
        }
        url_put(vm, RESULT, "search", url_get(vm, REL, "search"));
        url_put(vm, RESULT, "query", url_get(vm, REL, "query"));
        roots[4] = url_get(vm, REL, "host");
        url_put(vm, RESULT, "host", url_truthy(roots[4]) ? roots[4]
            : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "")));
        url_put(vm, RESULT, "auth", url_get(vm, REL, "auth"));
        MalValue hostname = url_get(vm, REL, "hostname");
        url_put(vm, RESULT, "hostname", url_truthy(hostname) ? hostname : url_get(vm, REL, "host"));
        url_put(vm, RESULT, "port", url_get(vm, REL, "port"));
        roots[3] = url_get(vm, RESULT, "pathname");
        roots[4] = url_get(vm, RESULT, "search");
        if (url_truthy(roots[3]) || url_truthy(roots[4])) {
            url_put(vm, RESULT, "path", url_concat(vm, url_truthy(roots[3]) ? roots[3] : mal_value_new_undefined(),
                url_truthy(roots[4]) ? roots[4] : mal_value_new_undefined()));
        }
        if (!url_truthy(url_get(vm, RESULT, "slashes"))) url_put(vm, RESULT, "slashes", url_get(vm, REL, "slashes"));
        result_value = url_finish(vm, RESULT);
        goto done;
    }

    MalValue result_pathname = url_get(vm, RESULT, "pathname");
    MalValue rel_pathname = url_get(vm, REL, "pathname");
    bool is_source_abs = url_truthy(result_pathname) && url_starts_with_slash(result_pathname);
    bool is_rel_abs = url_truthy(url_get(vm, REL, "host"))
        || (url_truthy(rel_pathname) && url_starts_with_slash(rel_pathname));
    bool must_end_abs = is_rel_abs || is_source_abs
        || (url_truthy(url_get(vm, RESULT, "host")) && url_truthy(rel_pathname));
    bool remove_all_dots = must_end_abs;
    usize capacity = 2 * (url_segments(result_pathname) + url_segments(rel_pathname)) + 8;
    MalValue *items = calloc(capacity * 2, sizeof(MalValue));
    if (items == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    for (usize i = 0; i < capacity * 2; i++) items[i] = mal_value_new_undefined();
    MalRootSpan path_root;
    mal_gc_root(&path_root, items, (i32) (capacity * 2));
    UrlPath src_path = {.items = items};
    UrlPath rel_path = {.items = items + capacity};
    url_path_split(vm, &src_path, url_get(vm, RESULT, "pathname"));
    url_path_split(vm, &rel_path, url_get(vm, REL, "pathname"));
    MalValue empty = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ""));
    roots[3] = url_get(vm, RESULT, "protocol");
    bool no_leading_slashes = url_truthy(roots[3]) && !url_slashed_protocol(roots[3]);
    if (no_leading_slashes) {
        url_put(vm, RESULT, "hostname", empty);
        url_put(vm, RESULT, "port", mal_value_new_null());
        roots[4] = url_get(vm, RESULT, "host");
        if (url_truthy(roots[4])) {
            if (src_path.count > 0 && url_is(src_path.items[0], "")) src_path.items[0] = roots[4];
            else url_path_unshift(&src_path, roots[4]);
        }
        url_put(vm, RESULT, "host", empty);
        if (url_truthy(url_get(vm, REL, "protocol"))) {
            url_put(vm, REL, "hostname", mal_value_new_null());
            url_put(vm, REL, "port", mal_value_new_null());
            url_put(vm, RESULT, "auth", mal_value_new_null());
            roots[4] = url_get(vm, REL, "host");
            if (url_truthy(roots[4])) {
                if (rel_path.count > 0 && url_is(rel_path.items[0], "")) rel_path.items[0] = roots[4];
                else url_path_unshift(&rel_path, roots[4]);
            }
            url_put(vm, REL, "host", mal_value_new_null());
        }
        must_end_abs = must_end_abs && ((rel_path.count > 0 && url_is(rel_path.items[0], ""))
            || (src_path.count > 0 && url_is(src_path.items[0], "")));
    }
    if (is_rel_abs) {
        roots[4] = url_get(vm, REL, "host");
        if (url_truthy(roots[4]) || url_is(roots[4], "")) {
            if (!mal_ops_strict_equal_bool(url_get(vm, RESULT, "host"), roots[4])) {
                url_put(vm, RESULT, "auth", mal_value_new_null());
            }
            url_put(vm, RESULT, "host", roots[4]);
            url_put(vm, RESULT, "port", url_get(vm, REL, "port"));
        }
        roots[4] = url_get(vm, REL, "hostname");
        if (url_truthy(roots[4]) || url_is(roots[4], "")) {
            if (!mal_ops_strict_equal_bool(url_get(vm, RESULT, "hostname"), roots[4])) {
                url_put(vm, RESULT, "auth", mal_value_new_null());
            }
            url_put(vm, RESULT, "hostname", roots[4]);
        }
        url_put(vm, RESULT, "search", url_get(vm, REL, "search"));
        url_put(vm, RESULT, "query", url_get(vm, REL, "query"));
        memcpy(src_path.items, rel_path.items, (usize) rel_path.count * sizeof(MalValue));
        src_path.count = rel_path.count;
    } else if (rel_path.count > 0) {
        if (src_path.count > 0) src_path.items[--src_path.count] = mal_value_new_undefined();
        memcpy(src_path.items + src_path.count, rel_path.items, (usize) rel_path.count * sizeof(MalValue));
        src_path.count += rel_path.count;
        url_put(vm, RESULT, "search", url_get(vm, REL, "search"));
        url_put(vm, RESULT, "query", url_get(vm, REL, "query"));
    } else if (!mal_value_is_nil(url_get(vm, REL, "search"))) {
        if (no_leading_slashes) {
            roots[4] = url_path_shift(&src_path);
            url_put(vm, RESULT, "host", roots[4]);
            url_put(vm, RESULT, "hostname", roots[4]);
            url_auth_in_host(vm, RESULT);
        }
        url_put(vm, RESULT, "search", url_get(vm, REL, "search"));
        url_put(vm, RESULT, "query", url_get(vm, REL, "query"));
        roots[3] = url_get(vm, RESULT, "pathname");
        roots[4] = url_get(vm, RESULT, "search");
        if (!mal_value_is_null(roots[3]) || !mal_value_is_null(roots[4])) {
            url_put(vm, RESULT, "path", url_concat(vm, url_truthy(roots[3]) ? roots[3] : empty,
                url_truthy(roots[4]) ? roots[4] : empty));
        }
        result_value = url_finish(vm, RESULT);
        goto paths_done;
    }
    if (src_path.count == 0) {
        url_put(vm, RESULT, "pathname", mal_value_new_null());
        roots[4] = url_get(vm, RESULT, "search");
        url_put(vm, RESULT, "path", url_truthy(roots[4])
            ? url_concat(vm, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "/")), roots[4])
            : mal_value_new_null());
        result_value = url_finish(vm, RESULT);
        goto paths_done;
    }
    {
        MalValue last = src_path.items[src_path.count - 1];
        bool has_trailing_slash = ((url_truthy(url_get(vm, RESULT, "host")) || url_truthy(url_get(vm, REL, "host"))
            || src_path.count > 1) && (url_is(last, ".") || url_is(last, ".."))) || url_is(last, "");
        i32 up = 0;
        for (i32 i = src_path.count - 1; i >= 0; i--) {
            last = src_path.items[i];
            if (url_is(last, ".")) {
                url_path_remove(&src_path, i);
            } else if (url_is(last, "..")) {
                url_path_remove(&src_path, i);
                up++;
            } else if (up > 0) {
                url_path_remove(&src_path, i);
                up--;
            }
        }
        if (!must_end_abs && !remove_all_dots) {
            MalValue dots = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ".."));
            while (up-- > 0) url_path_unshift(&src_path, dots);
        }
        if (must_end_abs && !(src_path.count > 0 && url_is(src_path.items[0], ""))
            && !(src_path.count > 0 && url_truthy(src_path.items[0]) && url_starts_with_slash(src_path.items[0]))) {
            url_path_unshift(&src_path, empty);
        }
        if (has_trailing_slash) {
            roots[4] = url_path_join(vm, &src_path);
            MalString *joined = mal_value_to_string(roots[4]);
            usize length = mal_string_length(joined);
            if (length == 0 || mal_string_code_units(joined)[length - 1] != '/') src_path.items[src_path.count++] = empty;
        }
        bool is_absolute = src_path.count > 0 && (url_is(src_path.items[0], "")
            || (url_truthy(src_path.items[0]) && url_starts_with_slash(src_path.items[0])));
        if (no_leading_slashes) {
            roots[4] = is_absolute ? empty : src_path.count > 0 ? url_path_shift(&src_path) : empty;
            url_put(vm, RESULT, "host", roots[4]);
            url_put(vm, RESULT, "hostname", roots[4]);
            url_auth_in_host(vm, RESULT);
        }
        must_end_abs = must_end_abs || (url_truthy(url_get(vm, RESULT, "host")) && src_path.count > 0);
        if (must_end_abs && !is_absolute) url_path_unshift(&src_path, empty);
        if (src_path.count == 0) {
            url_put(vm, RESULT, "pathname", mal_value_new_null());
            url_put(vm, RESULT, "path", mal_value_new_null());
        } else {
            url_put(vm, RESULT, "pathname", url_path_join(vm, &src_path));
        }
        roots[3] = url_get(vm, RESULT, "pathname");
        roots[4] = url_get(vm, RESULT, "search");
        if (!mal_value_is_null(roots[3]) || !mal_value_is_null(roots[4])) {
            url_put(vm, RESULT, "path", url_concat(vm, url_truthy(roots[3]) ? roots[3] : empty,
                url_truthy(roots[4]) ? roots[4] : empty));
        }
        roots[4] = url_get(vm, REL, "auth");
        url_put(vm, RESULT, "auth", url_truthy(roots[4]) ? roots[4] : url_get(vm, RESULT, "auth"));
        if (!url_truthy(url_get(vm, RESULT, "slashes"))) url_put(vm, RESULT, "slashes", url_get(vm, REL, "slashes"));
        result_value = url_finish(vm, RESULT);
    }
paths_done:
    mal_gc_unroot(&path_root);
    free(items);
#undef SELF
#undef REL
#undef RESULT
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result_value;
}

static MalValue url_parse_source(MalVm *vm, MalValue source) {
    MalValue prototype = vm->intrinsics[MAL_INTRINSIC_NODE_URL_PROTOTYPE];
    if (mal_value_is_object(source) && mal_value_is_object(prototype)) {
        for (MalObject *cursor = mal_object_get_prototype(mal_value_to_object(source)); cursor != nullptr;
             cursor = mal_object_get_prototype(cursor)) {
            if (cursor == mal_value_to_object(prototype)) return source;
        }
    }
    MalValue parse_args[] = {source, mal_value_new_boolean(false), mal_value_new_boolean(true)};
    return url_parse(vm, mal_value_new_undefined(), parse_args, 3, mal_value_new_undefined(),
        mal_value_new_undefined());
}

static MalValue url_module_resolve_object(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue source = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue relative = argc > 1 ? args[1] : mal_value_new_undefined();
    if (!url_truthy(source)) return relative;
    MalValue roots[] = {relative, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = url_parse_source(vm, source);
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : url_resolve_object_impl(vm, roots[1], roots[0]);
    mal_gc_unroot(&root);
    return result;
}

static MalValue url_resolve_with(MalVm *vm, MalValue self, MalValue relative) {
    MalValue roots[] = {self, url_parse_source(vm, relative)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[1] = url_resolve_object_impl(vm, roots[0], roots[1]);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            result = url_format(vm, mal_value_new_undefined(), &roots[1], 1, mal_value_new_undefined(),
                mal_value_new_undefined());
        }
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue url_module_resolve(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue relative = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue roots[] = {relative, url_parse_source(vm, argc > 0 ? args[0] : mal_value_new_undefined())};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : url_resolve_with(vm, roots[1], roots[0]);
    mal_gc_unroot(&root);
    return result;
}

static MalValue url_proto_resolve(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    return url_resolve_with(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined());
}

static MalValue url_proto_resolve_object(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    return url_resolve_object_impl(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined());
}

static MalValue url_proto_format(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target, (void) callee;
    MalValue argument = receiver;
    return url_format(vm, mal_value_new_undefined(), &argument, 1, mal_value_new_undefined(),
        mal_value_new_undefined());
}

void mal_host_install_node_url(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:url", slots, count)) return;
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
            mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "Url"), 0, url_constructor);
        mal_native_function_object_set_constructor(constructor);
        mal_native_function_object_set_handles_new_target_prototype(constructor);
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
			url_to_http_options);
        MalNativeFunctionObject *http_options = mal_value_to_native_function_object(roots[8]);
        mal_native_function_object_set_constructor(http_options);
        mal_native_function_object_set_handles_new_target_prototype(http_options);
        roots[9] = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_intrinsic_define_data(vm, (MalObject *) http_options, "prototype", roots[9], MAL_PROPERTY_WRITABLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[9]), "constructor", roots[8],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        roots[10] = vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_CONSTRUCTOR];
        static const char *names[] = {
            "Url", "parse", "format", "pathToFileURL", "fileURLToPath", "URL",
            "urlToHttpOptions", "URLSearchParams",
        };
		MalValue values[] = {
			roots[2], roots[3], roots[4], roots[5], roots[6], roots[7], roots[8], roots[10],
		};
        for (usize i = 0; i < countof(names); i++) {
            mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                                      (const byte *) names[i], values[i], URL_VISIBLE);
        }
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "domainToASCII", 1,
            url_domain_to_ascii);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "resolve", 2,
            url_module_resolve);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "resolveObject", 2,
            url_module_resolve_object);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]), (const byte *) "resolve", 1,
            url_proto_resolve);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]), (const byte *) "resolveObject", 1,
            url_proto_resolve_object);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]), (const byte *) "format", 0,
            url_proto_format);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "domainToUnicode", 1,
            url_domain_to_unicode);
        vm->intrinsics[MAL_INTRINSIC_NODE_URL_CONSTRUCTOR] = roots[2];
        vm->intrinsics[MAL_INTRINSIC_NODE_URL_PROTOTYPE] = roots[1];
        vm->intrinsics[MAL_INTRINSIC_NODE_URL_MODULE] = roots[0];
        module = roots[0];
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:url", slots, count, module);
}

#endif /* MAL_NODE */
