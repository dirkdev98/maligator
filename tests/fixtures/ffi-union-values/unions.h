#include <stddef.h>

typedef union Scalar {
    int integer;
    double real;
    unsigned long long wide;
    unsigned bits : 3;
    struct { int x; double y; } point;
    int items[3];
    const void *hidden;
} Scalar;
typedef struct ScalarBox { Scalar value; int label; } ScalarBox;

Scalar scalar_integer(Scalar value);
Scalar scalar_real(Scalar value);
Scalar scalar_wide(Scalar value);
Scalar scalar_bits(Scalar value);
Scalar scalar_point(Scalar value);
Scalar scalar_items(Scalar value);
ScalarBox scalar_box(ScalarBox value);
void scalar_update(Scalar *value);
void scalar_out(Scalar *value);
int scalar_many(const Scalar *values, size_t count);
double scalar_real_many(const Scalar *values, size_t count);
const Scalar *scalar_arrays(size_t *count);
void scalar_visit(Scalar value, Scalar (*visit)(Scalar));
int scalar_number(int value);

typedef struct Resource { int value; int *data; } Resource;
typedef union ResourcePayload { Resource resources[1]; int integer; } ResourcePayload;
typedef struct ResourceRecord { Resource resources[1]; } ResourceRecord;
int resource_read(Resource value);
void resources_visit(void (*visit)(ResourcePayload));
void resources_record_visit(void (*visit)(ResourceRecord));
void resources_keep(void (*visit)(ResourcePayload, void *), void *data, void (*release)(void *));
ResourcePayload resources_transform(ResourcePayload (*visit)(void));
ResourceRecord resources_record_transform(ResourceRecord (*visit)(void));
ResourcePayload resources_result(void);
ResourceRecord resources_record_result(void);
typedef struct ResourceParent { ResourcePayload payload; int version; } ResourceParent;
ResourceParent resource_parent_new(void);
typedef struct Closer Closer;
void resource_close(Closer *key, void (*done)(Closer *, ResourcePayload, void *), void *data);
