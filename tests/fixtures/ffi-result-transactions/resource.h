#include <stddef.h>
typedef struct TxBase TxBase;
typedef struct TxResource TxResource;
typedef struct TxManaged { const unsigned char *data; size_t length; } TxManaged;
TxResource *tx_create(int value);
TxResource *tx_borrow(int value);
TxResource *tx_pair(int bad, int distinct, TxResource **other, const char **message, size_t *length);
TxResource *tx_existing(int bad, TxResource **other, const char **message, size_t *length);
TxResource *tx_borrowed_result(int bad, TxResource **owned, const char **message, size_t *length);
TxResource *tx_arm(void (*callback)(void), TxResource **other);
void tx_destroy(TxResource *value);
void tx_clear(void);
int tx_read(TxResource *value);
int tx_destroyed(void);
TxBase *tx_base(int value);
int tx_base_read(TxBase *value);
void tx_invalid(TxManaged *state, TxResource **out);

void tx_watch(void (*callback)(int));
TxResource *tx_peek(void);
TxResource *tx_acquire(void);
TxResource *tx_reentry(int bad, char **text, const char **message, size_t *length);
void tx_text_free(void *text);
void tx_register(TxResource *(*callback)(void));
int tx_registered_value(void);

int tx_read_entries(void);
void tx_input(TxResource *value, void (*callback)(void *), void *data, void (*release)(void *));
int tx_input_entries(void);

char *tx_reentry_before(int bad, TxResource **out, const char **message, size_t *length);
TxResource *tx_reentry_existing(int bad, char **text, const char **message, size_t *length);
TxResource *tx_recycled(void);
TxResource *tx_reentry_recycled(int bad, char **text, const char **message, size_t *length);

typedef struct TxParent { TxResource *child; TxResource *library; } TxParent;
TxParent *tx_parent_new(void);
void tx_parent_bind(TxParent *parent);
void tx_parent_destroy(TxParent *parent);

typedef struct TxSpecial TxSpecial;
TxSpecial *tx_special_existing(int bad, char **text, const char **message, size_t *length);
TxSpecial *tx_special_peek(void);
void tx_special_destroy(TxSpecial *value);
int tx_special_read(TxSpecial *value);

typedef struct TxFields { TxResource *first; TxResource *second; TxResource *empty; } TxFields;
typedef struct TxRecord { TxFields nested; TxResource *third; int marker; } TxRecord;
TxFields tx_fields(void);
TxRecord tx_record(int bad, const char **message, size_t *length);
TxRecord tx_record_existing(int bad, TxResource **other, const char **message, size_t *length);
TxRecord tx_record_release(int bad, char **text, const char **message, size_t *length);
int tx_record_sum(TxRecord value);
int tx_record_visit(int (*callback)(TxRecord, void *), void *data);
TxRecord tx_record_wait(void);
int tx_record_started(void);
typedef struct TxFreshFields { TxResource *first; TxResource *second; } TxFreshFields;
TxFreshFields tx_fields_fresh(void);
