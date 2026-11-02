#include <stddef.h>

typedef struct InputPoint { int offset; } InputPoint;
unsigned int input_length(const char *text);
unsigned int input_count(const char *text, size_t length);
unsigned int input_after(const char *text, InputPoint point);
unsigned int input_mutate(char *text);
const char *input_alias(const char *text);
unsigned int input_callback(const char *text, void (*callback)(void *), void *data);
