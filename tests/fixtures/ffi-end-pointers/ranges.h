#ifndef RANGES_H
#define RANGES_H

const char *wrap_position(const char *text, const char *text_end, int width);
int text_bytes(const char *text, const char *text_end);
int nullable_bytes(const char *text, const char *text_end);

#endif
