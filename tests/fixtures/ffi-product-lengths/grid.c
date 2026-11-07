#include "grid.h"

static int calls;

int fill_pixels(int width, int height, unsigned char *pixels) {
	calls++;
	int bytes = width * height * 4;
	for (int index = 0; index < bytes; index++) pixels[index] = (unsigned char) (index + 1);
	return bytes;
}

double sum_grid(const double *values, int rows, int cols) {
	calls++;
	double total = 0;
	for (int index = 0; index < rows * cols; index++) total += values[index];
	return total;
}

int grid_calls(void) {
	return calls;
}
