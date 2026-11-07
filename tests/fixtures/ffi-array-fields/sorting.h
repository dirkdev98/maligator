#ifndef SORTING_H
#define SORTING_H

typedef struct { int column; int direction; } SortSpec;
typedef struct {
	const SortSpec *specs;
	int count;
	const unsigned short *order;
	unsigned int order_count;
} SortSpecs;

const SortSpecs *sort_specs(void);
const SortSpecs *empty_specs(void);
void sort_specs_set_count(int count);

#endif
