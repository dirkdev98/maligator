#include <stdio.h>
#include <stdlib.h>

#include "ffi/mal_ffi.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "line %d: %s\n", __LINE__, #condition); return 1; } } while (0)

static const MalFfiLibrary library = {.specifier = "maligator:ffi/sweep-fixture"};
static int resource;
static int destroyed;
static bool destroy_resource(void *value) {
    (void) value;
    destroyed++;
    return true;
}
static const MalFfiHandleType borrowed_type = {.name = "BorrowedResource"};
static const MalFfiHandleType owned_type = {
    .name = "OwnedResource", .destroy = destroy_resource, .collect = true,
    .borrows_owner = true, .library_lifetime = true,
};
static const MalFfiHandleType struct_type = {
    .name = "Registration", .size = sizeof(int), .alignment = alignof(int),
    .destroy = destroy_resource, .collect = true,
};
static const MalFfiHandleType child_type = {
    .name = "ChildResource", .borrows_owner = true,
};
static int child_resource;
static const MalFfiSite site = {"sweep", "resource", nullptr};
static usize no_workers(void) { return 0; }

static bool begin_sweep(MalVm *vm) {
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    for (int step = 0; step < 1000; step++) {
        mal_gc_safepoint(vm);
        if (vm->heap.sweeping) return true;
        mal_gc_poll = true;
    }
    return false;
}

static int check_borrowed(MalVm *vm) {
    MalValue root = mal_ffi_new_handle(vm, &library, &borrowed_type, &resource, false, false);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    CHECK(!mal_ffi_threw(vm));
    CHECK(root == mal_ffi_new_handle(vm, &library, &borrowed_type, &resource, false, false));
    mal_gc_collect(vm);
    root = mal_value_new_undefined();
    CHECK(begin_sweep(vm));
    root = mal_ffi_new_handle(vm, &library, &borrowed_type, &resource, false, false);
    CHECK(!mal_ffi_threw(vm));
    mal_gc_finish_pending_cycle(vm);
    void *pointer;
    CHECK(mal_ffi_to_handle(vm, root, &borrowed_type, false, &site, &pointer, nullptr));
    CHECK(pointer == &resource);
    mal_gc_unroot(&span);
    mal_gc_collect(vm);
    return 0;
}

static void clear_error(MalVm *vm) { vm->completion = (MalCompletion) {0}; }

static int check_owned(MalVm *vm) {
    MalValue root = mal_ffi_new_handle(vm, &library, &owned_type, &resource, true, false);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    mal_gc_collect(vm);
    root = mal_value_new_undefined();
    int before = destroyed;
    CHECK(begin_sweep(vm));
    CHECK(!mal_ffi_discard_needed(vm, nullptr, &owned_type, &resource, true));
    mal_ffi_new_handle(vm, &library, &owned_type, &resource, false, true);
    CHECK(mal_ffi_threw(vm));
    clear_error(vm);
    mal_ffi_new_library_handle(vm, &library, &owned_type, &resource);
    CHECK(mal_ffi_threw(vm));
    clear_error(vm);
    mal_gc_finish_pending_cycle(vm);
    CHECK(destroyed == before + 1);
    root = mal_ffi_new_handle(vm, &library, &owned_type, &resource, true, true);
    CHECK(!mal_ffi_threw(vm));
    mal_gc_unroot(&span);
    mal_gc_collect(vm);
    CHECK(destroyed == before + 2);
    return 0;
}

static int check_callback(MalVm *vm, const MalFfiHandleType *type) {
    MalValue root = mal_ffi_new_handle(vm, &library, type, &resource, true, false);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    MalFfiCallback *callback = mal_ffi_keep(vm, vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    CHECK(callback != nullptr);
    CHECK(mal_ffi_callback_own(vm, callback, root, nullptr, &site));
    CHECK(mal_ffi_callback_owner_vm(callback) == vm);
    mal_gc_collect(vm);
    root = mal_value_new_undefined();
    CHECK(begin_sweep(vm));
    CHECK(mal_ffi_callback_owner_vm(callback) == nullptr);
    mal_ffi_release(callback);
    mal_gc_finish_pending_cycle(vm);
    mal_gc_unroot(&span);
    return 0;
}

static int check_child_owner(MalVm *vm, const MalFfiHandleType *type) {
    int before = destroyed;
    MalValue roots[] = {
        mal_ffi_new_handle(vm, &library, type, &resource, true, false),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    CHECK(!mal_ffi_threw(vm));
    roots[1] = mal_ffi_new_owner_handle(vm, &library, &child_type, &child_resource, roots[0]);
    CHECK(!mal_ffi_threw(vm));
    roots[0] = mal_value_new_undefined();
    mal_gc_collect(vm);
    CHECK(destroyed == before);
    void *pointer;
    CHECK(mal_ffi_to_handle(vm, roots[1], &child_type, false, &site, &pointer, nullptr));
    CHECK(pointer == &child_resource);
    roots[1] = mal_value_new_undefined();
    mal_gc_collect(vm);
    CHECK(destroyed == before + 1);
    mal_gc_unroot(&span);
    return 0;
}

static MalHeapHeader *holder;
static bool holder_traced;
static void observe_holder(MalHeapHeader *cell) {
    if (cell == holder) holder_traced = true;
}

static int check_mark_recovery(MalVm *vm) {
    enum { BALLAST = 20000 };
    MalValue *roots = calloc(BALLAST + 2, sizeof(*roots));
    CHECK(roots != nullptr);
    for (int i = 0; i < BALLAST; i++)
        roots[i] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    roots[BALLAST] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    holder = mal_value_to_heap(roots[BALLAST]);
    roots[BALLAST + 1] = mal_ffi_new_handle(vm, &library, &borrowed_type, &resource, false, false);
    MalRootSpan span;
    mal_gc_root(&span, roots, BALLAST + 2);
    mal_gc_collect(vm);
    roots[BALLAST + 1] = mal_value_new_undefined();
    mal_gc_register_tracer(MAL_HEAP_OBJECT, observe_holder);
    holder_traced = false;
    vm->heap.next_gc_at = 1;
    for (int step = 0; step < 1000 && !holder_traced; step++) {
        mal_gc_poll = true;
        mal_gc_safepoint(vm);
    }
    CHECK(holder_traced && mal_gc_marking_active);
    MalValue recovered = mal_ffi_new_handle(vm, &library, &borrowed_type, &resource, false, false);
    CHECK(!mal_ffi_threw(vm));
    CHECK(mal_object_set((MalObject *) holder, mal_key_index_unsigned(0), recovered));
    mal_gc_finish_pending_cycle(vm);
    MalValue stored;
    CHECK(mal_vm_get_property(vm, roots[BALLAST], mal_key_index_unsigned(0), &stored));
    void *pointer;
    CHECK(mal_ffi_to_handle(vm, stored, &borrowed_type, false, &site, &pointer, nullptr));
    CHECK(pointer == &resource);
    mal_gc_register_tracer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_unroot(&span);
    free(roots);
    mal_gc_collect(vm);
    return 0;
}

int main(void) {
    mal_gc_test_precise_stack_roots = true;
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    mal_ffi_install(&vm, &library, nullptr, 0);
    CHECK(check_borrowed(&vm) == 0);
    CHECK(check_owned(&vm) == 0);
    CHECK(check_callback(&vm, &owned_type) == 0);
    CHECK(check_callback(&vm, &struct_type) == 0);
    CHECK(check_child_owner(&vm, &owned_type) == 0);
    CHECK(check_child_owner(&vm, &struct_type) == 0);
    CHECK(check_mark_recovery(&vm) == 0);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("ffi-handle-sweep PASS");
    return 0;
}
