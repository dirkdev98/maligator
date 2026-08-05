#include "node_immediate.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>

#include "async_context.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_host_timer.h"

typedef struct MalNodeImmediate {
    i64 id;
    MalVm *vm;
    MalValue callback;
    MalValue *args;
    i32 arg_count;
    MalAsyncContext *async_context;
    struct MalNodeImmediate *previous;
    struct MalNodeImmediate *next;
} MalNodeImmediate;

static MalNodeImmediate *node_immediates;
static MalNodeImmediate *node_immediates_tail;
static i64 node_immediate_next_id = 1;
static bool node_immediate_roots_installed;

static void node_immediate_unlink(MalNodeImmediate *immediate) {
    if (immediate->previous == nullptr) node_immediates = immediate->next;
    else immediate->previous->next = immediate->next;
    if (immediate->next == nullptr) node_immediates_tail = immediate->previous;
    else immediate->next->previous = immediate->previous;
}

static void node_immediate_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalNodeImmediate *immediate = node_immediates; immediate != nullptr;
         immediate = immediate->next) {
        if (immediate->vm != vm) continue;
        mal_gc_mark_value(immediate->callback);
        mal_gc_mark_values(immediate->args, immediate->arg_count);
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) immediate->async_context));
    }
}

static bool node_immediate_drain(MalVm *vm) {
    MalNodeImmediate *immediate = node_immediates;
    while (immediate != nullptr && immediate->vm != vm) immediate = immediate->next;
    if (immediate == nullptr) return false;
    node_immediate_unlink(immediate);

    MalValue callback = immediate->callback;
    MalValue *args = immediate->args;
    i32 arg_count = immediate->arg_count;
    MalAsyncContext *async_context = immediate->async_context;
    free(immediate);
    MalRootSpan callback_root;
    mal_gc_root(&callback_root, &callback, 1);
    MalRootSpan args_root;
    if (arg_count > 0) mal_gc_root(&args_root, args, arg_count);
    MalAsyncContextScope async_scope;
    mal_async_context_scope_enter(vm, &async_scope, async_context);
    mal_vm_call_value(vm, callback, mal_value_new_undefined(), args, arg_count);
    mal_async_context_scope_exit(vm, &async_scope);
    if (arg_count > 0) mal_gc_unroot(&args_root);
    mal_gc_unroot(&callback_root);
    free(args);
    return true;
}

static MalValue node_set_immediate(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "setImmediate callback must be a function");
        return mal_value_new_undefined();
    }
    MalNodeImmediate *immediate = calloc(1, sizeof(MalNodeImmediate));
    if (immediate == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    immediate->id = node_immediate_next_id++;
    immediate->vm = vm;
    immediate->callback = args[0];
    immediate->async_context = mal_async_context_capture(vm);
    immediate->arg_count = argc - 1;
    if (immediate->arg_count > 0) {
        immediate->args = malloc(sizeof(MalValue) * (usize) immediate->arg_count);
        if (immediate->args == nullptr) {
            free(immediate);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        for (i32 i = 0; i < immediate->arg_count; i++) immediate->args[i] = args[i + 1];
    }
    immediate->previous = node_immediates_tail;
    if (node_immediates_tail == nullptr) node_immediates = immediate;
    else node_immediates_tail->next = immediate;
    node_immediates_tail = immediate;
    return mal_value_from_f64((f64) immediate->id);
}

static MalValue node_clear_immediate(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1) return mal_value_new_undefined();
    f64 number;
    if (!mal_vm_to_number(vm, args[0], &number)) return mal_value_new_undefined();
    if (!isfinite(number) || trunc(number) != number) return mal_value_new_undefined();
    i64 id = (i64) number;
    for (MalNodeImmediate *immediate = node_immediates; immediate != nullptr;
         immediate = immediate->next) {
        if (immediate->vm != vm || immediate->id != id) continue;
        node_immediate_unlink(immediate);
        free(immediate->args);
        free(immediate);
        break;
    }
    return mal_value_new_undefined();
}

void mal_node_immediates_install(MalVm *vm, MalObject *global_this) {
    if (!node_immediate_roots_installed) {
        mal_gc_register_root_source(node_immediate_scan_roots, nullptr);
        mal_host_register_macrotask_drain(node_immediate_drain);
        node_immediate_roots_installed = true;
    }
    mal_intrinsic_define_method_n(vm, global_this, "setImmediate", 1, node_set_immediate);
    mal_intrinsic_define_method_n(vm, global_this, "clearImmediate", 1, node_clear_immediate);
}

void mal_node_immediates_free(MalVm *vm) {
    MalNodeImmediate *immediate = node_immediates;
    while (immediate != nullptr) {
        MalNodeImmediate *next = immediate->next;
        if (immediate->vm == vm) {
            node_immediate_unlink(immediate);
            free(immediate->args);
            free(immediate);
        }
        immediate = next;
    }
}

#endif /* MAL_NODE */
