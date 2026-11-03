#include "lifetime.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
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
static LifeRoot *held;
static void *held_data;
static void (*held_release)(void *);
static LifeChild *child_new(int value) {
    LifeChild *child = calloc(1, sizeof(*child));
    if (child == NULL) abort();
    child->value = value;
    return child;
}
static void child_free(LifeChild *child) {
    if (child->release != NULL) child->release(child->data);
    free(child);
    atomic_fetch_add(&destroyed, 1);
}
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
