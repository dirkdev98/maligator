#include "reentry.h"
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

struct ReentryResource { int value; };
static void (*listener)(int);
static int live;
static int destroys;

unsigned int reentry_text(const char *text) { return (unsigned int) strlen(text); }
unsigned int reentry_mutate(char *text) {
    unsigned int length = reentry_text(text);
    if (length != 0) text[0] = 'x';
    return length;
}
unsigned int reentry_after(const char *text, ReentryOffset value) {
    return reentry_text(text) + (unsigned int) value.offset;
}
void reentry_listen(void (*callback)(int)) { listener = callback; }
int reentry_emit(int value) { if (listener != NULL) listener(value); return value; }
char *reentry_owned_text(void) {
    char *text = malloc(6);
    if (text != NULL) memcpy(text, "cedar", 6);
    return text;
}
void reentry_release(void *text) { if (listener != NULL) listener(7); free(text); }
ReentryResource *reentry_open(void) {
    ReentryResource *resource = malloc(sizeof(*resource));
    if (resource != NULL) { resource->value = 11; live++; }
    return resource;
}
void reentry_destroy(ReentryResource *resource) {
    free(resource);
    live--;
    destroys++;
    if (listener != NULL) listener(9);
}
void reentry_bad_result(ReentryResource **resource, const char **text, size_t *length) {
    *resource = reentry_open();
    *text = "x";
    *length = (size_t) -1;
}
int reentry_live(void) { return live; }
int reentry_destroys(void) { return destroys; }
int reentry_variadic(const char *format, ...) {
    (void) format;
    va_list args;
    va_start(args, format);
    int value = va_arg(args, int);
    va_end(args);
    return value;
}
ReentryCallable reentry_callable(void) { return reentry_emit; }
