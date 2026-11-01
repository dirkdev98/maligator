#ifndef VIEWS_H
#define VIEWS_H

typedef struct ViewBase { int value; } ViewBase;
typedef ViewBase ViewBaseAlias;
typedef struct ViewMiddle { ViewBase base; } ViewMiddle;
typedef struct ViewDerived { ViewMiddle middle; } ViewDerived;
typedef struct ViewSibling { ViewBase base; } ViewSibling;
typedef struct ViewCaller { ViewBase base; } ViewCaller;
typedef struct ViewUnrelated { int value; } ViewUnrelated;
typedef struct ViewCopied { int value; } ViewCopied;

ViewDerived *views_open(int value);
ViewBase *views_open_base(int value);
ViewBase *views_pending(int value);
ViewDerived *views_take_pending(void);
ViewBase *views_base(ViewDerived *value);
ViewSibling *views_sibling(ViewDerived *value);
ViewBase *views_caller_base(ViewCaller *value);
ViewUnrelated *views_unrelated(void);
ViewCopied views_copy(void);
int views_read(ViewBase *value);
int views_read_middle(ViewMiddle *value);
int views_read_derived(ViewDerived *value);
int views_read_sibling(ViewSibling *value);
void views_set(ViewBase *value, int number);
void views_close_base(ViewBase *value);
void views_close_derived(ViewDerived *value);
int views_base_closes(void);
int views_derived_closes(void);
void views_visit(ViewDerived *value, void (*callback)(ViewBase *, void *), void *data);
void views_lend(void (*callback)(ViewBase *, void *), void *data);
void views_nested(ViewBase *value, void (*callback)(ViewMiddle *, void *), void *data);

#endif
