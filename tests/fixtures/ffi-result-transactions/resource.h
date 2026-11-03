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
