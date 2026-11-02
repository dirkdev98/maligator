#include "views.h"
#include <stdlib.h>

static ViewDerived *pending;
static int base_closes;
static int derived_closes;
static int scale_value(ViewBase *value, int factor) { return value->value * factor; }
static int invoke_value(ViewBase *value, int (*callback)(int)) { return callback(value->value); }

ViewDerived *views_open(int value) {
    ViewDerived *result = malloc(sizeof(*result));
    if (result != NULL) {
        result->middle.base = (ViewBase) {value, views_read};
        result->scale = scale_value;
        result->invoke = invoke_value;
        result->read = views_read;
    }
    return result;
}
ViewBase *views_open_base(int value) { return (ViewBase *) views_open(value); }
ViewBase *views_pending(int value) {
    pending = views_open(value);
    return (ViewBase *) pending;
}
ViewDerived *views_take_pending(void) {
    ViewDerived *result = pending;
    pending = NULL;
    return result;
}
ViewBase *views_base(ViewDerived *value) { return (ViewBase *) value; }
ViewSibling *views_sibling(ViewDerived *value) { return (ViewSibling *) value; }
ViewBase *views_caller_base(ViewCaller *value) { return &value->base; }
void views_caller_init(ViewCaller *value) { value->base.read = views_read; }
ViewUnrelated *views_unrelated(void) {
    static ViewUnrelated value = {37};
    return &value;
}
ViewCopied views_copy(void) { return (ViewCopied) {41}; }
int views_read(ViewBase *value) { return value->value; }
int views_read_middle(ViewMiddle *value) { return value->base.value; }
int views_read_derived(ViewDerived *value) { return value->middle.base.value; }
int views_read_sibling(ViewSibling *value) { return views_read((ViewBase *) value); }
void views_set(ViewBase *value, int number) { value->value = number; }
void views_close_base(ViewBase *value) { base_closes++; free(value); }
void views_close_derived(ViewDerived *value) { derived_closes++; free(value); }
int views_base_closes(void) { return base_closes; }
int views_derived_closes(void) { return derived_closes; }
void views_visit(ViewDerived *value, void (*callback)(ViewBase *, void *), void *data) {
    callback((ViewBase *) value, data);
}
void views_lend(void (*callback)(ViewBase *, void *), void *data) {
    static ViewDerived value = {.middle.base = {29, views_read}, .scale = scale_value, .invoke = invoke_value, .read = views_read};
    callback((ViewBase *) &value, data);
}
void views_nested(ViewBase *value, void (*callback)(ViewMiddle *, void *), void *data) {
    callback((ViewMiddle *) value, data);
}
