#include "./builtin_regexp.h"

#include <math.h>
#include <stdlib.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "mal_regexp.h"
#include "object_ops.h"
#include "regexp_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// The whole RegExp surface (constructor, prototype, exec, the Symbol.* protocol,
// and mal_regexp_create) runs on the regress engine (mal_regexp_* FFI). An
// engine.regexp:false build drops regress, so this TU must reference no regress
// symbols — compile it away wholesale, leaving only a no-op install stub (below) so
// intrinsics.c can still call mal_builtin_regexp_install unconditionally.
#if MAL_REGEXP

// The CreateDataPropertyOrThrow descriptor used for exec result-array members.
#define REGEXP_WEC (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static bool regexp_threw(MalVm *vm) {
    return vm->completion.kind == MAL_COMPLETION_THROW;
}

static bool regexp_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

// ---------------------------------------------------------------------------
// Strings + flags
// ---------------------------------------------------------------------------

static MalValue regexp_substring(MalVm *vm, MalString *s, i32 start, i32 end) {
    return mal_value_from_string(
        mal_string_new_slice(&vm->heap, s, (usize) start, (usize) (end - start))
    );
}

// Decode UTF-8 (regress group names) into a heap MalString of UTF-16 units.
static MalString *regexp_string_from_utf8(MalVm *vm, const uint8_t *bytes, usize len) {
    c16 stack_units[128];
    // UTF-8 can use up to four bytes for two UTF-16 code units. Cap scratch at
    // the output limit and enforce that limit while decoding, not against bytes.
    usize capacity = len < MAL_STRING_MAX_CODE_UNITS ? len : MAL_STRING_MAX_CODE_UNITS;
    usize units_bytes;
    if (!mal_checked_size_multiply(sizeof(c16), capacity, SIZE_MAX, &units_bytes)) {
        regexp_throw_string_length(vm);
        return mal_intrinsic_ascii(vm, (const byte *) "");
    }
    c16 *units = capacity <= 128 ? stack_units : malloc(units_bytes);
    if (units == nullptr) {
        regexp_throw_string_length(vm);
        return mal_intrinsic_ascii(vm, (const byte *) "");
    }
    usize count = 0;
    usize i = 0;
    while (i < len) {
        u32 cp;
        uint8_t b = bytes[i];
        if (b < 0x80) {
            cp = b;
            i += 1;
        } else if ((b & 0xE0) == 0xC0 && len - i >= 2) {
            cp = ((u32) (b & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
            i += 2;
        } else if ((b & 0xF0) == 0xE0 && len - i >= 3) {
            cp = ((u32) (b & 0x0F) << 12) | ((u32) (bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
            i += 3;
        } else if ((b & 0xF8) == 0xF0 && len - i >= 4) {
            cp = ((u32) (b & 0x07) << 18) | ((u32) (bytes[i + 1] & 0x3F) << 12) |
                 ((u32) (bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
            i += 4;
        } else {
            cp = 0xFFFD;
            i += 1;
        }
        usize width = cp <= 0xFFFF ? 1 : 2;
        if (count > MAL_STRING_MAX_CODE_UNITS - width) {
            if (units != stack_units) {
                free(units);
            }
            regexp_throw_string_length(vm);
            return mal_intrinsic_ascii(vm, (const byte *) "");
        }
        if (width == 1) {
            units[count++] = (c16) cp;
        } else {
            cp -= 0x10000;
            units[count++] = (c16) (0xD800 + (cp >> 10));
            units[count++] = (c16) (0xDC00 + (cp & 0x3FF));
        }
    }
    MalString *result = mal_string_new_copy(&vm->heap, units, count);
    if (units != stack_units) {
        free(units);
    }
    return result;
}

// ParseFlags: validate the flags string and produce the MalRegExpFlag bitmask.
// Rejects duplicates, unknown letters, and `u` together with `v`.
static bool regexp_parse_flags(const MalString *flags, u32 *out_bits) {
    const c16 *u = mal_string_code_units(flags);
    usize n = mal_string_length(flags);
    u32 bits = 0;
    for (usize i = 0; i < n; i++) {
        u32 bit;
        switch (u[i]) {
            case 'd': bit = MAL_REGEXP_JS_HAS_INDICES; break;
            case 'g': bit = MAL_REGEXP_JS_GLOBAL; break;
            case 'i': bit = MAL_REGEXP_JS_IGNORE_CASE; break;
            case 'm': bit = MAL_REGEXP_JS_MULTILINE; break;
            case 's': bit = MAL_REGEXP_JS_DOT_ALL; break;
            case 'u': bit = MAL_REGEXP_JS_UNICODE; break;
            case 'v': bit = MAL_REGEXP_JS_UNICODE_SETS; break;
            case 'y': bit = MAL_REGEXP_JS_STICKY; break;
            default: return false;
        }
        if (bits & bit) {
            return false;
        }
        bits |= bit;
    }
    if ((bits & MAL_REGEXP_JS_UNICODE) && (bits & MAL_REGEXP_JS_UNICODE_SETS)) {
        return false;
    }
    *out_bits = bits;
    return true;
}

// Translate JS flag bits to the regress-facing i/m/s/u/v subset.
static u32 regexp_regress_flags(u32 js) {
    u32 r = 0;
    if (js & MAL_REGEXP_JS_IGNORE_CASE) r |= MAL_REGEXP_FLAG_IGNORE_CASE;
    if (js & MAL_REGEXP_JS_MULTILINE) r |= MAL_REGEXP_FLAG_MULTILINE;
    if (js & MAL_REGEXP_JS_DOT_ALL) r |= MAL_REGEXP_FLAG_DOT_ALL;
    if (js & MAL_REGEXP_JS_UNICODE) r |= MAL_REGEXP_FLAG_UNICODE;
    if (js & MAL_REGEXP_JS_UNICODE_SETS) r |= MAL_REGEXP_FLAG_UNICODE_SETS;
    return r;
}

// EscapeRegExpPattern: the `.source` form. Empty -> "(?:)"; otherwise escape an
// unescaped "/" (so the result sits between literal slashes) and the four line
// terminators to their \X forms.
static MalValue regexp_escape_pattern(MalVm *vm, MalString *src) {
    usize n = mal_string_length(src);
    if (n == 0) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "(?:)"));
    }
    const c16 *u = mal_string_code_units(src);
    usize capacity = 0;
    usize bytes;
    bool prev_backslash = false;
    for (usize i = 0; i < n; i++) {
        c16 c = u[i];
        usize extra = (c == 0x2028 || c == 0x2029) ? 6 :
            (c == '\n' || c == '\r' || (c == '/' && !prev_backslash)) ? 2 : 1;
        if (!mal_checked_size_add(capacity, extra, MAL_STRING_MAX_CODE_UNITS, &capacity)) {
            regexp_throw_string_length(vm);
            return mal_value_new_undefined();
        }
        prev_backslash = (c == '\\') && !prev_backslash;
    }
    if (!mal_checked_size_multiply(sizeof(c16), capacity, SIZE_MAX, &bytes)) {
        regexp_throw_string_length(vm);
        return mal_value_new_undefined();
    }
    c16 *buf = malloc(bytes);
    if (buf == nullptr) {
        regexp_throw_string_length(vm);
        return mal_value_new_undefined();
    }
    usize out = 0;
    prev_backslash = false;
    for (usize i = 0; i < n; i++) {
        c16 c = u[i];
        if (c == '\n') {
            buf[out++] = '\\';
            buf[out++] = 'n';
        } else if (c == '\r') {
            buf[out++] = '\\';
            buf[out++] = 'r';
        } else if (c == 0x2028 || c == 0x2029) {
            const char *hex = "0123456789abcdef";
            buf[out++] = '\\';
            buf[out++] = 'u';
            buf[out++] = '2';
            buf[out++] = '0';
            buf[out++] = (c16) hex[(c >> 4) & 0xF];
            buf[out++] = (c16) hex[c & 0xF];
        } else if (c == '/' && !prev_backslash) {
            buf[out++] = '\\';
            buf[out++] = '/';
        } else {
            buf[out++] = c;
        }
        prev_backslash = (c == '\\') && !prev_backslash;
    }
    MalString *result = mal_string_new_copy(&vm->heap, buf, out);
    free(buf);
    return mal_value_from_string(result);
}

// ---------------------------------------------------------------------------
// RegExpInitialize / RegExpCreate
// ---------------------------------------------------------------------------

static bool regexp_initialize(MalVm *vm, MalRegExpObject *re, MalString *pattern, MalString *flags_str) {
    u32 bits;
    if (!regexp_parse_flags(flags_str, &bits)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "invalid regular expression flags");
        return false;
    }
    void *matcher = mal_regexp_compile(
        (const uint16_t *) mal_string_code_units(pattern), mal_string_length(pattern), regexp_regress_flags(bits)
    );
    if (matcher == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "invalid regular expression");
        return false;
    }
    re->matcher = matcher;
    re->source = pattern;
    re->flags = flags_str;
    re->flag_bits = bits;
    // lastIndex is a { writable, !enumerable, !configurable } own data property.
    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_from_i32(0), MAL_PROPERTY_WRITABLE);
    mal_object_define_own((MalObject *) re, mal_intrinsic_string_key(vm, (const byte *) "lastIndex"), &desc);
    return true;
}

MalValue mal_regexp_create(MalVm *vm, MalString *pattern, MalString *flags) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REGEXP_PROTOTYPE]);
    MalRegExpObject *re = mal_regexp_object_new(&vm->heap, prototype);
    if (!regexp_initialize(vm, re, pattern, flags)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_regexp_object(re);
}

// ---------------------------------------------------------------------------
// lastIndex helpers
// ---------------------------------------------------------------------------

static bool regexp_get_last_index(MalVm *vm, MalValue r, i64 *out) {
    MalValue v;
    if (!mal_vm_get_property(vm, r, mal_intrinsic_string_key(vm, (const byte *) "lastIndex"), &v)) {
        return false;
    }
    f64 num;
    if (!mal_vm_to_number(vm, v, &num)) {
        return false;
    }
    // ToLength: NaN/negatives clamp to 0, cap at 2^53-1.
    if (isnan(num) || num <= 0) {
        *out = 0;
        return true;
    }
    num = trunc(num);
    if (num > 9007199254740991.0) {
        num = 9007199254740991.0;
    }
    *out = (i64) num;
    return true;
}

static bool regexp_set_last_index(MalVm *vm, MalValue r, i64 value) {
    bool ok = mal_vm_set_property(
        vm, r, mal_intrinsic_string_key(vm, (const byte *) "lastIndex"), mal_value_from_f64((f64) value), r
    );
    if (regexp_threw(vm)) {
        return false;
    }
    if (!ok) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "cannot set lastIndex");
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// RegExpBuiltinExec result shaping
// ---------------------------------------------------------------------------

// Build the `.groups` object (null prototype), or undefined when the pattern has
// no named groups. Names + ranges come from the matcher's retained last match.
static MalValue regexp_build_groups(MalVm *vm, MalRegExpObject *re, MalString *s) {
    int32_t count = mal_regexp_named_group_count(re->matcher);
    if (count <= 0) {
        return mal_value_new_undefined();
    }
    MalObject *groups = mal_object_new(&vm->heap, nullptr);
    for (int32_t i = 0; i < count; i++) {
        uint8_t name_buf[128];
        int32_t range[2];
        int32_t name_len = mal_regexp_named_group(re->matcher, i, name_buf, (int32_t) sizeof(name_buf), range);
        if (name_len < 0) {
            continue;
        }
        uint8_t *nb = name_buf;
        if (name_len > (int32_t) sizeof(name_buf)) {
            nb = malloc((usize) name_len);
            if (nb == nullptr) {
                regexp_throw_string_length(vm);
                return mal_value_new_undefined();
            }
            mal_regexp_named_group(re->matcher, i, nb, name_len, range);
        }
        MalString *name = regexp_string_from_utf8(vm, nb, (usize) name_len);
        if (nb != name_buf) {
            free(nb);
        }
        MalValue value = range[0] < 0 ? mal_value_new_undefined() : regexp_substring(vm, s, range[0], range[1]);
        MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
        MalPropertyDesc desc = mal_intrinsic_data_desc(value, REGEXP_WEC);
        mal_object_define_own(groups, key, &desc);
    }
    return mal_value_from_object(groups);
}

// Build the `.indices` array for the `d` flag: a [start,end] pair (or undefined)
// per group, plus an `.indices.groups` object for named groups.
static MalValue regexp_build_indices(MalVm *vm, MalRegExpObject *re, MalString *s, const int32_t *caps, int32_t ngroups) {
    MalArrayObject *indices = mal_intrinsic_new_array(vm, (u32) ngroups);
    for (int32_t i = 0; i < ngroups; i++) {
        int32_t cs = caps[2 * i];
        int32_t ce = caps[2 * i + 1];
        MalValue entry;
        if (cs < 0) {
            entry = mal_value_new_undefined();
        } else {
            MalArrayObject *pair = mal_intrinsic_new_array(vm, 2);
            mal_array_object_store(pair, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_f64((f64) cs));
            mal_array_object_store(pair, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_from_f64((f64) ce));
            entry = mal_value_from_object((MalObject *) pair);
        }
        mal_array_object_store(indices, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)}, entry);
    }

    // indices.groups
    int32_t named = mal_regexp_named_group_count(re->matcher);
    MalValue groups_value;
    if (named <= 0) {
        groups_value = mal_value_new_undefined();
    } else {
        MalObject *groups = mal_object_new(&vm->heap, nullptr);
        for (int32_t i = 0; i < named; i++) {
            uint8_t name_buf[128];
            int32_t range[2];
            int32_t name_len = mal_regexp_named_group(re->matcher, i, name_buf, (int32_t) sizeof(name_buf), range);
            if (name_len < 0) {
                continue;
            }
            uint8_t *nb = name_buf;
            if (name_len > (int32_t) sizeof(name_buf)) {
                nb = malloc((usize) name_len);
                if (nb == nullptr) {
                    regexp_throw_string_length(vm);
                    return mal_value_new_undefined();
                }
                mal_regexp_named_group(re->matcher, i, nb, name_len, range);
            }
            MalString *name = regexp_string_from_utf8(vm, nb, (usize) name_len);
            if (nb != name_buf) {
                free(nb);
            }
            MalValue entry;
            if (range[0] < 0) {
                entry = mal_value_new_undefined();
            } else {
                MalArrayObject *pair = mal_intrinsic_new_array(vm, 2);
                mal_array_object_store(pair, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_f64((f64) range[0]));
                mal_array_object_store(pair, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_from_f64((f64) range[1]));
                entry = mal_value_from_object((MalObject *) pair);
            }
            MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
            MalPropertyDesc desc = mal_intrinsic_data_desc(entry, REGEXP_WEC);
            mal_object_define_own(groups, key, &desc);
        }
        groups_value = mal_value_from_object(groups);
    }
    MalPropertyDesc groups_desc = mal_intrinsic_data_desc(groups_value, REGEXP_WEC);
    mal_object_define_own((MalObject *) indices, mal_intrinsic_string_key(vm, (const byte *) "groups"), &groups_desc);

    return mal_value_from_object((MalObject *) indices);
}

// RegExpBuiltinExec(R, S): the matcher-backed exec. Returns the result array, or
// null on no match, or undefined with a pending throw on error.
// match_only skips building the result array (and its substrings/groups) — used
// by test(), where only match/no-match matters. This avoids per-call allocation
// in the bump heap, which is critical for the Unicode-scale test262 tests that
// call test() over ~1M code points. Returns boolean true on match (still
// non-null, so callers checking `!== null` work) and null on no match.
static MalValue regexp_builtin_exec(MalVm *vm, MalRegExpObject *re, MalValue r_value, MalString *s, bool match_only) {
    usize length = mal_string_length(s);

    i64 last_index;
    if (!regexp_get_last_index(vm, r_value, &last_index)) {
        return mal_value_new_undefined();
    }

    bool global = (re->flag_bits & MAL_REGEXP_JS_GLOBAL) != 0;
    bool sticky = (re->flag_bits & MAL_REGEXP_JS_STICKY) != 0;
    bool has_indices = (re->flag_bits & MAL_REGEXP_JS_HAS_INDICES) != 0;
    if (!global && !sticky) {
        last_index = 0;
    }

    if (last_index > (i64) length) {
        if (global || sticky) {
            if (!regexp_set_last_index(vm, r_value, 0)) {
                return mal_value_new_undefined();
            }
        }
        return mal_value_new_null();
    }

    int32_t stack_caps[64];
    int32_t *caps = stack_caps;
    int32_t ngroups = mal_regexp_exec(
        re->matcher, (const uint16_t *) mal_string_code_units(s), length, (size_t) last_index, caps, 64
    );
    if (ngroups < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "regular expression execution failed");
        return mal_value_new_undefined();
    }
    if (ngroups == 0) {
        if (global || sticky) {
            if (!regexp_set_last_index(vm, r_value, 0)) {
                return mal_value_new_undefined();
            }
        }
        return mal_value_new_null();
    }

    bool heap_caps = false;
    if (ngroups > 32) {
        usize capture_count;
        usize capture_bytes;
        if (!mal_checked_size_multiply((usize) ngroups, 2, MAL_STRING_MAX_CODE_UNITS, &capture_count) ||
            !mal_checked_size_multiply(sizeof(int32_t), capture_count, SIZE_MAX, &capture_bytes)) {
            regexp_throw_string_length(vm);
            return mal_value_new_undefined();
        }
        caps = malloc(capture_bytes);
        if (caps == nullptr) {
            regexp_throw_string_length(vm);
            return mal_value_new_undefined();
        }
        mal_regexp_copy_captures(re->matcher, caps, (int32_t) capture_count);
        heap_caps = true;
    }

    int32_t match_start = caps[0];
    int32_t match_end = caps[1];

    // Sticky requires the match to begin exactly at lastIndex.
    if (sticky && match_start != (i32) last_index) {
        if (heap_caps) {
            free(caps);
        }
        if (!regexp_set_last_index(vm, r_value, 0)) {
            return mal_value_new_undefined();
        }
        return mal_value_new_null();
    }

    if (global || sticky) {
        if (!regexp_set_last_index(vm, r_value, match_end)) {
            if (heap_caps) {
                free(caps);
            }
            return mal_value_new_undefined();
        }
    }

    if (match_only) {
        if (heap_caps) {
            free(caps);
        }
        return mal_value_new_boolean(true);
    }

    MalArrayObject *array = mal_intrinsic_new_array(vm, (u32) ngroups);
    MalObject *array_object = (MalObject *) array;

    MalPropertyDesc index_desc = mal_intrinsic_data_desc(mal_value_from_f64((f64) match_start), REGEXP_WEC);
    mal_object_define_own(array_object, mal_intrinsic_string_key(vm, (const byte *) "index"), &index_desc);
    MalPropertyDesc input_desc = mal_intrinsic_data_desc(mal_value_from_string(s), REGEXP_WEC);
    mal_object_define_own(array_object, mal_intrinsic_string_key(vm, (const byte *) "input"), &input_desc);

    for (int32_t i = 0; i < ngroups; i++) {
        int32_t cs = caps[2 * i];
        int32_t ce = caps[2 * i + 1];
        MalValue element = cs < 0 ? mal_value_new_undefined() : regexp_substring(vm, s, cs, ce);
        mal_array_object_store(array, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)}, element);
    }

    MalValue groups = regexp_build_groups(vm, re, s);
    MalPropertyDesc groups_desc = mal_intrinsic_data_desc(groups, REGEXP_WEC);
    mal_object_define_own(array_object, mal_intrinsic_string_key(vm, (const byte *) "groups"), &groups_desc);

    if (has_indices) {
        MalValue indices = regexp_build_indices(vm, re, s, caps, ngroups);
        MalPropertyDesc indices_desc = mal_intrinsic_data_desc(indices, REGEXP_WEC);
        mal_object_define_own(array_object, mal_intrinsic_string_key(vm, (const byte *) "indices"), &indices_desc);
    }

    if (heap_caps) {
        free(caps);
    }
    return mal_value_from_object(array_object);
}

// RegExpExec(R, S): use a user-defined `exec` if callable; else RegExpBuiltinExec.
// Returns object or null; sets *ok=false (with a pending throw) on error.
static MalValue regexp_exec_abstract(MalVm *vm, MalValue r, MalString *s, bool match_only, bool *ok) {
    MalValue exec_fn;
    if (!mal_vm_get_property(vm, r, mal_intrinsic_string_key(vm, (const byte *) "exec"), &exec_fn)) {
        *ok = false;
        return mal_value_new_undefined();
    }
    if (mal_value_is_callable(exec_fn)) {
        MalValue arg = mal_value_from_string(s);
        MalCompletion completion = mal_vm_call_value(vm, exec_fn, r, &arg, 1);
        if (completion.kind == MAL_COMPLETION_THROW) {
            *ok = false;
            return mal_value_new_undefined();
        }
        if (!mal_value_is_object(completion.value) && !mal_value_is_null(completion.value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "exec method must return an object or null");
            *ok = false;
            return mal_value_new_undefined();
        }
        *ok = true;
        return completion.value;
    }
    if (!mal_value_is_regexp_object(r)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype.exec called on incompatible receiver");
        *ok = false;
        return mal_value_new_undefined();
    }
    MalValue result = regexp_builtin_exec(vm, mal_value_to_regexp_object(r), r, s, match_only);
    *ok = !regexp_threw(vm);
    return result;
}

// IsRegExp(argument): @@match overrides the [[RegExpMatcher]] brand.
static bool regexp_is_regexp(MalVm *vm, MalValue arg, bool *out) {
    if (!mal_value_is_object(arg)) {
        *out = false;
        return true;
    }
    MalValue matcher;
    if (!mal_vm_get_property(vm, arg, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_MATCH), &matcher)) {
        return false;
    }
    if (!mal_value_is_undefined(matcher)) {
        *out = mal_value_is_truthy(matcher);
        return true;
    }
    *out = mal_value_is_regexp_object(arg);
    return true;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

static MalValue regexp_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalValue pattern = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue flags = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    bool pattern_is_regexp;
    if (!regexp_is_regexp(vm, pattern, &pattern_is_regexp)) {
        return mal_value_new_undefined();
    }

    MalValue used_new_target = new_target;
    if (mal_value_is_undefined(new_target)) {
        used_new_target = callee; // the active RegExp function
        // RegExp(re) with no flags and re.constructor === RegExp returns re.
        if (pattern_is_regexp && mal_value_is_undefined(flags)) {
            MalValue pattern_constructor;
            if (!mal_vm_get_property(vm, pattern, mal_intrinsic_string_key(vm, (const byte *) "constructor"), &pattern_constructor)) {
                return mal_value_new_undefined();
            }
            if (pattern_constructor == used_new_target) {
                return pattern;
            }
        }
    }

    MalString *p_str;
    MalString *f_str;
    if (mal_value_is_regexp_object(pattern)) {
        MalRegExpObject *source = mal_value_to_regexp_object(pattern);
        p_str = source->source;
        if (mal_value_is_undefined(flags)) {
            f_str = source->flags;
        } else if (!mal_vm_to_string(vm, flags, &f_str)) {
            return mal_value_new_undefined();
        }
    } else if (pattern_is_regexp) {
        MalValue source_value;
        if (!mal_vm_get_property(vm, pattern, mal_intrinsic_string_key(vm, (const byte *) "source"), &source_value)) {
            return mal_value_new_undefined();
        }
        if (!mal_vm_to_string(vm, source_value, &p_str)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_undefined(flags)) {
            MalValue flags_value;
            if (!mal_vm_get_property(vm, pattern, mal_intrinsic_string_key(vm, (const byte *) "flags"), &flags_value)) {
                return mal_value_new_undefined();
            }
            if (!mal_vm_to_string(vm, flags_value, &f_str)) {
                return mal_value_new_undefined();
            }
        } else if (!mal_vm_to_string(vm, flags, &f_str)) {
            return mal_value_new_undefined();
        }
    } else {
        if (mal_value_is_undefined(pattern)) {
            p_str = mal_intrinsic_ascii(vm, (const byte *) "");
        } else if (!mal_vm_to_string(vm, pattern, &p_str)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_undefined(flags)) {
            f_str = mal_intrinsic_ascii(vm, (const byte *) "");
        } else if (!mal_vm_to_string(vm, flags, &f_str)) {
            return mal_value_new_undefined();
        }
    }

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, used_new_target, MAL_INTRINSIC_REGEXP_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    MalRegExpObject *re = mal_regexp_object_new(&vm->heap, prototype);
    if (!regexp_initialize(vm, re, p_str, f_str)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_regexp_object(re);
}

// ---------------------------------------------------------------------------
// Prototype: exec / test
// ---------------------------------------------------------------------------

static bool regexp_this(MalVm *vm, MalValue this_value, MalRegExpObject **out) {
    if (!mal_value_is_regexp_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype method called on incompatible receiver");
        return false;
    }
    *out = mal_value_to_regexp_object(this_value);
    return true;
}

static MalValue regexp_proto_exec(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalRegExpObject *re;
    if (!regexp_this(vm, this_value, &re)) {
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }
    return regexp_builtin_exec(vm, re, this_value, s, false);
}

static MalValue regexp_proto_test(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype.test called on non-object");
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }
    bool ok;
    MalValue match = regexp_exec_abstract(vm, this_value, s, true, &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(!mal_value_is_null(match));
}

// ---------------------------------------------------------------------------
// Prototype: flag accessors + source + flags + toString
// ---------------------------------------------------------------------------

static bool regexp_getter_this(MalVm *vm, MalValue this_value, MalRegExpObject **out, bool *is_prototype) {
    *is_prototype = false;
    if (mal_value_is_regexp_object(this_value)) {
        *out = mal_value_to_regexp_object(this_value);
        return true;
    }
    if (this_value == vm->intrinsics[MAL_INTRINSIC_REGEXP_PROTOTYPE]) {
        *is_prototype = true;
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype accessor called on incompatible receiver");
    return false;
}

static MalValue regexp_flag_getter(MalVm *vm, MalValue this_value, u32 bit) {
    MalRegExpObject *re;
    bool is_prototype;
    if (!regexp_getter_this(vm, this_value, &re, &is_prototype)) {
        return mal_value_new_undefined();
    }
    if (is_prototype) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean((re->flag_bits & bit) != 0);
}

#define REGEXP_FLAG_GETTER(fn, bit)                                                                                     \
    static MalValue fn(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args;                                                                                                   \
        (void) arg_count;                                                                                              \
        (void) new_target;                                                                                             \
        (void) callee;                                                                                                 \
        return regexp_flag_getter(vm, this_value, (bit));                                                              \
    }

REGEXP_FLAG_GETTER(regexp_proto_get_global, MAL_REGEXP_JS_GLOBAL)
REGEXP_FLAG_GETTER(regexp_proto_get_ignore_case, MAL_REGEXP_JS_IGNORE_CASE)
REGEXP_FLAG_GETTER(regexp_proto_get_multiline, MAL_REGEXP_JS_MULTILINE)
REGEXP_FLAG_GETTER(regexp_proto_get_dot_all, MAL_REGEXP_JS_DOT_ALL)
REGEXP_FLAG_GETTER(regexp_proto_get_unicode, MAL_REGEXP_JS_UNICODE)
REGEXP_FLAG_GETTER(regexp_proto_get_sticky, MAL_REGEXP_JS_STICKY)
REGEXP_FLAG_GETTER(regexp_proto_get_has_indices, MAL_REGEXP_JS_HAS_INDICES)
REGEXP_FLAG_GETTER(regexp_proto_get_unicode_sets, MAL_REGEXP_JS_UNICODE_SETS)

static MalValue regexp_proto_get_source(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalRegExpObject *re;
    bool is_prototype;
    if (!regexp_getter_this(vm, this_value, &re, &is_prototype)) {
        return mal_value_new_undefined();
    }
    if (is_prototype) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "(?:)"));
    }
    return regexp_escape_pattern(vm, re->source);
}

// The generic `get flags` per spec: read the eight boolean flag getters off
// `this` in order and concatenate. Works on any object (so subclasses observe
// their overridden getters).
static MalValue regexp_proto_get_flags(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype.flags getter called on non-object");
        return mal_value_new_undefined();
    }
    static const struct {
        const char *name;
        char ch;
    } table[] = {
        {"hasIndices", 'd'}, {"global", 'g'}, {"ignoreCase", 'i'}, {"multiline", 'm'},
        {"dotAll", 's'}, {"unicode", 'u'}, {"unicodeSets", 'v'}, {"sticky", 'y'},
    };
    c16 buf[8];
    usize n = 0;
    for (usize i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        MalValue value;
        if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, (const byte *) table[i].name), &value)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_truthy(value)) {
            buf[n++] = (c16) table[i].ch;
        }
    }
    return mal_value_from_string(mal_string_new_copy(&vm->heap, buf, n));
}

static MalValue regexp_proto_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype.toString called on non-object");
        return mal_value_new_undefined();
    }
    MalValue source_value;
    MalString *source;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, (const byte *) "source"), &source_value)) {
        return mal_value_new_undefined();
    }
    if (!mal_vm_to_string(vm, source_value, &source)) {
        return mal_value_new_undefined();
    }
    MalValue flags_value;
    MalString *flags;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, (const byte *) "flags"), &flags_value)) {
        return mal_value_new_undefined();
    }
    if (!mal_vm_to_string(vm, flags_value, &flags)) {
        return mal_value_new_undefined();
    }
    usize source_len = mal_string_length(source);
    usize flags_len = mal_string_length(flags);
    usize total;
    usize bytes;
    if (!mal_checked_size_add(source_len, flags_len, MAL_STRING_MAX_CODE_UNITS, &total) ||
        !mal_checked_size_add(total, 2, MAL_STRING_MAX_CODE_UNITS, &total) ||
        !mal_checked_size_multiply(sizeof(c16), total, SIZE_MAX, &bytes)) {
        regexp_throw_string_length(vm);
        return mal_value_new_undefined();
    }
    c16 *buf = malloc(bytes);
    if (buf == nullptr) {
        regexp_throw_string_length(vm);
        return mal_value_new_undefined();
    }
    usize out = 0;
    buf[out++] = '/';
    for (usize i = 0; i < source_len; i++) {
        buf[out++] = mal_string_code_units(source)[i];
    }
    buf[out++] = '/';
    for (usize i = 0; i < flags_len; i++) {
        buf[out++] = mal_string_code_units(flags)[i];
    }
    MalString *result = mal_string_new_copy(&vm->heap, buf, out);
    free(buf);
    return mal_value_from_string(result);
}

// ---------------------------------------------------------------------------
// Symbol.* protocol helpers
// ---------------------------------------------------------------------------

// A growable UTF-16 string builder for @@replace / GetSubstitution.
typedef struct {
    c16 *data;
    usize len;
    usize cap;
} RegexpBuilder;

static bool regexp_builder_reserve(MalVm *vm, RegexpBuilder *b, usize extra) {
    usize required;
    if (!mal_checked_size_add(b->len, extra, MAL_STRING_MAX_CODE_UNITS, &required)) {
        return regexp_throw_string_length(vm);
    }
    if (required <= b->cap) {
        return true;
    }
    usize cap;
    usize bytes;
    if (!mal_checked_size_growth(b->cap, required, 16, MAL_STRING_MAX_CODE_UNITS, &cap) ||
        !mal_checked_size_multiply(sizeof(c16), cap, SIZE_MAX, &bytes)) {
        return regexp_throw_string_length(vm);
    }
    c16 *grown = realloc(b->data, bytes);
    if (grown == nullptr) {
        return regexp_throw_string_length(vm);
    }
    b->data = grown;
    b->cap = cap;
    return true;
}

static bool regexp_builder_append_units(MalVm *vm, RegexpBuilder *b, const c16 *units, usize n) {
    if (!regexp_builder_reserve(vm, b, n)) {
        return false;
    }
    for (usize i = 0; i < n; i++) {
        b->data[b->len++] = units[i];
    }
    return true;
}

static bool regexp_builder_append_string(MalVm *vm, RegexpBuilder *b, const MalString *s) {
    return regexp_builder_append_units(vm, b, mal_string_code_units(s), mal_string_length(s));
}

static MalValue regexp_builder_finish(MalVm *vm, RegexpBuilder *b) {
    MalString *s = mal_string_new_copy(&vm->heap, b->data, b->len);
    free(b->data);
    return mal_value_from_string(s);
}

// AdvanceStringIndex(S, index, unicode): +2 across a surrogate pair in unicode
// mode, else +1.
static i64 regexp_advance_string_index(MalString *s, i64 index, bool unicode) {
    if (!unicode) {
        return index + 1;
    }
    usize length = mal_string_length(s);
    if (index + 1 >= (i64) length) {
        return index + 1;
    }
    const c16 *u = mal_string_code_units(s);
    c16 first = u[index];
    c16 second = u[index + 1];
    if (first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF) {
        return index + 2;
    }
    return index + 1;
}

static bool regexp_flags_string(MalVm *vm, MalValue rx, MalString **out) {
    MalValue value;
    if (!mal_vm_get_property(vm, rx, mal_intrinsic_string_key(vm, (const byte *) "flags"), &value)) {
        return false;
    }
    return mal_vm_to_string(vm, value, out);
}

static bool regexp_flags_has(const MalString *flags, c16 ch) {
    const c16 *u = mal_string_code_units(flags);
    usize n = mal_string_length(flags);
    for (usize i = 0; i < n; i++) {
        if (u[i] == ch) {
            return true;
        }
    }
    return false;
}

static bool regexp_same_value(MalValue a, MalValue b) {
    if (mal_ops_is_number(a) && mal_ops_is_number(b)) {
        f64 x = mal_ops_number_as_f64(a);
        f64 y = mal_ops_number_as_f64(b);
        if (isnan(x) && isnan(y)) {
            return true;
        }
        if (x == 0.0 && y == 0.0) {
            return signbit(x) == signbit(y);
        }
        return x == y;
    }
    return a == b;
}

// SpeciesConstructor(rx, %RegExp%). Sets *ok=false on a pending throw.
static MalValue regexp_species_constructor(MalVm *vm, MalValue rx, bool *ok) {
    *ok = true;
    MalValue constructor;
    if (!mal_vm_get_property(vm, rx, mal_intrinsic_string_key(vm, (const byte *) "constructor"), &constructor)) {
        *ok = false;
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(constructor)) {
        return vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR];
    }
    if (!mal_value_is_object(constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "constructor is not an object");
        *ok = false;
        return mal_value_new_undefined();
    }
    MalValue species;
    if (!mal_vm_get_property(vm, constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &species)) {
        *ok = false;
        return mal_value_new_undefined();
    }
    if (mal_value_is_nil(species)) {
        return vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR];
    }
    if (!mal_vm_is_constructor(vm, species)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "@@species is not a constructor");
        *ok = false;
        return mal_value_new_undefined();
    }
    return species;
}

// Generic Get(obj, "name") -> ToString.
static bool regexp_get_string_prop(MalVm *vm, MalValue obj, const byte *name, MalString **out) {
    MalValue value;
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    return mal_vm_to_string(vm, value, out);
}

// Get(obj, index) -> ToString, using a canonical integer-index key (the result
// array stores elements under index keys, so a string "0" key would miss).
static bool regexp_get_index_string(MalVm *vm, MalValue obj, i32 index, MalString **out) {
    MalValue value;
    MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)};
    if (!mal_vm_get_property(vm, obj, key, &value)) {
        return false;
    }
    return mal_vm_to_string(vm, value, out);
}

// Generic Get(obj, "length") -> ToLength.
static bool regexp_get_length_prop(MalVm *vm, MalValue obj, const byte *name, i64 *out) {
    MalValue value;
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    f64 num;
    if (!mal_vm_to_number(vm, value, &num)) {
        return false;
    }
    if (isnan(num) || num <= 0) {
        *out = 0;
        return true;
    }
    num = trunc(num);
    if (num > 9007199254740991.0) {
        num = 9007199254740991.0;
    }
    *out = (i64) num;
    return true;
}

// ---------------------------------------------------------------------------
// RegExp.prototype[@@search]
// ---------------------------------------------------------------------------

static MalValue regexp_proto_search(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype[Symbol.search] called on non-object");
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }

    MalValue previous_last_index;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, (const byte *) "lastIndex"), &previous_last_index)) {
        return mal_value_new_undefined();
    }
    if (!regexp_same_value(previous_last_index, mal_value_from_i32(0))) {
        if (!regexp_set_last_index(vm, this_value, 0)) {
            return mal_value_new_undefined();
        }
    }

    bool ok;
    MalValue result = regexp_exec_abstract(vm, this_value, s, false, &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }

    MalValue current_last_index;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, (const byte *) "lastIndex"), &current_last_index)) {
        return mal_value_new_undefined();
    }
    if (!regexp_same_value(current_last_index, previous_last_index)) {
        bool restore = mal_vm_set_property(
            vm, this_value, mal_intrinsic_string_key(vm, (const byte *) "lastIndex"), previous_last_index, this_value
        );
        if (regexp_threw(vm) || !restore) {
            if (!regexp_threw(vm)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "cannot restore lastIndex");
            }
            return mal_value_new_undefined();
        }
    }

    if (mal_value_is_null(result)) {
        return mal_value_from_i32(-1);
    }
    MalValue index;
    if (!mal_vm_get_property(vm, result, mal_intrinsic_string_key(vm, (const byte *) "index"), &index)) {
        return mal_value_new_undefined();
    }
    return index;
}

// ---------------------------------------------------------------------------
// RegExp.prototype[@@match]
// ---------------------------------------------------------------------------

static MalValue regexp_proto_match(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype[Symbol.match] called on non-object");
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }
    MalString *flags;
    if (!regexp_flags_string(vm, this_value, &flags)) {
        return mal_value_new_undefined();
    }
    bool global = regexp_flags_has(flags, 'g');

    if (!global) {
        bool ok;
        MalValue result = regexp_exec_abstract(vm, this_value, s, false, &ok);
        return ok ? result : mal_value_new_undefined();
    }

    bool full_unicode = regexp_flags_has(flags, 'u') || regexp_flags_has(flags, 'v');
    if (!regexp_set_last_index(vm, this_value, 0)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
    u32 n = 0;
    while (true) {
        bool ok;
        MalValue result = regexp_exec_abstract(vm, this_value, s, false, &ok);
        if (!ok) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_null(result)) {
            return n == 0 ? mal_value_new_null() : mal_value_from_object((MalObject *) array);
        }
        MalString *match_str;
        if (!regexp_get_index_string(vm, result, 0, &match_str)) {
            return mal_value_new_undefined();
        }
        mal_array_object_store(array, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) n)}, mal_value_from_string(match_str));
        if (mal_string_length(match_str) == 0) {
            i64 this_index;
            if (!regexp_get_last_index(vm, this_value, &this_index)) {
                return mal_value_new_undefined();
            }
            i64 next_index = regexp_advance_string_index(s, this_index, full_unicode);
            if (!regexp_set_last_index(vm, this_value, next_index)) {
                return mal_value_new_undefined();
            }
        }
        n++;
    }
}

// ---------------------------------------------------------------------------
// GetSubstitution + RegExp.prototype[@@replace]
// ---------------------------------------------------------------------------

// GetSubstitution(matched, str, position, captures[], capture_count, named, replacement).
// captures entries are ToString'd strings or undefined; named is the groups
// object or undefined. Appends the expanded replacement into `out`.
static bool regexp_get_substitution(
    MalVm *vm, MalString *matched, MalString *str, i64 position, const MalValue *captures, i64 capture_count,
    MalValue named, MalString *replacement, RegexpBuilder *out
) {
    const c16 *r = mal_string_code_units(replacement);
    usize rlen = mal_string_length(replacement);
    usize match_len = mal_string_length(matched);
    usize str_len = mal_string_length(str);

    usize i = 0;
    while (i < rlen) {
        c16 c = r[i];
        if (c != '$' || i + 1 >= rlen) {
            if (!regexp_builder_append_units(vm, out, &r[i], 1)) return false;
            i++;
            continue;
        }
        c16 next = r[i + 1];
        if (next == '$') {
            if (!regexp_builder_append_units(vm, out, &(c16){'$'}, 1)) return false;
            i += 2;
        } else if (next == '&') {
            if (!regexp_builder_append_string(vm, out, matched)) return false;
            i += 2;
        } else if (next == '`') {
            if (!regexp_builder_append_units(vm, out, mal_string_code_units(str), (usize) position)) return false;
            i += 2;
        } else if (next == '\'') {
            usize tail = (usize) position + match_len;
            if (tail < str_len) {
                if (!regexp_builder_append_units(vm, out, mal_string_code_units(str) + tail, str_len - tail)) return false;
            }
            i += 2;
        } else if (next >= '0' && next <= '9') {
            // $n or $nn (1..99); prefer two digits when in range.
            i64 one = next - '0';
            i64 two = -1;
            if (i + 2 < rlen && r[i + 2] >= '0' && r[i + 2] <= '9') {
                two = one * 10 + (r[i + 2] - '0');
            }
            i64 n = -1;
            usize consumed = 0;
            if (two >= 1 && two <= capture_count) {
                n = two;
                consumed = 3;
            } else if (one >= 1 && one <= capture_count) {
                n = one;
                consumed = 2;
            }
            if (n < 0) {
                if (!regexp_builder_append_units(vm, out, &r[i], 1)) return false;
                i++;
            } else {
                MalValue capture = captures[n - 1];
                if (!mal_value_is_undefined(capture)) {
                    if (!regexp_builder_append_string(vm, out, mal_value_to_string(capture))) return false;
                }
                i += consumed;
            }
        } else if (next == '<' && !mal_value_is_undefined(named)) {
            // $<name>
            usize close = 0;
            bool found = false;
            for (usize j = i + 2; j < rlen; j++) {
                if (r[j] == '>') {
                    close = j;
                    found = true;
                    break;
                }
            }
            if (!found) {
                if (!regexp_builder_append_units(vm, out, &r[i], 1)) return false;
                i++;
            } else {
                MalString *name = mal_string_new_copy(&vm->heap, &r[i + 2], close - (i + 2));
                MalValue value;
                if (!mal_vm_get_property(vm, named, (MalKey){.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)}, &value)) {
                    return false;
                }
                if (!mal_value_is_undefined(value)) {
                    MalString *value_str;
                    if (!mal_vm_to_string(vm, value, &value_str)) {
                        return false;
                    }
                    if (!regexp_builder_append_string(vm, out, value_str)) return false;
                }
                i = close + 1;
            }
        } else {
            if (!regexp_builder_append_units(vm, out, &r[i], 1)) return false;
            i++;
        }
    }
    return true;
}

static MalValue regexp_proto_replace(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype[Symbol.replace] called on non-object");
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }
    usize length_s = mal_string_length(s);
    MalValue replace_value = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    bool functional = mal_value_is_callable(replace_value);
    MalString *replace_string = nullptr;
    if (!functional) {
        if (!mal_vm_to_string(vm, replace_value, &replace_string)) {
            return mal_value_new_undefined();
        }
    }

    MalString *flags;
    if (!regexp_flags_string(vm, this_value, &flags)) {
        return mal_value_new_undefined();
    }
    bool global = regexp_flags_has(flags, 'g');
    bool full_unicode = false;
    if (global) {
        full_unicode = regexp_flags_has(flags, 'u') || regexp_flags_has(flags, 'v');
        if (!regexp_set_last_index(vm, this_value, 0)) {
            return mal_value_new_undefined();
        }
    }

    // Collect all match results, then build the replacement string. Both phases
    // re-enter JS (exec, capture ToString, the replacer callback, ToString of its
    // result) and so can collect; lift GC suppression and root every heap value
    // held across a re-entry. Function-level spans (LIFO): the subject + literal
    // replacement template; the growing result array (pointer refreshed on
    // realloc, count tracked); the per-result scratch (matched / named groups /
    // replacement); and the per-result capture buffer (count grows as filled).
    // The replacer arguments get their own span across that one call.
    MalValue *results = nullptr;
    usize results_len = 0;
    usize results_cap = 0;
    RegexpBuilder accumulated = {0};
    MalValue *captures = nullptr;
    MalValue ret = mal_value_new_undefined();

    MalValue s_roots[2] = {mal_value_from_string(s), functional ? mal_value_new_undefined() : mal_value_from_string(replace_string)};
    MalValue pr_roots[3] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan s_span, results_span, pr_span, caps_span;
    mal_gc_root(&s_span, s_roots, 2);
    mal_gc_root(&results_span, results, 0);
    mal_gc_root(&pr_span, pr_roots, 3);
    mal_gc_root(&caps_span, captures, 0);
    mal_gc_native_rooted_begin(vm);

    while (true) {
        bool ok;
        MalValue result = regexp_exec_abstract(vm, this_value, s, false, &ok);
        if (!ok) {
            goto done;
        }
        if (mal_value_is_null(result)) {
            break;
        }
        if (results_len == results_cap) {
            usize required;
            usize new_cap;
            usize bytes;
            if (!mal_checked_size_add(results_len, 1, MAL_STRING_MAX_CODE_UNITS, &required) ||
                !mal_checked_size_growth(results_cap, required, 8, MAL_STRING_MAX_CODE_UNITS, &new_cap) ||
                !mal_checked_size_multiply(sizeof(MalValue), new_cap, SIZE_MAX, &bytes)) {
                regexp_throw_string_length(vm);
                goto done;
            }
            MalValue *grown = realloc(results, bytes);
            if (grown == nullptr) {
                regexp_throw_string_length(vm);
                goto done;
            }
            results = grown;
            results_cap = new_cap;
            results_span.slots = results;
        }
        results[results_len++] = result;
        results_span.count = (i32) results_len;
        if (!global) {
            break;
        }
        MalString *match_str;
        if (!regexp_get_index_string(vm, result, 0, &match_str)) {
            goto done;
        }
        if (mal_string_length(match_str) == 0) {
            i64 this_index;
            if (!regexp_get_last_index(vm, this_value, &this_index)) {
                goto done;
            }
            i64 next_index = regexp_advance_string_index(s, this_index, full_unicode);
            if (!regexp_set_last_index(vm, this_value, next_index)) {
                goto done;
            }
        }
    }

    i64 next_source_position = 0;
    for (usize ri = 0; ri < results_len; ri++) {
        MalValue result = results[ri];
        i64 result_length;
        if (!regexp_get_length_prop(vm, result, (const byte *) "length", &result_length)) {
            goto done;
        }
        i64 n_captures = result_length - 1;
        if (n_captures < 0) {
            n_captures = 0;
        }
        if ((u64) n_captures > MAL_STRING_MAX_CODE_UNITS) {
            regexp_throw_string_length(vm);
            goto done;
        }
        MalString *matched;
        if (!regexp_get_index_string(vm, result, 0, &matched)) {
            goto done;
        }
        pr_roots[0] = mal_value_from_string(matched);
        usize matched_len = mal_string_length(matched);

        MalValue index_value;
        if (!mal_vm_get_property(vm, result, mal_intrinsic_string_key(vm, (const byte *) "index"), &index_value)) {
            goto done;
        }
        f64 index_num;
        if (!mal_vm_to_number(vm, index_value, &index_num)) {
            goto done;
        }
        i64 position = isnan(index_num) ? 0 : (i64) trunc(index_num);
        if (position < 0) {
            position = 0;
        }
        if (position > (i64) length_s) {
            position = (i64) length_s;
        }

        // Captures 1..n_captures, each ToString'd or undefined.
        usize capture_bytes;
        if (!mal_checked_size_multiply(sizeof(MalValue), (usize) n_captures, SIZE_MAX, &capture_bytes)) {
            regexp_throw_string_length(vm);
            goto done;
        }
        captures = n_captures > 0 ? malloc(capture_bytes) : nullptr;
        if (n_captures > 0 && captures == nullptr) {
            regexp_throw_string_length(vm);
            goto done;
        }
        caps_span.slots = captures;
        caps_span.count = 0;
        bool capture_error = false;
        for (i64 ci = 1; ci <= n_captures; ci++) {
            MalValue cap_value;
            MalKey cap_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) ci)};
            if (!mal_vm_get_property(vm, result, cap_key, &cap_value)) {
                capture_error = true;
                break;
            }
            if (mal_value_is_undefined(cap_value)) {
                captures[ci - 1] = mal_value_new_undefined();
            } else {
                MalString *cap_str;
                if (!mal_vm_to_string(vm, cap_value, &cap_str)) {
                    capture_error = true;
                    break;
                }
                captures[ci - 1] = mal_value_from_string(cap_str);
            }
            caps_span.count = (i32) ci;
        }
        if (capture_error) {
            goto done;
        }

        MalValue named_captures;
        if (!mal_vm_get_property(vm, result, mal_intrinsic_string_key(vm, (const byte *) "groups"), &named_captures)) {
            goto done;
        }
        pr_roots[1] = named_captures;

        MalString *replacement_str = nullptr;
        if (functional) {
            // Args: matched, captures..., position, S, [named].
            usize argc;
            usize call_bytes;
            if (!mal_checked_size_add((usize) n_captures, 3, MAL_STRING_MAX_CODE_UNITS, &argc) ||
                (!mal_value_is_undefined(named_captures) &&
                    !mal_checked_size_add(argc, 1, MAL_STRING_MAX_CODE_UNITS, &argc)) ||
                !mal_checked_size_multiply(sizeof(MalValue), argc, SIZE_MAX, &call_bytes)) {
                regexp_throw_string_length(vm);
                goto done;
            }
            MalValue *call_args = malloc(call_bytes);
            if (call_args == nullptr) {
                regexp_throw_string_length(vm);
                goto done;
            }
            usize ai = 0;
            call_args[ai++] = mal_value_from_string(matched);
            for (i64 ci = 0; ci < n_captures; ci++) {
                call_args[ai++] = captures[ci];
            }
            call_args[ai++] = mal_value_from_f64((f64) position);
            call_args[ai++] = mal_value_from_string(s);
            if (!mal_value_is_undefined(named_captures)) {
                call_args[ai++] = named_captures;
            }
            MalRootSpan call_span;
            mal_gc_root(&call_span, call_args, (i32) argc);
            MalCompletion completion = mal_vm_call_value(vm, replace_value, mal_value_new_undefined(), call_args, (i32) argc);
            mal_gc_unroot(&call_span);
            free(call_args);
            if (completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
            if (!mal_vm_to_string(vm, completion.value, &replacement_str)) {
                goto done;
            }
            pr_roots[2] = mal_value_from_string(replacement_str);
        }

        if (position >= next_source_position) {
            if (!regexp_builder_append_units(
                    vm, &accumulated, mal_string_code_units(s) + next_source_position,
                    (usize) (position - next_source_position))) {
                goto done;
            }
            if (functional) {
                if (!regexp_builder_append_string(vm, &accumulated, replacement_str)) {
                    goto done;
                }
            } else {
                if (!regexp_get_substitution(vm, matched, s, position, captures, n_captures, named_captures, replace_string, &accumulated)) {
                    goto done;
                }
            }
            next_source_position = position + (i64) matched_len;
        }
        free(captures);
        captures = nullptr;
        caps_span.slots = nullptr;
        caps_span.count = 0;
        pr_roots[0] = pr_roots[1] = pr_roots[2] = mal_value_new_undefined();
    }

    if (next_source_position < (i64) length_s) {
        if (!regexp_builder_append_units(
                vm, &accumulated, mal_string_code_units(s) + next_source_position,
                length_s - (usize) next_source_position)) {
            goto done;
        }
    }
    ret = regexp_builder_finish(vm, &accumulated);
    accumulated.data = nullptr; // regexp_builder_finish copied and freed it

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&caps_span);
    mal_gc_unroot(&pr_span);
    mal_gc_unroot(&results_span);
    mal_gc_unroot(&s_span);
    free(captures);
    free(results);
    free(accumulated.data);
    return ret;
}

// ---------------------------------------------------------------------------
// RegExp.prototype[@@split]
// ---------------------------------------------------------------------------

static MalValue regexp_proto_split(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype[Symbol.split] called on non-object");
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }
    MalValue limit_value = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    // Build the sticky splitter via SpeciesConstructor.
    bool ok;
    MalValue constructor = regexp_species_constructor(vm, this_value, &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    MalString *flags;
    if (!regexp_flags_string(vm, this_value, &flags)) {
        return mal_value_new_undefined();
    }
    bool unicode = regexp_flags_has(flags, 'u') || regexp_flags_has(flags, 'v');
    // newFlags = flags + "y" (if not already sticky).
    MalString *new_flags = flags;
    if (!regexp_flags_has(flags, 'y')) {
        usize fl = mal_string_length(flags);
        usize new_length;
        usize bytes;
        if (!mal_checked_size_add(fl, 1, MAL_STRING_MAX_CODE_UNITS, &new_length) ||
            !mal_checked_size_multiply(sizeof(c16), new_length, SIZE_MAX, &bytes)) {
            regexp_throw_string_length(vm);
            return mal_value_new_undefined();
        }
        c16 *buf = malloc(bytes);
        if (buf == nullptr) {
            regexp_throw_string_length(vm);
            return mal_value_new_undefined();
        }
        for (usize i = 0; i < fl; i++) {
            buf[i] = mal_string_code_units(flags)[i];
        }
        buf[fl] = 'y';
        new_flags = mal_string_new_copy(&vm->heap, buf, new_length);
        free(buf);
    }
    MalValue ctor_args[2] = {this_value, mal_value_from_string(new_flags)};
    MalCompletion splitter_completion = mal_vm_construct_value(vm, constructor, ctor_args, 2);
    if (splitter_completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue splitter = splitter_completion.value;

    // limit: ToUint32; 0 -> empty array.
    u32 limit = 0xFFFFFFFFu;
    if (!mal_value_is_undefined(limit_value)) {
        f64 lim;
        if (!mal_vm_to_number(vm, limit_value, &lim)) {
            return mal_value_new_undefined();
        }
        if (isnan(lim) || lim == 0) {
            limit = 0;
        } else {
            double m = trunc(lim);
            double mod = fmod(m, 4294967296.0);
            if (mod < 0) {
                mod += 4294967296.0;
            }
            limit = (u32) mod;
        }
    }

    MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
    u32 array_len = 0;
    if (limit == 0) {
        return mal_value_from_object((MalObject *) array);
    }

    usize size = mal_string_length(s);
    if (size == 0) {
        // If the regexp matches the empty string, no split; else [S].
        bool exec_ok;
        MalValue z = regexp_exec_abstract(vm, splitter, s, false, &exec_ok);
        if (!exec_ok) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_null(z)) {
            return mal_value_from_object((MalObject *) array);
        }
        mal_array_object_store(array, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_string(s));
        return mal_value_from_object((MalObject *) array);
    }

    usize p = 0;
    usize q = p;
    while (q < size) {
        if (!regexp_set_last_index(vm, splitter, (i64) q)) {
            return mal_value_new_undefined();
        }
        bool exec_ok;
        MalValue z = regexp_exec_abstract(vm, splitter, s, false, &exec_ok);
        if (!exec_ok) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_null(z)) {
            q = (usize) regexp_advance_string_index(s, (i64) q, unicode);
            continue;
        }
        i64 e_raw;
        if (!regexp_get_length_prop(vm, splitter, (const byte *) "lastIndex", &e_raw)) {
            return mal_value_new_undefined();
        }
        usize e = (usize) e_raw;
        if (e > size) {
            e = size;
        }
        if (e == p) {
            q = (usize) regexp_advance_string_index(s, (i64) q, unicode);
            continue;
        }
        // Substring S[p, q].
        mal_array_object_store(
            array, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) array_len++)},
            regexp_substring(vm, s, (i32) p, (i32) q)
        );
        if (array_len == limit) {
            return mal_value_from_object((MalObject *) array);
        }
        // Append captures 1..numberOfCaptures.
        i64 number_of_captures;
        if (!regexp_get_length_prop(vm, z, (const byte *) "length", &number_of_captures)) {
            return mal_value_new_undefined();
        }
        number_of_captures = number_of_captures > 0 ? number_of_captures - 1 : 0;
        for (i64 i = 1; i <= number_of_captures; i++) {
            MalValue capture;
            MalKey capture_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
            if (!mal_vm_get_property(vm, z, capture_key, &capture)) {
                return mal_value_new_undefined();
            }
            mal_array_object_store(array, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) array_len++)}, capture);
            if (array_len == limit) {
                return mal_value_from_object((MalObject *) array);
            }
        }
        p = e;
        q = p;
    }
    // Final substring S[p, size].
    mal_array_object_store(
        array, (MalKey){.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) array_len)},
        regexp_substring(vm, s, (i32) p, (i32) size)
    );
    return mal_value_from_object((MalObject *) array);
}

// ---------------------------------------------------------------------------
// RegExp.prototype[@@matchAll] + the RegExp String Iterator
// ---------------------------------------------------------------------------

static MalValue regexp_proto_match_all(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.prototype[Symbol.matchAll] called on non-object");
        return mal_value_new_undefined();
    }
    MalString *s;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &s)) {
        return mal_value_new_undefined();
    }

    bool ok;
    MalValue constructor = regexp_species_constructor(vm, this_value, &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    MalString *flags;
    if (!regexp_flags_string(vm, this_value, &flags)) {
        return mal_value_new_undefined();
    }
    MalValue ctor_args[2] = {this_value, mal_value_from_string(flags)};
    MalCompletion matcher_completion = mal_vm_construct_value(vm, constructor, ctor_args, 2);
    if (matcher_completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue matcher = matcher_completion.value;

    i64 last_index;
    if (!regexp_get_last_index(vm, this_value, &last_index)) {
        return mal_value_new_undefined();
    }
    if (!regexp_set_last_index(vm, matcher, last_index)) {
        return mal_value_new_undefined();
    }

    bool global = regexp_flags_has(flags, 'g');
    bool unicode = regexp_flags_has(flags, 'u') || regexp_flags_has(flags, 'v');

    MalObject *iterator_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE]);
    MalRegExpStringIteratorObject *iterator =
        mal_regexp_string_iterator_object_new(&vm->heap, iterator_prototype, matcher, s, global, unicode);
    return mal_value_from_regexp_string_iterator_object(iterator);
}

static MalValue regexp_string_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    if (!mal_value_is_regexp_string_iterator_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "not a RegExp String Iterator");
        return mal_value_new_undefined();
    }
    MalRegExpStringIteratorObject *iterator = mal_value_to_regexp_string_iterator_object(this_value);
    if (iterator->done) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    bool ok;
    MalValue match = regexp_exec_abstract(vm, iterator->regexp, iterator->string, false, &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_null(match)) {
        iterator->done = true;
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    if (!iterator->global) {
        iterator->done = true;
        return mal_vm_create_iter_result(vm, match, false);
    }

    MalString *match_str;
    if (!regexp_get_index_string(vm, match, 0, &match_str)) {
        return mal_value_new_undefined();
    }
    if (mal_string_length(match_str) == 0) {
        i64 this_index;
        if (!regexp_get_last_index(vm, iterator->regexp, &this_index)) {
            return mal_value_new_undefined();
        }
        i64 next_index = regexp_advance_string_index(iterator->string, this_index, iterator->unicode);
        if (!regexp_set_last_index(vm, iterator->regexp, next_index)) {
            return mal_value_new_undefined();
        }
    }
    return mal_vm_create_iter_result(vm, match, false);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

static void regexp_define_getter(MalVm *vm, MalObject *prototype, const byte *name, const byte *display_name, MalNativeFunctionCallback callback) {
    MalNativeFunctionObject *getter = mal_native_function_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]), mal_intrinsic_ascii(vm, display_name), callback
    );
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(getter),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, name), &desc);
}

// Define a symbol-keyed method with an explicit arity (its `length`), unlike
// mal_intrinsic_define_symbol_method which always uses arity 0.
static void regexp_define_symbol_method_n(MalVm *vm, MalObject *object, MalIntrinsic symbol_slot, const byte *display_name, i32 arity, MalNativeFunctionCallback callback) {
    MalNativeFunctionObject *function = mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]), mal_intrinsic_ascii(vm, display_name), arity, callback
    );
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_native_function_object(function), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, symbol_slot), &desc);
}

// ---------------------------------------------------------------------------
// RegExp.escape (EncodeForRegExpEscape)
// ---------------------------------------------------------------------------

static bool regexp_escape_hex(MalVm *vm, RegexpBuilder *b, u32 c) {
    static const char *hex = "0123456789abcdef";
    if (c <= 0xFF) {
        c16 units[4] = {'\\', 'x', (c16) hex[(c >> 4) & 0xF], (c16) hex[c & 0xF]};
        return regexp_builder_append_units(vm, b, units, 4);
    } else {
        c16 units[6] = {'\\', 'u', (c16) hex[(c >> 12) & 0xF], (c16) hex[(c >> 8) & 0xF], (c16) hex[(c >> 4) & 0xF], (c16) hex[c & 0xF]};
        return regexp_builder_append_units(vm, b, units, 6);
    }
}

static bool regexp_is_syntax_char(c16 c) {
    switch (c) {
        case '^': case '$': case '\\': case '.': case '*': case '+':
        case '?': case '(': case ')': case '[': case ']': case '{':
        case '}': case '|':
            return true;
        default:
            return false;
    }
}

static bool regexp_is_punctuator_or_space(c16 c) {
    switch (c) {
        // otherPunctuators: ,-=<>#&!%:;@~'`"
        case ',': case '-': case '=': case '<': case '>': case '#': case '&':
        case '!': case '%': case ':': case ';': case '@': case '~': case '\'':
        case '`': case '"':
        // WhiteSpace + LineTerminator (BMP); 0x09-0x0D are control-escaped above.
        case 0x20: case 0xA0: case 0x1680: case 0x2000: case 0x2001: case 0x2002:
        case 0x2003: case 0x2004: case 0x2005: case 0x2006: case 0x2007: case 0x2008:
        case 0x2009: case 0x200A: case 0x2028: case 0x2029: case 0x202F: case 0x205F:
        case 0x3000: case 0xFEFF:
            return true;
        default:
            return false;
    }
}

static MalValue regexp_escape(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue s_value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(s_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp.escape requires a string argument");
        return mal_value_new_undefined();
    }
    MalString *s = mal_value_to_string(s_value);
    const c16 *u = mal_string_code_units(s);
    usize n = mal_string_length(s);
    RegexpBuilder builder = {0};
    for (usize i = 0; i < n; i++) {
        c16 c = u[i];
        // The first code point, if an ASCII alphanumeric, is hex-escaped so the
        // result can't combine with a preceding character into an identifier.
        if (i == 0 && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
            if (!regexp_escape_hex(vm, &builder, c)) {
                free(builder.data);
                return mal_value_new_undefined();
            }
            continue;
        }
        if (regexp_is_syntax_char(c) || c == '/') {
            c16 units[2] = {'\\', c};
            if (!regexp_builder_append_units(vm, &builder, units, 2)) goto fail;
        } else if (c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D) {
            char letter = c == 0x09 ? 't' : c == 0x0A ? 'n' : c == 0x0B ? 'v' : c == 0x0C ? 'f' : 'r';
            c16 units[2] = {'\\', (c16) letter};
            if (!regexp_builder_append_units(vm, &builder, units, 2)) goto fail;
        } else if (regexp_is_punctuator_or_space(c)) {
            if (!regexp_escape_hex(vm, &builder, c)) goto fail;
        } else {
            if (!regexp_builder_append_units(vm, &builder, &c, 1)) goto fail;
        }
    }
    return regexp_builder_finish(vm, &builder);

fail:
    free(builder.data);
    return mal_value_new_undefined();
}

void mal_builtin_regexp_install(MalVm *vm) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // RegExp.prototype is an ordinary object (NOT a RegExp), so its methods/
    // accessors throw (or special-case) on the bare prototype receiver.
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "RegExp"), 2, regexp_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_REGEXP_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, (const byte *) "prototype", vm->intrinsics[MAL_INTRINSIC_REGEXP_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_species(vm, constructor_object);
    mal_intrinsic_define_method_n(vm, constructor_object, (const byte *) "escape", 1, regexp_escape);

    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "exec", 1, regexp_proto_exec);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "test", 1, regexp_proto_test);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "toString", 0, regexp_proto_to_string);

    regexp_define_symbol_method_n(vm, prototype, MAL_INTRINSIC_SYMBOL_MATCH, (const byte *) "[Symbol.match]", 1, regexp_proto_match);
    regexp_define_symbol_method_n(vm, prototype, MAL_INTRINSIC_SYMBOL_MATCH_ALL, (const byte *) "[Symbol.matchAll]", 1, regexp_proto_match_all);
    regexp_define_symbol_method_n(vm, prototype, MAL_INTRINSIC_SYMBOL_SEARCH, (const byte *) "[Symbol.search]", 1, regexp_proto_search);
    regexp_define_symbol_method_n(vm, prototype, MAL_INTRINSIC_SYMBOL_REPLACE, (const byte *) "[Symbol.replace]", 2, regexp_proto_replace);
    regexp_define_symbol_method_n(vm, prototype, MAL_INTRINSIC_SYMBOL_SPLIT, (const byte *) "[Symbol.split]", 2, regexp_proto_split);

    // %RegExpStringIteratorPrototype% inherits from %IteratorPrototype%.
    MalObject *iterator_prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE] = mal_value_from_object(iterator_prototype);
    mal_intrinsic_define_method_n(vm, iterator_prototype, (const byte *) "next", 0, regexp_string_iterator_next);
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "RegExp String Iterator")), MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(iterator_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    regexp_define_getter(vm, prototype, (const byte *) "source", (const byte *) "get source", regexp_proto_get_source);
    regexp_define_getter(vm, prototype, (const byte *) "flags", (const byte *) "get flags", regexp_proto_get_flags);
    regexp_define_getter(vm, prototype, (const byte *) "global", (const byte *) "get global", regexp_proto_get_global);
    regexp_define_getter(vm, prototype, (const byte *) "ignoreCase", (const byte *) "get ignoreCase", regexp_proto_get_ignore_case);
    regexp_define_getter(vm, prototype, (const byte *) "multiline", (const byte *) "get multiline", regexp_proto_get_multiline);
    regexp_define_getter(vm, prototype, (const byte *) "dotAll", (const byte *) "get dotAll", regexp_proto_get_dot_all);
    regexp_define_getter(vm, prototype, (const byte *) "unicode", (const byte *) "get unicode", regexp_proto_get_unicode);
    regexp_define_getter(vm, prototype, (const byte *) "unicodeSets", (const byte *) "get unicodeSets", regexp_proto_get_unicode_sets);
    regexp_define_getter(vm, prototype, (const byte *) "sticky", (const byte *) "get sticky", regexp_proto_get_sticky);
    regexp_define_getter(vm, prototype, (const byte *) "hasIndices", (const byte *) "get hasIndices", regexp_proto_get_has_indices);
}

#else // !MAL_REGEXP

// engine.regexp:false — no RegExp global (typeof RegExp === "undefined").
void mal_builtin_regexp_install(MalVm *vm) {
    (void) vm;
}

#endif // MAL_REGEXP
