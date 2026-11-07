#ifndef SCALARS_H
#define SCALARS_H

typedef enum { DATA_INT = 0, DATA_DOUBLE = 1 } DataType;

int scalar_step(DataType type, void *value);
int scalar_clamp(DataType type, void *value, const void *minimum, const void *maximum);

#endif
