#define _POSIX_C_SOURCE 200809L
#include "sqlite.h"
#include "crypto.h"
#include "text.h"
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
    uint64_t warm = 16777216 / (size ? size : 1);
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
    } else if (strcmp(mode, "libc-strcmp") == 0) {
        if (strcmp(pattern, "early") != 0 && strcmp(pattern, "equal") != 0 && strcmp(pattern, "late") != 0) return 21;
        char *left = malloc(size + 1), *right = malloc(size + 1);
        if (!left || !right) return 22;
        memset(left, 'x', size); memset(right, 'x', size);
        left[size] = right[size] = 0;
        if (size != 0 && strcmp(pattern, "early") == 0) right[0] = 'y';
        if (size != 0 && strcmp(pattern, "late") == 0) right[size - 1] = 'y';
        for (int phase = 0; phase < 2; phase++) {
            checksum = 0;
            uint64_t count = phase == 0 ? warm : iterations;
            double start = now_ms();
            for (uint64_t i = 0; i < count; i++) checksum += ffi_bench_string_compare(left, right) < 0 ? 1U : 0U;
            elapsed = now_ms() - start;
        }
        free(left); free(right);
        if (checksum != (strcmp(pattern, "equal") == 0 || size == 0 ? 0 : iterations)) return 23;
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
