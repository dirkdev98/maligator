#include "node_child_process.h"

#if MAL_NODE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "posix_process.h" // host: fork/exec syscalls (MalProcRequest / MalProcResult)
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "utf8.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h" // mal_vm_get_property / mal_vm_to_string

/* ---------------------------------------------------------------------------
 * Marshalling helpers.
 * --------------------------------------------------------------------------- */

static void mal_ncp_throw_nul(MalVm *vm, const char *name) {
    char message[96];
    snprintf(message, sizeof(message), "The \"%s\" argument must not contain null bytes", name);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
}

/* Coerce `v` to a string and UTF-8-encode it into a fresh NUL-terminated C
 * buffer (heap-owned; caller frees). Returns NULL when coercion or embedded-NUL
 * validation threw; the empty string yields a 1-byte "". */
static byte *mal_ncp_to_cstr(MalVm *vm, MalValue v, const char *name) {
    MalString *s;
    if (!mal_vm_to_string(vm, v, &s)) {
        return NULL;
    }
    char *bytes;
    usize out_len;
    MalUtf8CStringResult result = mal_string_to_utf8_c_string(s, &bytes, &out_len);
    if (result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
        mal_ncp_throw_nul(vm, name);
        return NULL;
    }
    if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
        return NULL;
    }
    return (byte *) bytes;
}

static bool mal_ncp_str_eq_ascii(const MalString *s, const char *ascii) {
    return mal_string_equals_ascii(s, ascii);
}

/* Map one `stdio` entry (a "pipe"/"inherit"/"ignore" string) to a stream mode,
 * falling back to `dflt` for anything else. */
static MalProcStdio mal_ncp_stdio_mode(MalValue v, MalProcStdio dflt) {
    if (!mal_value_is_string(v)) {
        return dflt;
    }
    const MalString *s = mal_value_to_string(v);
    if (mal_ncp_str_eq_ascii(s, "inherit")) {
        return MAL_PROC_STDIO_INHERIT;
    }
    if (mal_ncp_str_eq_ascii(s, "ignore")) {
        return MAL_PROC_STDIO_IGNORE;
    }
    if (mal_ncp_str_eq_ascii(s, "pipe")) {
        return MAL_PROC_STDIO_PIPE;
    }
    return dflt;
}

static MalKey mal_ncp_name_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

/* Read `opts.<name>` into *out (undefined when opts is not an object or the
 * property is absent). Returns false only when a getter threw. */
static bool mal_ncp_option(MalVm *vm, MalValue opts, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(opts)) {
        return true;
    }
    return mal_vm_get_property(vm, opts, mal_ncp_name_key(vm, name), out);
}

/* Concatenate `n` C strings into a fresh heap buffer (caller frees). */
static char *mal_ncp_concat(const char *const *parts, usize n) {
    usize total = 0;
    for (usize i = 0; i < n; i++) {
        total += strlen(parts[i]);
    }
    char *s = malloc(total + 1);
    usize o = 0;
    for (usize i = 0; i < n; i++) {
        usize l = strlen(parts[i]);
        memcpy(s + o, parts[i], l);
        o += l;
    }
    s[o] = '\0';
    return s;
}

/* JS string from a C string. */
static MalValue mal_ncp_string(MalVm *vm, const char *s) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) s, strlen(s)));
}

/* A captured stream as a UTF-8 JS string, or null when the stream was not piped. */
static MalValue mal_ncp_captured(MalVm *vm, const byte *data, usize len, bool captured) {
    if (!captured) {
        return mal_value_new_null();
    }
    MalString *string = mal_string_from_utf8(
        &vm->heap, data != NULL ? data : (const byte *) "", len);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

/* UTF-8 encode an enumerable property key for an environment entry. */
static byte *mal_ncp_env_key(MalVm *vm, MalKey key, usize *len) {
    if (key.kind == MAL_KEY_STRING) {
        const MalString *s = mal_value_to_string(key.value);
        char *out;
        MalUtf8CStringResult result = mal_string_to_utf8_c_string(s, &out, len);
        if (result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
            mal_ncp_throw_nul(vm, "env name");
            return NULL;
        }
        if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
            mal_vm_throw_allocation_error(vm);
            return NULL;
        }
        return (byte *) out;
    }
    char index[16];
    int n = snprintf(index, sizeof(index), "%d", mal_value_to_i32(key.value));
    byte *out = malloc((usize) n + 1);
    memcpy(out, index, (usize) n + 1);
    *len = (usize) n;
    return out;
}

/* uv-style name for a launch errno, or NULL when unmapped. */
static const char *mal_ncp_errno_name(int e) {
    switch (e) {
        case ENOENT:
            return "ENOENT";
        case EACCES:
            return "EACCES";
        case ENOTDIR:
            return "ENOTDIR";
        case ENOEXEC:
            return "ENOEXEC";
        case ELOOP:
            return "ELOOP";
        case ENAMETOOLONG:
            return "ENAMETOOLONG";
        case E2BIG:
            return "E2BIG";
        case ENOMEM:
            return "ENOMEM";
        case EMFILE:
            return "EMFILE";
        case ENFILE:
            return "ENFILE";
        case EAGAIN:
            return "EAGAIN";
        case EIO:
            return "EIO";
        default:
            return NULL;
    }
}

/* ---------------------------------------------------------------------------
 * Throwing the two error shapes. Both build the property values first, root
 * them alongside the freshly-thrown Error object, then attach them (each set
 * can allocate a table entry and trigger a collection).
 * --------------------------------------------------------------------------- */

/* Nonzero exit or terminating signal: Error with .status/.signal + .stdout/.stderr. */
static void mal_ncp_throw_exit(MalVm *vm, const MalProcResult *res, const char *file, bool out_cap, bool err_cap) {
    MalValue vals[5];
    for (i32 i = 0; i < 5; i++) {
        vals[i] = mal_value_new_undefined();
    }
    MalRootSpan rs;
    mal_gc_root(&rs, vals, 5);

    vals[0] = mal_ncp_captured(vm, res->stdout_data, res->stdout_len, out_cap);
    vals[1] = mal_ncp_captured(vm, res->stderr_data, res->stderr_len, err_cap);
    vals[2] = res->exited ? mal_value_from_f64((f64) res->exit_status) : mal_value_new_null();
    if (res->signaled) {
        const char *name = mal_proc_signal_name(res->term_signal);
        vals[3] = name != NULL ? mal_ncp_string(vm, name) : mal_value_from_f64((f64) res->term_signal);
    } else {
        vals[3] = mal_value_new_null();
    }

    char *message = mal_ncp_concat((const char *const[]) {"Command failed: ", file}, 2);
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
    free(message);

    vals[4] = vm->completion.value;
    MalObject *err = mal_value_to_object(vals[4]);
    mal_object_set(err, mal_ncp_name_key(vm, "status"), vals[2]);
    mal_object_set(err, mal_ncp_name_key(vm, "signal"), vals[3]);
    mal_object_set(err, mal_ncp_name_key(vm, "stdout"), vals[0]);
    mal_object_set(err, mal_ncp_name_key(vm, "stderr"), vals[1]);

    mal_gc_unroot(&rs);
}

/* Launch failure (missing executable, bad cwd): Error with .code/.errno/.syscall/.path. */
static void mal_ncp_throw_launch(MalVm *vm, int launch_errno, const char *file) {
    const char *code = mal_ncp_errno_name(launch_errno);

    char *syscall = mal_ncp_concat((const char *const[]) {"spawnSync ", file}, 2);
    char *message = mal_ncp_concat((const char *const[]) {syscall, " ", code != NULL ? code : "failed"}, 3);
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
    free(message);

    MalValue vals[7];
    for (i32 i = 0; i < 7; i++) {
        vals[i] = mal_value_new_undefined();
    }
    MalRootSpan rs;
    mal_gc_root(&rs, vals, 7);
    vals[0] = vm->completion.value;
    MalObject *err = mal_value_to_object(vals[0]);
    if (code != NULL) {
        vals[1] = mal_ncp_string(vm, code);
        mal_object_set(err, mal_ncp_name_key(vm, "code"), vals[1]);
    }
    vals[2] = mal_value_from_f64((f64) (-launch_errno)); // Node reports errno as a negative number
    mal_object_set(err, mal_ncp_name_key(vm, "errno"), vals[2]);
    vals[3] = mal_ncp_string(vm, syscall);
    mal_object_set(err, mal_ncp_name_key(vm, "syscall"), vals[3]);
    vals[4] = mal_ncp_string(vm, file);
    mal_object_set(err, mal_ncp_name_key(vm, "path"), vals[4]);
    vals[5] = mal_value_new_null();
    vals[6] = mal_value_new_null();
    mal_object_set(err, mal_ncp_name_key(vm, "status"), vals[5]);
    mal_object_set(err, mal_ncp_name_key(vm, "signal"), vals[6]);
    mal_gc_unroot(&rs);

    free(syscall);
}

/* ---------------------------------------------------------------------------
 * execFileSync(file[, args][, options]).
 * --------------------------------------------------------------------------- */

static MalValue mal_node_exec_file_sync(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    byte *file_c = NULL;
    char **argv = NULL;
    u32 argv_args = 0; // count of allocated arg strings, argv[1 .. argv_args]
    byte *cwd_c = NULL;
    char **envp = NULL;
    usize envp_count = 0;
    byte *input_c = NULL;
    usize input_len = 0;
    MalProcResult res = {0};
    MalValue ret = mal_value_new_undefined();

    MalValue args_val = mal_value_new_undefined();
    MalValue opts_val = mal_value_new_undefined();
    MalValue tmp = mal_value_new_undefined();
    MalProcStdio in_mode = MAL_PROC_STDIO_PIPE;
    MalProcStdio out_mode = MAL_PROC_STDIO_PIPE;
    MalProcStdio err_mode = MAL_PROC_STDIO_PIPE;

    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"file\" argument must be a string");
        goto cleanup;
    }
    file_c = mal_ncp_to_cstr(vm, args[0], "file");
    if (file_c == NULL) {
        goto cleanup;
    }

    // Overload: execFileSync(file[, args][, options]). An array second arg is
    // `args`; a plain object in either the second or third slot is `options`.
    {
        MalValue a1 = argc >= 2 ? args[1] : mal_value_new_undefined();
        MalValue a2 = argc >= 3 ? args[2] : mal_value_new_undefined();
        if (mal_value_is_array_object(a1)) {
            args_val = a1;
            if (mal_value_is_object(a2)) {
                opts_val = a2;
            }
        } else if (mal_value_is_object(a1)) {
            opts_val = a1;
        } else if (mal_value_is_object(a2)) {
            opts_val = a2;
        }
    }

    // cwd
    if (!mal_ncp_option(vm, opts_val, "cwd", &tmp)) {
        goto cleanup;
    }
    if (!mal_value_is_nil(tmp)) {
        cwd_c = mal_ncp_to_cstr(vm, tmp, "cwd");
        if (cwd_c == NULL) {
            goto cleanup;
        }
    }

    // input (fed to stdin)
    if (!mal_ncp_option(vm, opts_val, "input", &tmp)) {
        goto cleanup;
    }
    if (!mal_value_is_nil(tmp)) {
        MalString *s;
        if (!mal_vm_to_string(vm, tmp, &s)) {
            goto cleanup;
        }
        input_c = mal_string_to_utf8(s, &input_len);
        if (input_c == NULL) {
            mal_vm_throw_allocation_error(vm);
            goto cleanup;
        }
    }

    // stdio: a single string covers all three streams; a 3-element array is per-stream.
    if (!mal_ncp_option(vm, opts_val, "stdio", &tmp)) {
        goto cleanup;
    }
    if (mal_value_is_array_object(tmp)) {
        u32 n = mal_array_object_length(mal_value_to_array_object(tmp));
        const MalProcStdio dflts[3] = {MAL_PROC_STDIO_PIPE, MAL_PROC_STDIO_PIPE, MAL_PROC_STDIO_PIPE};
        MalProcStdio modes[3] = {dflts[0], dflts[1], dflts[2]};
        for (u32 i = 0; i < 3 && i < n; i++) {
            MalValue el;
            if (!mal_vm_get_property(vm, tmp, mal_key_index(i), &el)) {
                goto cleanup;
            }
            modes[i] = mal_ncp_stdio_mode(el, dflts[i]);
        }
        in_mode = modes[0];
        out_mode = modes[1];
        err_mode = modes[2];
    } else if (mal_value_is_string(tmp)) {
        MalProcStdio m = mal_ncp_stdio_mode(tmp, MAL_PROC_STDIO_PIPE);
        in_mode = out_mode = err_mode = m;
    }

    // env: an explicit object supplies the child's *entire* environment. Snapshot
    // its own enumerable keys, then perform ordinary reads so accessors participate.
    if (!mal_ncp_option(vm, opts_val, "env", &tmp)) {
        goto cleanup;
    }
    if (mal_value_is_object(tmp)) {
        MalObject *eo = mal_value_to_object(tmp);
        usize cap = 0;
        MalPropertyIter it;
        MalKey k;
        MalPropertyDesc d;
        mal_property_iter_init(&it, eo, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        while (mal_property_iter_next(&it, &k, &d)) {
            if (k.kind != MAL_KEY_SYMBOL) {
                cap++;
            }
        }
        envp = malloc((cap + 1) * sizeof(char *));
        MalKey *keys = cap > 0 ? malloc(cap * sizeof(MalKey)) : NULL;
        MalValue *key_values = cap > 0 ? malloc(cap * sizeof(MalValue)) : NULL;
        usize key_count = 0;
        mal_property_iter_init(&it, eo, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        while (mal_property_iter_next(&it, &k, &d)) {
            if (k.kind != MAL_KEY_SYMBOL) {
                keys[key_count] = k;
                key_values[key_count] = k.value;
                key_count++;
            }
        }

        MalValue env_roots[2] = {tmp, mal_value_new_undefined()};
        MalRootSpan env_root;
        MalRootSpan keys_root;
        mal_gc_root(&env_root, env_roots, 2);
        mal_gc_root(&keys_root, key_values, (i32) key_count);
        mal_gc_native_rooted_begin(vm);
        bool env_ok = true;
        for (usize i = 0; i < key_count; i++) {
            MalPropertyLookup lookup = mal_object_get_own(eo, keys[i]);
            if (!lookup.present || !(lookup.desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }
            if (!mal_vm_get_property(vm, env_roots[0], keys[i], &env_roots[1])) {
                env_ok = false;
                break;
            }
            if (mal_value_is_undefined(env_roots[1])) {
                continue;
            }
            usize klen;
            byte *kc = mal_ncp_env_key(vm, keys[i], &klen);
            if (kc == NULL) {
                env_ok = false;
                break;
            }
            MalString *vs;
            if (!mal_vm_to_string(vm, env_roots[1], &vs)) {
                free(kc);
                env_ok = false;
                break;
            }
            usize vlen;
            char *vc;
            MalUtf8CStringResult value_result =
                mal_string_to_utf8_c_string(vs, &vc, &vlen);
            if (value_result != MAL_UTF8_C_STRING_OK) {
                free(kc);
                if (value_result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
                    mal_ncp_throw_nul(vm, "env value");
                } else {
                    mal_vm_throw_allocation_error(vm);
                }
                env_ok = false;
                break;
            }
            char *entry = malloc(klen + 1 + vlen + 1);
            if (entry == NULL) {
                free(kc);
                free(vc);
                mal_vm_throw_allocation_error(vm);
                env_ok = false;
                break;
            }
            memcpy(entry, kc, klen);
            entry[klen] = '=';
            memcpy(entry + klen + 1, vc, vlen);
            entry[klen + 1 + vlen] = '\0';
            free(kc);
            free(vc);
            envp[envp_count++] = entry;
        }
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&keys_root);
        mal_gc_unroot(&env_root);
        free(key_values);
        free(keys);
        if (!env_ok) {
            goto cleanup;
        }
        envp[envp_count] = NULL;
    }

    // argv = [file, ...args], NULL-terminated.
    {
        u32 nargs = mal_value_is_array_object(args_val) ? mal_array_object_length(mal_value_to_array_object(args_val)) : 0;
        argv = malloc(((usize) nargs + 2) * sizeof(char *));
        argv[0] = (char *) file_c;
        for (u32 i = 0; i < nargs; i++) {
            MalValue el;
            if (!mal_vm_get_property(vm, args_val, mal_key_index(i), &el)) {
                argv[argv_args + 1] = NULL;
                goto cleanup;
            }
            byte *ac = mal_ncp_to_cstr(vm, el, "args");
            if (ac == NULL) {
                argv[argv_args + 1] = NULL;
                goto cleanup;
            }
            argv[i + 1] = (char *) ac;
            argv_args++;
        }
        argv[nargs + 1] = NULL;
    }

    MalProcRequest req = {
        .file = (const char *) file_c,
        .argv = argv,
        .envp = envp,
        .cwd = (const char *) cwd_c,
        .stdin_mode = in_mode,
        .stdout_mode = out_mode,
        .stderr_mode = err_mode,
        .input = input_c,
        .input_len = input_len,
    };

    bool out_cap = out_mode == MAL_PROC_STDIO_PIPE;
    bool err_cap = err_mode == MAL_PROC_STDIO_PIPE;

    if (mal_proc_run(&req, &res) != 0) {
        if (!res.launched) {
            mal_ncp_throw_launch(vm, res.launch_errno, (const char *) file_c);
            goto cleanup;
        }
        // Launched but a parent-side I/O/wait failure: surface it as a generic error.
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "execFileSync: I/O failure while running the child");
        goto cleanup;
    }

    if ((res.exited && res.exit_status != 0) || res.signaled) {
        mal_ncp_throw_exit(vm, &res, (const char *) file_c, out_cap, err_cap);
        goto cleanup;
    }

    // Success: captured stdout as a UTF-8 string, or null for inherit/ignore.
    ret = mal_ncp_captured(vm, res.stdout_data, res.stdout_len, out_cap);

cleanup:
    mal_proc_result_dispose(&res);
    free(input_c);
    free(cwd_c);
    if (envp != NULL) {
        for (usize i = 0; i < envp_count; i++) {
            free(envp[i]);
        }
        free(envp);
    }
    if (argv != NULL) {
        for (u32 i = 0; i < argv_args; i++) {
            free(argv[i + 1]); // argv[0] aliases file_c, freed below
        }
        free(argv);
    }
    free(file_c);
    return ret;
}

/* ---------------------------------------------------------------------------
 * Installation.
 * --------------------------------------------------------------------------- */

void mal_host_install_node_child_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
) {
    (void) launch;
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "execFileSync") == 0) {
            MalNativeFunctionObject *fn = mal_native_function_object_new_arity(
                &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) "execFileSync"), 3, mal_node_exec_file_sync
            );
            vm->globals[slots[i].slot] = mal_value_from_native_function_object(fn);
        }
    }
}

#endif /* MAL_NODE */
