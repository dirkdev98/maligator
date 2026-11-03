#ifdef calloc
#undef calloc
#endif
#include "arrays.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <time.h>
struct ArrayResource { int value; };
static _Atomic int created, destroyed, freed_arrays, started, fail_next, failed_allocations;
static ArrayResource **current;
static ArrayResource *single;
static ArrayResource recycled;
static int recycled_open;
static void (*on_destroy)(void);
static void (*watch)(void);
static char text[2];
static int first_frees, second_frees;
void *array_test_calloc(size_t count, size_t width) {
    if (atomic_exchange(&fail_next, 0)) { atomic_fetch_add(&failed_allocations, 1); return NULL; }
    return calloc(count, width);
}
static ArrayResource *make_resource(int value) {
    ArrayResource *resource = malloc(sizeof(*resource));
    if (resource == NULL) abort();
    resource->value = value;
    atomic_fetch_add(&created, 1);
    return resource;
}
ArrayResource **array_make(int count, int bad, size_t *length, const char **message, size_t *message_length) {
    *length = (size_t) count;
    ArrayResource **values = malloc((count > 0 ? (size_t) count : 1) * sizeof(*values));
    if (values == NULL) abort();
    for (int index = 0; index < count; index++) values[index] = index % 2 == 0 ? (index % 6 == 4 ? NULL : make_resource(17 + index)) : values[index - 1];
    *message = "x"; *message_length = bad ? (size_t)-1 : 1;
    current = values;
    return values;
}
ArrayResource **array_alias(ArrayResource ***other, size_t *length, size_t *other_length) {
    const char *message; size_t bytes;
    ArrayResource **values = array_make(3, 0, length, &message, &bytes);
    *other = values; *other_length = *length;
    return values;
}
ArrayResource *array_mixed(ArrayResource ***out, size_t *length, int bad, const char **message, size_t *message_length) {
    *out = array_make(3, bad, length, message, message_length);
    return (*out)[2];
}
ArrayResource **array_null(size_t *length) { *length = (size_t)-1; return NULL; }
ArrayResource **array_fail(int bad, size_t *length, const char **message, size_t *message_length) {
    ArrayResource **values = array_make(3, bad, length, message, message_length);
    atomic_store(&fail_next, 1);
    return values;
}
ArrayResource **array_callback(void (*callback)(void), size_t *length) {
    const char *message; size_t bytes;
    ArrayResource **values = array_make(3, 0, length, &message, &bytes);
    callback();
    atomic_store(&fail_next, 1);
    return values;
}
ArrayResource **array_existing(ArrayResource *prior, void (*callback)(void), size_t *length) {
    ArrayResource **values = malloc(3 * sizeof(*values));
    if (values == NULL) abort();
    *length = 3; values[0] = prior; values[1] = prior; values[2] = make_resource(41);
    current = values;
    callback();
    return values;
}
ArrayResource **array_wait(size_t *length) {
    const char *message; size_t bytes;
    ArrayResource **values = array_make(3, 0, length, &message, &bytes);
    atomic_store_explicit(&started, 1, memory_order_release);
    struct timespec delay = { .tv_nsec = 150000000 };
    nanosleep(&delay, NULL);
    return values;
}
void array_free(void *values) { if (watch != NULL) watch(); current = NULL; atomic_fetch_add(&freed_arrays, 1); free(values); }
void array_watch(void (*callback)(void)) { watch = callback; }
ArrayResource *array_peek(int index) { return current == NULL ? NULL : current[index]; }
ArrayResource *resource_borrow(int value) { single = make_resource(value); return single; }
void resource_clear(void) { if (single != NULL) resource_free(single); }
void resource_free(ArrayResource *value) {
    if (single == value) single = NULL;
    atomic_fetch_add(&destroyed, 1);
    if (value == &recycled) {
        assert(recycled_open); recycled_open = 0;
        void (*callback)(void) = on_destroy; on_destroy = NULL;
        if (callback != NULL) callback();
    } else free(value);
}
int resource_value(ArrayResource *value) { return value->value; }
int resources_created(void) { return atomic_load(&created); }
int resources_destroyed(void) { return atomic_load(&destroyed); }
int arrays_freed(void) { return atomic_load(&freed_arrays); }
int array_started(void) { return atomic_load_explicit(&started, memory_order_acquire); }
int allocation_failures(void) { return atomic_load(&failed_allocations); }
void allocation_reset(void) { atomic_store(&fail_next, 0); }
char *buffer_alias(char **other) { text[0] = 'x'; text[1] = 0; *other = text; return text; }
void buffer_free_first(void *value) { (void) value; first_frees++; ((char *) value)[0] = 'z'; if (watch != NULL) watch(); }
void buffer_free_second(void *value) { (void) value; second_frees++; }
int buffer_first_frees(void) { return first_frees; }
int buffer_second_frees(void) { return second_frees; }

ArrayResource **array_single(int count, size_t *length) {
    const char *message; size_t bytes;
    return array_make(count, 0, length, &message, &bytes);
}
static void do_nothing(void) {}
ArrayResource **array_existing_bad(ArrayResource *prior, int bad, size_t *length, const char **message, size_t *message_length) {
    *message = "x"; *message_length = bad ? (size_t)-1 : 1;
    return array_existing(prior, do_nothing, length);
}
ArrayResource *resource_recycled(void) {
    assert(!recycled_open); recycled_open = 1; recycled.value = 73;
    atomic_fetch_add(&created, 1);
    return &recycled;
}
void resource_on_destroy(void (*callback)(void)) { on_destroy = callback; }
ArrayResource *array_fresh(ArrayResource ***out, size_t *length) {
    ArrayResource *value = resource_recycled();
    *length = 1; *out = malloc(sizeof(**out));
    if (*out == NULL) abort();
    (*out)[0] = value; current = *out;
    return value;
}
char *buffer_single(int marker) {
    static char value[128];
    for (int index = 0; index < 127; index++) value[index] = (char) ('a' + (index + marker) % 26);
    value[127] = 0;
    return value;
}

ArrayResource *array_fresh_fail(ArrayResource ***out, size_t *length) {
    ArrayResource *value = resource_recycled();
    *length = 3; *out = malloc(*length * sizeof(**out));
    if (*out == NULL) abort();
    for (size_t index = 0; index < *length; index++) (*out)[index] = value;
    current = *out;
    atomic_store(&fail_next, 1);
    return value;
}
static ArrayResource *registered;
void array_register(ArrayResource *(*callback)(void)) { registered = callback == NULL ? NULL : callback(); }
int array_registered_value(void) { return registered == NULL ? -1 : registered->value; }
