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
static _Atomic int special_destroyed;
void tx_special_destroy(TxSpecial *value) { special_destroyed++; tx_destroy((TxResource *) value); }
int tx_special_destroyed(void) { return special_destroyed; }
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
TxChoice tx_choice(int bad, int existing, TxResource **other, const char **message, size_t *length) {
    TxFields fields = existing ? (TxFields) {current, current, NULL} : tx_fields();
    *other = fields.first; *message = "x"; *length = bad ? (size_t)-1 : 1;
    return (TxChoice) {.fields = fields};
}
TxConstChoice tx_const_choice(void) { return (TxConstChoice) {.fields = tx_fields()}; }
TxChoice tx_choice_release(int bad, char **text, const char **message, size_t *length) {
    TxResource *value = tx_reentry(bad, text, message, length);
    return (TxChoice) {.fields = {value, value, NULL}};
}
int tx_choice_sum(TxChoice value) { return value.fields.first->value + value.fields.second->value; }
int tx_const_choice_sum(TxConstChoice value) { return value.fields.first->value + value.fields.second->value; }
int tx_choice_visit(int (*callback)(TxChoice, void *), void *data) {
    TxChoice value = {.fields = tx_fields()};
    int result = callback(value, data);
    tx_destroy(value.fields.first);
    return result;
}
static _Atomic int choice_started;
TxChoice tx_choice_wait(void) {
    TxChoice value = {.fields = tx_fields()};
    atomic_store(&choice_started, 1);
    usleep(150000);
    return value;
}
int tx_choice_started(void) { return atomic_load(&choice_started); }
TxFreshChoice tx_choice_fresh(void) { return (TxFreshChoice) {.fields = tx_fields_fresh()}; }
TxChoiceBox tx_choice_box(void) { return (TxChoiceBox) {{.fields = tx_fields()}, 7}; }
void tx_choice_out(TxChoice *value) { *value = (TxChoice) {.fields = tx_fields()}; }
TxSpecial *tx_special_borrowed(int bad, const char **message, size_t *length) {
    *message = "x"; *length = bad ? (size_t)-1 : 1;
    return (TxSpecial *) current;
}
TxSpecial *tx_special_borrowed_pair(int bad, TxResource **owned, const char **message, size_t *length) {
    *owned = create(127);
    return tx_special_borrowed(bad, message, length);
}
TxBase *tx_base_special(int bad, TxSpecial **owned, const char **message, size_t *length) {
    TxBase *base = tx_base(131);
    *owned = tx_special_borrowed(bad, message, length);
    return base;
}
TxSpecial *tx_special_borrowed_release(int bad, int create, char **text, const char **message, size_t *length) {
    if (create) tx_base(137);
    return (TxSpecial *) tx_reentry_existing(bad, text, message, length);
}
TxBase *tx_base_peek(void) { return (TxBase *) current; }
TxBase *tx_base_echo(TxBase *value) { return value; }
void tx_base_visit(void (*callback)(TxBase *, void *), void *data) {
    TxResource *value = create(139);
    callback((TxBase *) value, data);
    tx_destroy(value);
}
char *tx_special_borrowed_out(int bad, TxSpecial **out, const char **message, size_t *length) {
    tx_base(149);
    char *text;
    *out = (TxSpecial *) tx_reentry_existing(bad, &text, message, length);
    if (bad == 2) *length = (size_t)-1;
    return text;
}
void tx_special_borrowed_inout(TxSpecial **value, int bad, const char **message, size_t *length) {
    if (*value != NULL && *value != (TxSpecial *) current) abort();
    *value = tx_special_borrowed(bad, message, length);
}
static TxResource *native_kept;
static void *native_data;
static void (*native_release)(void *);
void tx_native_keep(TxResource *(*callback)(void *), void *data, void (*release)(void *)) {
    if (native_release != NULL) abort();
    native_data = data;
    native_release = release;
    native_kept = callback(data);
}
int tx_native_value(void) { return native_kept == NULL ? -1 : native_kept->value; }
void tx_native_drop(void) {
    void (*release)(void *) = native_release;
    void *data = native_data;
    native_kept = NULL; native_data = NULL; native_release = NULL;
    if (release != NULL) release(data);
}
static _Atomic int native_started;
TxResource *tx_native_wait(TxResource **alias) {
    TxResource *value = current;
    *alias = value;
    atomic_store(&native_started, 1);
    usleep(150000);
    return value;
}
int tx_native_started(void) { return atomic_load(&native_started); }
struct TxPool { int generation; };
static TxPool pool;
static _Atomic int pool_busy, pool_pause, pool_released, pool_continue, pool_destroyed;
static void *pool_data;
static void (*pool_release)(void *);
static void (*pool_watch)(TxPool *);
TxPool *tx_pool_create(void) {
    if (atomic_exchange(&pool_busy, 1)) abort();
    pool.generation++;
    return &pool;
}
TxPool *tx_pool_peek(void) { return &pool; }
TxPool *tx_pool_reentry(char **text) {
    TxPool *value = tx_pool_create();
    *text = malloc(2);
    if (*text == NULL) abort();
    (*text)[0] = 'x'; (*text)[1] = 0; release_bad = 1;
    return value;
}
void tx_pool_destroy(TxPool *value) {
    if (value != &pool || !atomic_load(&pool_busy)) abort();
    pool_watch = NULL;
    atomic_fetch_add(&pool_destroyed, 1);
    atomic_store(&pool_busy, 0);
    if (atomic_exchange(&pool_pause, 0)) {
        atomic_store(&pool_released, 1);
        while (!atomic_load(&pool_continue)) usleep(1000);
    }
}
void tx_pool_keep(TxPool *(*callback)(void *), void *data, void (*release)(void *)) {
    if (pool_release != NULL || callback(data) != &pool) abort();
    pool_data = data; pool_release = release;
}
void tx_pool_drop(void) {
    void (*release)(void *) = pool_release;
    void *data = pool_data;
    pool_data = NULL; pool_release = NULL;
    if (release != NULL) release(data);
}
void tx_pool_pause(void) { atomic_store(&pool_continue, 0); atomic_store(&pool_released, 0); atomic_store(&pool_pause, 1); }
int tx_pool_released(void) { return atomic_load(&pool_released); }
void tx_pool_continue(void) { atomic_store(&pool_continue, 1); }
int tx_pool_destroyed(void) { return atomic_load(&pool_destroyed); }
int tx_pool_generation(TxPool *value) { return value->generation; }
void tx_pool_watch(TxPool *value, void (*callback)(TxPool *)) { if (value != &pool) abort(); pool_watch = callback; }
void tx_pool_signal(TxPool *value) { if (value != &pool) abort(); if (pool_watch != NULL) pool_watch(value); }
void tx_pool_clear(void) { tx_pool_destroy(&pool); }

static TxGrid grid_value(TxResource *first, TxResource *second) {
    TxGrid grid = {.tail = first};
    grid.rows[0][0] = (TxFields) {first, second, NULL};
    grid.rows[0][1] = (TxFields) {second, first, NULL};
    grid.rows[1][0] = (TxFields) {NULL, second, first};
    grid.rows[1][1] = (TxFields) {first, NULL, second};
    return grid;
}
TxGrid tx_grid(int bad, int existing, TxResource **alias, const char **message, size_t *length) {
    TxResource *first = existing ? current : tx_create(157);
    *alias = create(163);
    *message = "x"; *length = bad ? (size_t)-1 : 1;
    return grid_value(first, *alias);
}
TxChoiceGrid tx_choice_grid(void) {
    TxFields fields = tx_fields();
    return (TxChoiceGrid) {{{.fields = fields}, {.fields = fields}}};
}
void tx_grid_out(TxFields (*rows)[2]) {
    TxFields fields = tx_fields();
    (*rows)[0] = fields; (*rows)[1] = fields;
}
int tx_grid_sum(TxGrid grid) {
    return grid.rows[0][0].first->value + grid.rows[1][1].empty->value + grid.tail->value;
}
int tx_grid_visit(int (*callback)(TxGrid, void *), void *data) {
    TxResource *first = create(167), *second = create(173);
    int result = callback(grid_value(first, second), data);
    tx_destroy(first); tx_destroy(second);
    return result;
}
static _Atomic int grid_started;
TxGrid tx_grid_wait(void) {
    TxGrid grid = grid_value(create(179), create(181));
    atomic_fetch_add(&grid_started, 1);
    usleep(150000);
    return grid;
}
int tx_grid_started(void) { return atomic_load(&grid_started); }
TxPolicyGrid tx_policy_grid(int bad, const char **message, size_t *length) {
    TxResource *value = create(191);
    *message = "x"; *length = bad ? (size_t)-1 : 1;
    return (TxPolicyGrid) {{{NULL, (TxSpecial *) value}, {value, NULL}}};
}
TxBase *tx_fresh_grid(int bad, void (*close)(void), TxFreshGrid *grid, const char **message, size_t *length) {
    close();
    recycled.value = 193;
    *message = "x"; *length = bad ? (size_t)-1 : 1;
    *grid = (TxFreshGrid) {{{(TxSpecial *) &recycled, NULL}, {NULL, &recycled}}};
    return (TxBase *) &recycled;
}

TxGrid tx_grid_arm(void (*callback)(void)) {
    TxGrid grid = grid_value(create(197), create(199));
    callback();
    return grid;
}
TxPolicyGrid tx_policy_wait(void) {
    const char *message; size_t length;
    TxPolicyGrid grid = tx_policy_grid(0, &message, &length);
    atomic_fetch_add(&grid_started, 1);
    usleep(150000);
    return grid;
}
static TxResource *invalid_table[1];
TxResource **tx_policy_capacity(TxPolicyGrid *grid, size_t *length) {
    const char *message;
    *grid = tx_policy_grid(0, &message, length);
    *length = (size_t)-1;
    return invalid_table;
}
TxResource **tx_fresh_capacity(void (*close)(void), TxFreshGrid *grid, size_t *length) {
    const char *message;
    tx_fresh_grid(0, close, grid, &message, length);
    *length = (size_t)-1;
    return invalid_table;
}

static _Atomic int tables_freed, table_started;
static TxFields *table_value(TxResource *prior) {
    TxResource *first = prior == NULL ? create(223) : prior;
    TxResource *second = create(227);
    TxFields *rows = malloc(2 * sizeof(*rows));
    if (rows == NULL) abort();
    rows[0] = (TxFields) {first, second, NULL};
    rows[1] = (TxFields) {second, first, NULL};
    return rows;
}
TxFields *tx_table(int mode, TxResource *prior, size_t *length, const char **message, size_t *text_length) {
    *message = "x"; *text_length = mode == 1 ? (size_t)-1 : 1;
    release_bad = mode == 5;
    if (mode == 2) { *length = (size_t)-1; return NULL; }
    if (mode == 3 || mode == 4) {
        TxFields *rows = calloc(1, sizeof(*rows));
        if (rows == NULL) abort();
        *length = mode == 3 ? 0 : (size_t)-1;
        return rows;
    }
    *length = 2;
    return table_value(prior);
}
void tx_table_free(void *table) { tables_freed++; if (watch != NULL) watch(release_bad); free(table); }
int tx_tables_freed(void) { return atomic_load(&tables_freed); }
void tx_table_out(TxFields **rows, size_t *length) { *rows = table_value(NULL); *length = 2; release_bad = 0; }
TxChoice *tx_table_choice(size_t *length) {
    TxChoice *rows = malloc(2 * sizeof(*rows));
    if (rows == NULL) abort();
    TxFields fields = tx_fields();
    rows[0].fields = fields; rows[1].fields = fields;
    *length = 2; release_bad = 0;
    return rows;
}
TxFields (*tx_table_grid(size_t *length))[2] {
    *length = 1; release_bad = 0;
    return (TxFields (*)[2]) table_value(NULL);
}
const TxFields *tx_table_const(size_t *length) { *length = 2; release_bad = 0; return table_value(NULL); }
TxFields *tx_static_table(size_t *length) {
    static TxFields rows[2];
    TxResource *first = create(229), *second = create(233);
    rows[0] = (TxFields) {first, second, NULL};
    rows[1] = (TxFields) {second, first, NULL};
    *length = 2;
    return rows;
}
TxFields *tx_table_arm(void (*callback)(void), size_t *length) {
    TxFields *rows = table_value(NULL);
    *length = 2; release_bad = 0;
    callback();
    return rows;
}
TxFields *tx_table_wait(size_t *length) {
    TxFields *rows = table_value(NULL);
    *length = 2; release_bad = 0;
    atomic_store(&table_started, 1);
    usleep(150000);
    return rows;
}
int tx_table_started(void) { return atomic_load(&table_started); }
TxPolicyFields *tx_table_policy(size_t *length) {
    const char *message; size_t text_length;
    TxPolicyGrid value = tx_policy_grid(0, &message, &text_length);
    TxPolicyFields *rows = malloc(sizeof(value.rows));
    if (rows == NULL) abort();
    rows[0] = value.rows[0]; rows[1] = value.rows[1];
    *length = 2; release_bad = 0;
    return rows;
}
TxBase *tx_fresh_table(void (*close)(void), TxFreshRow **rows, size_t *length) {
    const char *message; size_t text_length;
    TxFreshGrid value;
    TxBase *base = tx_fresh_grid(0, close, &value, &message, &text_length);
    *rows = malloc(sizeof(value.rows));
    if (*rows == NULL) abort();
    (*rows)[0] = value.rows[0]; (*rows)[1] = value.rows[1];
    *length = 2; release_bad = 0;
    return base;
}

TxTagged tx_tagged(int kind, int bad, int existing, TxResource **alias, const char **message, size_t *length) {
    *message = "x"; *length = bad ? (size_t)-1 : 1;
    *alias = NULL;
    if (kind == 1 || kind == 2) {
        *alias = existing ? current : create(241);
        if (kind == 1) return (TxTagged) {kind, {.fields = {*alias, *alias, NULL}}};
        return (TxTagged) {kind, {.policy = {NULL, (TxSpecial *) *alias}}};
    }
    if (kind == 77) *alias = create(251);
    return (TxTagged) {kind, {.number = 1}};
}
static TxTaggedGrid tagged_grid_value(TxResource *first, TxResource *second) {
    return (TxTaggedGrid) {{{2, {.policy = {NULL, (TxSpecial *) first}}},
        {3, {.number = 1}}, {1, {.fields = {first, second, NULL}}}}};
}
TxTaggedGrid tx_tagged_grid(int bad, TxResource **alias, const char **message, size_t *length) {
    *alias = create(241);
    *message = "x"; *length = bad == 1 ? (size_t)-1 : 1;
    TxTaggedGrid value = tagged_grid_value(*alias, create(251));
    if (bad == 2) value.values[1].kind = 77;
    return value;
}
int tx_tagged_sum(TxTagged value) {
    if (value.kind == 1) return value.payload.fields.first->value + value.payload.fields.second->value;
    if (value.kind == 2) return ((TxResource *) value.payload.policy.second)->value;
    if (value.kind == 3) return value.payload.number;
    return 0;
}
int tx_tagged_grid_sum(TxTaggedGrid value) {
    return tx_tagged_sum(value.values[0]) + tx_tagged_sum(value.values[1]) + tx_tagged_sum(value.values[2]);
}
int tx_tagged_visit(int (*callback)(TxTaggedGrid, void *), void *data) {
    TxResource *first = create(241), *second = create(251);
    int result = callback(tagged_grid_value(first, second), data);
    tx_destroy(first); tx_destroy(second);
    return result;
}
void tx_tagged_out(TxTagged *value) { *value = (TxTagged) {1, {.fields = tx_fields()}}; }
TxTagged *tx_tagged_table(size_t *length) {
    TxTaggedGrid value = tagged_grid_value(create(241), create(251));
    TxTagged *rows = malloc(sizeof(value.values));
    if (rows == NULL) abort();
    for (size_t i = 0; i < 3; i++) rows[i] = value.values[i];
    *length = 3; release_bad = 0;
    return rows;
}
TxConstTagged tx_const_tagged(void) { return (TxConstTagged) {1, {.fields = tx_fields()}}; }
TxPromotedTagged tx_promoted_tagged(void) {
    return (TxPromotedTagged) {1, {.fields = {{create(257)}}}};
}
TxBase *tx_tagged_fresh(void (*close)(void), TxFreshTagged *value) {
    TxFreshGrid grid; const char *message; size_t length;
    TxBase *base = tx_fresh_grid(0, close, &grid, &message, &length);
    *value = (TxFreshTagged) {1, {.fields = {grid.rows[0].owned, grid.rows[1].fresh}}};
    return base;
}
TxBase *tx_inactive_fresh(void (*close)(void), TxFreshTagged *out) {
    TxResource *value = current;
    close();
    *out = (TxFreshTagged) {2, {.fields = {(TxSpecial *) value, value}}};
    return (TxBase *) value;
}
static _Atomic int tagged_started;
TxTaggedGrid tx_tagged_wait(void) {
    TxTaggedGrid value = tagged_grid_value(create(241), create(251));
    atomic_fetch_add(&tagged_started, 1);
    usleep(150000);
    return value;
}
TxConstTagged tx_const_tagged_wait(void) {
    const TxConstTagged value = tx_const_tagged();
    atomic_fetch_add(&tagged_started, 1);
    usleep(150000);
    return value;
}
int tx_tagged_started(void) { return atomic_load(&tagged_started); }
TxTaggedGrid tx_tagged_arm(void (*callback)(void)) {
    TxTaggedGrid value = tagged_grid_value(create(241), create(251));
    callback();
    return value;
}
