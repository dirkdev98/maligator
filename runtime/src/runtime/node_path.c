#include "node_path.h"

#if MAL_NODE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "property_store.h"
#include "web_text_encoding.h"
#include "value.h"
#include "vm.h"

/*
 * Native `node:path`, POSIX flavor. A direct port of Node's lib/path.js `posix`
 * object, operating on UTF-16 code units (only '/' and '.' are structural, and
 * both are ASCII, so raw code-unit scanning preserves arbitrary string content
 * exactly the way Node's JS — which likewise indexes UTF-16 code units — does).
 *
 * The path separator is always '/' and the only "root" is a leading '/'. String
 * arguments are validated like Node (a non-string throws TypeError; there is no
 * ToString coercion). `resolve` (and `relative`, which resolves both operands)
 * fills in the current directory from getcwd(3) when no absolute segment is seen.
 */

#define PATH_SEP ((c16) '/')
#define PATH_DOT ((c16) '.')

/* --------------------------------------------------------------------------
 * A growable UTF-16 scratch buffer (plain malloc storage, never a GC cell). The
 * path algorithms build results here, then copy into a heap MalString at the end.
 * -------------------------------------------------------------------------- */

typedef struct {
    c16 *data;
    usize len;
    usize cap;
} MalPathBuf;

static void path_buf_init(MalPathBuf *b) {
    b->data = nullptr;
    b->len = 0;
    b->cap = 0;
}

static void path_buf_free(MalPathBuf *b) {
    free(b->data);
    b->data = nullptr;
    b->len = 0;
    b->cap = 0;
}

static void path_buf_reserve(MalPathBuf *b, usize need) {
    if (need <= b->cap) {
        return;
    }
    usize cap = b->cap != 0 ? b->cap : 16;
    while (cap < need) {
        cap *= 2;
    }
    b->data = realloc(b->data, cap * sizeof(c16));
    b->cap = cap;
}

static void path_buf_push_units(MalPathBuf *b, const c16 *units, usize n) {
    if (n == 0) {
        return;
    }
    path_buf_reserve(b, b->len + n);
    memcpy(b->data + b->len, units, n * sizeof(c16));
    b->len += n;
}

static void path_buf_push_char(MalPathBuf *b, c16 c) {
    path_buf_reserve(b, b->len + 1);
    b->data[b->len++] = c;
}

/* Prepend `seg` + "/" to the buffer (the `${path}/${resolvedPath}` step of resolve). */
static void path_buf_prepend_seg(MalPathBuf *b, const c16 *seg, usize seg_len) {
    usize add = seg_len + 1;
    path_buf_reserve(b, b->len + add);
    memmove(b->data + add, b->data, b->len * sizeof(c16));
    memcpy(b->data, seg, seg_len * sizeof(c16));
    b->data[seg_len] = PATH_SEP;
    b->len += add;
}

/* Index of the last '/' in the buffer, or -1. */
static i64 path_buf_last_sep(const MalPathBuf *b) {
    for (i64 i = (i64) b->len - 1; i >= 0; --i) {
        if (b->data[i] == PATH_SEP) {
            return i;
        }
    }
    return -1;
}

/* --------------------------------------------------------------------------
 * Value/string helpers.
 * -------------------------------------------------------------------------- */

static MalValue path_ascii(MalVm *vm, const char *s) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) s, strlen(s)));
}

static MalValue path_units(MalVm *vm, const c16 *units, usize n) {
    if (n == 0) {
        return path_ascii(vm, "");
    }
    if (n > MAL_STRING_MAX_CODE_UNITS) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_string_new_copy(&vm->heap, units, n));
}

/* Node validateString: a non-string argument is an ERR_INVALID_ARG_TYPE TypeError.
 * On success writes the unboxed string and returns true; on failure raises the
 * throw completion and returns false. */
static bool path_require_string(MalVm *vm, MalValue v, const char *arg_name, MalString **out) {
    if (mal_value_is_string(v)) {
        *out = mal_value_to_string(v);
        return true;
    }
    char msg[96];
    snprintf(msg, sizeof(msg), "The \"%s\" argument must be of type string.", arg_name);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) msg);
    return false;
}

/* --------------------------------------------------------------------------
 * normalizeString: the shared core resolving '.' / '..' segments. A direct port
 * of Node's normalizeString(path, allowAboveRoot, '/', isPosixPathSeparator).
 * Builds into `res` (assumed empty on entry).
 * -------------------------------------------------------------------------- */

static void normalize_string(const c16 *path, i64 len, bool allow_above_root, MalPathBuf *res) {
    i64 last_segment_length = 0;
    i64 last_slash = -1;
    i64 dots = 0;
    c16 code = 0;

    for (i64 i = 0; i <= len; ++i) {
        if (i < len) {
            code = path[i];
        } else if (code == PATH_SEP) {
            break;
        } else {
            code = PATH_SEP;
        }

        if (code == PATH_SEP) {
            if (last_slash == i - 1 || dots == 1) {
                // NOOP: empty segment or a lone '.'.
            } else if (dots == 2) {
                if ((i64) res->len < 2 || last_segment_length != 2
                    || res->data[res->len - 1] != PATH_DOT || res->data[res->len - 2] != PATH_DOT) {
                    if ((i64) res->len > 2) {
                        i64 last_sep_index = path_buf_last_sep(res);
                        if (last_sep_index == -1) {
                            res->len = 0;
                            last_segment_length = 0;
                        } else {
                            res->len = (usize) last_sep_index;
                            last_segment_length = (i64) res->len - 1 - path_buf_last_sep(res);
                        }
                        last_slash = i;
                        dots = 0;
                        continue;
                    } else if (res->len != 0) {
                        res->len = 0;
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        continue;
                    }
                }
                if (allow_above_root) {
                    if (res->len > 0) {
                        path_buf_push_char(res, PATH_SEP);
                    }
                    path_buf_push_char(res, PATH_DOT);
                    path_buf_push_char(res, PATH_DOT);
                    last_segment_length = 2;
                }
            } else {
                i64 seg_len = i - last_slash - 1;
                if (res->len > 0) {
                    path_buf_push_char(res, PATH_SEP);
                }
                path_buf_push_units(res, &path[last_slash + 1], (usize) seg_len);
                last_segment_length = seg_len;
            }
            last_slash = i;
            dots = 0;
        } else if (code == PATH_DOT && dots != -1) {
            ++dots;
        } else {
            dots = -1;
        }
    }
}

/* posix.normalize over code units (no argument validation — callers pass units). */
static MalValue posix_normalize_units(MalVm *vm, const c16 *path, i64 len) {
    if (len == 0) {
        return path_ascii(vm, ".");
    }
    bool is_absolute = path[0] == PATH_SEP;
    bool trailing_sep = path[len - 1] == PATH_SEP;

    MalPathBuf res;
    path_buf_init(&res);
    normalize_string(path, len, !is_absolute, &res);

    MalValue result;
    if (res.len == 0) {
        if (is_absolute) {
            result = path_ascii(vm, "/");
        } else {
            result = trailing_sep ? path_ascii(vm, "./") : path_ascii(vm, ".");
        }
    } else {
        MalPathBuf out;
        path_buf_init(&out);
        if (is_absolute) {
            path_buf_push_char(&out, PATH_SEP);
        }
        path_buf_push_units(&out, res.data, res.len);
        if (trailing_sep) {
            path_buf_push_char(&out, PATH_SEP);
        }
        result = path_units(vm, out.data, out.len);
        path_buf_free(&out);
    }
    path_buf_free(&res);
    return result;
}

/* Current working directory as freshly-malloc'd UTF-16 units (caller frees).
 * Returns nullptr / *out_len 0 if getcwd fails, which resolve treats as an empty
 * segment (best-effort, matching the "might happen when process.cwd() fails"
 * comment in Node's resolve). */
static c16 *path_get_cwd(usize *out_len) {
    usize cap = 256;
    char *buf = malloc(cap);
    while (getcwd(buf, cap) == nullptr) {
        if (errno != ERANGE) {
            free(buf);
            *out_len = 0;
            return nullptr;
        }
        cap *= 2;
        buf = realloc(buf, cap);
    }
    usize count;
    c16 *units = mal_utf8_decode((const byte *) buf, strlen(buf), &count);
    free(buf);
    *out_len = count;
    return units;
}

/* posix.resolve core: resolve args[0..argc) right-to-left into `out` (assumed
 * empty on entry), filling from getcwd when nothing absolute was seen. Returns
 * false with a pending throw if an argument that had to be visited is not a
 * string. */
static bool posix_resolve_core(MalVm *vm, const MalValue *args, i32 argc, MalPathBuf *out) {
    MalPathBuf resolved;
    path_buf_init(&resolved);
    bool resolved_absolute = false;

    for (i32 i = argc - 1; i >= -1 && !resolved_absolute; --i) {
        const c16 *pu;
        usize pl;
        c16 *cwd_units = nullptr;
        if (i >= 0) {
            if (!mal_value_is_string(args[i])) {
                char msg[96];
                snprintf(msg, sizeof(msg),
                    "The \"paths[%d]\" argument must be of type string.", i);
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) msg);
                path_buf_free(&resolved);
                return false;
            }
            MalString *s = mal_value_to_string(args[i]);
            pu = mal_string_code_units(s);
            pl = mal_string_length(s);
        } else {
            usize cwd_len;
            cwd_units = path_get_cwd(&cwd_len);
            pu = cwd_units;
            pl = cwd_len;
        }
        if (pl == 0) {
            free(cwd_units);
            continue;
        }
        path_buf_prepend_seg(&resolved, pu, pl);
        resolved_absolute = pu[0] == PATH_SEP;
        free(cwd_units);
    }

    MalPathBuf norm;
    path_buf_init(&norm);
    normalize_string(resolved.data, (i64) resolved.len, !resolved_absolute, &norm);
    path_buf_free(&resolved);

    if (resolved_absolute) {
        path_buf_push_char(out, PATH_SEP);
        path_buf_push_units(out, norm.data, norm.len);
    } else if (norm.len > 0) {
        path_buf_push_units(out, norm.data, norm.len);
    } else {
        path_buf_push_char(out, PATH_DOT);
    }
    path_buf_free(&norm);
    return true;
}

/* --------------------------------------------------------------------------
 * Exported methods (MalNativeFunctionCallback ABI).
 * -------------------------------------------------------------------------- */

static MalValue mal_node_path_resolve(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalPathBuf out;
    path_buf_init(&out);
    if (!posix_resolve_core(vm, args, argc, &out)) {
        path_buf_free(&out);
        return mal_value_new_undefined();
    }
    MalValue result = path_units(vm, out.data, out.len);
    path_buf_free(&out);
    return result;
}

static MalValue mal_node_path_normalize(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    return posix_normalize_units(
        vm, mal_string_code_units(s), (i64) mal_string_length(s));
}

static MalValue mal_node_path_is_absolute(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    bool absolute = mal_string_length(s) > 0 && mal_string_code_units(s)[0] == PATH_SEP;
    return mal_value_new_boolean(absolute);
}

static MalValue mal_node_path_join(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    if (argc == 0) {
        return path_ascii(vm, ".");
    }
    MalPathBuf joined;
    path_buf_init(&joined);
    bool have = false;
    for (i32 i = 0; i < argc; ++i) {
        MalString *s;
        if (!path_require_string(vm, args[i], "path", &s)) {
            path_buf_free(&joined);
            return mal_value_new_undefined();
        }
        usize sl = mal_string_length(s);
        if (sl > 0) {
            if (have) {
                path_buf_push_char(&joined, PATH_SEP);
            }
            path_buf_push_units(&joined, mal_string_code_units(s), sl);
            have = true;
        }
    }
    MalValue result = have ? posix_normalize_units(vm, joined.data, (i64) joined.len)
                           : path_ascii(vm, ".");
    path_buf_free(&joined);
    return result;
}

static MalValue mal_node_path_dirname(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *p = mal_string_code_units(s);
    i64 len = (i64) mal_string_length(s);
    if (len == 0) {
        return path_ascii(vm, ".");
    }
    bool has_root = p[0] == PATH_SEP;
    i64 end = -1;
    bool matched_slash = true;
    for (i64 i = len - 1; i >= 1; --i) {
        if (p[i] == PATH_SEP) {
            if (!matched_slash) {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
    }

    if (end == -1) {
        return has_root ? path_ascii(vm, "/") : path_ascii(vm, ".");
    }
    if (has_root && end == 1) {
        return path_ascii(vm, "//");
    }
    return path_units(vm, p, (usize) end);
}

static MalValue mal_node_path_basename(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *p = mal_string_code_units(s);
    i64 end = (i64) mal_string_length(s);
    while (end > 0 && p[end - 1] == PATH_SEP) end--;
    i64 start = end;
    while (start > 0 && p[start - 1] != PATH_SEP) start--;
    return path_units(vm, p + start, (usize) (end - start));
}

static MalValue mal_node_path_extname(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *p = mal_string_code_units(s);
    i64 len = (i64) mal_string_length(s);
    i64 start_dot = -1;
    i64 start_part = 0;
    i64 end = -1;
    bool matched_slash = true;
    // -1: seen a non-dot char after the first dot; 0: initial; 1: seen a preceding dot.
    i64 pre_dot_state = 0;

    for (i64 i = len - 1; i >= 0; --i) {
        c16 code = p[i];
        if (code == PATH_SEP) {
            if (!matched_slash) {
                start_part = i + 1;
                break;
            }
            continue;
        }
        if (end == -1) {
            matched_slash = false;
            end = i + 1;
        }
        if (code == PATH_DOT) {
            if (start_dot == -1) {
                start_dot = i;
            } else if (pre_dot_state != 1) {
                pre_dot_state = 1;
            }
        } else if (start_dot != -1) {
            pre_dot_state = -1;
        }
    }

    if (start_dot == -1 || end == -1 || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)) {
        return path_ascii(vm, "");
    }
    return path_units(vm, &p[start_dot], (usize) (end - start_dot));
}

static MalValue mal_node_path_relative(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalValue from_v = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue to_v = argc >= 2 ? args[1] : mal_value_new_undefined();
    MalString *from_s;
    MalString *to_s;
    if (!path_require_string(vm, from_v, "from", &from_s)) {
        return mal_value_new_undefined();
    }
    if (!path_require_string(vm, to_v, "to", &to_s)) {
        return mal_value_new_undefined();
    }
    if (mal_string_equals(from_s, to_s)) {
        return path_ascii(vm, "");
    }

    MalValue from_one[1] = {from_v};
    MalValue to_one[1] = {to_v};
    MalPathBuf from_buf;
    MalPathBuf to_buf;
    path_buf_init(&from_buf);
    path_buf_init(&to_buf);
    if (!posix_resolve_core(vm, from_one, 1, &from_buf)
        || !posix_resolve_core(vm, to_one, 1, &to_buf)) {
        path_buf_free(&from_buf);
        path_buf_free(&to_buf);
        return mal_value_new_undefined();
    }

    const c16 *from = from_buf.data;
    const c16 *to = to_buf.data;
    i64 from_total = (i64) from_buf.len;
    i64 to_total = (i64) to_buf.len;

    if (from_total == to_total
        && memcmp(from, to, (usize) from_total * sizeof(c16)) == 0) {
        path_buf_free(&from_buf);
        path_buf_free(&to_buf);
        return path_ascii(vm, "");
    }

    // Both resolved paths are absolute; skip the leading '/'.
    i64 from_start = 1;
    i64 from_end = from_total;
    i64 from_len = from_end - from_start;
    i64 to_start = 1;
    i64 to_len = to_total - to_start;
    i64 length = from_len < to_len ? from_len : to_len;
    i64 last_common_sep = -1;
    i64 i = 0;
    for (; i < length; ++i) {
        c16 from_code = from[from_start + i];
        if (from_code != to[to_start + i]) {
            break;
        } else if (from_code == PATH_SEP) {
            last_common_sep = i;
        }
    }
    if (i == length) {
        if (to_len > length) {
            if (to[to_start + i] == PATH_SEP) {
                // `from` is the exact base path of `to` (from='/foo/bar', to='/foo/bar/baz').
                MalValue r = path_units(vm, &to[to_start + i + 1],
                    (usize) (to_total - (to_start + i + 1)));
                path_buf_free(&from_buf);
                path_buf_free(&to_buf);
                return r;
            }
            if (i == 0) {
                // `from` is the root (from='/', to='/foo').
                MalValue r = path_units(vm, &to[to_start + i], (usize) (to_total - (to_start + i)));
                path_buf_free(&from_buf);
                path_buf_free(&to_buf);
                return r;
            }
        } else if (from_len > length) {
            if (from[from_start + i] == PATH_SEP) {
                // `to` is the exact base path of `from`.
                last_common_sep = i;
            } else if (i == 0) {
                // `to` is the root.
                last_common_sep = 0;
            }
        }
    }

    MalPathBuf out;
    path_buf_init(&out);
    for (i = from_start + last_common_sep + 1; i <= from_end; ++i) {
        if (i == from_end || from[i] == PATH_SEP) {
            if (out.len == 0) {
                path_buf_push_char(&out, PATH_DOT);
                path_buf_push_char(&out, PATH_DOT);
            } else {
                path_buf_push_char(&out, PATH_SEP);
                path_buf_push_char(&out, PATH_DOT);
                path_buf_push_char(&out, PATH_DOT);
            }
        }
    }
    // Append the tail of `to` after the common prefix (keeps its leading '/').
    i64 tail_start = to_start + last_common_sep;
    path_buf_push_units(&out, &to[tail_start], (usize) (to_total - tail_start));

    MalValue result = path_units(vm, out.data, out.len);
    path_buf_free(&out);
    path_buf_free(&from_buf);
    path_buf_free(&to_buf);
    return result;
}

/* --------------------------------------------------------------------------
 * Installer.
 * -------------------------------------------------------------------------- */

// The exported surface, in one place: name, spec `.length`, and callback. Node's
// rest-parameter functions (join/resolve) report length 0; the fixed ones report
// their declared parameter count.
typedef struct {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} MalNodePathExport;

#define MAL_NODE_PATH_FUNCTION_COUNT 8

static const MalNodePathExport mal_node_path_exports[MAL_NODE_PATH_FUNCTION_COUNT] = {
    {"basename", 1, mal_node_path_basename},
    {"dirname", 1, mal_node_path_dirname},
    {"extname", 1, mal_node_path_extname},
    {"isAbsolute", 1, mal_node_path_is_absolute},
    {"join", 0, mal_node_path_join},
    {"normalize", 1, mal_node_path_normalize},
    {"relative", 2, mal_node_path_relative},
    {"resolve", 0, mal_node_path_resolve},
};

void mal_host_install_node_path(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // Function values plus the default namespace object and two constant strings.
    MalValue vals[MAL_NODE_PATH_FUNCTION_COUNT + 3];
    for (usize i = 0; i < countof(vals); ++i) {
        vals[i] = mal_value_new_undefined();
    }
    MalRootSpan rs;
    mal_gc_root(&rs, vals, (i32) countof(vals));

    for (usize i = 0; i < MAL_NODE_PATH_FUNCTION_COUNT; ++i) {
        const MalNodePathExport *e = &mal_node_path_exports[i];
        MalNativeFunctionObject *fn = mal_native_function_object_new_arity(
            &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) e->name), e->length,
            e->callback);
        vals[i] = mal_value_from_native_function_object(fn);
    }

    MalObject *def = mal_intrinsic_new_object(vm);
    vals[MAL_NODE_PATH_FUNCTION_COUNT] = mal_value_from_object(def);
    vals[MAL_NODE_PATH_FUNCTION_COUNT + 1] = path_ascii(vm, ":");
    vals[MAL_NODE_PATH_FUNCTION_COUNT + 2] = path_ascii(vm, "/");
    for (usize i = 0; i < MAL_NODE_PATH_FUNCTION_COUNT; ++i) {
        mal_intrinsic_define_data(vm, def, (const byte *) mal_node_path_exports[i].name, vals[i],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_data(vm, def, (const byte *) "delimiter",
        vals[MAL_NODE_PATH_FUNCTION_COUNT + 1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, def, (const byte *) "sep",
        vals[MAL_NODE_PATH_FUNCTION_COUNT + 2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    for (i32 s = 0; s < count; ++s) {
        const char *name = slots[s].name;
        MalValue value = mal_value_new_undefined();
        bool matched = false;
        for (usize i = 0; i < MAL_NODE_PATH_FUNCTION_COUNT; ++i) {
            if (strcmp(name, mal_node_path_exports[i].name) == 0) {
                value = vals[i];
                matched = true;
                break;
            }
        }
        if (!matched && strcmp(name, "default") == 0) {
            value = vals[MAL_NODE_PATH_FUNCTION_COUNT];
            matched = true;
        } else if (!matched && strcmp(name, "delimiter") == 0) {
            value = vals[MAL_NODE_PATH_FUNCTION_COUNT + 1];
            matched = true;
        } else if (!matched && strcmp(name, "sep") == 0) {
            value = vals[MAL_NODE_PATH_FUNCTION_COUNT + 2];
            matched = true;
        }
        if (matched) {
            vm->globals[slots[s].slot] = value;
        }
    }

    mal_gc_unroot(&rs);
}

#endif /* MAL_NODE */
