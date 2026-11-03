#include "resource.h"
#include <stdlib.h>
struct TxResource { int value; };
static TxResource *current;
static int destroyed;
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
    free(value);
}
void tx_clear(void) { if (current != NULL) tx_destroy(current); }
int tx_read(TxResource *value) { return value->value; }
int tx_destroyed(void) { return destroyed; }

TxBase *tx_base(int value) { return (TxBase *) tx_borrow(value); }
int tx_base_read(TxBase *value) { return ((TxResource *) value)->value; }
void tx_invalid(TxManaged *state, TxResource **out) {
    state->length = (size_t)-1;
    *out = create(47);
}
