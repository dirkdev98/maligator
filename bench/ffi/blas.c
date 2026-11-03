#include "blas.h"
#include <cblas.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>

/* Byte spans let both JS callers lend typed-array storage without copying numeric
 * elements. Every lane uses this adapter, including its bounds and alignment checks. */
static blasint vector_length(const void *x, size_t x_bytes,
    const void *y, size_t y_bytes, int stride) {
    if (!x || !y || stride < 1 || x_bytes != y_bytes
        || (uintptr_t)x % _Alignof(double) || (uintptr_t)y % _Alignof(double)) abort();
    size_t width = sizeof(double) * (size_t)stride;
    if (x_bytes % width || x_bytes / width > INT_MAX) abort();
    return (blasint)(x_bytes / width);
}

double ffi_bench_blas_dot(const void *x, size_t x_bytes,
    const void *y, size_t y_bytes, int stride) {
    blasint n = vector_length(x, x_bytes, y, y_bytes, stride);
    return cblas_ddot(n, x, stride, y, stride);
}

double ffi_bench_blas_dot_values(const double *x, const double *y, int count) {
    if (count < 0 || !x || !y
        || (uintptr_t)x % _Alignof(double) || (uintptr_t)y % _Alignof(double)) abort();
    return cblas_ddot(count, x, 1, y, 1);
}

void ffi_bench_blas_axpy(double alpha, const void *x, size_t x_bytes,
    void *y, size_t y_bytes, int stride) {
    blasint n = vector_length(x, x_bytes, y, y_bytes, stride);
    cblas_daxpy(n, alpha, x, stride, y, stride);
}
