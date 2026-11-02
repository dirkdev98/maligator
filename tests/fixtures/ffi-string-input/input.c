#include "input.h"
#include <string.h>

unsigned int input_length(const char *text) { return (unsigned int) strlen(text); }
unsigned int input_count(const char *text, size_t length) {
    unsigned int sum = 0;
    for (size_t i = 0; i < length; i++) sum += (unsigned char) text[i];
    return sum;
}
unsigned int input_after(const char *text, InputPoint point) {
    return input_length(text) + (unsigned int) point.offset;
}
unsigned int input_mutate(char *text) {
    unsigned int length = input_length(text);
    if (length != 0) { text[0] = 'z'; text[length - 1] = 'z'; }
    return length;
}
const char *input_alias(const char *text) { return text; }
unsigned int input_callback(const char *text, void (*callback)(void *), void *data) {
    callback(data);
    return input_length(text);
}
