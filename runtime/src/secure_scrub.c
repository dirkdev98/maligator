#include "secure_scrub.h"

#include <string.h>

// Calling memset through a volatile pointer keeps the optimizer from proving the
// stores dead, while still clearing a buffer at memset speed rather than a byte at a time.
static void *(*const volatile mal_secure_memset)(void *, int, size_t) = memset;

void mal_secure_scrub(void *bytes, usize length) {
    if (bytes == nullptr) return;
    mal_secure_memset(bytes, 0, length);
}
