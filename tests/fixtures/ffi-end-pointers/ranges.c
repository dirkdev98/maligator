#include "ranges.h"

#include <stddef.h>

const char *wrap_position(const char *text, const char *text_end, int width) {
	if (text_end - text <= width) return text_end;
	return text + width;
}

int text_bytes(const char *text, const char *text_end) {
	return (int) (text_end - text);
}

int nullable_bytes(const char *text, const char *text_end) {
	if (text == NULL) return text_end == NULL ? -1 : -2;
	return (int) (text_end - text);
}
