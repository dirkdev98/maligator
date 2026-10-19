#include "node_child_process.h"

#if MAL_NODE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <math.h>
#include <unistd.h>

#include "ascii.h"
#include "array_object.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "node_module.h"
#include "node_events.h"
#include "posix_signal.h"
#include "web_host_timer.h"
#include "object.h"
#include "object_ops.h"
#include "posix_process.h" // host: fork/exec syscalls (MalProcRequest / MalProcResult)
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
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
        usize length = strlen(parts[i]);
        if (length >= SIZE_MAX - total) return nullptr;
        total += length;
    }
    char *s = malloc(total + 1);
    if (s == nullptr) return nullptr;
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
    int n = snprintf(index, sizeof(index), "%u", mal_key_index_value(key));
    byte *out = malloc((usize) n + 1);
    if (out == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
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
        case ETIMEDOUT:
            return "ETIMEDOUT";
        case ENOBUFS:
            return "ENOBUFS";
        default:
            return NULL;
    }
}

typedef enum MalNcpKind {
    MAL_NCP_SPAWN,
    MAL_NCP_SPAWN_SYNC,
    MAL_NCP_EXEC_FILE_SYNC,
    MAL_NCP_EXEC_SYNC,
} MalNcpKind;

/* Launch failure, timeout or ENOBUFS: an Error with Node's spawn error fields.
 * Returns undefined with a pending exception on allocation failure. */
static MalValue mal_ncp_spawn_error(MalVm *vm, int error, const char *file, char *const *argv, bool asynchronous) {
    const char *code = mal_ncp_errno_name(error);
    char *syscall = mal_ncp_concat((const char *const[]) {asynchronous ? "spawn " : "spawnSync ", file}, 2);
    if (syscall == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    char *message = mal_ncp_concat((const char *const[]) {syscall, " ", code != NULL ? code : "failed"}, 3);
    if (message == nullptr) {
        free(syscall);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
    free(message);
    MalValue vals[2] = {vm->completion.value, mal_value_new_undefined()};
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, vals, 2);
    MalObject *err = mal_value_to_object(vals[0]);
    vals[1] = mal_value_from_f64((f64) -error);
    mal_object_set(err, mal_ncp_name_key(vm, "errno"), vals[1]);
    if (code != NULL) {
        vals[1] = mal_ncp_string(vm, code);
        mal_object_set(err, mal_ncp_name_key(vm, "code"), vals[1]);
    }
    vals[1] = mal_ncp_string(vm, syscall);
    mal_object_set(err, mal_ncp_name_key(vm, "syscall"), vals[1]);
    vals[1] = mal_ncp_string(vm, file);
    mal_object_set(err, mal_ncp_name_key(vm, "path"), vals[1]);
    if (argv != nullptr) {
        u32 count = 0;
        while (argv[count + 1] != nullptr) count++;
        MalValue *spawnargs = count > 0 ? calloc(count, sizeof(MalValue)) : nullptr;
        if (count > 0 && spawnargs == nullptr) {
            mal_gc_unroot(&rs);
            free(syscall);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        MalRootSpan args_root;
        mal_gc_root(&args_root, spawnargs, (i32) count);
        for (u32 i = 0; i < count; i++) {
            spawnargs[i] = mal_value_from_string(mal_string_from_utf8(
                &vm->heap, (const byte *) argv[i + 1], strlen(argv[i + 1])));
        }
        vals[1] = mal_value_from_array_object(mal_array_object_new_from_values(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), spawnargs, count));
        mal_gc_unroot(&args_root);
        free(spawnargs);
        mal_object_set(err, mal_ncp_name_key(vm, "spawnargs"), vals[1]);
    }
    mal_gc_unroot(&rs);
    free(syscall);
    return vals[0];
}

static void mal_ncp_write_stderr(const byte *data, usize len) {
    while (len > 0) {
        ssize_t n = write(STDERR_FILENO, data, len);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return;
        data += n;
        len -= (usize) n;
    }
}

/* `Command failed: <cmd>`, plus a newline and stderr when the child wrote any. */
static MalValue mal_ncp_failure_message(MalVm *vm, const char *cmd, const byte *err, usize err_len) {
    usize cmd_len = strlen(cmd);
    static const char prefix[] = "Command failed: ";
    usize len = sizeof(prefix) - 1 + cmd_len + (err_len > 0 ? 1 + err_len : 0);
    byte *bytes = malloc(len);
    if (bytes == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    memcpy(bytes, prefix, sizeof(prefix) - 1);
    memcpy(bytes + sizeof(prefix) - 1, cmd, cmd_len);
    if (err_len > 0) {
        bytes[sizeof(prefix) - 1 + cmd_len] = '\n';
        memcpy(bytes + sizeof(prefix) + cmd_len, err, err_len);
    }
    MalString *message = mal_string_from_utf8(&vm->heap, bytes, len);
    free(bytes);
    if (message == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    return mal_value_from_string(message);
}

/* One captured stream as Node presents it: a Buffer adopting the collected bytes,
 * a string in `encoding`, or null when the stream was not piped. */
static MalValue mal_ncp_output(MalVm *vm, byte **data, usize len, bool captured, MalValue encoding) {
    if (!captured) return mal_value_new_null();
    if (mal_value_is_undefined(encoding)) {
        byte *bytes = *data;
        *data = nullptr;
        return mal_node_buffer_from_owned_bytes(vm, bytes, len);
    }
    return mal_node_buffer_encode_bytes(vm, *data != nullptr ? *data : (const byte *) "", len, encoding, false);
}

static char *mal_ncp_join_argv(char *const *argv) {
    usize total = 0;
    for (usize i = 0; argv[i] != nullptr; i++) total += strlen(argv[i]) + 1;
    char *joined = malloc(total > 0 ? total : 1);
    if (joined == nullptr) return nullptr;
    usize o = 0;
    for (usize i = 0; argv[i] != nullptr; i++) {
        if (i > 0) joined[o++] = ' ';
        usize l = strlen(argv[i]);
        memcpy(joined + o, argv[i], l);
        o += l;
    }
    joined[o] = '\0';
    return joined;
}

static bool mal_ncp_define(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

static MalValue mal_node_spawn_request(MalVm *vm, const MalProcRequest *request);

static MalValue mal_node_process_command(MalVm *vm, const MalValue *args, i32 argc, MalNcpKind kind) {
    byte *file_c = NULL;
    char **argv = NULL;
    u32 argv_args = 0; // count of allocated arg strings, argv[1 .. argv_args]
    byte *cwd_c = NULL;
    char **envp = NULL;
    usize envp_count = 0;
    byte *input_c = NULL;
    const byte *input_bytes = NULL;
    usize input_len = 0;
    byte *shell_c = NULL;
    char *shell_command = NULL;
    char *failed_command = NULL;
    MalProcResult res = {0};
    MalValue ret = mal_value_new_undefined();

    MalValue args_val = mal_value_new_undefined();
    MalValue opts_val = mal_value_new_undefined();
    MalValue tmp = mal_value_new_undefined();
    MalValue encoding = mal_value_new_undefined();
    MalProcStdio in_mode = MAL_PROC_STDIO_PIPE;
    MalProcStdio out_mode = MAL_PROC_STDIO_PIPE;
    MalProcStdio err_mode = MAL_PROC_STDIO_PIPE;
    bool detached = false;
    bool inherit_stderr = false;
    bool use_shell = kind == MAL_NCP_EXEC_SYNC;
    i64 timeout_ms = 0;
    int kill_signal = SIGTERM;
    usize max_buffer = 1024 * 1024;
    MalValue roots[5] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            kind == MAL_NCP_EXEC_SYNC ? "The \"command\" argument must be of type string"
                                      : "The \"file\" argument must be of type string");
        goto cleanup;
    }
    file_c = mal_ncp_to_cstr(vm, args[0], kind == MAL_NCP_EXEC_SYNC ? "command" : "file");
    if (file_c == NULL) {
        goto cleanup;
    }

    // Overloads: execSync(command[, options]); otherwise (file[, args][, options]),
    // where an array second argument is `args` and an object in either slot is `options`.
    {
        MalValue a1 = argc >= 2 ? args[1] : mal_value_new_undefined();
        MalValue a2 = argc >= 3 ? args[2] : mal_value_new_undefined();
        if (kind == MAL_NCP_EXEC_SYNC) {
            if (mal_value_is_object(a1)) opts_val = a1;
        } else if (mal_value_is_array_object(a1)) {
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
    roots[0] = args_val;
    roots[1] = opts_val;

    if (!mal_ncp_option(vm, opts_val, "cwd", &tmp)) {
        goto cleanup;
    }
    if (!mal_value_is_nil(tmp)) {
        cwd_c = mal_ncp_to_cstr(vm, tmp, "cwd");
        if (cwd_c == NULL) {
            goto cleanup;
        }
    }

    if (!mal_ncp_option(vm, opts_val, "input", &roots[4])) {
        goto cleanup;
    }
    if (!mal_value_is_nil(roots[4]) && !mal_value_is_object(roots[4])) {
        MalString *s;
        if (!mal_vm_to_string(vm, roots[4], &s)) {
            goto cleanup;
        }
        input_c = mal_string_to_utf8(s, &input_len);
        if (input_c == NULL) {
            mal_vm_throw_allocation_error(vm);
            goto cleanup;
        }
        input_bytes = input_c;
    }

    if (!mal_ncp_option(vm, opts_val, "detached", &tmp)) {
        goto cleanup;
    }
    detached = mal_value_is_truthy(tmp);

    if (!mal_ncp_option(vm, opts_val, "shell", &tmp)) {
        goto cleanup;
    }
    if (mal_value_is_string(tmp)) {
        use_shell = true;
        shell_c = mal_ncp_to_cstr(vm, tmp, "shell");
        if (shell_c == NULL) goto cleanup;
    } else if (kind != MAL_NCP_EXEC_SYNC) {
        use_shell = mal_value_is_truthy(tmp);
    }

    if (!mal_ncp_option(vm, opts_val, "encoding", &tmp)) {
        goto cleanup;
    }
    if (mal_value_is_string(tmp) && !mal_ncp_str_eq_ascii(mal_value_to_string(tmp), "buffer")
        && mal_node_buffer_encoding_is_known(tmp)) {
        encoding = tmp;
        roots[2] = encoding;
    }

    if (!mal_ncp_option(vm, opts_val, "timeout", &tmp)) {
        goto cleanup;
    }
    if (mal_ops_is_number(tmp)) {
        f64 t = mal_ops_number_as_f64(tmp);
        if (!isfinite(t) || t < 0 || t != floor(t)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "The value of \"timeout\" is out of range. It must be an unsigned integer.");
            goto cleanup;
        }
        timeout_ms = t > 9.0e15 ? (i64) 9.0e15 : (i64) t;
    }

    if (!mal_ncp_option(vm, opts_val, "killSignal", &tmp)) {
        goto cleanup;
    }
    if (mal_value_is_string(tmp)) {
        byte *name = mal_ncp_to_cstr(vm, tmp, "killSignal");
        if (name == nullptr) goto cleanup;
        kill_signal = mal_host_signal_number_named((const char *) name);
        if (kill_signal == 0) {
            char *message = mal_ncp_concat((const char *const[]) {"Unknown signal: ", (const char *) name}, 2);
            free(name);
            if (message == nullptr) { mal_vm_throw_allocation_error(vm); goto cleanup; }
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
            free(message);
            goto cleanup;
        }
        free(name);
    } else if (mal_ops_is_number(tmp)) {
        f64 n = mal_ops_number_as_f64(tmp);
        if (!(n > 0 && n < 128) || n != floor(n)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unknown signal");
            goto cleanup;
        }
        kill_signal = (int) n;
    }

    if (!mal_ncp_option(vm, opts_val, "maxBuffer", &tmp)) {
        goto cleanup;
    }
    if (!mal_value_is_nil(tmp)) {
        f64 m = mal_ops_is_number(tmp) ? mal_ops_number_as_f64(tmp) : NAN;
        if (!(m >= 0)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "The value of \"options.maxBuffer\" is out of range. It must be a positive number.");
            goto cleanup;
        }
        max_buffer = isinf(m) || m >= 1.8e19 ? 0 : (usize) m;
    }

    // stdio: a single string covers all three streams; a 3-element array is per-stream.
    if (!mal_ncp_option(vm, opts_val, "stdio", &tmp)) {
        goto cleanup;
    }
    inherit_stderr = (kind == MAL_NCP_EXEC_SYNC || kind == MAL_NCP_EXEC_FILE_SYNC) && !mal_value_is_truthy(tmp);
    if (mal_value_is_array_object(tmp)) {
        u32 n = mal_array_object_length(mal_value_to_array_object(tmp));
        MalProcStdio modes[3] = {MAL_PROC_STDIO_PIPE, MAL_PROC_STDIO_PIPE, MAL_PROC_STDIO_PIPE};
        roots[3] = tmp;
        for (u32 i = 0; i < 3 && i < n; i++) {
            MalValue el;
            if (!mal_vm_get_property(vm, roots[3], mal_key_index(i), &el)) {
                goto cleanup;
            }
            modes[i] = mal_ncp_stdio_mode(el, MAL_PROC_STDIO_PIPE);
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
        if (envp == nullptr || (cap > 0 && (keys == nullptr || key_values == nullptr))) {
            free(keys); free(key_values);
            mal_vm_throw_allocation_error(vm);
            goto cleanup;
        }
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
        if (argv == nullptr) { mal_vm_throw_allocation_error(vm); goto cleanup; }
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

    if (use_shell) {
        shell_command = mal_ncp_join_argv(argv);
        if (shell_command == nullptr) { mal_vm_throw_allocation_error(vm); goto cleanup; }
        for (u32 i = 0; i < argv_args; i++) free(argv[i + 1]);
        argv_args = 0;
        char **shell_argv = realloc(argv, 4 * sizeof(char *));
        if (shell_argv == nullptr) { mal_vm_throw_allocation_error(vm); goto cleanup; }
        argv = shell_argv;
        argv[0] = shell_c != NULL ? (char *) shell_c : (char *) "/bin/sh";
        argv[1] = (char *) "-c";
        argv[2] = shell_command;
        argv[3] = NULL;
    }
    const char *spawn_file = argv[0];

    // Resolved after every option getter and argument coercion has run, so no
    // user code can detach or resize the source while its bytes are borrowed.
    if (mal_value_is_object(roots[4])) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(roots[4], &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The \"options.input\" property must be of type string or an instance of Buffer, TypedArray, or DataView");
            goto cleanup;
        }
        if (span.length > 0) {
            input_bytes = mal_buffer_source_span_private(&span, &input_c);
            if (input_bytes == nullptr) { mal_vm_throw_allocation_error(vm); goto cleanup; }
        }
        input_len = span.length;
    }

    MalProcRequest req = {
        .file = spawn_file,
        .argv = argv,
        .envp = envp,
        .cwd = (const char *) cwd_c,
        .stdin_mode = in_mode,
        .stdout_mode = out_mode,
        .stderr_mode = err_mode,
        .input = input_bytes,
        .input_len = input_len,
        .detached = detached,
        .timeout_ms = timeout_ms,
        .kill_signal = kill_signal,
        .max_buffer = max_buffer,
    };

    if (kind == MAL_NCP_SPAWN) {
        if (in_mode == MAL_PROC_STDIO_PIPE || out_mode == MAL_PROC_STDIO_PIPE
            || err_mode == MAL_PROC_STDIO_PIPE) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Async spawn currently requires inherit or ignore stdio");
        } else {
            ret = mal_node_spawn_request(vm, &req);
        }
        goto cleanup;
    }

    bool out_cap = out_mode == MAL_PROC_STDIO_PIPE;
    bool err_cap = err_mode == MAL_PROC_STDIO_PIPE;
    bool exec_kind = kind != MAL_NCP_SPAWN_SYNC;
    int rc = mal_proc_run(&req, &res);
    int error = 0;
    if (!res.launched) {
        error = res.launch_errno != 0 ? res.launch_errno : res.io_errno;
    } else if (res.timed_out) {
        error = ETIMEDOUT;
    } else if (res.buffer_exceeded) {
        error = ENOBUFS;
    } else if (rc != 0) {
        error = res.io_errno;
    }
    if (inherit_stderr && res.stderr_len > 0) mal_ncp_write_stderr(res.stderr_data, res.stderr_len);

    // vals: error, status, signal, output, pid, stdout, stderr, result.
    MalValue vals[8];
    for (usize i = 0; i < countof(vals); i++) vals[i] = mal_value_new_undefined();
    MalRootSpan vals_root;
    mal_gc_root(&vals_root, vals, countof(vals));
    bool failed_exit = error == 0 && !(res.exited && res.exit_status == 0);
    if (exec_kind && failed_exit) {
        failed_command = kind == MAL_NCP_EXEC_SYNC ? strdup((const char *) file_c) : mal_ncp_join_argv(argv);
        if (failed_command == nullptr) { mal_vm_throw_allocation_error(vm); goto vals_done; }
    }
    if (error != 0) {
        vals[0] = mal_ncp_spawn_error(vm, error, spawn_file, argv, false);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto vals_done;
    }
    vals[1] = res.launched && res.exited ? mal_value_from_i32(res.exit_status) : mal_value_new_null();
    const char *signal_name = res.signaled ? mal_proc_signal_name(res.term_signal) : nullptr;
    vals[2] = signal_name != nullptr ? mal_ncp_string(vm, signal_name)
        : res.signaled ? mal_value_from_i32(res.term_signal) : mal_value_new_null();
    vals[4] = mal_value_from_i32(res.launched ? res.pid : 0);
    if (res.launched) {
        // The failure message decodes stderr before a Buffer adopts its bytes.
        if (failed_command != nullptr && mal_value_is_undefined(encoding)) {
            vals[7] = mal_ncp_failure_message(vm, failed_command, res.stderr_data, res.stderr_len);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto vals_done;
        }
        vals[5] = mal_ncp_output(vm, &res.stdout_data, res.stdout_len, out_cap, encoding);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto vals_done;
        vals[6] = mal_ncp_output(vm, &res.stderr_data, res.stderr_len, err_cap, encoding);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto vals_done;
        if (failed_command != nullptr && !mal_value_is_undefined(encoding)) {
            byte *err_bytes = NULL;
            usize err_len = 0;
            if (mal_value_is_string(vals[6])) {
                err_bytes = mal_string_to_utf8(mal_value_to_string(vals[6]), &err_len);
                if (err_bytes == nullptr) { mal_vm_throw_allocation_error(vm); goto vals_done; }
            }
            vals[7] = mal_ncp_failure_message(vm, failed_command, err_bytes, err_len);
            free(err_bytes);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto vals_done;
        }
        MalValue output[3] = {mal_value_new_null(), vals[5], vals[6]};
        vals[3] = mal_value_from_array_object(mal_array_object_new_from_values(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), output, 3));
    } else {
        vals[3] = mal_value_new_null();
    }

    if (!exec_kind || (error == 0 && !failed_exit)) {
        if (exec_kind) {
            ret = vals[5];
            goto vals_done;
        }
        vals[7] = mal_value_from_object(mal_intrinsic_new_object(vm));
    } else if (error == 0) {
        mal_vm_throw_error_value(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, vals[7]);
        vals[7] = vm->completion.value;
    } else {
        vals[7] = vals[0];
    }
    {
        static const char *const names[] = {"error", "status", "signal", "output", "pid", "stdout", "stderr"};
        MalCompletion pending = vm->completion;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        for (usize i = 0; i < countof(names); i++) {
            if (i == 0 && error == 0) continue;
            if (!mal_ncp_define(vm, vals[7], names[i], vals[i])) goto vals_done;
        }
        if (exec_kind) {
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = vals[7]};
        } else {
            vm->completion = pending;
            ret = vals[7];
        }
    }

vals_done:
    mal_gc_unroot(&vals_root);

cleanup:
    mal_gc_unroot(&root);
    mal_proc_result_dispose(&res);
    free(failed_command);
    free(shell_command);
    free(shell_c);
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
            free(argv[i + 1]); // argv[0] aliases file_c or the shell, freed above and below
        }
        free(argv);
    }
    free(file_c);
    return ret;
}

static MalValue mal_node_exec_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_node_process_command(vm, args, argc, MAL_NCP_EXEC_FILE_SYNC);
}

static MalValue mal_node_exec_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_node_process_command(vm, args, argc, MAL_NCP_EXEC_SYNC);
}

static MalValue mal_node_spawn_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_node_process_command(vm, args, argc, MAL_NCP_SPAWN_SYNC);
}

static MalValue mal_node_spawn(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_node_process_command(vm, args, argc, MAL_NCP_SPAWN);
}

typedef struct MalNodeChild {
    MalVm *vm;
    MalValue object;
    MalProcChild process;
    char *file;
    bool spawn_emitted;
    /* An unreferenced child's poll timer does not keep the event loop alive. */
    bool referenced;
    i64 poll_timer;
    struct MalNodeChild *next;
} MalNodeChild;

static void mal_node_child_arm(MalVm *vm, MalNodeChild *child, MalValue poll, i64 delay_ms) {
    child->poll_timer = mal_host_set_timeout(vm, poll, delay_ms, nullptr, 0);
    if (!child->referenced) mal_host_timer_set_referenced(vm, child->poll_timer, false);
}

// Child handles hold JS objects and are drained by the spawning isolate's mutator.
static MAL_ISOLATE_LOCAL MalNodeChild *mal_node_children;

static void mal_node_child_cleanup(MalVm *vm) {
    MalNodeChild **link = &mal_node_children;
    while (*link != nullptr) {
        MalNodeChild *child = *link;
        if (child->vm != vm) { link = &child->next; continue; }
        *link = child->next;
        mal_proc_detach(&child->process);
        free(child->file);
        free(child);
    }
}

static void mal_node_child_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalNodeChild *child = mal_node_children; child != nullptr; child = child->next) {
        if (child->vm == vm) mal_gc_mark_value(child->object);
    }
}

static void mal_node_child_emit(MalVm *vm, MalValue object, const char *event,
    const MalValue *args, i32 argc) {
    MalValue roots[4] = {object, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_ncp_string(vm, event);
    for (i32 i = 0; i < argc && i < 2; i++) roots[i + 2] = args[i];
    MalValue emit;
    if (mal_vm_get_property(vm, roots[0], mal_ncp_name_key(vm, "emit"), &emit)) {
        mal_vm_call_value(vm, emit, roots[0], roots + 1, argc + 1);
    }
    mal_gc_unroot(&root);
}

static MalValue mal_node_child_poll_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue object = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalNodeChild **link = &mal_node_children;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->object != object)) link = &(*link)->next;
    if (*link == nullptr) return mal_value_new_undefined();
    MalNodeChild *child = *link;
    MalProcResult result;
    bool finished = mal_proc_poll(&child->process, &result);
    if (child->process.launched && !child->spawn_emitted) {
        child->spawn_emitted = true;
        mal_node_child_emit(vm, object, "spawn", nullptr, 0);
    }
    bool listener_threw = vm->completion.kind == MAL_COMPLETION_THROW;
    if (!finished) {
        if (!listener_threw) mal_node_child_arm(vm, child, callee, 5);
        return mal_value_new_undefined();
    }
    link = &mal_node_children;
    while (*link != nullptr && *link != child) link = &(*link)->next;
    if (*link == child) *link = child->next;
    MalValue roots[] = {object, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (listener_threw) goto child_done;
    if (!result.launched || result.io_errno != 0) {
        int error = result.launch_errno != 0 ? result.launch_errno : result.io_errno;
        roots[1] = mal_ncp_spawn_error(vm, error, child->file, nullptr, true);
        mal_object_set(mal_value_to_object(object), mal_ncp_name_key(vm, "pid"),
            mal_value_new_undefined());
        mal_node_child_emit(vm, object, "error", roots + 1, 1);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            roots[1] = mal_value_from_i32(-error);
            roots[2] = mal_value_new_null();
            mal_node_child_emit(vm, object, "close", roots + 1, 2);
        }
    } else {
        roots[1] = result.exited ? mal_value_from_i32(result.exit_status) : mal_value_new_null();
        const char *signal = result.signaled ? mal_proc_signal_name(result.term_signal) : nullptr;
        roots[2] = signal != nullptr ? mal_ncp_string(vm, signal) : mal_value_new_null();
        mal_object_set(mal_value_to_object(object), mal_ncp_name_key(vm, "exitCode"), roots[1]);
        mal_object_set(mal_value_to_object(object), mal_ncp_name_key(vm, "signalCode"), roots[2]);
        mal_node_child_emit(vm, object, "exit", roots + 1, 2);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_child_emit(vm, object, "close", roots + 1, 2);
        }
    }
child_done:
    free(child->file);
    free(child);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_node_child_kill(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    int signal = SIGTERM;
    if (argc > 0 && !mal_value_is_undefined(args[0])) {
        if (mal_value_is_string(args[0])) {
            byte *name = mal_ncp_to_cstr(vm, args[0], "signal");
            if (name == nullptr) return mal_value_new_undefined();
            signal = mal_host_signal_number_named((const char *) name);
            free(name);
            if (signal == 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unknown signal");
                return mal_value_new_undefined();
            }
        } else if (mal_value_is_int32(args[0]) && mal_value_to_i32(args[0]) >= 0) {
            signal = mal_value_to_i32(args[0]);
        } else {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid signal");
            return mal_value_new_undefined();
        }
    }
    for (MalNodeChild *child = mal_node_children; child != nullptr; child = child->next) {
        if (child->vm == vm && child->object == self) {
            bool killed = mal_proc_kill(&child->process, signal);
            if (killed) mal_object_set(mal_value_to_object(self), mal_ncp_name_key(vm, "killed"),
                mal_value_new_boolean(true));
            return mal_value_new_boolean(killed);
        }
    }
    return mal_value_new_boolean(false);
}

static MalValue mal_node_child_set_referenced(MalVm *vm, MalValue self, bool referenced) {
    for (MalNodeChild *child = mal_node_children; child != nullptr; child = child->next) {
        if (child->vm == vm && child->object == self) {
            child->referenced = referenced;
            mal_host_timer_set_referenced(vm, child->poll_timer, referenced);
            break;
        }
    }
    return mal_value_new_undefined();
}

static MalValue mal_node_child_ref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    return mal_node_child_set_referenced(vm, self, true);
}

static MalValue mal_node_child_unref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    return mal_node_child_set_referenced(vm, self, false);
}

static MalValue mal_node_spawn_request(MalVm *vm, const MalProcRequest *request) {
    MalNodeChild *child = calloc(1, sizeof(*child));
    if (child == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (!mal_vm_register_runtime_cleanup(vm, mal_node_child_cleanup)) {
        free(child);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    child->file = strdup(request->file);
    if (child->file == nullptr) {
        free(child);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    mal_host_install_node_events(vm, nullptr, 0, nullptr);
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]))),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    child->vm = vm;
    child->object = roots[0];
    child->referenced = true;
    mal_proc_spawn(request, &child->process);
    child->next = mal_node_children;
    mal_node_children = child;
    mal_gc_register_root_source(mal_node_child_scan_roots, nullptr);
    MalObject *object = mal_value_to_object(roots[0]);
    mal_intrinsic_define_data(vm, object, (const byte *) "pid",
        child->process.pid > 0 ? mal_value_from_i32(child->process.pid) : mal_value_new_undefined(),
        MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "exitCode", mal_value_new_null(),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "signalCode", mal_value_new_null(),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "killed", mal_value_new_boolean(false),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, object, (const byte *) "kill", 1, mal_node_child_kill);
    mal_intrinsic_define_method_n(vm, object, (const byte *) "ref", 0, mal_node_child_ref);
    mal_intrinsic_define_method_n(vm, object, (const byte *) "unref", 0, mal_node_child_unref);
    roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "childProcessPoll"), mal_node_child_poll_task, roots, 1));
    mal_node_child_arm(vm, child, roots[1], 0);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_async_child_process_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "child_process.exec and child_process.execFile are not supported by this host");
    return mal_value_new_undefined();
}

static MalValue mal_node_fork_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "child_process.fork IPC is not supported by this host");
    return mal_value_new_undefined();
}

void mal_host_install_node_child_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:child_process", slots, count)) return;
    MalValue roots[2] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    static const struct {
        const char *name;
        MalNativeFunctionCallback callback;
    } functions[] = {
        {"exec", mal_node_async_child_process_unavailable},
        {"execFile", mal_node_async_child_process_unavailable},
        {"execFileSync", mal_node_exec_file_sync},
        {"execSync", mal_node_exec_sync},
        {"fork", mal_node_fork_unavailable},
        {"spawn", mal_node_spawn},
        {"spawnSync", mal_node_spawn_sync},
    };
    for (usize i = 0; i < countof(functions); i++) {
        roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) functions[i].name), 3, functions[i].callback));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) functions[i].name, roots[1],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_node_module_publish(vm, "node:child_process", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
