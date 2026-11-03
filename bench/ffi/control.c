#define _POSIX_C_SOURCE 200809L
#include "sqlite.h"
#include "crypto.h"
#include "blas.h"
#include <zstd.h>
#include <openssl/evp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1000000.0;
}

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    const char *mode = argv[1], *pattern = argv[4];
    int rows = strcmp(mode, "sqlite-row") == 0;
    int compress = strcmp(mode, "zstd-compress") == 0;
    int repeat = strcmp(pattern, "repeat") == 0;
    size_t size = (size_t)strtoull(argv[2], NULL, 10);
    uint64_t iterations = strtoull(argv[3], NULL, 10);
    const char *identity = ffi_bench_library_identity();
    if (!identity || !iterations || size > 1048576) return 3;
    unsigned char *backing = calloc(size + 17, 1);
    if (!backing) return 4;
    uint32_t seed = 0x12345678;
    for (size_t i = 0; i < size + 17; i++) {
        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
        backing[i] = repeat ? (i & 7) : (seed & 255);
    }
    unsigned char *data = backing + 17;
    int blas = strcmp(mode, "blas-dot") == 0 || strcmp(mode, "blas-axpy") == 0;
    int stride = strcmp(pattern, "stride-1") == 0 ? 1 : strcmp(pattern, "stride-2") == 0 ? 2 : 0;
    size_t work_bytes = blas ? size * (size_t)stride * sizeof(double) * 2 : size;
    uint64_t warm = 16777216 / (work_bytes ? work_bytes : 1);
    if (warm < 1) warm = 1;
    if (warm > 10000) warm = 10000;
    if (warm > iterations) warm = iterations;
    uint32_t checksum = 0;
    char digest[65] = "";
    double elapsed = 0;
    if (strcmp(mode, "sqlite-bind") == 0 || strcmp(mode, "sqlite-row") == 0) {
        FfiBenchDb *db = ffi_bench_sql_open();
        if (!db) return 5;
        FfiBenchStatement *s = ffi_bench_sql_prepare(db, "SELECT ?1 + 17");
        if (!s) return 6;
        for (int phase = 0; phase < 2; phase++) {
            checksum = 0;
            uint64_t count = phase == 0 ? warm : iterations;
            double start = now_ms();
            for (uint64_t i = 0; i < count; i++) {
                if (ffi_bench_sql_bind(s, (int)(i & 1023)) != 0) return 7;
                if (rows) {
                    if (ffi_bench_sql_step(s) != 100) return 8;
                    checksum += (uint32_t)ffi_bench_sql_column(s);
                    if (ffi_bench_sql_reset(s) != 0) return 9;
                }
            }
            elapsed = now_ms() - start;
        }
        if (!rows) {
            if (ffi_bench_sql_step(s) != 100) return 19;
            checksum = (uint32_t)ffi_bench_sql_column(s);
            if (checksum != ((iterations - 1) & 1023) + 17) return 20;
        }
        if (ffi_bench_sql_finalize(s) != 0 || ffi_bench_sql_close(db) != 0) return 10;
    } else if (strcmp(mode, "sqlite-text") == 0) {
        const char *unit = strcmp(pattern, "ascii") == 0 ? "x"
            : strcmp(pattern, "latin1") == 0 ? "é"
            : strcmp(pattern, "bmp") == 0 ? "☃"
            : strcmp(pattern, "astral") == 0 ? "😀" : NULL;
        if (!unit) return 24;
        size_t width = strlen(unit), offset = 0;
        char *text = malloc(size + 1);
        if (!text) return 25;
        for (; offset + width <= size; offset += width) memcpy(text + offset, unit, width);
        memset(text + offset, 'x', size - offset); text[size] = 0;
        FfiBenchDb *db = ffi_bench_sql_open();
        if (!db) return 5;
        FfiBenchStatement *s = ffi_bench_sql_prepare(db, "SELECT ?1");
        if (!s) return 6;
        for (int phase = 0; phase < 2; phase++) {
            uint64_t count = phase == 0 ? warm : iterations;
            double start = now_ms();
            for (uint64_t i = 0; i < count; i++)
                if (ffi_bench_sql_bind_text(s, text) != 0) return 7;
            elapsed = now_ms() - start;
        }
        if (ffi_bench_sql_step(s) != 100) return 19;
        checksum = (uint32_t)ffi_bench_sql_column_bytes(s);
        unsigned int actual = ffi_bench_sql_text_hash(s), expected = 2166136261U;
        for (size_t i = 0; i < size; i++) expected = (expected ^ (unsigned char)text[i]) * 16777619U;
        if (checksum != size || actual != expected) return 26;
        snprintf(digest, sizeof(digest), "%x", actual);
        if (ffi_bench_sql_finalize(s) != 0 || ffi_bench_sql_close(db) != 0) return 10;
        free(text);
    } else if (blas) {
        if (!stride || !size) return 21;
        size_t elements = size * (size_t)stride, bytes = elements * sizeof(double);
        double *x_base = malloc((elements + 2) * sizeof(double));
        double *y_base = malloc((elements + 2) * sizeof(double));
        if (!x_base || !y_base) return 22;
        double *x = x_base + 1, *y = y_base + 1;
        x_base[0] = x_base[elements + 1] = y_base[0] = y_base[elements + 1] = 37;
        for (size_t i = 0; i < elements; i++) x[i] = i % stride == 0 ? (i / stride) % 13 + 1 : 17;
        const double alpha = 0x1p-20;
        double result = 0;
        int dot = strcmp(mode, "blas-dot") == 0;
        for (int phase = 0; phase < 2; phase++) {
            for (size_t i = 0; i < elements; i++) y[i] = i % stride == 0 ? (i / stride) % 7 + 1 : 29;
            uint64_t count = phase == 0 ? warm : iterations;
            double start = now_ms();
            if (dot) {
                for (uint64_t i = 0; i < count; i++) result = ffi_bench_blas_dot(x, bytes, y, bytes, stride);
            } else {
                for (uint64_t i = 0; i < count; i++) ffi_bench_blas_axpy(alpha, x, bytes, y, bytes, stride);
            }
            elapsed = now_ms() - start;
        }
        uint32_t hash = 2166136261U;
        double expected_dot = 0;
        for (size_t i = 0; i < elements; i++) {
            double expected_x = i % stride == 0 ? (i / stride) % 13 + 1 : 17;
            double initial_y = i % stride == 0 ? (i / stride) % 7 + 1 : 29;
            double expected_y = initial_y + (!dot && i % stride == 0 ? (double)iterations * alpha * expected_x : 0);
            if (x[i] != expected_x || y[i] != expected_y) return 23;
            if (i % stride == 0) expected_dot += expected_x * initial_y;
            hash = (hash ^ (uint32_t)(uint64_t)(y[i] * 0x1p20)) * 16777619U;
        }
        if (x_base[0] != 37 || x_base[elements + 1] != 37 || y_base[0] != 37 || y_base[elements + 1] != 37) return 23;
        if (dot && result != expected_dot) return 23;
        checksum = dot ? (uint32_t)result : hash;
        snprintf(digest, sizeof(digest), "%x", hash);
        free(x_base); free(y_base);
    } else if (strcmp(mode, "zstd-compress") == 0 || strcmp(mode, "zstd-decompress") == 0) {
        ZSTD_CCtx *encoder = ZSTD_createCCtx();
        ZSTD_DCtx *decoder = ZSTD_createDCtx();
        size_t capacity = ZSTD_compressBound(size);
        unsigned char *compressed_base = calloc(capacity + 13, 1);
        unsigned char *output_base = calloc(size + 13, 1);
        if (!encoder || !decoder || !compressed_base || !output_base) return 11;
        unsigned char *compressed = compressed_base + 13, *output = output_base + 13;
        size_t length = ZSTD_compressCCtx(encoder, compressed, capacity, data, size, 1);
        if (ZSTD_isError(length)) return 12;
        size_t result = 0;
        for (int phase = 0; phase < 2; phase++) {
            checksum = 0;
            uint64_t count = phase == 0 ? warm : iterations;
            double start = now_ms();
            for (uint64_t i = 0; i < count; i++) {
                result = compress
                    ? ZSTD_compressCCtx(encoder, compressed, capacity, data, size, 1)
                    : ZSTD_decompressDCtx(decoder, output, size, compressed, length);
                checksum += (uint32_t)result;
            }
            elapsed = now_ms() - start;
        }
        if (ZSTD_isError(result)) return 13;
        if (compress) {
            if (ZSTD_decompressDCtx(decoder, output, size, compressed, length) != size) return 14;
        } else if (result != size) return 14;
        if (memcmp(output, data, size) != 0) return 14;
        uint32_t hash = 2166136261U;
        for (size_t i = 0; i < length; i++) hash = (hash ^ compressed[i]) * 16777619U;
        snprintf(digest, sizeof(digest), "%x", hash);
        ZSTD_freeDCtx(decoder); ZSTD_freeCCtx(encoder);
        free(compressed_base); free(output_base);
    } else if (strcmp(mode, "crypto-update") == 0) {
        EVP_MD_CTX *context = EVP_MD_CTX_new();
        const EVP_MD *method = EVP_sha256();
        if (!context || !method) return 15;
        for (int phase = 0; phase < 2; phase++) {
            if (EVP_DigestInit_ex(context, method, NULL) != 1) return 16;
            checksum = 0;
            uint64_t count = phase == 0 ? warm : iterations;
            double start = now_ms();
            for (uint64_t i = 0; i < count; i++) checksum += EVP_DigestUpdate(context, data, size);
            elapsed = now_ms() - start;
        }
        unsigned char output[32];
        if (ffi_bench_crypto_final(context, output, sizeof(output)) != 32) return 17;
        for (size_t i = 0; i < sizeof(output); i++) snprintf(digest + i * 2, 3, "%02x", output[i]);
        EVP_MD_CTX_free(context);
    } else return 18;
    printf("{\"mode\":\"%s\",\"size\":%zu,\"iterations\":%llu,\"pattern\":\"%s\","
        "\"checksum\":%u,\"digest\":\"%s\",\"elapsedMs\":%.9f,\"identity\":\"",
        mode, size, (unsigned long long)iterations, pattern, checksum, digest, elapsed);
    for (const char *p = identity; *p; p++) {
        if (*p == '\n') fputs("\\n", stdout);
        else if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else putchar(*p);
    }
    puts("\"}");
    free(backing);
    return 0;
}
