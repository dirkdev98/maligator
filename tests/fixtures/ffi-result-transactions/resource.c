#include "resource.h"
#include <stdlib.h>
#include <stdatomic.h>
#include <unistd.h>
struct TxResource { int value; };
static TxResource *current;
static TxResource recycled;
static _Atomic int destroyed;
static int read_entries;
static int input_entries;
static TxResource *create(int value) {
    TxResource *resource = malloc(sizeof(*resource));
    if (resource == NULL) abort();
    resource->value = value;
    return resource;
}
TxResource *tx_create(int value) { current = create(value); return current; }
TxResource *tx_borrow(int value) { return tx_create(value); }
TxResource *tx_pair(int bad, int distinct, TxResource **other, const char **message, size_t *length) {
    TxResource *value = create(17);
    *other = distinct ? create(19) : value;
    *message = "x";
    *length = bad ? (size_t)-1 : 1;
    return value;
}
TxResource *tx_existing(int bad, TxResource **other, const char **message, size_t *length) {
    *other = current;
    *message = "x";
    *length = bad ? (size_t)-1 : 1;
    return current;
}
TxResource *tx_borrowed_result(int bad, TxResource **owned, const char **message, size_t *length) {
    current = create(23);
    return tx_existing(bad, owned, message, length);
}
TxResource *tx_arm(void (*callback)(void), TxResource **other) {
    *other = create(43);
    callback();
    return current;
}
void tx_destroy(TxResource *value) {
    if (current == value) current = NULL;
    destroyed++;
    if (value != &recycled) free(value);
}
void tx_clear(void) { if (current != NULL) tx_destroy(current); }
int tx_read(TxResource *value) { read_entries++; return value->value; }
int tx_destroyed(void) { return destroyed; }

TxBase *tx_base(int value) { return (TxBase *) tx_borrow(value); }
int tx_base_read(TxBase *value) { return ((TxResource *) value)->value; }
void tx_invalid(TxManaged *state, TxResource **out) {
    state->length = (size_t)-1;
    *out = create(47);
}

static void (*watch)(int);
static int release_bad;
static TxResource *registered;
void tx_watch(void (*callback)(int)) { watch = callback; }
TxResource *tx_peek(void) { return current; }
TxResource *tx_acquire(void) { return current; }
TxResource *tx_reentry(int bad, char **text, const char **message, size_t *length) {
    *text = malloc(2);
    if (*text == NULL) abort();
    (*text)[0] = 'x'; (*text)[1] = 0;
    *message = "x";
    *length = 1; release_bad = bad;
    return tx_create(61);
}
void tx_text_free(void *text) { int bad = release_bad; if (watch != NULL) watch(bad); free(text); }
void tx_register(TxResource *(*callback)(void)) { registered = callback == NULL ? NULL : callback(); }
int tx_registered_value(void) { return registered == NULL ? -1 : registered->value; }

int tx_read_entries(void) { return read_entries; }
void tx_input(TxResource *value, void (*callback)(void *), void *data, void (*release)(void *)) {
    (void) value; (void) callback;
    input_entries++;
    release(data);
}
int tx_input_entries(void) { return input_entries; }

char *tx_reentry_before(int bad, TxResource **out, const char **message, size_t *length) {
    char *text;
    *out = tx_reentry(bad, &text, message, length);
    return text;
}
TxResource *tx_reentry_existing(int bad, char **text, const char **message, size_t *length) {
    *text = malloc(2);
    if (*text == NULL) abort();
    (*text)[0] = 'x'; (*text)[1] = 0;
    *message = "x";
    *length = 1; release_bad = bad;
    return current;
}
TxResource *tx_recycled(void) { recycled.value = 67; current = &recycled; return current; }
TxResource *tx_reentry_recycled(int bad, char **text, const char **message, size_t *length) {
    tx_recycled();
    return tx_reentry_existing(bad, text, message, length);
}

TxParent *tx_parent_new(void) {
    TxParent *parent = calloc(1, sizeof(*parent));
    if (parent == NULL) abort();
    return parent;
}
void tx_parent_bind(TxParent *parent) { parent->child = current; parent->library = current; }
void tx_parent_destroy(TxParent *parent) { free(parent); }

TxSpecial *tx_special_existing(int bad, char **text, const char **message, size_t *length) {
    return (TxSpecial *) tx_reentry_existing(bad, text, message, length);
}
TxSpecial *tx_special_peek(void) { return (TxSpecial *) current; }
void tx_special_destroy(TxSpecial *value) { tx_destroy((TxResource *) value); }
int tx_special_read(TxSpecial *value) { return ((TxResource *) value)->value; }

static TxRecord record_new(void) {
    TxResource *first = tx_create(71);
    return (TxRecord) {{first, first, NULL}, create(73), 3};
}
TxFields tx_fields(void) {
    TxResource *value = tx_create(79);
    return (TxFields) {value, value, NULL};
}
TxRecord tx_record(int bad, const char **message, size_t *length) {
    *message = "x"; *length = bad ? (size_t)-1 : 1;
    return record_new();
}
TxRecord tx_record_existing(int bad, TxResource **other, const char **message, size_t *length) {
    *message = "x"; *length = bad ? (size_t)-1 : 1; *other = current;
    return (TxRecord) {{current, current, NULL}, create(83), 5};
}
TxRecord tx_record_release(int bad, char **text, const char **message, size_t *length) {
    *text = malloc(2);
    if (*text == NULL) abort();
    (*text)[0] = 'x'; (*text)[1] = 0;
    *message = "x"; *length = 1; release_bad = bad;
    return record_new();
}
int tx_record_sum(TxRecord value) { return value.nested.first->value + value.third->value + value.marker; }
int tx_record_visit(int (*callback)(TxRecord, void *), void *data) {
    TxRecord value = record_new();
    int result = callback(value, data);
    tx_destroy(value.nested.first); tx_destroy(value.third);
    return result;
}
static _Atomic int record_started;
TxRecord tx_record_wait(void) {
    TxRecord value = record_new();
    atomic_store(&record_started, 1);
    usleep(150000);
    return value;
}
int tx_record_started(void) { return atomic_load(&record_started); }
TxFreshFields tx_fields_fresh(void) {
    recycled.value = 101;
    return (TxFreshFields) {&recycled, &recycled};
}
