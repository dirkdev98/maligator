#include "node_process_env.h"

#include <signal.h>
#include <string.h>

#include "intrinsics.h"
#include "object.h"
#include "utf8.h"
#include "vm_ops.h"

// The process environment. On Darwin the real environ of an executable is reached
// through _NSGetEnviron(); the bare `extern char **environ` only resolves in a
// non-dylib main image, so the crt_externs form is the portable one here.
#if defined(__APPLE__)
#include <crt_externs.h>
char **mal_process_environ(void) {
    return *_NSGetEnviron();
}
#else
extern char **environ;
char **mal_process_environ(void) {
    return environ;
}
#endif

static const MalPropertyFlags visible_data =
    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

void mal_process_define_env(MalVm *vm, MalObject *process) {
    MalObject *env = mal_intrinsic_new_object(vm);
    MalValue roots[] = {mal_value_from_object(env), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // Keep ordinary read caches while ensuring a shape store cannot bypass coercion.
    mal_object_properties(env)->process_environment = true;

    char **entries = mal_process_environ();
    for (usize i = 0; entries != nullptr && entries[i] != nullptr; i++) {
        const char *entry = entries[i];
        const char *eq = strchr(entry, '=');
        if (eq == nullptr || eq == entry) continue;
        MalString *name = mal_string_from_utf8(&vm->heap, (const byte *) entry, (usize) (eq - entry));
        if (name == nullptr) {
            mal_vm_throw_allocation_error(vm);
            break;
        }
        roots[1] = mal_value_from_string(name);
        MalString *value = mal_string_from_utf8(&vm->heap, (const byte *) eq + 1, strlen(eq + 1));
        if (value == nullptr) {
            mal_vm_throw_allocation_error(vm);
            break;
        }
        roots[2] = mal_value_from_string(value);
        MalKey key;
        if (!mal_vm_value_to_property_key(vm, roots[1], &key)) break;
        mal_object_set(env, key, roots[2]);
    }

    if (vm->completion.kind == MAL_COMPLETION_NORMAL)
        mal_intrinsic_define_data(vm, process, "env", roots[0], visible_data);
    mal_gc_unroot(&root);
}

void mal_host_install_process_env(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    // Keep Node's unhandled-rejection and web body semantics without the console hooks.
    vm->host_node = true;
    struct sigaction ignored = {.sa_handler = SIG_IGN};
    sigemptyset(&ignored.sa_mask);
    sigaction(SIGPIPE, &ignored, nullptr);
    MalValue process = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &process, 1);
    mal_process_define_env(vm, mal_value_to_object(process));
    if (vm->completion.kind == MAL_COMPLETION_NORMAL)
        mal_intrinsic_define_data(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]),
            "process", process, visible_data);
    mal_gc_unroot(&root);
}
