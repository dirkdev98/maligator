#include "maligator_http.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "maligator_assets.h"
#include "posix_fs.h"
#include "sha256.h"
#include "utf8.h"
#include "value.h"
#include "vm_ops.h"
#include "web_fetch.h"
#include "web_headers_object.h"
#include "web_response_object.h"

struct MalHttpAssetRoute {
    /** Empty, or a path prefix without a trailing slash, such as "/static". */
    char *prefix;
    /** The member served when a path names none, for client-side routing. */
    char *fallback;
    char **immutable;
    usize immutable_count;
};

static char *http_cstr(MalVm *vm, MalValue value, const char *what) {
    if (!mal_value_is_string(value)) {
        char message[96];
        snprintf(message, sizeof message, "serveAsset option '%s' must be a string", what);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
        return nullptr;
    }
    char *bytes = nullptr;
    usize length = 0;
    if (mal_string_to_utf8_c_string(mal_value_to_string(value), &bytes, &length)
        != MAL_UTF8_C_STRING_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "serveAsset options must not contain null bytes");
        return nullptr;
    }
    return bytes;
}

void mal_http_asset_route_free(MalHttpAssetRoute *route) {
    if (route == nullptr) return;
    free(route->prefix);
    free(route->fallback);
    for (usize i = 0; i < route->immutable_count; i++) free(route->immutable[i]);
    free(route->immutable);
    free(route);
}

MalHttpAssetRoute *mal_http_asset_route_new(MalVm *vm, MalValue options) {
    MalHttpAssetRoute *route = calloc(1, sizeof(MalHttpAssetRoute));
    if (route == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    MalRootSpan root;
    mal_gc_root(&root, &options, 1);
    MalValue value;
    bool ok = mal_value_is_object(options);
    if (ok && mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "prefix"), &value)
        && !mal_value_is_undefined(value)) {
        route->prefix = http_cstr(vm, value, "prefix");
        ok = route->prefix != nullptr;
    }
    if (ok && mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "fallback"), &value)
        && !mal_value_is_undefined(value)) {
        route->fallback = http_cstr(vm, value, "fallback");
        ok = route->fallback != nullptr;
    }
    if (ok && mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "immutable"), &value)
        && mal_value_is_array_object(value)) {
        u32 count = mal_array_object_length(mal_value_to_array_object(value));
        route->immutable = calloc(count == 0 ? 1 : count, sizeof(char *));
        ok = route->immutable != nullptr;
        if (!ok) mal_vm_throw_allocation_error(vm);
        MalRootSpan list_root;
        mal_gc_root(&list_root, &value, 1);
        for (u32 i = 0; ok && i < count; i++) {
            MalValue pattern;
            ok = mal_vm_get_property(vm, value, mal_key_index(i), &pattern);
            if (ok) {
                route->immutable[i] = http_cstr(vm, pattern, "immutable");
                ok = route->immutable[i] != nullptr;
                if (ok) route->immutable_count = i + 1;
            }
        }
        mal_gc_unroot(&list_root);
    }
    mal_gc_unroot(&root);
    if (!ok || vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_http_asset_route_free(route);
        return nullptr;
    }
    if (route->prefix == nullptr) route->prefix = strdup("");
    if (route->prefix == nullptr) {
        mal_http_asset_route_free(route);
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    return route;
}

static void reply_header(MalHttpAssetReply *reply, const char *name, const char *value) {
    if (reply->header_count == MAL_HTTP_ASSET_REPLY_HEADERS) return;
    reply->headers[reply->header_count].name = name;
    snprintf(reply->headers[reply->header_count].value,
        sizeof reply->headers[reply->header_count].value, "%s", value);
    reply->header_count++;
}

static void reply_text(MalHttpAssetReply *reply, int status, const char *text) {
    reply->status = status;
    reply_header(reply, "content-type", "text/plain; charset=utf-8");
    reply->body = (const byte *) text;
    reply->body_length = strlen(text);
}

void mal_http_asset_reply_dispose(MalHttpAssetReply *reply) {
    free(reply->owned);
    reply->owned = nullptr;
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/*
 * Decode the member path a request names. An escaped slash or NUL would change which
 * segments the path has, so such a path names no member.
 */
static char *decode_member(const char *path, usize length) {
    char *decoded = malloc(length + sizeof "index.html");
    if (decoded == nullptr) return nullptr;
    usize out = 0;
    for (usize i = 0; i < length; i++) {
        char c = path[i];
        if (c == '%') {
            int high = i + 2 < length ? hex_value(path[i + 1]) : -1;
            int low = i + 2 < length ? hex_value(path[i + 2]) : -1;
            if (high < 0 || low < 0) {
                free(decoded);
                return strdup("");
            }
            c = (char) (high * 16 + low);
            if (c == '/' || c == '\0') {
                free(decoded);
                return strdup("");
            }
            i += 2;
        }
        decoded[out++] = c;
    }
    if (out == 0 || decoded[out - 1] == '/') {
        memcpy(decoded + out, "index.html", sizeof "index.html");
    } else {
        decoded[out] = '\0';
    }
    return decoded;
}

/*
 * The member path a request target names under the route's prefix: 1 with `*out`
 * set (empty when the path names no valid member), 0 for a path outside the prefix,
 * -1 when allocation fails.
 */
static int route_member(
    const MalHttpAssetRoute *route, const char *target, usize length, char **out) {
    usize path_length = 0;
    while (path_length < length && target[path_length] != '?' && target[path_length] != '#')
        path_length++;
    usize prefix_length = strlen(route->prefix);
    if (path_length < prefix_length || memcmp(target, route->prefix, prefix_length) != 0)
        return 0;
    const char *rest = target + prefix_length;
    usize rest_length = path_length - prefix_length;
    if (rest_length > 0 && rest[0] != '/') return 0;
    if (rest_length > 0) {
        rest++;
        rest_length--;
    }
    *out = decode_member(rest, rest_length);
    return *out == nullptr ? -1 : 1;
}

/* The q-value a comma-separated Accept-Encoding gives `coding`, counting `*`. */
static bool accepts_coding(const char *header, usize length, const char *coding) {
    if (header == nullptr) return false;
    usize coding_length = strlen(coding);
    bool wildcard = false;
    usize start = 0;
    while (start < length) {
        usize end = start;
        while (end < length && header[end] != ',') end++;
        usize name_start = start;
        while (name_start < end && (header[name_start] == ' ' || header[name_start] == '\t'))
            name_start++;
        usize name_end = name_start;
        while (name_end < end && header[name_end] != ';' && header[name_end] != ' '
            && header[name_end] != '\t')
            name_end++;
        bool allowed = true;
        for (usize i = name_end; i + 1 < end; i++) {
            if (header[i] != 'q' || header[i + 1] != '=') continue;
            // q=0, q=0.0 and q=0.000 refuse a coding.
            usize digit = i + 2;
            allowed = digit < end && header[digit] != '0';
            for (usize j = digit + 1; !allowed && j < end; j++) {
                if (header[j] >= '1' && header[j] <= '9') allowed = true;
                else if (header[j] != '.' && header[j] != '0') break;
            }
            break;
        }
        usize name_length = name_end - name_start;
        bool same = name_length == coding_length;
        for (usize i = 0; same && i < coding_length; i++)
            same = mal_ascii_to_lower((u8) header[name_start + i]) == (u8) coding[i];
        if (same) return allowed;
        if (name_length == 1 && header[name_start] == '*') wildcard = allowed;
        start = end + 1;
    }
    return wildcard;
}

static bool etag_matches(const char *header, usize length, const char *etag) {
    if (header == nullptr) return false;
    usize etag_length = strlen(etag);
    for (usize i = 0; i < length; i++) {
        if (header[i] == '*') return true;
        if (i + etag_length <= length && memcmp(header + i, etag, etag_length) == 0) return true;
    }
    return false;
}

/* One `bytes=` range; false when absent, malformed or several, which serve the whole. */
static bool single_range(
    const char *header, usize length, usize size, usize *first, usize *last, bool *satisfiable) {
    if (header == nullptr || length < 7 || memcmp(header, "bytes=", 6) != 0) return false;
    const char *spec = header + 6;
    usize spec_length = length - 6;
    for (usize i = 0; i < spec_length; i++)
        if (spec[i] == ',') return false;
    usize dash = 0;
    while (dash < spec_length && spec[dash] != '-') dash++;
    if (dash == spec_length) return false;
    u64 start = 0;
    u64 end = 0;
    bool has_start = dash > 0;
    bool has_end = dash + 1 < spec_length;
    for (usize i = 0; i < dash; i++) {
        if (spec[i] < '0' || spec[i] > '9' || start > UINT64_MAX / 10 - 9) return false;
        start = start * 10 + (u64) (spec[i] - '0');
    }
    for (usize i = dash + 1; i < spec_length; i++) {
        if (spec[i] < '0' || spec[i] > '9' || end > UINT64_MAX / 10 - 9) return false;
        end = end * 10 + (u64) (spec[i] - '0');
    }
    if (!has_start && !has_end) return false;
    if (!has_start) {
        // A suffix range: the last `end` bytes.
        *satisfiable = end > 0 && size > 0;
        *first = end >= size ? 0 : size - (usize) end;
        *last = size == 0 ? 0 : size - 1;
        return true;
    }
    if (has_end && end < start) return false;
    *satisfiable = start < size;
    *first = (usize) start;
    *last = !has_end || end >= size ? size - 1 : (usize) end;
    return true;
}

static void hex_digest(const byte *bytes, usize length, char out[65]) {
    MalSha256 context;
    u8 digest[32];
    mal_sha256_init(&context);
    mal_sha256_update(&context, (const u8 *) bytes, length);
    mal_sha256_final(&context, digest);
    for (usize i = 0; i < sizeof digest; i++) snprintf(out + i * 2, 3, "%02x", digest[i]);
}

bool mal_http_asset_reply(
    MalVm *vm,
    const MalHttpAssetRoute *route,
    MalValue handle,
    const MalHttpAssetRequest *request,
    MalHttpAssetReply *reply) {
    *reply = (MalHttpAssetReply) {0};
    bool get = request->method_length == 3 && memcmp(request->method, "GET", 3) == 0;
    bool head = request->method_length == 4 && memcmp(request->method, "HEAD", 4) == 0;
    if (!get && !head) {
        reply_text(reply, 405, "Method Not Allowed");
        reply_header(reply, "allow", "GET, HEAD");
        return true;
    }
    char *member_path = nullptr;
    int routed = route_member(route, request->target, request->target_length, &member_path);
    if (routed < 0) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    MalAssetMember member = {0};
    int found = routed == 0 ? 0 : mal_asset_member(vm, handle, member_path, &member);
    free(member_path);
    // The fallback stands in for paths below the prefix that name no file, as a
    // client-side router expects; paths outside the prefix are not the route's.
    if (found == 0 && routed > 0 && route->fallback != nullptr)
        found = mal_asset_member(vm, handle, route->fallback, &member);
    if (found < 0) return false;
    if (found == 0) {
        reply_text(reply, 404, "Not Found");
        return true;
    }

    const byte *bytes;
    usize size;
    char digest[65];
    if (member.embedded != nullptr) {
        bytes = (const byte *) member.embedded->data;
        size = member.embedded->length;
        snprintf(digest, sizeof digest, "%s", member.embedded->digest);
    } else {
        int err = mal_posix_fs_read_file(member.live_path, &reply->owned, &size);
        if (err != 0) {
            mal_asset_member_dispose(&member);
            reply_text(reply, err == ENOENT ? 404 : 500,
                err == ENOENT ? "Not Found" : "Internal Server Error");
            return true;
        }
        bytes = reply->owned;
        hex_digest(bytes, size, digest);
    }

    char etag[80];
    snprintf(etag, sizeof etag, "\"%s\"", digest);
    bool immutable = false;
    for (usize i = 0; !immutable && i < route->immutable_count; i++)
        immutable = mal_asset_pattern_match(route->immutable[i], member.path, false);
    const char *cache_control = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    reply_header(reply, "content-type", mal_asset_media_type(member.path));
    reply_header(reply, "cache-control", cache_control);
    bool variants = member.embedded != nullptr
        && (member.embedded->brotli != nullptr || member.embedded->gzip != nullptr);
    if (variants) reply_header(reply, "vary", "accept-encoding");

    usize header_length = 0;
    const char *range = request->header(request->context, "range", &header_length);
    usize range_length = header_length;
    const char *encoding = nullptr;
    if (variants && range == nullptr) {
        const char *accept = request->header(request->context, "accept-encoding", &header_length);
        if (member.embedded->brotli != nullptr && accepts_coding(accept, header_length, "br")) {
            encoding = "br";
            bytes = (const byte *) member.embedded->brotli;
            size = member.embedded->brotli_length;
        } else if (member.embedded->gzip != nullptr && accepts_coding(accept, header_length, "gzip")) {
            encoding = "gzip";
            bytes = (const byte *) member.embedded->gzip;
            size = member.embedded->gzip_length;
        }
    }
    if (encoding != nullptr) {
        // Each representation needs its own validator.
        snprintf(etag, sizeof etag, "\"%s-%s\"", digest, encoding);
        reply_header(reply, "content-encoding", encoding);
    }
    reply_header(reply, "etag", etag);
    mal_asset_member_dispose(&member);

    const char *match = request->header(request->context, "if-none-match", &header_length);
    if (etag_matches(match, header_length, etag)) {
        reply->status = 304;
        return true;
    }
    reply_header(reply, "accept-ranges", "bytes");
    usize first = 0;
    usize last = 0;
    bool satisfiable = false;
    if (encoding == nullptr && single_range(range, range_length, size, &first, &last, &satisfiable)) {
        char content_range[96];
        if (!satisfiable) {
            snprintf(content_range, sizeof content_range, "bytes */%zu", size);
            reply_header(reply, "content-range", content_range);
            reply->status = 416;
            return true;
        }
        snprintf(content_range, sizeof content_range, "bytes %zu-%zu/%zu", first, last, size);
        reply_header(reply, "content-range", content_range);
        reply->status = 206;
        reply->body = bytes + first;
        reply->body_length = last - first + 1;
        return true;
    }
    reply->status = 200;
    reply->body = bytes;
    reply->body_length = size;
    return true;
}

/* A JavaScript Request's headers, read through its `headers.get`. */
typedef struct HttpRequestHeaders {
    MalVm *vm;
    MalValue headers;
    char *values[4];
    usize used;
} HttpRequestHeaders;

static const char *http_request_header(void *context, const char *name, usize *length) {
    HttpRequestHeaders *request = context;
    MalVm *vm = request->vm;
    if (request->used == countof(request->values)) return nullptr;
    MalValue get;
    if (!mal_vm_get_property(vm, request->headers, mal_intrinsic_string_key(vm, (const byte *) "get"), &get)
        || !mal_value_is_callable(get))
        return nullptr;
    MalValue argument = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name));
    MalCompletion completion = mal_vm_call_value(vm, get, request->headers, &argument, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return nullptr;
    }
    if (!mal_value_is_string(completion.value)) return nullptr;
    char *value = nullptr;
    if (mal_string_to_utf8_c_string(mal_value_to_string(completion.value), &value, length)
        != MAL_UTF8_C_STRING_OK)
        return nullptr;
    request->values[request->used++] = value;
    return value;
}

static bool http_request_string(MalVm *vm, MalValue request, const char *name, char **out) {
    MalValue value;
    if (!mal_vm_get_property(vm, request, mal_intrinsic_string_key(vm, (const byte *) name), &value))
        return false;
    usize length = 0;
    if (!mal_value_is_string(value)
        || mal_string_to_utf8_c_string(mal_value_to_string(value), out, &length)
            != MAL_UTF8_C_STRING_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "serveAsset handlers take a Request");
        return false;
    }
    return true;
}

/* A HEAD reply keeps its body: the server advertises its length and sends none. */
static MalValue http_reply_response(MalVm *vm, MalHttpAssetReply *reply) {
    byte *body = nullptr;
    usize length = reply->status == 304 ? 0 : reply->body_length;
    if (length > 0) {
        body = malloc(length);
        if (body == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        memcpy(body, reply->body, length);
    }
    MalResponseObject *response = mal_response_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]),
        reply->status, body, length);
    MalValue result = mal_value_from_response_object(response);
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalHeadersObject *headers = mal_headers_create(vm);
    response->headers = mal_value_from_headers_object(headers);
    for (usize i = 0; i < reply->header_count; i++) {
        mal_headers_append_bytes(vm, headers, reply->headers[i].name,
            strlen(reply->headers[i].name), reply->headers[i].value,
            strlen(reply->headers[i].value));
    }
    headers->guard = MAL_HEADERS_GUARD_IMMUTABLE;
    mal_gc_unroot(&root);
    return result;
}

/* assetResponse(handle, request, options): the Response a serveAsset handler returns. */
static MalValue http_asset_response(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc < 3) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "assetResponse requires a handle, a request and options");
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {args[1], mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    char *method = nullptr;
    char *url = nullptr;
    MalHttpAssetRoute *route = mal_http_asset_route_new(vm, args[2]);
    HttpRequestHeaders headers = {.vm = vm};
    if (route == nullptr || !http_request_string(vm, roots[0], "method", &method)
        || !http_request_string(vm, roots[0], "url", &url)
        || !mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "headers"), &roots[1]))
        goto done;
    headers.headers = roots[1];
    // The origin-form target follows the scheme and authority of the absolute URL.
    const char *target = strstr(url, "://");
    target = target == nullptr ? url : strchr(target + 3, '/');
    if (target == nullptr) target = "/";
    MalHttpAssetRequest request = {
        .method = method,
        .method_length = strlen(method),
        .target = target,
        .target_length = strlen(target),
        .header = http_request_header,
        .context = &headers,
    };
    MalHttpAssetReply reply;
    if (mal_http_asset_reply(vm, route, args[0], &request, &reply)
        && vm->completion.kind != MAL_COMPLETION_THROW) {
        result = http_reply_response(vm, &reply);
    }
    mal_http_asset_reply_dispose(&reply);
done:
    for (usize i = 0; i < headers.used; i++) free(headers.values[i]);
    free(method);
    free(url);
    mal_http_asset_route_free(route);
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

/* assetProxy(handle): the dev server URL this command serves the handle from. */
static MalValue http_asset_proxy(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    char *url = argc > 0 ? mal_asset_proxy_url(vm, args[0]) : nullptr;
    if (url == nullptr) return mal_value_new_undefined();
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) url, strlen(url));
    free(url);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

/* listen(options): a running server, `{ port, close() }`. */
static MalValue http_listen(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_fetch_server_start(vm, argc > 0 ? args[0] : mal_value_new_undefined());
}

void mal_host_install_maligator_internal_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    for (i32 i = 0; i < count; i++) {
        MalNativeFunctionCallback callback = nullptr;
        i32 length = 1;
        if (strcmp(slots[i].name, "listen") == 0) callback = http_listen;
        else if (strcmp(slots[i].name, "assetResponse") == 0) {
            callback = http_asset_response;
            length = 3;
        } else if (strcmp(slots[i].name, "assetProxy") == 0) callback = http_asset_proxy;
        if (callback == nullptr) continue;
        vm->globals[slots[i].slot] = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) slots[i].name), length, callback,
                nullptr, 0));
    }
}
