#include <stddef.h>

double ffi_bench_blas_dot(const void *x, size_t x_bytes,
    const void *y, size_t y_bytes, int stride);
double ffi_bench_blas_dot_values(const double *x, const double *y, int count);
void ffi_bench_blas_axpy(double alpha, const void *x, size_t x_bytes,
    void *y, size_t y_bytes, int stride);
