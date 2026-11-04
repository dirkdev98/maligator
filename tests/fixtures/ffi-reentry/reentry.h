#ifndef REENTRY_H
#define REENTRY_H
#include <stddef.h>

typedef struct ReentryOffset { int offset; } ReentryOffset;
typedef struct ReentryResource ReentryResource;
typedef int (*ReentryCallable)(int);
unsigned int reentry_text(const char *text);
unsigned int reentry_mutate(char *text);
unsigned int reentry_after(const char *text, ReentryOffset value);
void reentry_listen(void (*callback)(int));
int reentry_emit(int value);
char *reentry_owned_text(void);
void reentry_release(void *text);
ReentryResource *reentry_open(void);
void reentry_destroy(ReentryResource *resource);
void reentry_bad_result(ReentryResource **resource, const char **text, size_t *length);
int reentry_live(void);
int reentry_destroys(void);
int reentry_variadic(const char *format, ...);
ReentryCallable reentry_callable(void);
#endif
