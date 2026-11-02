#define _GNU_SOURCE
#include "sqlite.h"
#include "crypto.h"
#include <sqlite3.h>
#include <zstd.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

FfiBenchDb *ffi_bench_sql_open(void) {
    sqlite3 *db = NULL;
    if (sqlite3_open(":memory:", &db) != SQLITE_OK) {
        sqlite3_close_v2(db);
        return NULL;
    }
    return (FfiBenchDb *)db;
}

FfiBenchStatement *ffi_bench_sql_prepare(FfiBenchDb *db, const char *sql) {
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2((sqlite3 *)db, sql, -1, &statement, NULL) != SQLITE_OK)
        return NULL;
    return (FfiBenchStatement *)statement;
}

/* These exports isolate SQLite from the runtime's embedded copy. Each timed
 * export forwards exactly one call; the benchmark loop stays in its caller. */
int ffi_bench_sql_bind(FfiBenchStatement *s, int v) {
    return sqlite3_bind_int((sqlite3_stmt *)s, 1, v);
}
int ffi_bench_sql_step(FfiBenchStatement *s) {
    return sqlite3_step((sqlite3_stmt *)s);
}
int ffi_bench_sql_column(FfiBenchStatement *s) {
    return sqlite3_column_int((sqlite3_stmt *)s, 0);
}
int ffi_bench_sql_reset(FfiBenchStatement *s) {
    return sqlite3_reset((sqlite3_stmt *)s);
}
int ffi_bench_sql_finalize(FfiBenchStatement *s) {
    return sqlite3_finalize((sqlite3_stmt *)s);
}
int ffi_bench_sql_close(FfiBenchDb *db) {
    return sqlite3_close_v2((sqlite3 *)db);
}

/* EVP's finalizer omits capacity from its ABI. Check it before giving C a buffer. */
int ffi_bench_crypto_final(EVP_MD_CTX *context, unsigned char *output, unsigned int capacity) {
    int required = EVP_MD_CTX_get_size(context);
    unsigned int written = 0;
    if (required <= 0 || (unsigned int)required > capacity) return 0;
    return EVP_DigestFinal_ex(context, output, &written) == 1 ? (int)written : 0;
}

const char *ffi_bench_library_identity(void) {
    static char result[16384];
    const void *functions[] = {
        (void *)sqlite3_open, (void *)sqlite3_prepare_v2,
        (void *)sqlite3_bind_int, (void *)sqlite3_step,
        (void *)sqlite3_column_int, (void *)sqlite3_reset,
        (void *)sqlite3_finalize, (void *)sqlite3_close_v2,
        (void *)ZSTD_compressCCtx, (void *)ZSTD_decompressDCtx,
        (void *)EVP_DigestInit_ex, (void *)EVP_DigestUpdate,
        (void *)EVP_DigestFinal_ex, (void *)strcmp
    };
    size_t used = (size_t)snprintf(result, sizeof(result), "%s\n%s\n%s\n%s\n",
        sqlite3_libversion(), sqlite3_sourceid(), ZSTD_versionString(),
        OpenSSL_version(OPENSSL_VERSION));
    for (size_t i = 0; i < sizeof(functions) / sizeof(functions[0]); i++) {
        Dl_info info;
        if (dladdr(functions[i], &info) == 0 || info.dli_fname == NULL) return NULL;
        int count = snprintf(result + used, sizeof(result) - used, "%s\n", info.dli_fname);
        if (count < 0 || (size_t)count >= sizeof(result) - used) return NULL;
        used += (size_t)count;
    }
    return result;
}
