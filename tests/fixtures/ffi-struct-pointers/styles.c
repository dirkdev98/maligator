#include "styles.h"

#include <stdlib.h>

static int destroyed;
static Style shared = { 2.0f, 1 };

Style *style_new(void) {
	Style *style = malloc(sizeof(*style));
	style->weight = 1.5f;
	style->flags = 0;
	return style;
}

void style_destroy(Style *style) {
	destroyed++;
	free(style);
}

float style_weight(Style style) {
	return style.weight;
}

void style_set_flags(Style *style, int flags) {
	style->flags = flags;
}

Style *style_shared(void) {
	return &shared;
}

int style_destroyed(void) {
	return destroyed;
}
