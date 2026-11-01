#include "text.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

static _Atomic int live;
static _Atomic int calls;
int text_length(const char *text, size_t length) { (void)text; calls++; return (int)length; }
int text_nullable(const char *text, size_t length) { calls++; return text == NULL ? 1 : length == 0 ? 2 : 0; }
int text_legacy(const char *text) { calls++; return text == NULL ? -1 : (int)strlen(text); }
int text_many(const char *const *texts, size_t count) { int total = 0; for (size_t i = 0; i < count; i++) total += (int)strlen(texts[i]); return total; }
int text_narrow(const char *text, unsigned char length) { (void)text; calls++; return length; }
int text_plain(const char *text, char length) { (void)text; calls++; return length; }
int text_plain_max(void) { return CHAR_MAX; }
char *text_copy(const char *text, size_t length, int *written) {
    calls++;
    *written = (int)length;
    if (text == NULL) return NULL;
    char *copy = malloc(length == 0 ? 1 : length);
    if (copy != NULL) { if (length != 0) memcpy(copy, text, length); live++; }
    return copy;
}
const char *text_view(const char *text, size_t length) { (void)length; calls++; return text; }
const char *text_invalid(int *length) {
    static const char text[] = { 'f', (char)0x80, 0, (char)0xc3, (char)0xa9 };
    *length = sizeof(text); calls++; return text;
}
char *text_bad_count(int mode, int *length) {
    calls++;
    *length = mode == 0 ? -1 : INT_MAX;
    char *text = malloc(1);
    if (text != NULL) { text[0] = 'x'; live++; }
    return text;
}
char *text_callback(void (*callback)(void *), void *data, int *length) {
    char *text = text_copy("x", 1, length);
    callback(data);
    return text;
}
void text_counted_callback(void (*callback)(const char *, int, void *), void *data, int mode) {
    char text[] = { 'a', 0, (char)0xc3, (char)0xa9 };
    callback(mode == 1 ? NULL : text, mode == 2 ? -1 : mode == 3 ? INT_MAX : (int)sizeof(text), data);
    memset(text, 'x', sizeof(text));
}
void text_out(char **text, int *length) {
    static const char source[] = {'a', 0, (char)0xc3, (char)0xa9};
    *text = text_copy(source, sizeof(source), length);
}
void text_out_bad(char **text, int *length, int mode) { *text = text_bad_count(mode, length); }
void text_out_callback(void (*callback)(void *), void *data, char **text, int *length) {
    text_out(text, length);
    callback(data);
}
void text_advance(char **text, int *length, int skip) {
    calls++;
    if (skip < 0) { *length = -1; return; }
    if (skip > *length) abort();
    if (*text != NULL) *text += skip;
    *length -= skip;
}
void text_inout_copy(char **text, int *length) { *text = text_copy(*text, (size_t)*length, length); }
void text_advance_first(int *length, char **text, int skip) { text_advance(text, length, skip); }
void text_inout_fixed(char **text, unsigned char length) {
    calls++;
    if (*text != NULL && length != 0) (*text)[0] = 'z';
}
void text_free(void *text) { if (text != NULL) { free(text); live--; } }
int text_live(void) { return live; }
int text_calls(void) { return calls; }
