#include "mal_zlib.h"

#include <assert.h>
#include <stdint.h>

int main(void) {
    assert(mal_zlib_abi_version() == MAL_ZLIB_ABI_VERSION);

    MalZlibStream *handle = (MalZlibStream *)(uintptr_t)1;
    assert(mal_zlib_create(UINT32_MAX, &handle) == MAL_ZLIB_STATUS_INVALID_ARGUMENT);
    assert(handle == NULL);
    assert(mal_zlib_create(MAL_ZLIB_FORMAT_ZLIB, &handle) == MAL_ZLIB_STATUS_NEED_INPUT);

    size_t consumed = 7;
    assert(mal_zlib_pump(handle, NULL, 0, NULL, 0, &consumed, NULL) ==
           MAL_ZLIB_STATUS_INVALID_ARGUMENT);
    assert(consumed == 0);

    size_t produced = 9;
    assert(mal_zlib_pump(handle, NULL, 0, NULL, 0, NULL, &produced) ==
           MAL_ZLIB_STATUS_INVALID_ARGUMENT);
    assert(produced == 0);

    uint8_t byte = 0;
    const size_t oversized = (size_t)PTRDIFF_MAX + 1u;
    consumed = 7;
    produced = 9;
    assert(mal_zlib_pump(handle, &byte, oversized, NULL, 0, &consumed, &produced) ==
           MAL_ZLIB_STATUS_INVALID_ARGUMENT);
    assert(consumed == 0);
    assert(produced == 0);

    mal_zlib_free(&handle);
    assert(handle == NULL);
    mal_zlib_free(&handle);
    return 0;
}
