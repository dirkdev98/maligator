#include "owner.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>
static _Atomic int results_destroyed;
static _Atomic int children_destroyed;
static _Atomic int released;
static OwnerChild library_child = {777, 0};
OwnerChild *owner_child_new(int value) {
    OwnerChild *child = malloc(sizeof(*child));
    if (child == 0) abort();
    *child = (OwnerChild){value, 0};
    return child;
}
void owner_child_free(OwnerChild *child) { if (child != 0) { atomic_fetch_add(&children_destroyed, 1); free(child); } }
OwnerResult owner_result_new(int seed) {
    OwnerChild *first = owner_child_new(seed), *second = owner_child_new(seed + 1);
    first->next = second;
    return (OwnerResult){first, second, 0, &library_child, 1, seed};
}
OwnerResult owner_result_alias(OwnerChild *child) { return (OwnerResult){child, 0, 0, &library_child, 0, 0}; }
OwnerResult owner_result_callback(void (*callback)(void *), void *data) { callback(data); return owner_result_new(50); }
void owner_result_destroy(OwnerResult value) {
    atomic_fetch_add(&results_destroyed, 1);
    if (value.owns_children == 1) { owner_child_free(value.first); owner_child_free(value.second); }
}
int owner_result_destroyed(void) { return atomic_load(&results_destroyed); }
int owner_child_destroyed(void) { return atomic_load(&children_destroyed); }
int owner_child_value(OwnerChild *child) { return child->value; }
OwnerChild *owner_child_alias(OwnerChild *child) { return child; }
int owner_child_visit(OwnerChild *child, void (*callback)(void *), void *data) { callback(data); return child->value; }
int owner_child_wait(OwnerChild *child) { while (!atomic_load(&released)) usleep(1000); return child->value; }
void owner_child_release(void) { atomic_store(&released, 1); }
static OwnerChild *kept_child;
static void *kept_data;
static void (*kept_release)(void *);
void owner_keep_child(OwnerChild *(*callback)(void *), void *data, void (*release)(void *)) { kept_data = data; kept_release = release; kept_child = callback(data); }
int owner_kept_child_value(void) { return kept_child == 0 ? -1 : kept_child->value; }
void owner_release_child(void) { void (*release)(void *) = kept_release; kept_release = 0; kept_child = 0; if (release != 0) release(kept_data); }
void owner_wait_reset(void) { atomic_store(&released, 0); }
int owner_result_wait(OwnerResult value) { while (!atomic_load(&released)) usleep(1000); return value.first->value; }
void owner_lend_child(void (*callback)(OwnerChild *, void *), void *data) { OwnerChild *child = owner_child_new(70); callback(child, data); owner_child_free(child); }
OwnerBase *owner_result_base(OwnerResult value) { return (OwnerBase *) value.first; }
int owner_base_value(OwnerBase *value) { return ((OwnerChild *) value)->value; }
static _Atomic int watch_calls;
void owner_watch_child(OwnerChild *child, void (*callback)(void *), void *data, void (*release)(void *)) {
    (void) child;
    atomic_fetch_add(&watch_calls, 1);
    if (callback != 0) callback(data);
    if (release != 0) release(data);
}
void owner_replace_child(OwnerChild *child, void (*callback)(OwnerChild *, void *), void *data) {
    atomic_fetch_add(&watch_calls, 1);
    if (callback != 0) callback(child, data);
}
int owner_watch_calls(void) { return atomic_load(&watch_calls); }
void owner_lend_result(void (*callback)(OwnerResult, void *), void *data) {
    OwnerResult value = owner_result_new(80);
    callback(value, data);
    owner_result_destroy(value);
}
int owner_visit_result(OwnerChild *(*callback)(void *), void *data) { OwnerChild *child = callback(data); return child == 0 ? -1 : child->value; }
static OwnerChild reused_child;
OwnerResult owner_result_reused(int seed) { reused_child = (OwnerChild){seed, 0}; return (OwnerResult){&reused_child, 0, 0, &library_child, 2, seed}; }
