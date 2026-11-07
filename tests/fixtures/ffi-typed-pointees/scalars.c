#include "scalars.h"

int scalar_step(DataType type, void *value) {
	if (type == DATA_DOUBLE) *(double *) value += 0.5;
	else *(int *) value += 1;
	return (int) type;
}

int scalar_clamp(DataType type, void *value, const void *minimum, const void *maximum) {
	if (type == DATA_DOUBLE) {
		double *current = value;
		double low = *(const double *) minimum, high = *(const double *) maximum;
		if (*current < low) *current = low;
		if (*current > high) *current = high;
	} else {
		int *current = value;
		int low = *(const int *) minimum, high = *(const int *) maximum;
		if (*current < low) *current = low;
		if (*current > high) *current = high;
	}
	return (int) type;
}
