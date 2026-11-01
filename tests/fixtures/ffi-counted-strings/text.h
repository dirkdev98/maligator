#ifndef COUNTED_TEXT_H
#define COUNTED_TEXT_H
#include <stddef.h>
int text_length(const char *text, size_t length);
int text_nullable(const char *text, size_t length);
int text_legacy(const char *text);
int text_many(const char *const *texts, size_t count);
int text_narrow(const char *text, unsigned char length);
int text_plain(const char *text, char length);
int text_plain_max(void);
char *text_copy(const char *text, size_t length, int *written);
const char *text_view(const char *text, size_t length);
const char *text_invalid(int *length);
char *text_bad_count(int mode, int *length);
char *text_callback(void (*callback)(void *), void *data, int *length);
void text_counted_callback(void (*callback)(const char *, int, void *), void *data, int mode);
void text_out(char **text, int *length);
void text_free(void *text);
int text_live(void);
int text_calls(void);
#endif
