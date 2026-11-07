#include "sorting.h"

#include <stddef.h>

static const SortSpec specs[] = { { 2, 1 }, { 0, -1 }, { 5, 1 } };
static const unsigned short order[] = { 3, 1, 2, 0 };
static SortSpecs current = { specs, 2, order, 4, 0.75 };
static SortSpecs empty = { NULL, 0, NULL, 0, 0 };

const SortSpecs *sort_specs(void) {
	return &current;
}

const SortSpecs *empty_specs(void) {
	return &empty;
}

void sort_specs_set_count(int count) {
	current.count = count;
}
