#include "lifetime.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <unistd.h>
struct LifeChild {
    int value;
    int (*callback)(void *);
    void *data;
    void (*release)(void *);
    int (*replaced)(LifeChild *, void *);
    void *replaced_data;
    void (*notice)(void *);
    LifeRoot *(*resource)(void *);
};
static _Atomic int destroyed;
static _Atomic bool recycle;
static _Atomic(LifeChild *) recycled;
static LifeRoot *held;
static void *held_data;
static void (*held_release)(void *);
static LifeChild *child_new(int value) {
    LifeChild *child = atomic_exchange(&recycled, NULL);
    if (child == NULL) child = malloc(sizeof(*child));
    if (child == NULL) abort();
    *child = (LifeChild) {.value = value};
    return child;
}
static void child_free(LifeChild *child) {
    if (child->release != NULL) child->release(child->data);
    if (atomic_exchange(&recycle, false)) child = atomic_exchange(&recycled, child);
    free(child);
    atomic_fetch_add(&destroyed, 1);
}
/* The next freed child's storage becomes the next child's, as allocators often recycle it. */
void life_recycle_next(void) { atomic_store(&recycle, true); }
LifeRoot *life_new(int value) {
    LifeRoot *root = malloc(sizeof(*root));
    if (root == NULL) abort();
    root->child = child_new(value);
    return root;
}
void life_destroy(LifeRoot *root) { child_free(root->child); free(root); }
RetryRoot *retry_new(int value) {
    RetryRoot *root = malloc(sizeof(*root));
    if (root == NULL) abort();
    root->child = child_new(value); root->fail = 1;
    return root;
}
int retry_destroy(RetryRoot *root) {
    if (root->fail) return 0;
    child_free(root->child); free(root); return 1;
}
void retry_allow(RetryRoot *root) { root->fail = 0; }
void life_subscribe(LifeChild *child, int (*callback)(void *), void *data, void (*release)(void *)) {
    if (child == NULL) return;
    if (child->callback != NULL) abort();
    child->callback = callback; child->data = data; child->release = release;
}
void life_subscribe_queued(LifeChild *child, int (*callback)(void *), void *data, void (*release)(void *)) {
    life_subscribe(child, callback, data, release);
}
void life_subscribe_notice(LifeChild *child, void (*callback)(void *), void *data, void (*release)(void *)) {
    child->notice = callback; child->data = data; child->release = release;
}
void life_subscribe_result(LifeChild *child, LifeRoot *(*callback)(void *), void *data, void (*release)(void *)) {
    child->resource = callback; child->data = data; child->release = release;
}
int life_fire_result(LifeChild *child) {
    LifeRoot *root = child->resource(child->data);
    return root == NULL ? -1 : root->child->value;
}
static void *post_notice(void *data) {
    LifeChild *child = data;
    child->notice(child->data); return NULL;
}
void life_post(LifeChild *child) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, post_notice, child) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
}
void life_replace(LifeChild *child, int (*callback)(LifeChild *, void *), void *data) {
    child->replaced = callback; child->replaced_data = data;
}
int life_fire(LifeChild *child) {
    if (child->callback != NULL) return child->callback(child->data);
    if (child->replaced != NULL) return child->replaced(child, child->replaced_data);
    return -1;
}
static void *fire(void *data) {
    int *result = malloc(sizeof(*result));
    if (result == NULL) abort();
    *result = life_fire(data); return result;
}
int life_fire_thread(LifeChild *child) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, fire, child) != 0) abort();
    void *result;
    if (pthread_join(thread, &result) != 0) abort();
    int value = *(int *) result; free(result); return value;
}
int life_value(LifeChild *child) { return child->value; }
int life_destroyed(void) { return atomic_load(&destroyed); }
void life_keep_root(LifeRoot *(*callback)(void *), void *data, void (*release)(void *)) {
    if (held != NULL) abort();
    held = callback(data); held_data = data; held_release = release;
}
int life_held_value(void) { return held == NULL ? -1 : life_value(held->child); }
int life_held_fire(void) { return held == NULL ? -1 : life_fire(held->child); }
void life_clear_root(void) {
    void (*release)(void *) = held_release;
    void *data = held_data;
    held = NULL; held_release = NULL; held_data = NULL;
    if (release != NULL) release(data);
}

static CopiedRoot *copied_live;
static int copy_entries;
CopiedRoot copied_new(int value) { return (CopiedRoot) {child_new(value)}; }
void copied_destroy(CopiedRoot value) {
    if (copied_live != NULL && copied_live->child == value.child) copied_live = NULL;
    child_free(value.child);
}
void copied_subscribe(CopiedRoot *root, int (*callback)(void *), void *data, void (*release)(void *)) {
    copy_entries++;
    copied_live = root;
    life_subscribe(root->child, callback, data, release);
}
int copied_value(CopiedRoot *root) { return life_value(root->child); }
int copied_live_value(void) { return copied_live == NULL ? -1 : copied_value(copied_live); }
int copied_entries(void) { return copy_entries; }
ManualCopy manual_copy_new(int value) { return (ManualCopy) {child_new(value)}; }
void manual_copy_destroy(ManualCopy value) { child_free(value.child); }
void manual_copy_subscribe(ManualCopy *root, int (*callback)(void *), void *data, void (*release)(void *)) {
    copy_entries++; life_subscribe(root->child, callback, data, release);
}
RetryCopy retry_copy_new(int value) { return (RetryCopy) {child_new(value), 1}; }
int retry_copy_destroy(RetryCopy value) { if (value.fail) return 0; child_free(value.child); return 1; }
void retry_copy_allow(RetryCopy *root) { root->fail = 0; }
void retry_copy_subscribe(RetryCopy *root, int (*callback)(void *), void *data, void (*release)(void *)) {
    copy_entries++; life_subscribe(root->child, callback, data, release);
}
static LifeChild *held_child;
static void *child_data;
static void (*child_release)(void *);
void life_keep_child(LifeChild *(*callback)(void *), void *data, void (*release)(void *)) {
    if (held_child != NULL) abort();
    held_child = callback(data); child_data = data; child_release = release;
}
int life_held_child_value(void) { return held_child == NULL ? -1 : life_value(held_child); }
int life_held_child_fire(void) { return held_child == NULL ? -1 : life_fire(held_child); }
void life_clear_child(void) {
    void (*release)(void *) = child_release; void *data = child_data;
    held_child = NULL; child_data = NULL; child_release = NULL;
    if (release != NULL) release(data);
}

static CallerRoot *caller_live;
static _Atomic int caller_entry_count, caller_init_count, caller_start_count;
static int caller_close_count;
void caller_close_view(CallerBase *root, void (*callback)(CallerBase *, void *), void *data) { (void) root; (void) callback; (void) data; caller_close_count++; }
int caller_close_entries(void) { return caller_close_count; }
int caller_init(CallerRoot *root, int value, int mode, const char **message, size_t *length) {
    atomic_fetch_add(&caller_entry_count, 1);
    *message = "x"; *length = mode == 2 ? (size_t)-1 : 1;
    if (root->child != NULL) abort();
    if (mode == 1) return -1;
    if (mode != 5) { root->child = child_new(value); atomic_fetch_add(&caller_init_count, 1); }
    if (mode == 3) root->length = (size_t)-1;
    if (mode == 4 || mode == 5) { atomic_fetch_add(&caller_start_count, 1); usleep(150000); }
    return mode == 5 ? -1 : 0;
}
int caller_init_callback(CallerRoot *root, void (*callback)(void)) {
    const char *message; size_t length;
    int result = caller_init(root, 443, 0, &message, &length);
    callback(); return result;
}
int caller_init_late(CallerRoot *root, CallerLater later) {
    const char *message; size_t length;
    return caller_init(root, later.value, 0, &message, &length);
}
void caller_init_void(CallerRoot *root, int value) {
    const char *message; size_t length;
    (void) caller_init(root, value, 0, &message, &length);
}
CallerRoot *caller_echo(CallerRoot *root) { return root; }
void caller_cleanup(CallerRoot *root) {
    if (root->child == NULL) abort();
    if (caller_live == root) caller_live = NULL;
    child_free(root->child); root->child = NULL;
}
void caller_subscribe(CallerRoot *root, int (*callback)(void *), void *data, void (*release)(void *)) {
    caller_live = root; life_subscribe(root->child, callback, data, release);
}
int caller_value(CallerRoot *root) { return life_value(root->child); }
int caller_live_value(void) { return caller_live == NULL ? -1 : caller_value(caller_live); }
int caller_live_byte(void) { return caller_live == NULL ? -1 : (int) caller_live->data[0] + (int) caller_live->length; }
int caller_entries(void) { return atomic_load(&caller_entry_count); }
int caller_inits(void) { return atomic_load(&caller_init_count); }
int caller_started(void) { return atomic_load(&caller_start_count); }
