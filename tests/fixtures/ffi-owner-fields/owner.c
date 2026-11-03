#define _DEFAULT_SOURCE 1
#include "owner.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mman.h>
#include <pthread.h>
static _Atomic int results_destroyed;
static _Atomic int children_destroyed;
static _Atomic int released;
static _Atomic int leaves_destroyed;
static OwnerChild library_child = {777, 0};
OwnerChild *owner_child_new(int value) {
    OwnerChild *child = malloc(sizeof(*child));
    if (child == 0) abort();
    *child = (OwnerChild){.value = value, .subscribe = owner_watch_child};
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
    if (value.owns_children == 3) {
        free(value.nodes->next);
        free(value.nodes);
        atomic_fetch_add(&leaves_destroyed, 2);
    }
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
OwnerBase *owner_result_last_base(OwnerResult value) { return (OwnerBase *) value.second; }
int owner_base_value(OwnerBase *value) { return ((OwnerChild *) value)->value; }
static _Atomic int watch_calls;
typedef struct OwnerWatch {
    OwnerChild *child;
    void (*callback)(void *);
    void *data;
    void (*release)(void *);
    void (*replaced)(OwnerChild *, void *);
    void *replaced_data;
} OwnerWatch;
static OwnerWatch watches[64];
static pthread_mutex_t watch_lock = PTHREAD_MUTEX_INITIALIZER;
static OwnerWatch *owner_watch_slot(OwnerChild *child) {
    OwnerWatch *empty = 0;
    for (size_t i = 0; i < sizeof(watches) / sizeof(watches[0]); i++) {
        if (watches[i].child == child) return &watches[i];
        if (watches[i].child == 0 && empty == 0) empty = &watches[i];
    }
    if (empty == 0) abort();
    empty->child = child;
    return empty;
}
void owner_watch_child(OwnerChild *child, void (*callback)(void *), void *data, void (*release)(void *)) {
    atomic_fetch_add(&watch_calls, 1);
    pthread_mutex_lock(&watch_lock);
    OwnerWatch *slot = owner_watch_slot(child);
    void (*previous)(void *) = slot->release;
    void *previous_data = slot->data;
    slot->callback = callback;
    slot->data = data;
    slot->release = release;
    if (callback == 0 && slot->replaced == 0) *slot = (OwnerWatch){};
    pthread_mutex_unlock(&watch_lock);
    if (previous != 0) previous(previous_data);
}
void owner_replace_child(OwnerChild *child, void (*callback)(OwnerChild *, void *), void *data) {
    atomic_fetch_add(&watch_calls, 1);
    pthread_mutex_lock(&watch_lock);
    OwnerWatch *slot = owner_watch_slot(child);
    slot->replaced = callback;
    slot->replaced_data = data;
    if (callback == 0 && slot->callback == 0) *slot = (OwnerWatch){};
    pthread_mutex_unlock(&watch_lock);
}
int owner_watch_calls(void) { return atomic_load(&watch_calls); }
void owner_watch_input(OwnerChild *const *input, int count, void (*callback)(void *), void *data, void (*release)(void *)) {
    if (count != 2) abort();
    owner_watch_child(input[0], callback, data, release);
}
void owner_keep_input(OwnerChild *const *input, int count, OwnerChild *(*callback)(void *), void *data, void (*release)(void *)) {
    if (count != 2) abort();
    (void) input;
    atomic_fetch_add(&watch_calls, 1);
    owner_keep_child(callback, data, release);
}
int owner_fire_child(OwnerChild *child) {
    pthread_mutex_lock(&watch_lock);
    OwnerWatch copy = {};
    for (size_t i = 0; i < sizeof(watches) / sizeof(watches[0]); i++)
        if (watches[i].child == child) { copy = watches[i]; break; }
    pthread_mutex_unlock(&watch_lock);
    if (copy.callback != 0) copy.callback(copy.data);
    pthread_mutex_lock(&watch_lock);
    copy = (OwnerWatch){};
    for (size_t i = 0; i < sizeof(watches) / sizeof(watches[0]); i++)
        if (watches[i].child == child) { copy = watches[i]; break; }
    pthread_mutex_unlock(&watch_lock);
    if (copy.replaced != 0) copy.replaced(child, copy.replaced_data);
    return child->value;
}
int owner_fire_all(void) {
    int total = 0;
    for (size_t i = 0; i < sizeof(watches) / sizeof(watches[0]); i++) {
        pthread_mutex_lock(&watch_lock);
        OwnerChild *child = watches[i].child;
        pthread_mutex_unlock(&watch_lock);
        if (child != 0) total += owner_fire_child(child);
    }
    return total;
}
void owner_clear_watches(void) {
    for (size_t i = 0; i < sizeof(watches) / sizeof(watches[0]); i++) {
        pthread_mutex_lock(&watch_lock);
        OwnerWatch copy = watches[i];
        watches[i].callback = 0;
        watches[i].data = 0;
        watches[i].release = 0;
        if (watches[i].replaced == 0) watches[i] = (OwnerWatch){};
        pthread_mutex_unlock(&watch_lock);
        if (copy.release != 0) copy.release(copy.data);
    }
}
void owner_lend_result(void (*callback)(OwnerResult, void *), void *data) {
    OwnerResult value = owner_result_new(80);
    callback(value, data);
    owner_result_destroy(value);
}
int owner_visit_result(OwnerChild *(*callback)(void *), void *data) { OwnerChild *child = callback(data); return child == 0 ? -1 : child->value; }
static OwnerChild reused_child;
OwnerResult owner_result_reused(int seed) { reused_child = (OwnerChild){seed, 0}; return (OwnerResult){&reused_child, 0, 0, &library_child, 2, seed}; }
OwnerResult owner_result_nodes(int seed) {
    OwnerLeaf *first = malloc(sizeof(*first)), *second = malloc(sizeof(*second));
    if (first == 0 || second == 0) abort();
    *first = (OwnerLeaf){seed, second};
    *second = (OwnerLeaf){seed + 1, 0};
    return (OwnerResult){.owns_children = 3, .marker = seed, .nodes = first};
}
int owner_leaf_value(OwnerLeaf *leaf) { return leaf->value; }
OwnerLeaf *owner_leaf_alias(OwnerResult value) { return value.nodes; }
int owner_leaf_visit(OwnerLeaf *leaf, void (*callback)(void *), void *data) { callback(data); return leaf->value; }
int owner_leaf_wait(OwnerLeaf *leaf) { while (!atomic_load(&released)) usleep(1000); return leaf->value; }
int owner_leaf_results(OwnerLeaf *(*callback)(int, void *), void *data) {
    OwnerLeaf *first = callback(0, data);
    callback(1, data);
    return first == 0 ? -1 : first->value;
}
int owner_leaf_destroyed(void) { return atomic_load(&leaves_destroyed); }
static void *unreadable_base;
OwnerBase *owner_unreadable_base(void) {
    unreadable_base = mmap(0, (size_t)sysconf(_SC_PAGESIZE), PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (unreadable_base == MAP_FAILED) abort();
    return unreadable_base;
}
OwnerChild *owner_child_from_base(OwnerBase *base) { return (OwnerChild *)base; }
void owner_unreadable_release(void) { munmap(unreadable_base, (size_t)sysconf(_SC_PAGESIZE)); unreadable_base = 0; }
OwnerChild *owner_library_owned(void) { return &library_child; }
OwnerChild *owner_library_callback(void (*callback)(void *), void *data) { callback(data); return &library_child; }
OwnerResult owner_result_library_alias(OwnerChild *child) { return (OwnerResult){.library = child}; }
static OwnerChild program_children[128];
int owner_program_count(void) { return (int)(sizeof(program_children) / sizeof(program_children[0])); }
OwnerResult owner_result_program(int index) {
    if (index < 0 || index >= owner_program_count()) abort();
    program_children[index].value = 1000 + index;
    return (OwnerResult){.library = &program_children[index]};
}
OwnerChild *owner_program_owned(int index) {
    if (index < 0 || index >= owner_program_count()) abort();
    return &program_children[index];
}
void owner_close_child(OwnerChild *child, void (*done)(OwnerChild *, void *), void *data) {
    atomic_fetch_add(&watch_calls, 1);
    done(child, data);
    owner_child_free(child);
}
OwnerChild *owner_alias_callback(OwnerChild *child, void (*callback)(void *), void *data) {
    callback(data);
    return child;
}
OwnerChild *owner_alias_outputs(OwnerChild *child, OwnerChild **out, void (*callback)(void *), void *data) {
    *out = child;
    callback(data);
    return child;
}
OwnerChild *owner_new_outputs(int value, OwnerChild **out, void (*callback)(void *), void *data) {
    return owner_alias_outputs(owner_child_new(value), out, callback, data);
}
static OwnerChild *global_alias;
static _Atomic int global_started;
void owner_global_reset(void) { global_alias = 0; atomic_store(&global_started, 0); }
void owner_global_set(OwnerChild *child) { global_alias = child; }
int owner_global_started(void) { return atomic_load(&global_started); }
OwnerChild *owner_global_wait(int (*callback)(void *), void *data) {
    atomic_store(&global_started, 1);
    while (callback(data) != 0) usleep(1000);
    return global_alias;
}
OwnerChild *owner_new_wait(int value, int (*callback)(void *), void *data) {
    atomic_store(&global_started, 1);
    while (callback(data) != 0) usleep(1000);
    return owner_child_new(value);
}
OwnerChild *owner_new_wait_outputs(int value, OwnerChild **out, int (*callback)(void *), void *data) {
    OwnerChild *child = owner_new_wait(value, callback, data);
    *out = child;
    return child;
}
OwnerChild *owner_loan_owned(void (*callback)(OwnerChild *, void *), void *data) {
    OwnerChild *child = owner_child_new(96);
    callback(child, data);
    return child;
}
