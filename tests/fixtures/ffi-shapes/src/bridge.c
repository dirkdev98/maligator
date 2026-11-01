#include "bridge.h"
#include "shapes.h"

int bridge_checksum(const unsigned char *data, size_t size) {
	shapes_fail(1);
	return shapes_checksum(data, size);
}
