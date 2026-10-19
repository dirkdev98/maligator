#include "node_path.h"

#if MAL_NODE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "function_object.h"
#include "gc.h"
#include "checked_size.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "property_store.h"
#include "text_buffer.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

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

// Path normalization mutates contiguous UTF-16 scratch; finished strings own it.

typedef MalTextBuffer MalPathBuf;

static void path_buf_init(MalPathBuf *b) {
    *b = (MalPathBuf) {.utf16 = true};
}

static void path_buf_free(MalPathBuf *b) {
    mal_text_buffer_dispose(b);
}

static void path_buf_push_units(MalPathBuf *b, const c16 *units, usize n) {
    mal_text_buffer_append_units(b, units, n);
}

static void path_buf_push_char(MalPathBuf *b, c16 c) {
    mal_text_buffer_push(b, c);
}

/* Prepend `seg` + "/" to the buffer (the `${path}/${resolvedPath}` step of resolve). */
static void path_buf_prepend_seg(MalPathBuf *b, MalString *segment) {
    usize seg_len = mal_string_length(segment);
    usize add;
    if (!mal_checked_size_add(seg_len, 1, MAL_STRING_MAX_CODE_UNITS, &add)) {
        b->status = MAL_TEXT_BUFFER_LENGTH_OVERFLOW;
        return;
    }
    if (mal_text_buffer_reserve(b, add) != MAL_TEXT_BUFFER_OK) {
        return;
    }
    memmove((c16 *) b->data + add, b->data, b->length * sizeof(c16));
    mal_string_copy_range_to(segment, 0, seg_len, b->data);
    ((c16 *) b->data)[seg_len] = PATH_SEP;
    b->length += add;
}

/* Index of the last '/' in the buffer, or -1. */
static i64 path_buf_last_sep(const MalPathBuf *b, c16 separator) {
    for (i64 i = (i64) b->length - 1; i >= 0; --i) {
        if (mal_text_buffer_code_unit_at(b, (usize) i) == separator) {
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

static bool path_buf_check(MalVm *vm, const MalPathBuf *buffer) {
    if (buffer->status == MAL_TEXT_BUFFER_OK) {
        return true;
    }
    if (buffer->status == MAL_TEXT_BUFFER_LENGTH_OVERFLOW) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    } else {
        mal_vm_throw_allocation_error(vm);
    }
    return false;
}

static MalValue path_buf_to_value(MalVm *vm, MalPathBuf *buffer) {
    if (!path_buf_check(vm, buffer)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, buffer));
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

/* `win32` accepts '\\' as a separator too and joins with it, as Node's win32 caller does. */
static void normalize_string(const c16 *path, i64 len, bool allow_above_root, bool win32, MalPathBuf *res) {
    c16 separator = win32 ? (c16) '\\' : PATH_SEP;
    i64 last_segment_length = 0;
    i64 last_slash = -1;
    i64 dots = 0;
    c16 code = 0;

    for (i64 i = 0; i <= len; ++i) {
        if (i < len) {
            code = path[i];
        } else if (code == PATH_SEP || (win32 && code == '\\')) {
            break;
        } else {
            code = PATH_SEP;
        }

        if (code == PATH_SEP || (win32 && code == '\\')) {
            if (last_slash == i - 1 || dots == 1) {
                // NOOP: empty segment or a lone '.'.
            } else if (dots == 2) {
                if ((i64) res->length < 2 || last_segment_length != 2
                    || mal_text_buffer_code_unit_at(res, res->length - 1) != PATH_DOT
                    || mal_text_buffer_code_unit_at(res, res->length - 2) != PATH_DOT) {
                    if ((i64) res->length > 2) {
                        i64 last_sep_index = path_buf_last_sep(res, separator);
                        if (last_sep_index == -1) {
                            res->length = 0;
                            last_segment_length = 0;
                        } else {
                            res->length = (usize) last_sep_index;
                            last_segment_length = (i64) res->length - 1 - path_buf_last_sep(res, separator);
                        }
                        last_slash = i;
                        dots = 0;
                        continue;
                    } else if (res->length != 0) {
                        res->length = 0;
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        continue;
                    }
                }
                if (allow_above_root) {
                    if (res->length > 0) {
                        path_buf_push_char(res, separator);
                    }
                    path_buf_push_char(res, PATH_DOT);
                    path_buf_push_char(res, PATH_DOT);
                    last_segment_length = 2;
                }
            } else {
                i64 seg_len = i - last_slash - 1;
                if (res->length > 0) {
                    path_buf_push_char(res, separator);
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
    normalize_string(path, len, !is_absolute, false, &res);
    if (!path_buf_check(vm, &res)) {
        path_buf_free(&res);
        return mal_value_new_undefined();
    }

    MalValue result;
    if (res.length == 0) {
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
        path_buf_push_units(&out, res.data, res.length);
        if (trailing_sep) {
            path_buf_push_char(&out, PATH_SEP);
        }
        result = path_buf_to_value(vm, &out);
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
        MalString *segment;
        MalString cwd;
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
            segment = mal_value_to_string(args[i]);
        } else {
            usize length;
            cwd_units = path_get_cwd(&length);
            mal_string_init_external(&cwd, cwd_units, length);
            segment = &cwd;
        }
        if (mal_string_length(segment) == 0) {
            free(cwd_units);
            continue;
        }
        path_buf_prepend_seg(&resolved, segment);
        if (!path_buf_check(vm, &resolved)) {
            free(cwd_units);
            path_buf_free(&resolved);
            return false;
        }
        resolved_absolute = mal_string_code_unit_at(segment, 0) == PATH_SEP;
        free(cwd_units);
    }

    MalPathBuf norm;
    path_buf_init(&norm);
    normalize_string(resolved.data, (i64) resolved.length, !resolved_absolute, false, &norm);
    path_buf_free(&resolved);
    if (!path_buf_check(vm, &norm)) {
        path_buf_free(&norm);
        return false;
    }

    if (resolved_absolute) {
        path_buf_push_char(out, PATH_SEP);
        path_buf_push_units(out, norm.data, norm.length);
    } else if (norm.length > 0) {
        path_buf_push_units(out, norm.data, norm.length);
    } else {
        path_buf_push_char(out, PATH_DOT);
    }
    path_buf_free(&norm);
    return path_buf_check(vm, out);
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
    MalValue result = path_buf_to_value(vm, &out);
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
    bool absolute = mal_string_length(s) > 0 && mal_string_code_unit_at(s, 0) == PATH_SEP;
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
            mal_text_buffer_append_string(&joined, s);
            have = true;
        }
    }
    MalValue result = path_buf_check(vm, &joined)
        ? (have ? posix_normalize_units(vm, joined.data, (i64) joined.length)
                : path_ascii(vm, "."))
        : mal_value_new_undefined();
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
    MalString *suffix = nullptr;
    if (argc >= 2 && !mal_value_is_undefined(args[1])
        && !path_require_string(vm, args[1], "suffix", &suffix)) {
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!path_require_string(vm,
            argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *p = mal_string_code_units(s);
    i64 length = (i64) mal_string_length(s);
    i64 start = 0;
    i64 end = -1;
    bool matched_slash = true;
    if (suffix != nullptr && mal_string_length(suffix) > 0
        && mal_string_length(suffix) <= (usize) length) {
        if (mal_string_equals(suffix, s)) return path_ascii(vm, "");
        const c16 *suffix_units = mal_string_code_units(suffix);
        i64 suffix_index = (i64) mal_string_length(suffix) - 1;
        i64 first_non_slash_end = -1;
        for (i64 i = length - 1; i >= 0; i--) {
            c16 code = p[i];
            if (code == PATH_SEP) {
                if (!matched_slash) {
                    start = i + 1;
                    break;
                }
            } else {
                if (first_non_slash_end == -1) {
                    matched_slash = false;
                    first_non_slash_end = i + 1;
                }
                if (suffix_index >= 0) {
                    if (code == suffix_units[suffix_index]) {
                        if (--suffix_index == -1) end = i;
                    } else {
                        suffix_index = -1;
                        end = first_non_slash_end;
                    }
                }
            }
        }
        if (start == end) {
            end = first_non_slash_end;
        } else if (end == -1) {
            end = length;
        }
        return path_units(vm, p + start, (usize) (end - start));
    }
    for (i64 i = length - 1; i >= 0; i--) {
        if (p[i] == PATH_SEP) {
            if (!matched_slash) {
                start = i + 1;
                break;
            }
        } else if (end == -1) {
            matched_slash = false;
            end = i + 1;
        }
    }
    if (end == -1) return path_ascii(vm, "");
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

static bool path_get_named(
    MalVm *vm, MalValue object, const char *name, MalValue *out
) {
    return mal_vm_get_property(
        vm, object, mal_intrinsic_string_key(vm, (const byte *) name), out);
}

static bool path_append_value(
    MalVm *vm, MalPathBuf *buffer, MalValue value, MalValue *string_root
) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    *string_root = mal_value_from_string(string);
    mal_text_buffer_append_string(buffer, string);
    return path_buf_check(vm, buffer);
}

/* Node's _format(sep, pathObject), shared by the posix and win32 bindings. */
static MalValue path_format_with(MalVm *vm, const MalValue *args, i32 argc, c16 separator) {
    MalValue roots[] = {
        argc >= 1 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_object(roots[0])
        || mal_value_is_array_object(roots[0])
        || mal_value_is_callable(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"pathObject\" argument must be of type object");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }

    if (!path_get_named(vm, roots[0], "dir", &roots[1])) goto fail;
    if (!mal_value_is_truthy(roots[1])
        && !path_get_named(vm, roots[0], "root", &roots[1])) goto fail;

    if (!path_get_named(vm, roots[0], "base", &roots[3])) goto fail;
    if (!mal_value_is_truthy(roots[3])) {
        MalPathBuf base;
        path_buf_init(&base);
        if (!path_get_named(vm, roots[0], "name", &roots[4])) {
            path_buf_free(&base);
            goto fail;
        }
        if (mal_value_is_truthy(roots[4])
            && !path_append_value(vm, &base, roots[4], &roots[6])) {
            path_buf_free(&base);
            goto fail;
        }
        if (!path_get_named(vm, roots[0], "ext", &roots[5])) {
            path_buf_free(&base);
            goto fail;
        }
        if (mal_value_is_truthy(roots[5])) {
            MalValue first;
            if (!mal_vm_get_property(vm, roots[5], mal_key_index(0), &first)) {
                path_buf_free(&base);
                goto fail;
            }
            MalValue dot = path_ascii(vm, ".");
            if (!mal_ops_strict_equal_bool(first, dot)) {
                path_buf_push_char(&base, PATH_DOT);
            }
            if (!path_append_value(vm, &base, roots[5], &roots[6])) {
                path_buf_free(&base);
                goto fail;
            }
        }
        roots[3] = path_buf_to_value(vm, &base);
        path_buf_free(&base);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    }

    if (!mal_value_is_truthy(roots[1])) {
        MalValue result = roots[3];
        mal_gc_unroot(&root);
        return result;
    }
    if (!path_get_named(vm, roots[0], "root", &roots[2])) goto fail;
    MalPathBuf output;
    path_buf_init(&output);
    if (!path_append_value(vm, &output, roots[1], &roots[6])) {
        path_buf_free(&output);
        goto fail;
    }
    if (!mal_ops_strict_equal_bool(roots[1], roots[2])) {
        path_buf_push_char(&output, separator);
    }
    if (!path_append_value(vm, &output, roots[3], &roots[6])) {
        path_buf_free(&output);
        goto fail;
    }
    roots[6] = path_buf_to_value(vm, &output);
    path_buf_free(&output);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    MalValue result = roots[6];
    mal_gc_unroot(&root);
    return result;

fail:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_node_path_format(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee
) {
    (void) this_value;
    (void) nt;
    (void) callee;
    return path_format_with(vm, args, argc, PATH_SEP);
}

static void path_parse_define(
    MalVm *vm, MalObject *object, const char *name, MalValue value
) {
    mal_intrinsic_define_data(vm, object, (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE
            | MAL_PROPERTY_CONFIGURABLE);
}

static MalValue mal_node_path_parse(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee
) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalString *string;
    if (!path_require_string(vm,
            argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &string)) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (usize i = 1; i < countof(roots); ++i) {
        roots[i] = path_ascii(vm, "");
    }
    const c16 *units = mal_string_code_units(string);
    i64 length = (i64) mal_string_length(string);
    bool absolute = length > 0 && units[0] == PATH_SEP;
    if (absolute) roots[1] = path_ascii(vm, "/");
    i64 start = absolute ? 1 : 0;
    i64 start_dot = -1;
    i64 start_part = 0;
    i64 end = -1;
    bool matched_slash = true;
    i64 pre_dot_state = 0;
    for (i64 i = length - 1; i >= start; i--) {
        c16 code = units[i];
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
    if (end != -1) {
        i64 part_start = start_part == 0 && absolute ? 1 : start_part;
        roots[3] = path_units(
            vm, units + part_start, (usize) (end - part_start));
        if (start_dot == -1 || pre_dot_state == 0
            || (pre_dot_state == 1 && start_dot == end - 1
                && start_dot == start_part + 1)) {
            roots[5] = roots[3];
        } else {
            roots[4] = path_units(
                vm, units + start_dot, (usize) (end - start_dot));
            roots[5] = path_units(
                vm, units + part_start, (usize) (start_dot - part_start));
        }
    }
    if (start_part > 0) {
        roots[2] = path_units(vm, units, (usize) (start_part - 1));
    } else if (absolute) {
        roots[2] = path_ascii(vm, "/");
    }
    MalObject *result = mal_value_to_object(roots[0]);
    path_parse_define(vm, result, "root", roots[1]);
    path_parse_define(vm, result, "dir", roots[2]);
    path_parse_define(vm, result, "base", roots[3]);
    path_parse_define(vm, result, "ext", roots[4]);
    path_parse_define(vm, result, "name", roots[5]);
    MalValue value = roots[0];
    mal_gc_unroot(&root);
    return value;
}

static MalValue mal_node_path_to_namespaced_path(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) nt;
    (void) callee;
    return argc >= 1 ? args[0] : mal_value_new_undefined();
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
    i64 from_total = (i64) from_buf.length;
    i64 to_total = (i64) to_buf.length;

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
            if (out.length == 0) {
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

    MalValue result = path_buf_to_value(vm, &out);
    path_buf_free(&out);
    path_buf_free(&from_buf);
    path_buf_free(&to_buf);
    return result;
}


MalValue mal_node_path_resolve_path(MalVm *vm, MalValue path) {
    return mal_node_path_resolve(vm, mal_value_new_undefined(), &path, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

typedef struct {
    MalVm *vm;
    usize remaining;
    usize depth;
} PathGlobContext;

static bool path_glob_work(PathGlobContext *ctx) {
    if (ctx->vm->completion.kind == MAL_COMPLETION_THROW) return false;
    if (ctx->remaining > 0) { ctx->remaining--; return true; }
    if (ctx->vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error(ctx->vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Glob pattern is too complex");
    }
    return false;
}

static bool path_glob_enter(PathGlobContext *ctx) {
    if (ctx->vm->completion.kind == MAL_COMPLETION_THROW) return false;
    if (ctx->depth >= 256) {
        mal_vm_throw_error(ctx->vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Glob pattern is too complex");
        return false;
    }
    ctx->depth++;
    return true;
}


static bool path_glob_explicit_dot(PathGlobContext *ctx, const c16 *p, usize pn);

static bool path_glob_explicit_dot_impl(PathGlobContext *ctx, const c16 *p, usize pn) {
    if (pn == 0) return false;
    if (p[0] == '.') return true;
    if (pn > 1 && p[0] == '\\' && p[1] == '.') return true;
    if (pn >= 3 && p[0] == '[' && p[1] == '.' && p[2] == ']') return true;
    if (pn > 2 && p[1] == '(' && (p[0] == '@' || p[0] == '?' || p[0] == '+' || p[0] == '*')) {
        usize begin = 2;
        usize depth = 0;
        for (usize i = begin; i < pn; i++) {
            if (p[i] == '(') depth++;
            if (p[i] == ')' && depth == 0) return path_glob_explicit_dot(ctx, p + begin, i - begin);
            if (p[i] == ')' && depth > 0) depth--;
            if (p[i] == '|' && depth == 0) {
                if (path_glob_explicit_dot(ctx, p + begin, i - begin)) return true;
                begin = i + 1;
            }
        }
    }
    return false;
}

static bool path_glob_explicit_dot(PathGlobContext *ctx, const c16 *p, usize pn) {
    if (!path_glob_enter(ctx)) return false;
    bool result = path_glob_explicit_dot_impl(ctx, p, pn);
    ctx->depth--;
    return result;
}

static bool path_glob_atom(c16 s, const c16 *p, usize pn, usize *consumed) {
    *consumed = 1;
    if (p[0] == '?') return true;
    if (p[0] == '\\' && pn > 1) { *consumed = 2; return s == p[1]; }
    if (p[0] != '[') return s == p[0];
    usize end = 1;
    if (end < pn && (p[end] == '!' || p[end] == '^')) end++;
    if (end < pn && p[end] == ']') end++;
    while (end < pn && p[end] != ']') end++;
    if (end == pn) return s == '[';
    usize n = 1;
    bool negate = p[n] == '!' || p[n] == '^';
    if (negate) n++;
    bool found = false;
    while (n < end) {
        c16 low = p[n++];
        if (low == '\\' && n < end) low = p[n++];
        if (n + 1 < end && p[n] == '-') {
            c16 high = p[n + 1]; n += 2;
            if (s >= low && s <= high) found = true;
        } else if (s == low) found = true;
    }
    *consumed = end + 1;
    return found != negate;
}

static bool path_glob_simple(const c16 *s, usize sn, const c16 *p, usize pn) {
    usize si = 0, pi = 0, star = SIZE_MAX, retry = 0;
    while (si < sn) {
        if (pi < pn && p[pi] == '*') { star = ++pi; retry = si; continue; }
        usize consumed;
        if (pi < pn && path_glob_atom(s[si], p + pi, pn - pi, &consumed)) {
            si++; pi += consumed; continue;
        }
        if (star == SIZE_MAX) return false;
        pi = star; si = ++retry;
    }
    while (pi < pn && p[pi] == '*') pi++;
    return pi == pn;
}

static bool path_glob_segment(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn);
static bool path_glob_alternatives(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn);
static bool path_glob_repeat(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *group, usize gn, const c16 *suffix, usize suffix_length, bool required);
static bool path_glob_parts(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn, bool partial);


static bool path_glob_alternatives_impl(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn) {
    usize begin = 0;
    usize depth = 0;
    for (usize i = 0; i <= pn; i++) {
        if (i < pn && p[i] == '\\' && i + 1 < pn) { i++; continue; }
        if (i < pn && p[i] == '(') depth++;
        if (i < pn && p[i] == ')' && depth > 0) depth--;
        if (i == pn || (p[i] == '|' && depth == 0)) {
            if (path_glob_segment(ctx, s, sn, p + begin, i - begin)) return true;
            begin = i + 1;
        }
    }
    return false;
}

static bool path_glob_repeat_impl(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *group, usize gn,
    const c16 *suffix, usize suffix_length, bool required) {
    if (!path_glob_work(ctx)) return false;
    if (!required && path_glob_segment(ctx, s, sn, suffix, suffix_length)) return true;
    for (usize n = 1; n <= sn; n++) {
        if (ctx->vm->completion.kind == MAL_COMPLETION_THROW) return false;
        if (path_glob_alternatives(ctx, s, n, group, gn)
            && path_glob_repeat(ctx, s + n, sn - n, group, gn, suffix, suffix_length, false)) {
            return true;
        }
    }
    return required && path_glob_alternatives(ctx, s, 0, group, gn)
        && path_glob_segment(ctx, s, sn, suffix, suffix_length);
}

static bool path_glob_segment_impl(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn) {
    if (!path_glob_work(ctx)) return false;
    bool extended = false;
    for (usize i = 0; i + 1 < pn; i++) {
        if (p[i] == '\\') { i++; continue; }
        if (p[i + 1] == '(' && (p[i] == '@' || p[i] == '?' || p[i] == '+' || p[i] == '*' || p[i] == '!')) {
            extended = true;
            break;
        }
    }
    if (!extended) return path_glob_simple(s, sn, p, pn);
    while (pn > 0) {
        c16 c = *p;
        if (pn > 1 && p[1] == '(' && (c == '@' || c == '?' || c == '+' || c == '*' || c == '!')) {
            usize end = 2;
            usize depth = 1;
            for (; end < pn; end++) {
                if (p[end] == '\\' && end + 1 < pn) { end++; continue; }
                if (p[end] == '(') depth++;
                if (p[end] == ')' && --depth == 0) break;
            }
            if (end < pn) {
                const c16 *suffix = p + end + 1;
                usize suffix_length = pn - end - 1;
                if (c == '*' || c == '+') {
                    return path_glob_repeat(ctx, s, sn, p + 2, end - 2, suffix, suffix_length, c == '+');
                }
                if (c == '?' && path_glob_segment(ctx, s, sn, suffix, suffix_length)) return true;
                for (usize n = 0; n <= sn; n++) {
                    if (ctx->vm->completion.kind == MAL_COMPLETION_THROW) return false;
                    bool group_match = path_glob_alternatives(ctx, s, n, p + 2, end - 2);
                    if ((c == '!' ? !group_match : group_match)
                        && path_glob_segment(ctx, s + n, sn - n, suffix, suffix_length)) return true;
                }
                return false;
            }
        }
        if (c == '*') {
            do { p++; pn--; } while (pn > 0 && *p == '*');
            if (pn == 0) return true;
            for (usize n = 0; n <= sn; n++) {
                if (ctx->vm->completion.kind == MAL_COMPLETION_THROW) return false;
                if (path_glob_segment(ctx, s + n, sn - n, p, pn)) return true;
            }
            return false;
        }
        if (sn == 0) return false;
        if (c == '?') { s++; sn--; p++; pn--; continue; }
        if (c == '[') {
            usize end = 1;
            if (end < pn && (p[end] == '!' || p[end] == '^')) end++;
            if (end < pn && p[end] == ']') end++;
            while (end < pn && p[end] != ']') end++;
            if (end < pn) {
                usize n = 1;
                bool negate = p[n] == '!' || p[n] == '^';
                if (negate) n++;
                bool found = false;
                while (n < end) {
                    c16 low = p[n++];
                    if (low == '\\' && n < end) low = p[n++];
                    if (n + 1 < end && p[n] == '-') {
                        c16 high = p[n + 1];
                        n += 2;
                        if (*s >= low && *s <= high) found = true;
                    } else if (*s == low) found = true;
                }
                if (found == negate) return false;
                s++; sn--; p += end + 1; pn -= end + 1;
                continue;
            }
        }
        if (c == '\\' && pn > 1) { p++; pn--; c = *p; }
        if (*s != c) return false;
        s++; sn--; p++; pn--;
    }
    return sn == 0;
}

static bool path_glob_parts_impl(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn, bool partial) {
    if (!path_glob_work(ctx)) return false;
    usize se = 0;
    usize pe = 0;
    while (se < sn && s[se] != '/') se++;
    while (pe < pn && p[pe] != '/') pe++;
    bool globstar = pe == 2 && p[0] == '*' && p[1] == '*';
    if (globstar) {
        usize next = pe;
        while (next < pn && p[next] == '/') next++;
        if (next < pn && path_glob_parts(ctx, s, sn, p + next, pn - next, partial)) return true;
        if (sn == 0) return next == pn || partial;
        if (s[0] == '.') return false;
        if (next == pn && se == sn) return true;
        if (se < sn) {
            usize step = se;
            while (step < sn && s[step] == '/') step++;
            return path_glob_parts(ctx, s + step, sn - step, p, pn, partial);
        }
        return partial;
    }
    if (sn == 0 && partial) return true;
    if (se > 0 && s[0] == '.' && !path_glob_explicit_dot(ctx, p, pe)) return false;
    if (se == 0 && pe > 0) return false;
    if (!path_glob_segment(ctx, s, se, p, pe)) return false;
    if (pe == pn) {
        while (se < sn && s[se] == '/') se++;
        return se == sn;
    }
    if (se == sn) return partial;
    while (se < sn && s[se] == '/') se++;
    while (pe < pn && p[pe] == '/') pe++;
    return path_glob_parts(ctx, s + se, sn - se, p + pe, pn - pe, partial);
}


static bool path_glob_segment(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn) {
    if (!path_glob_enter(ctx)) return false;
    bool result = path_glob_segment_impl(ctx, s, sn, p, pn);
    ctx->depth--;
    return result;
}

static bool path_glob_alternatives(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn) {
    if (!path_glob_enter(ctx)) return false;
    bool result = path_glob_alternatives_impl(ctx, s, sn, p, pn);
    ctx->depth--;
    return result;
}

static bool path_glob_repeat(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *group,
    usize gn, const c16 *suffix, usize suffix_length, bool required) {
    if (!path_glob_enter(ctx)) return false;
    bool result = path_glob_repeat_impl(ctx, s, sn, group, gn, suffix, suffix_length, required);
    ctx->depth--;
    return result;
}

static bool path_glob_parts(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn, bool partial) {
    if (!path_glob_enter(ctx)) return false;
    bool result = path_glob_parts_impl(ctx, s, sn, p, pn, partial);
    ctx->depth--;
    return result;
}

static bool path_glob_range_number(const c16 *p, usize n, i64 *out) {
    bool negative = n > 0 && p[0] == '-';
    usize i = negative ? 1 : 0;
    if (i == n || n > 15) return false;
    i64 value = 0;
    for (; i < n; i++) {
        if (p[i] < '0' || p[i] > '9') return false;
        value = value * 10 + p[i] - '0';
    }
    *out = negative ? -value : value;
    return true;
}

static bool path_glob_expand(PathGlobContext *ctx, const c16 *s, usize sn, const c16 *p, usize pn,
    bool partial, usize depth) {
    if (depth > 64) {
        mal_vm_throw_error(ctx->vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Glob pattern is too complex");
        return false;
    }
    usize begin = 0;
    for (; begin < pn; begin++) {
        if (p[begin] == '\\' && begin + 1 < pn) { begin++; continue; }
        if (p[begin] == '{') break;
    }
    if (begin == pn) return path_glob_parts(ctx, s, sn, p, pn, partial);
    usize end = begin + 1;
    usize nesting = 1;
    bool comma = false;
    for (; end < pn; end++) {
        if (p[end] == '\\' && end + 1 < pn) { end++; continue; }
        if (p[end] == '{') nesting++;
        if (p[end] == '}' && --nesting == 0) break;
        if (p[end] == ',' && nesting == 1) comma = true;
    }
    if (end == pn) return path_glob_parts(ctx, s, sn, p, pn, partial);
    if (!comma) {
        usize separator = begin + 1;
        while (separator + 1 < end && !(p[separator] == '.' && p[separator + 1] == '.')) separator++;
        if (separator + 1 >= end) return path_glob_parts(ctx, s, sn, p, pn, partial);
        usize step_at = separator + 2;
        while (step_at + 1 < end && !(p[step_at] == '.' && p[step_at + 1] == '.')) step_at++;
        if (step_at + 1 >= end) step_at = end;
        i64 low, high, step = 1;
        usize low_length = separator - begin - 1;
        usize high_length = step_at - separator - 2;
        bool numbers = path_glob_range_number(p + begin + 1, low_length, &low)
            && path_glob_range_number(p + separator + 2, high_length, &high);
        if (!numbers) {
            if (low_length != 1 || high_length != 1) return path_glob_parts(ctx, s, sn, p, pn, partial);
            low = p[begin + 1]; high = p[separator + 2];
        }
        if (step_at < end && !path_glob_range_number(p + step_at + 2, end - step_at - 2, &step)) {
            return path_glob_parts(ctx, s, sn, p, pn, partial);
        }
        if (step < 0) step = -step;
        if (step == 0) step = 1;
        if ((u64) (low > high ? low - high : high - low) / (u64) step > 10000) {
            mal_vm_throw_error(ctx->vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Glob pattern is too complex");
            return false;
        }
        c16 *expanded = malloc((pn + 32) * sizeof(c16));
        if (expanded == nullptr) { mal_vm_throw_allocation_error(ctx->vm); return false; }
        memcpy(expanded, p, begin * sizeof(c16));
        bool matched = false;
        bool padded = numbers && ((low_length > 1 && p[begin + 1] == '0')
            || (high_length > 1 && p[separator + 2] == '0')
            || (low_length > 2 && p[begin + 1] == '-' && p[begin + 2] == '0')
            || (high_length > 2 && p[separator + 2] == '-' && p[separator + 3] == '0'));
        int width = padded ? (int) (low_length > high_length ? low_length : high_length) : 0;
        for (i64 value = low; low <= high ? value <= high : value >= high; value += low <= high ? step : -step) {
            char formatted[32];
            usize expansion_length;
            if (numbers) {
                expansion_length = (usize) snprintf(formatted, sizeof(formatted), "%0*lld", width, (long long) value);
                for (usize i = 0; i < expansion_length; i++) expanded[begin + i] = (c16) formatted[i];
            } else { expansion_length = 1; expanded[begin] = (c16) value; }
            memcpy(expanded + begin + expansion_length, p + end + 1, (pn - end - 1) * sizeof(c16));
            matched = path_glob_expand(ctx, s, sn, expanded, begin + expansion_length + pn - end - 1, partial, depth + 1);
            if (matched || ctx->vm->completion.kind == MAL_COMPLETION_THROW) break;
        }
        free(expanded);
        return matched;
    }
    c16 *expanded = malloc(pn * sizeof(c16));
    if (expanded == nullptr) { mal_vm_throw_allocation_error(ctx->vm); return false; }
    memcpy(expanded, p, begin * sizeof(c16));
    usize branch = begin + 1;
    nesting = 0;
    bool matched = false;
    for (usize i = branch; i <= end; i++) {
        if (i < end && p[i] == '\\' && i + 1 < end) { i++; continue; }
        if (i < end && p[i] == '{') nesting++;
        if (i < end && p[i] == '}' && nesting > 0) nesting--;
        if (i == end || (p[i] == ',' && nesting == 0)) {
            usize expansion_length = i - branch;
            memcpy(expanded + begin, p + branch, expansion_length * sizeof(c16));
            memcpy(expanded + begin + expansion_length, p + end + 1, (pn - end - 1) * sizeof(c16));
            matched = path_glob_expand(ctx, s, sn, expanded,
                begin + expansion_length + pn - end - 1, partial, depth + 1);
            if (matched || ctx->vm->completion.kind == MAL_COMPLETION_THROW) break;
            branch = i + 1;
        }
    }
    free(expanded);
    return matched;
}

bool mal_node_path_glob_match(MalVm *vm, MalString *path, MalString *pattern, bool partial) {
    const c16 *s = mal_string_code_units(path);
    const c16 *p = mal_string_code_units(pattern);
    usize sn = mal_string_length(path);
    usize pn = mal_string_length(pattern);
    if ((sn > 0 && s[0] == '/') != (pn > 0 && p[0] == '/')) return false;
    PathGlobContext context = {.vm = vm, .remaining = 1000000};
    return path_glob_expand(&context, s, sn, p, pn, partial, 0);
}

static MalValue mal_node_path_matches_glob(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalString *path;
    MalString *pattern;
    if (!path_require_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "path", &path)
        || !path_require_string(vm, argc > 1 ? args[1] : mal_value_new_undefined(), "pattern", &pattern)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(mal_node_path_glob_match(vm, path, pattern, false));
}

/* --------------------------------------------------------------------------
 * Installer.
 * -------------------------------------------------------------------------- */

// The exported surface, in one place: name, spec `.length`, and callback. Node's
// rest-parameter functions (join/resolve) report length 0; the fixed ones report
// their declared parameter count.

/* --------------------------------------------------------------------------
 * path.win32: a port of Node's lib/path.js `win32` object. Both '\\' and '/'
 * separate; output uses '\\'. Only resolve consults the process (cwd and the
 * per-drive "=X:" variables Windows keeps in the environment).
 * -------------------------------------------------------------------------- */

#define WIN_SEP ((c16) '\\')

static bool win_is_sep(c16 code) {
    return code == '/' || code == '\\';
}

static bool win_is_device_root(c16 code) {
    return (code >= 'A' && code <= 'Z') || (code >= 'a' && code <= 'z');
}

static c16 win_lower(c16 code) {
    return code >= 'A' && code <= 'Z' ? (c16) (code + 32) : code;
}

static i64 win_index_of(const c16 *p, i64 len, c16 needle, i64 from) {
    for (i64 i = from < 0 ? 0 : from; i < len; i++) {
        if (p[i] == needle) return i;
    }
    return -1;
}

/* Node's isWindowsReservedName: path.slice(0, colonIndex) upper-cased, with slice's
 * negative-index rule, so a missing colon (-1) tests all but the last code unit. */
static bool win_reserved_name(const c16 *p, i64 len, i64 colon_index) {
    static const char *const names[] = {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5",
        "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "COM\xb9", "COM\xb2", "COM\xb3", "LPT\xb9", "LPT\xb2", "LPT\xb3"};
    i64 end = colon_index < 0 ? len + colon_index : colon_index;
    if (end < 0) end = 0;
    if (end > len) end = len;
    for (usize n = 0; n < countof(names); n++) {
        usize length = strlen(names[n]);
        if ((i64) length != end) continue;
        bool same = true;
        for (usize i = 0; i < length && same; i++) {
            c16 code = p[i] >= 'a' && p[i] <= 'z' ? (c16) (p[i] - 32) : p[i];
            same = code == (c16) (u8) names[n][i];
        }
        if (same) return true;
    }
    return false;
}

static void win_push_ascii(MalPathBuf *b, const char *text) {
    while (*text != '\0') path_buf_push_char(b, (c16) *text++);
}

static MalValue win_slice(MalVm *vm, const c16 *p, i64 start, i64 end) {
    return path_units(vm, p + start, (usize) (end > start ? end - start : 0));
}

static MalValue win_normalize_units(MalVm *vm, const c16 *path, i64 len) {
    if (len == 0) return path_ascii(vm, ".");
    i64 root_end = 0;
    bool has_device = false;
    MalPathBuf device;
    path_buf_init(&device);
    bool is_absolute = false;
    c16 code = path[0];
    if (len == 1) {
        path_buf_free(&device);
        return code == '/' ? path_ascii(vm, "\\") : path_units(vm, path, 1);
    }
    MalValue result = mal_value_new_undefined();
    if (win_is_sep(code)) {
        is_absolute = true;
        if (win_is_sep(path[1])) {
            i64 j = 2;
            i64 last = j;
            while (j < len && !win_is_sep(path[j])) j++;
            if (j < len && j != last) {
                i64 first_start = last, first_end = j;
                last = j;
                while (j < len && win_is_sep(path[j])) j++;
                if (j < len && j != last) {
                    last = j;
                    while (j < len && !win_is_sep(path[j])) j++;
                    if (j == len || j != last) {
                        bool dot_or_question = first_end - first_start == 1
                            && (path[first_start] == '.' || path[first_start] == '?');
                        if (dot_or_question) {
                            has_device = true;
                            win_push_ascii(&device, "\\\\");
                            path_buf_push_char(&device, path[first_start]);
                            root_end = 4;
                            i64 colon_index = win_index_of(path, len, ':', 0);
                            i64 possible_end = colon_index + 1;
                            if (possible_end > 4 && win_reserved_name(path + 4, possible_end - 4, possible_end - 4 - 1)) {
                                device.length = 0;
                                win_push_ascii(&device, "\\\\?\\");
                                path_buf_push_units(&device, path + 4, (usize) (possible_end - 4));
                                root_end = possible_end;
                            }
                        } else if (j == len) {
                            MalPathBuf out;
                            path_buf_init(&out);
                            win_push_ascii(&out, "\\\\");
                            path_buf_push_units(&out, path + first_start, (usize) (first_end - first_start));
                            path_buf_push_char(&out, WIN_SEP);
                            path_buf_push_units(&out, path + last, (usize) (len - last));
                            path_buf_push_char(&out, WIN_SEP);
                            result = path_buf_to_value(vm, &out);
                            path_buf_free(&out);
                            path_buf_free(&device);
                            return result;
                        } else {
                            has_device = true;
                            win_push_ascii(&device, "\\\\");
                            path_buf_push_units(&device, path + first_start, (usize) (first_end - first_start));
                            path_buf_push_char(&device, WIN_SEP);
                            path_buf_push_units(&device, path + last, (usize) (j - last));
                            root_end = j;
                        }
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else {
        i64 colon_index = win_index_of(path, len, ':', 0);
        if (colon_index > 0) {
            if (win_is_device_root(code) && colon_index == 1) {
                has_device = true;
                path_buf_push_units(&device, path, 2);
                root_end = 2;
                if (len > 2 && win_is_sep(path[2])) {
                    is_absolute = true;
                    root_end = 3;
                }
            } else if (win_reserved_name(path, len, colon_index)) {
                has_device = true;
                path_buf_push_units(&device, path, (usize) (colon_index + 1));
                root_end = colon_index + 1;
            }
        }
    }
    MalPathBuf tail;
    path_buf_init(&tail);
    if (root_end < len) normalize_string(path + root_end, len - root_end, !is_absolute, true, &tail);
    if (tail.length == 0 && !is_absolute) path_buf_push_char(&tail, '.');
    if (tail.length > 0 && win_is_sep(path[len - 1])) path_buf_push_char(&tail, WIN_SEP);
    MalPathBuf out;
    path_buf_init(&out);
    bool done = false;
    if (!is_absolute && !has_device && win_index_of(path, len, ':', 0) != -1) {
        const c16 *t = (const c16 *) tail.data;
        bool dotted = tail.length >= 2 && win_is_device_root(t[0]) && t[1] == ':';
        for (i64 index = win_index_of(path, len, ':', 0); !dotted && index != -1;
            index = win_index_of(path, len, ':', index + 1)) {
            dotted = index == len - 1 || win_is_sep(path[index + 1]);
        }
        if (dotted) {
            win_push_ascii(&out, ".\\");
            path_buf_push_units(&out, tail.data, tail.length);
            done = true;
        }
    }
    if (!done && win_reserved_name(path, len, win_index_of(path, len, ':', 0))) {
        win_push_ascii(&out, ".\\");
        path_buf_push_units(&out, device.data, device.length);
        path_buf_push_units(&out, tail.data, tail.length);
        done = true;
    }
    if (!done) {
        path_buf_push_units(&out, device.data, device.length);
        if (is_absolute) path_buf_push_char(&out, WIN_SEP);
        path_buf_push_units(&out, tail.data, tail.length);
    }
    result = path_buf_check(vm, &tail) && path_buf_check(vm, &device) ? path_buf_to_value(vm, &out)
                                                                       : mal_value_new_undefined();
    path_buf_free(&out);
    path_buf_free(&tail);
    path_buf_free(&device);
    return result;
}

static MalValue mal_node_path_win32_normalize(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    return win_normalize_units(vm, mal_string_code_units(s), (i64) mal_string_length(s));
}

static MalValue mal_node_path_win32_is_absolute(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *p = mal_string_code_units(s);
    usize len = mal_string_length(s);
    if (len == 0) return mal_value_new_boolean(false);
    return mal_value_new_boolean(win_is_sep(p[0])
        || (len > 2 && win_is_device_root(p[0]) && p[1] == ':' && win_is_sep(p[2])));
}

static MalValue mal_node_path_win32_join(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    if (argc == 0) return path_ascii(vm, ".");
    MalPathBuf joined;
    path_buf_init(&joined);
    MalString *first = nullptr;
    for (i32 i = 0; i < argc; ++i) {
        MalString *s;
        if (!path_require_string(vm, args[i], "path", &s)) {
            path_buf_free(&joined);
            return mal_value_new_undefined();
        }
        if (mal_string_length(s) == 0) continue;
        if (first != nullptr) path_buf_push_char(&joined, WIN_SEP);
        else first = s;
        mal_text_buffer_append_string(&joined, s);
    }
    if (first == nullptr) {
        path_buf_free(&joined);
        return path_ascii(vm, ".");
    }
    if (!path_buf_check(vm, &joined)) {
        path_buf_free(&joined);
        return mal_value_new_undefined();
    }
    const c16 *fp = mal_string_code_units(first);
    usize first_len = mal_string_length(first);
    bool needs_replace = true;
    usize slash_count = 0;
    if (win_is_sep(fp[0])) {
        ++slash_count;
        if (first_len > 1 && win_is_sep(fp[1])) {
            ++slash_count;
            if (first_len > 2) {
                if (win_is_sep(fp[2])) ++slash_count;
                else needs_replace = false;
            }
        }
    }
    const c16 *jp = (const c16 *) joined.data;
    usize jlen = joined.length;
    usize skip = 0;
    if (needs_replace) {
        while (slash_count < jlen && win_is_sep(jp[slash_count])) slash_count++;
        if (slash_count >= 2) skip = slash_count - 1;
    }
    // A collapsed run of leading separators keeps exactly one, which is a backslash.
    MalPathBuf collapsed;
    path_buf_init(&collapsed);
    if (skip > 0) {
        path_buf_push_char(&collapsed, WIN_SEP);
        path_buf_push_units(&collapsed, jp + skip + 1, jlen - skip - 1);
    } else {
        path_buf_push_units(&collapsed, jp, jlen);
    }
    path_buf_free(&joined);
    if (!path_buf_check(vm, &collapsed)) {
        path_buf_free(&collapsed);
        return mal_value_new_undefined();
    }
    const c16 *cp = (const c16 *) collapsed.data;
    i64 clen = (i64) collapsed.length;
    bool reserved = false;
    for (i64 start = 0; start < clen && !reserved;) {
        while (start < clen && cp[start] == '\\') start++;
        i64 end = start;
        while (end < clen && cp[end] != '\\') end++;
        if (end > start) {
            i64 colon = win_index_of(cp + start, end - start, ':', 0);
            reserved = colon != -1 && win_reserved_name(cp + start, end - start, colon);
        }
        start = end;
    }
    MalValue result;
    if (reserved) {
        MalPathBuf out;
        path_buf_init(&out);
        for (i64 i = 0; i < clen; i++) path_buf_push_char(&out, cp[i] == '/' ? WIN_SEP : cp[i]);
        result = path_buf_to_value(vm, &out);
        path_buf_free(&out);
    } else {
        result = win_normalize_units(vm, cp, clen);
    }
    path_buf_free(&collapsed);
    return result;
}

static bool win_ci_equal(const c16 *a, usize a_len, const c16 *b, usize b_len) {
    if (a_len != b_len) return false;
    for (usize i = 0; i < a_len; i++) {
        if (win_lower(a[i]) != win_lower(b[i])) return false;
    }
    return true;
}

/* Parses one resolve argument's root the way Node's resolve loop does. */
static void win_root(const c16 *path, i64 len, i64 *root_end, i64 *device_start, i64 *device_len,
    bool *unc, i64 *first_start, i64 *first_end, i64 *second_start, i64 *second_end, bool *is_absolute) {
    *root_end = 0;
    *device_len = 0;
    *device_start = 0;
    *unc = false;
    *is_absolute = false;
    c16 code = path[0];
    if (len == 1) {
        if (win_is_sep(code)) {
            *root_end = 1;
            *is_absolute = true;
        }
    } else if (win_is_sep(code)) {
        *is_absolute = true;
        if (win_is_sep(path[1])) {
            i64 j = 2;
            i64 last = j;
            while (j < len && !win_is_sep(path[j])) j++;
            if (j < len && j != last) {
                *first_start = last;
                *first_end = j;
                last = j;
                while (j < len && win_is_sep(path[j])) j++;
                if (j < len && j != last) {
                    last = j;
                    while (j < len && !win_is_sep(path[j])) j++;
                    if (j == len || j != last) {
                        *unc = true;
                        bool dot_or_question = *first_end - *first_start == 1
                            && (path[*first_start] == '.' || path[*first_start] == '?');
                        *second_start = last;
                        *second_end = dot_or_question ? last - 1 : j;
                        *root_end = dot_or_question ? 4 : j;
                        *device_len = -1;
                        if (dot_or_question) *second_start = -1;
                    }
                }
            }
        } else {
            *root_end = 1;
        }
    } else if (win_is_device_root(code) && path[1] == ':') {
        *device_start = 0;
        *device_len = 2;
        *root_end = 2;
        if (len > 2 && win_is_sep(path[2])) {
            *is_absolute = true;
            *root_end = 3;
        }
    }
}

static c16 *win_units_from_utf8(const char *text, usize *out_len) {
    usize length = strlen(text);
    c16 *units = malloc((length > 0 ? length : 1) * sizeof(c16));
    if (units == nullptr) return nullptr;
    for (usize i = 0; i < length; i++) units[i] = (c16) (u8) text[i];
    *out_len = length;
    return units;
}

static bool win_resolve_core(MalVm *vm, const MalValue *args, i32 argc, MalPathBuf *out) {
    MalPathBuf device, tail;
    path_buf_init(&device);
    path_buf_init(&tail);
    bool resolved_absolute = false;
    bool ok = true;
    for (i32 i = argc - 1; i >= -1; i--) {
        c16 *owned = nullptr;
        const c16 *path;
        i64 len;
        if (i >= 0) {
            MalString *s;
            char name[32];
            snprintf(name, sizeof(name), "paths[%d]", i);
            if (!path_require_string(vm, args[i], name, &s)) { ok = false; break; }
            path = mal_string_code_units(s);
            len = (i64) mal_string_length(s);
            if (len == 0) continue;
        } else if (device.length == 0) {
            usize cwd_len = 0;
            owned = path_get_cwd(&cwd_len);
            path = owned;
            len = (i64) cwd_len;
            bool current = argc == 0 || (argc == 1 && mal_value_is_string(args[0])
                && (mal_string_length(mal_value_to_string(args[0])) == 0
                    || (mal_string_length(mal_value_to_string(args[0])) == 1
                        && mal_string_code_unit_at(mal_value_to_string(args[0]), 0) == '.')));
            if (current && len > 0 && win_is_sep(path[0])) {
                // Node's fast path on POSIX hosts: process.cwd() with '/' turned into '\\'.
                out->length = 0;
                for (i64 k = 0; k < len; k++) path_buf_push_char(out, path[k] == '/' ? WIN_SEP : path[k]);
                free(owned);
                path_buf_free(&device);
                path_buf_free(&tail);
                return path_buf_check(vm, out);
            }
            if (owned == nullptr) len = 0;
        } else {
            char variable[16];
            snprintf(variable, sizeof(variable), "=%c%c", (char) ((const c16 *) device.data)[0],
                (char) ((const c16 *) device.data)[1]);
            const char *env = getenv(variable);
            usize cwd_len = 0;
            owned = env != nullptr && env[0] != '\0' ? win_units_from_utf8(env, &cwd_len) : path_get_cwd(&cwd_len);
            path = owned;
            len = (i64) cwd_len;
            const c16 *d = (const c16 *) device.data;
            bool mismatch = owned == nullptr
                || (len >= 3 && !(win_lower(path[0]) == win_lower(d[0]) && win_lower(path[1]) == win_lower(d[1]))
                    && path[2] == '\\');
            if (owned == nullptr || mismatch) {
                free(owned);
                owned = malloc(3 * sizeof(c16));
                if (owned == nullptr) { ok = false; break; }
                owned[0] = d[0];
                owned[1] = d[1];
                owned[2] = WIN_SEP;
                path = owned;
                len = 3;
            }
        }
        if (len == 0) { free(owned); continue; }
        i64 root_end, device_start, device_len, first_start = 0, first_end = 0, second_start = 0, second_end = 0;
        bool unc, is_absolute;
        win_root(path, len, &root_end, &device_start, &device_len, &unc, &first_start, &first_end, &second_start,
            &second_end, &is_absolute);
        MalPathBuf this_device;
        path_buf_init(&this_device);
        if (unc) {
            win_push_ascii(&this_device, "\\\\");
            path_buf_push_units(&this_device, path + first_start, (usize) (first_end - first_start));
            if (second_start >= 0) {
                path_buf_push_char(&this_device, WIN_SEP);
                path_buf_push_units(&this_device, path + second_start, (usize) (second_end - second_start));
            }
        } else if (device_len > 0) {
            path_buf_push_units(&this_device, path + device_start, (usize) device_len);
        }
        bool skip = false;
        if (this_device.length > 0) {
            if (device.length > 0) {
                skip = !win_ci_equal(this_device.data, this_device.length, device.data, device.length);
            } else {
                path_buf_push_units(&device, this_device.data, this_device.length);
            }
        }
        path_buf_free(&this_device);
        if (skip) { free(owned); continue; }
        bool stop = false;
        if (resolved_absolute) {
            stop = device.length > 0;
        } else {
            MalPathBuf next;
            path_buf_init(&next);
            path_buf_push_units(&next, path + root_end, (usize) (len - root_end));
            path_buf_push_char(&next, WIN_SEP);
            path_buf_push_units(&next, tail.data, tail.length);
            path_buf_free(&tail);
            tail = next;
            resolved_absolute = is_absolute;
            stop = is_absolute && device.length > 0;
        }
        free(owned);
        if (stop) break;
    }
    if (ok) {
        MalPathBuf normalized;
        path_buf_init(&normalized);
        normalize_string(tail.data, (i64) tail.length, !resolved_absolute, true, &normalized);
        out->length = 0;
        path_buf_push_units(out, device.data, device.length);
        if (resolved_absolute) path_buf_push_char(out, WIN_SEP);
        path_buf_push_units(out, normalized.data, normalized.length);
        if (out->length == 0) path_buf_push_char(out, '.');
        ok = path_buf_check(vm, &normalized) && path_buf_check(vm, &tail) && path_buf_check(vm, out);
        path_buf_free(&normalized);
    }
    path_buf_free(&device);
    path_buf_free(&tail);
    return ok;
}

static MalValue mal_node_path_win32_resolve(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalPathBuf out;
    path_buf_init(&out);
    MalValue result = win_resolve_core(vm, args, argc, &out) ? path_buf_to_value(vm, &out) : mal_value_new_undefined();
    path_buf_free(&out);
    return result;
}

static MalValue mal_node_path_win32_to_namespaced_path(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalValue path = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(path) || mal_string_length(mal_value_to_string(path)) == 0) return path;
    MalPathBuf resolved;
    path_buf_init(&resolved);
    if (!win_resolve_core(vm, &path, 1, &resolved)) {
        path_buf_free(&resolved);
        return mal_value_new_undefined();
    }
    const c16 *r = (const c16 *) resolved.data;
    usize len = resolved.length;
    MalValue result;
    MalPathBuf out;
    path_buf_init(&out);
    if (len <= 2) {
        result = path;
    } else if (r[0] == '\\' && r[1] == '\\' && r[2] != '?' && r[2] != '.') {
        win_push_ascii(&out, "\\\\?\\UNC\\");
        path_buf_push_units(&out, r + 2, len - 2);
        result = path_buf_to_value(vm, &out);
    } else if (r[0] != '\\' && win_is_device_root(r[0]) && r[1] == ':' && r[2] == '\\') {
        win_push_ascii(&out, "\\\\?\\");
        path_buf_push_units(&out, r, len);
        result = path_buf_to_value(vm, &out);
    } else {
        result = path_buf_to_value(vm, &resolved);
    }
    path_buf_free(&out);
    path_buf_free(&resolved);
    return result;
}

static MalValue mal_node_path_win32_relative(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *from_string, *to_string;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "from", &from_string)
        || !path_require_string(vm, argc >= 2 ? args[1] : mal_value_new_undefined(), "to", &to_string)) {
        return mal_value_new_undefined();
    }
    if (mal_string_equals(from_string, to_string)) return path_ascii(vm, "");
    MalPathBuf from_orig, to_orig;
    path_buf_init(&from_orig);
    path_buf_init(&to_orig);
    MalValue result = mal_value_new_undefined();
    MalPathBuf out;
    path_buf_init(&out);
    if (!win_resolve_core(vm, &args[0], 1, &from_orig) || !win_resolve_core(vm, &args[1], 1, &to_orig)) goto done;
    const c16 *fo = (const c16 *) from_orig.data;
    const c16 *to = (const c16 *) to_orig.data;
    i64 flen_all = (i64) from_orig.length, tlen_all = (i64) to_orig.length;
    if (flen_all == tlen_all && memcmp(fo, to, (usize) flen_all * sizeof(c16)) == 0) { result = path_ascii(vm, ""); goto done; }
    if (win_ci_equal(fo, (usize) flen_all, to, (usize) tlen_all)) { result = path_ascii(vm, ""); goto done; }
    // ASCII lowering never changes length, so Node's split-based branch for length-changing case maps is unreachable.
    i64 from_start = 0;
    while (from_start < flen_all && fo[from_start] == '\\') from_start++;
    i64 from_end = flen_all;
    while (from_end - 1 > from_start && fo[from_end - 1] == '\\') from_end--;
    i64 from_len = from_end - from_start;
    i64 to_start = 0;
    while (to_start < tlen_all && to[to_start] == '\\') to_start++;
    i64 to_end = tlen_all;
    while (to_end - 1 > to_start && to[to_end - 1] == '\\') to_end--;
    i64 to_len = to_end - to_start;
    i64 length = from_len < to_len ? from_len : to_len;
    i64 last_common_sep = -1;
    i64 i = 0;
    for (; i < length; i++) {
        c16 from_code = win_lower(fo[from_start + i]);
        if (from_code != win_lower(to[to_start + i])) break;
        if (from_code == '\\') last_common_sep = i;
    }
    if (i != length) {
        if (last_common_sep == -1) { result = path_buf_to_value(vm, &to_orig); goto done; }
    } else {
        if (to_len > length) {
            if (to[to_start + i] == '\\') { result = win_slice(vm, to, to_start + i + 1, tlen_all); goto done; }
            if (i == 2) { result = win_slice(vm, to, to_start + i, tlen_all); goto done; }
        }
        if (from_len > length) {
            if (fo[from_start + i] == '\\') last_common_sep = i;
            else if (i == 2) last_common_sep = 3;
        }
        if (last_common_sep == -1) last_common_sep = 0;
    }
    for (i = from_start + last_common_sep + 1; i <= from_end; ++i) {
        if (i == from_end || fo[i] == '\\') {
            if (out.length == 0) win_push_ascii(&out, "..");
            else win_push_ascii(&out, "\\..");
        }
    }
    to_start += last_common_sep;
    if (out.length > 0) {
        path_buf_push_units(&out, to + to_start, (usize) (to_end - to_start));
        result = path_buf_to_value(vm, &out);
        goto done;
    }
    if (to_start < tlen_all && to[to_start] == '\\') ++to_start;
    result = win_slice(vm, to, to_start, to_end);
done:
    path_buf_free(&out);
    path_buf_free(&from_orig);
    path_buf_free(&to_orig);
    return result;
}

static MalValue mal_node_path_win32_dirname(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *path = mal_string_code_units(s);
    i64 len = (i64) mal_string_length(s);
    if (len == 0) return path_ascii(vm, ".");
    i64 root_end = -1, offset = 0;
    c16 code = path[0];
    if (len == 1) return win_is_sep(code) ? mal_value_from_string(s) : path_ascii(vm, ".");
    if (win_is_sep(code)) {
        root_end = offset = 1;
        if (win_is_sep(path[1])) {
            i64 j = 2, last = j;
            while (j < len && !win_is_sep(path[j])) j++;
            if (j < len && j != last) {
                last = j;
                while (j < len && win_is_sep(path[j])) j++;
                if (j < len && j != last) {
                    last = j;
                    while (j < len && !win_is_sep(path[j])) j++;
                    if (j == len) return mal_value_from_string(s);
                    if (j != last) root_end = offset = j + 1;
                }
            }
        }
    } else if (win_is_device_root(code) && path[1] == ':') {
        root_end = len > 2 && win_is_sep(path[2]) ? 3 : 2;
        offset = root_end;
    }
    i64 end = -1;
    bool matched_slash = true;
    for (i64 i = len - 1; i >= offset; --i) {
        if (win_is_sep(path[i])) {
            if (!matched_slash) { end = i; break; }
        } else {
            matched_slash = false;
        }
    }
    if (end == -1) {
        if (root_end == -1) return path_ascii(vm, ".");
        end = root_end;
    }
    return win_slice(vm, path, 0, end);
}

static MalValue mal_node_path_win32_basename(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *suffix = nullptr;
    if (argc >= 2 && !mal_value_is_undefined(args[1]) && !path_require_string(vm, args[1], "suffix", &suffix)) {
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *path = mal_string_code_units(s);
    i64 len = (i64) mal_string_length(s);
    i64 start = 0, end = -1;
    bool matched_slash = true;
    if (len >= 2 && win_is_device_root(path[0]) && path[1] == ':') start = 2;
    i64 suffix_len = suffix != nullptr ? (i64) mal_string_length(suffix) : 0;
    if (suffix != nullptr && suffix_len > 0 && suffix_len <= len) {
        if (mal_string_equals(suffix, s)) return path_ascii(vm, "");
        const c16 *sp = mal_string_code_units(suffix);
        i64 ext_idx = suffix_len - 1;
        i64 first_non_slash_end = -1;
        for (i64 i = len - 1; i >= start; --i) {
            c16 code = path[i];
            if (win_is_sep(code)) {
                if (!matched_slash) { start = i + 1; break; }
            } else {
                if (first_non_slash_end == -1) {
                    matched_slash = false;
                    first_non_slash_end = i + 1;
                }
                if (ext_idx >= 0) {
                    if (code == sp[ext_idx]) {
                        if (--ext_idx == -1) end = i;
                    } else {
                        ext_idx = -1;
                        end = first_non_slash_end;
                    }
                }
            }
        }
        if (start == end) end = first_non_slash_end;
        else if (end == -1) end = len;
        return win_slice(vm, path, start, end);
    }
    for (i64 i = len - 1; i >= start; --i) {
        if (win_is_sep(path[i])) {
            if (!matched_slash) { start = i + 1; break; }
        } else if (end == -1) {
            matched_slash = false;
            end = i + 1;
        }
    }
    if (end == -1) return path_ascii(vm, "");
    return win_slice(vm, path, start, end);
}

static MalValue mal_node_path_win32_extname(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    const c16 *path = mal_string_code_units(s);
    i64 len = (i64) mal_string_length(s);
    i64 start = 0, start_dot = -1, start_part = 0, end = -1, pre_dot_state = 0;
    bool matched_slash = true;
    if (len >= 2 && path[1] == ':' && win_is_device_root(path[0])) start = start_part = 2;
    for (i64 i = len - 1; i >= start; --i) {
        c16 code = path[i];
        if (win_is_sep(code)) {
            if (!matched_slash) { start_part = i + 1; break; }
            continue;
        }
        if (end == -1) { matched_slash = false; end = i + 1; }
        if (code == '.') {
            if (start_dot == -1) start_dot = i;
            else if (pre_dot_state != 1) pre_dot_state = 1;
        } else if (start_dot != -1) {
            pre_dot_state = -1;
        }
    }
    if (start_dot == -1 || end == -1 || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)) {
        return path_ascii(vm, "");
    }
    return win_slice(vm, path, start_dot, end);
}

static MalValue mal_node_path_win32_parse(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    MalString *s;
    if (!path_require_string(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "path", &s)) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_string(s), path_ascii(vm, ""), path_ascii(vm, ""), path_ascii(vm, ""),
        path_ascii(vm, ""), path_ascii(vm, ""), mal_value_new_undefined()};
    enum { P_PATH, P_ROOT, P_DIR, P_BASE, P_EXT, P_NAME, P_OBJECT };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    const c16 *path = mal_string_code_units(s);
    i64 len = (i64) mal_string_length(s);
    if (len == 0) goto build;
    i64 root_end = 0;
    c16 code = path[0];
    if (len == 1) {
        if (win_is_sep(code)) roots[P_ROOT] = roots[P_DIR] = roots[P_PATH];
        else roots[P_BASE] = roots[P_NAME] = roots[P_PATH];
        goto build;
    }
    if (win_is_sep(code)) {
        root_end = 1;
        if (win_is_sep(path[1])) {
            i64 j = 2, last = j;
            while (j < len && !win_is_sep(path[j])) j++;
            if (j < len && j != last) {
                last = j;
                while (j < len && win_is_sep(path[j])) j++;
                if (j < len && j != last) {
                    last = j;
                    while (j < len && !win_is_sep(path[j])) j++;
                    if (j == len) root_end = j;
                    else if (j != last) root_end = j + 1;
                }
            }
        }
    } else if (win_is_device_root(code) && path[1] == ':') {
        if (len <= 2) {
            roots[P_ROOT] = roots[P_DIR] = roots[P_PATH];
            goto build;
        }
        root_end = 2;
        if (win_is_sep(path[2])) {
            if (len == 3) {
                roots[P_ROOT] = roots[P_DIR] = roots[P_PATH];
                goto build;
            }
            root_end = 3;
        }
    }
    if (root_end > 0) roots[P_ROOT] = win_slice(vm, path, 0, root_end);
    {
        i64 start_dot = -1, start_part = root_end, end = -1, pre_dot_state = 0;
        bool matched_slash = true;
        for (i64 i = len - 1; i >= root_end; --i) {
            code = path[i];
            if (win_is_sep(code)) {
                if (!matched_slash) { start_part = i + 1; break; }
                continue;
            }
            if (end == -1) { matched_slash = false; end = i + 1; }
            if (code == '.') {
                if (start_dot == -1) start_dot = i;
                else if (pre_dot_state != 1) pre_dot_state = 1;
            } else if (start_dot != -1) {
                pre_dot_state = -1;
            }
        }
        if (end != -1) {
            if (start_dot == -1 || pre_dot_state == 0
                || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)) {
                roots[P_BASE] = roots[P_NAME] = win_slice(vm, path, start_part, end);
            } else {
                roots[P_NAME] = win_slice(vm, path, start_part, start_dot);
                roots[P_BASE] = win_slice(vm, path, start_part, end);
                roots[P_EXT] = win_slice(vm, path, start_dot, end);
            }
        }
        roots[P_DIR] = start_part > 0 && start_part != root_end ? win_slice(vm, path, 0, start_part - 1) : roots[P_ROOT];
    }
build:
    roots[P_OBJECT] = mal_value_from_object(mal_intrinsic_new_object(vm));
    path_parse_define(vm, mal_value_to_object(roots[P_OBJECT]), "root", roots[P_ROOT]);
    path_parse_define(vm, mal_value_to_object(roots[P_OBJECT]), "dir", roots[P_DIR]);
    path_parse_define(vm, mal_value_to_object(roots[P_OBJECT]), "base", roots[P_BASE]);
    path_parse_define(vm, mal_value_to_object(roots[P_OBJECT]), "ext", roots[P_EXT]);
    path_parse_define(vm, mal_value_to_object(roots[P_OBJECT]), "name", roots[P_NAME]);
    MalValue result = roots[P_OBJECT];
    mal_gc_unroot(&root);
    return result;
}

/* Node's minimatch runs with windowsPathsNoEscape, so '\\' separates in both path and pattern. */
static MalValue mal_node_path_win32_matches_glob(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalString *path;
    MalString *pattern;
    if (!path_require_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "path", &path)
        || !path_require_string(vm, argc > 1 ? args[1] : mal_value_new_undefined(), "pattern", &pattern)) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_string(pattern), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPathBuf converted;
    path_buf_init(&converted);
    const c16 *p = mal_string_code_units(path);
    usize len = mal_string_length(path);
    for (usize i = 0; i < len; i++) path_buf_push_char(&converted, p[i] == '\\' ? PATH_SEP : p[i]);
    roots[1] = path_buf_to_value(vm, &converted);
    path_buf_free(&converted);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        path_buf_init(&converted);
        const c16 *g = mal_string_code_units(pattern);
        usize glob_len = mal_string_length(pattern);
        for (usize i = 0; i < glob_len; i++) path_buf_push_char(&converted, g[i] == '\\' ? PATH_SEP : g[i]);
        roots[0] = path_buf_to_value(vm, &converted);
        path_buf_free(&converted);
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : mal_value_new_boolean(mal_node_path_glob_match(vm, mal_value_to_string(roots[1]),
            mal_value_to_string(roots[0]), false));
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_node_path_win32_format(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value; (void) nt; (void) callee;
    return path_format_with(vm, args, argc, WIN_SEP);
}

typedef struct {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} MalNodePathExport;

#define MAL_NODE_PATH_FUNCTION_COUNT 12

static const MalNodePathExport mal_node_path_exports[MAL_NODE_PATH_FUNCTION_COUNT] = {
    {"basename", 2, mal_node_path_basename},
    {"dirname", 1, mal_node_path_dirname},
    {"extname", 1, mal_node_path_extname},
    {"format", 1, mal_node_path_format},
    {"isAbsolute", 1, mal_node_path_is_absolute},
    {"join", 0, mal_node_path_join},
    {"matchesGlob", 2, mal_node_path_matches_glob},
    {"normalize", 1, mal_node_path_normalize},
    {"parse", 1, mal_node_path_parse},
    {"relative", 2, mal_node_path_relative},
    {"resolve", 0, mal_node_path_resolve},
    {"toNamespacedPath", 1, mal_node_path_to_namespaced_path},
};

static const MalNodePathExport mal_node_path_win32_exports[MAL_NODE_PATH_FUNCTION_COUNT] = {
    {"basename", 2, mal_node_path_win32_basename},
    {"dirname", 1, mal_node_path_win32_dirname},
    {"extname", 1, mal_node_path_win32_extname},
    {"format", 1, mal_node_path_win32_format},
    {"isAbsolute", 1, mal_node_path_win32_is_absolute},
    {"join", 0, mal_node_path_win32_join},
    {"matchesGlob", 2, mal_node_path_win32_matches_glob},
    {"normalize", 1, mal_node_path_win32_normalize},
    {"parse", 1, mal_node_path_win32_parse},
    {"relative", 2, mal_node_path_win32_relative},
    {"resolve", 0, mal_node_path_win32_resolve},
    {"toNamespacedPath", 1, mal_node_path_win32_to_namespaced_path},
};

static MalObject *path_namespace(MalVm *vm, const MalNodePathExport *exports, const char *delimiter, const char *sep) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *object = mal_value_to_object(roots[0]);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    for (usize i = 0; i < MAL_NODE_PATH_FUNCTION_COUNT; ++i) {
        const MalNodePathExport *e = &exports[i];
        const char *function_name = strcmp(e->name, "format") == 0 ? "bound _format" : e->name;
        roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) function_name), e->length, e->callback));
        mal_intrinsic_define_data(vm, object, (const byte *) e->name, roots[1], flags);
    }
    roots[1] = path_ascii(vm, delimiter);
    mal_intrinsic_define_data(vm, object, (const byte *) "delimiter", roots[1], flags);
    roots[1] = path_ascii(vm, sep);
    mal_intrinsic_define_data(vm, object, (const byte *) "sep", roots[1], flags);
    mal_gc_unroot(&root);
    return object;
}

void mal_host_install_node_path(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:path", slots, count)) return;
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_object(path_namespace(vm, mal_node_path_exports, ":", "/"));
    roots[1] = mal_value_from_object(path_namespace(vm, mal_node_path_win32_exports, ";", "\\"));
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    // Node's posix and win32 objects reference each other and themselves.
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "win32", roots[1], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "posix", roots[0], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "win32", roots[1], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "posix", roots[0], flags);
    mal_node_module_publish(vm, "node:path", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

void mal_host_install_node_path_posix(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:path/posix", slots, count)) return;
    mal_host_install_node_path(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    mal_node_module_publish(vm, "node:path/posix", slots, count,
        mal_node_module_get_cached(vm, "node:path"));
}

void mal_host_install_node_path_win32(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:path/win32", slots, count)) return;
    mal_host_install_node_path(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue win32 = mal_value_new_undefined();
    MalValue posix = mal_node_module_get_cached(vm, "node:path");
    if (mal_vm_get_property(vm, posix, mal_intrinsic_string_key(vm, (const byte *) "win32"), &win32)) {
        mal_node_module_publish(vm, "node:path/win32", slots, count, win32);
    }
}

#endif /* MAL_NODE */
