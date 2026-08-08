#include "secure_scrub.h"

void mal_secure_scrub(void *bytes, usize length) {
    if (bytes == nullptr) return;
    volatile byte *cursor = (volatile byte *) bytes;
    for (usize i = 0; i < length; i++) {
        cursor[i] = 0;
    }
}
