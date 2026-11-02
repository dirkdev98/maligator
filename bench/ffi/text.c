#include "text.h"
#include <string.h>

int ffi_bench_string_compare(const char *left, const char *right) {
    return strcmp(left, right);
}
