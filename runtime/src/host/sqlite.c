#include "sqlite.h"
#include "profile.h"

#include <limits.h>
#include <stdlib.h>
#if MAL_PROFILE
#include <pthread.h>
#endif

#include "sqlite3.h"

struct MalSqliteDatabase {
    sqlite3 *handle;
    usize references;
    bool open;
};

struct MalSqliteStatement {
    sqlite3_stmt *handle;
    MalSqliteDatabase *database;
};

#if MAL_PROFILE
static bool mal_sqlite_profile_block_sigprof(sigset_t *previous) {
    // SQLite may create sorter threads during exec or step; they must inherit blocked SIGPROF.
    sigset_t blocked;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGPROF);
    return pthread_sigmask(SIG_BLOCK, &blocked, previous) == 0;
}
#endif

static void mal_sqlite_database_retain(MalSqliteDatabase *database) {
    database->references++;
}

i32 mal_sqlite_database_open(
    const char *path, const MalSqliteOpenOptions *options,
    MalSqliteDatabase **database) {
    *database = nullptr;
    MalSqliteDatabase *result = calloc(1, sizeof(MalSqliteDatabase));
    if (result == nullptr) return SQLITE_NOMEM;
    result->references = 1;
    i32 flags = options->read_only
        ? SQLITE_OPEN_READONLY
        : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    i32 status = sqlite3_open_v2(path, &result->handle, flags, nullptr);
    *database = result;
    if (status != SQLITE_OK) return status;
    result->open = true;
    sqlite3_extended_result_codes(result->handle, 1);

    status = sqlite3_busy_timeout(result->handle, options->timeout_ms);
    if (status == SQLITE_OK) {
        status = sqlite3_db_config(
            result->handle, SQLITE_DBCONFIG_ENABLE_FKEY,
            options->foreign_keys ? 1 : 0, nullptr);
    }
    if (status == SQLITE_OK) {
        status = sqlite3_db_config(
            result->handle, SQLITE_DBCONFIG_DQS_DML,
            options->double_quoted_strings ? 1 : 0, nullptr);
    }
    if (status == SQLITE_OK) {
        status = sqlite3_db_config(
            result->handle, SQLITE_DBCONFIG_DQS_DDL,
            options->double_quoted_strings ? 1 : 0, nullptr);
    }
    if (status == SQLITE_OK) {
        status = sqlite3_db_config(
            result->handle, SQLITE_DBCONFIG_DEFENSIVE,
            options->defensive ? 1 : 0, nullptr);
    }
    return status;
}

void mal_sqlite_database_release(MalSqliteDatabase *database) {
    if (database == nullptr) return;
    if (--database->references != 0) return;
    if (database->open) {
        sqlite3_close_v2(database->handle);
        database->open = false;
    }
    free(database);
}

i32 mal_sqlite_database_close(MalSqliteDatabase *database) {
    if (database == nullptr || !database->open) return SQLITE_MISUSE;
    i32 status = sqlite3_close_v2(database->handle);
    if (status == SQLITE_OK) database->open = false;
    return status;
}

bool mal_sqlite_database_is_open(const MalSqliteDatabase *database) {
    return database != nullptr && database->open;
}

bool mal_sqlite_database_is_transaction(const MalSqliteDatabase *database) {
    return database != nullptr && database->open
        && sqlite3_get_autocommit(database->handle) == 0;
}

const char *mal_sqlite_database_error(const MalSqliteDatabase *database) {
    if (database == nullptr) return "SQLite database allocation failed";
    if (database->handle == nullptr) return "SQLite database is not open";
    return sqlite3_errmsg(database->handle);
}

i32 mal_sqlite_database_exec(MalSqliteDatabase *database, const char *sql) {
    if (database == nullptr || !database->open) return SQLITE_MISUSE;
    mal_profile_mark_worker_cpu_possible();
#if MAL_PROFILE
    sigset_t previous;
    if (!mal_sqlite_profile_block_sigprof(&previous)) return SQLITE_ERROR;
#endif
    i32 status = sqlite3_exec(database->handle, sql, nullptr, nullptr, nullptr);
#if MAL_PROFILE
    pthread_sigmask(SIG_SETMASK, &previous, nullptr);
#endif
    return status;
}

i32 mal_sqlite_database_prepare(
    MalSqliteDatabase *database, const char *sql, usize length,
    MalSqliteStatement **statement) {
    *statement = nullptr;
    if (database == nullptr || !database->open) return SQLITE_MISUSE;
    if (length > INT32_MAX) return SQLITE_TOOBIG;
    MalSqliteStatement *result = calloc(1, sizeof(MalSqliteStatement));
    if (result == nullptr) return SQLITE_NOMEM;
    i32 status = sqlite3_prepare_v2(
        database->handle, sql, (i32) length, &result->handle, nullptr);
    if (status != SQLITE_OK) {
        free(result);
        return status;
    }
    result->database = database;
    mal_sqlite_database_retain(database);
    *statement = result;
    return SQLITE_OK;
}

void mal_sqlite_statement_release(MalSqliteStatement *statement) {
    if (statement == nullptr) return;
    if (statement->handle != nullptr) sqlite3_finalize(statement->handle);
    mal_sqlite_database_release(statement->database);
    free(statement);
}

bool mal_sqlite_statement_is_open(const MalSqliteStatement *statement) {
    return statement != nullptr && statement->handle != nullptr
        && mal_sqlite_database_is_open(statement->database);
}

const char *mal_sqlite_statement_error(const MalSqliteStatement *statement) {
    if (!mal_sqlite_statement_is_open(statement)) {
        return "SQLite statement is not open";
    }
    return sqlite3_errmsg(statement->database->handle);
}

i32 mal_sqlite_statement_reset(MalSqliteStatement *statement) {
    if (!mal_sqlite_statement_is_open(statement)) return SQLITE_MISUSE;
    return sqlite3_reset(statement->handle);
}

i32 mal_sqlite_statement_clear_bindings(MalSqliteStatement *statement) {
    if (!mal_sqlite_statement_is_open(statement)) return SQLITE_MISUSE;
    return sqlite3_clear_bindings(statement->handle);
}

i32 mal_sqlite_statement_bind(
    MalSqliteStatement *statement, i32 index, const MalSqliteValue *value) {
    if (!mal_sqlite_statement_is_open(statement)) return SQLITE_MISUSE;
    switch (value->kind) {
        case MAL_SQLITE_VALUE_NULL:
            return sqlite3_bind_null(statement->handle, index);
        case MAL_SQLITE_VALUE_INTEGER:
            return sqlite3_bind_int64(statement->handle, index, value->as.integer);
        case MAL_SQLITE_VALUE_REAL:
            return sqlite3_bind_double(statement->handle, index, value->as.real);
        case MAL_SQLITE_VALUE_TEXT:
            if (value->as.bytes.length > INT32_MAX) return SQLITE_TOOBIG;
            return sqlite3_bind_text(
                statement->handle, index, (const char *) value->as.bytes.data,
                (i32) value->as.bytes.length, SQLITE_TRANSIENT);
        case MAL_SQLITE_VALUE_TEXT_UTF8_STATIC:
            if (value->as.bytes.length > INT32_MAX) return SQLITE_TOOBIG;
            return sqlite3_bind_text(
                statement->handle, index, (const char *) value->as.bytes.data,
                (i32) value->as.bytes.length, SQLITE_STATIC);
        case MAL_SQLITE_VALUE_TEXT_UTF16:
            if (value->as.bytes.length > INT32_MAX) return SQLITE_TOOBIG;
            return sqlite3_bind_text16(
                statement->handle, index, value->as.bytes.data,
                (i32) value->as.bytes.length, SQLITE_TRANSIENT);
        case MAL_SQLITE_VALUE_BLOB:
            if (value->as.bytes.length > INT32_MAX) return SQLITE_TOOBIG;
            if (value->as.bytes.length == 0) {
                return sqlite3_bind_zeroblob(statement->handle, index, 0);
            }
            return sqlite3_bind_blob(
                statement->handle, index, value->as.bytes.data,
                (i32) value->as.bytes.length, SQLITE_TRANSIENT);
    }
    return SQLITE_MISMATCH;
}

i32 mal_sqlite_statement_parameter_count(const MalSqliteStatement *statement) {
    return mal_sqlite_statement_is_open(statement)
        ? sqlite3_bind_parameter_count(statement->handle)
        : 0;
}

const char *mal_sqlite_statement_parameter_name(
    const MalSqliteStatement *statement, i32 index) {
    return mal_sqlite_statement_is_open(statement)
        ? sqlite3_bind_parameter_name(statement->handle, index)
        : nullptr;
}

i32 mal_sqlite_statement_step(MalSqliteStatement *statement) {
    if (!mal_sqlite_statement_is_open(statement)) return SQLITE_MISUSE;
    mal_profile_mark_worker_cpu_possible();
#if MAL_PROFILE
    sigset_t previous;
    if (!mal_sqlite_profile_block_sigprof(&previous)) return SQLITE_ERROR;
#endif
    i32 status = sqlite3_step(statement->handle);
#if MAL_PROFILE
    pthread_sigmask(SIG_SETMASK, &previous, nullptr);
#endif
    return status;
}

i32 mal_sqlite_statement_column_count(const MalSqliteStatement *statement) {
    return mal_sqlite_statement_is_open(statement)
        ? sqlite3_column_count(statement->handle)
        : 0;
}

const char *mal_sqlite_statement_column_name(
    const MalSqliteStatement *statement, i32 column) {
    return mal_sqlite_statement_is_open(statement)
        ? sqlite3_column_name(statement->handle, column)
        : nullptr;
}

MalSqliteValue mal_sqlite_statement_column(
    const MalSqliteStatement *statement, i32 column) {
    MalSqliteValue value = {.kind = MAL_SQLITE_VALUE_NULL};
    if (!mal_sqlite_statement_is_open(statement)) return value;
    switch (sqlite3_column_type(statement->handle, column)) {
        case SQLITE_INTEGER:
            value.kind = MAL_SQLITE_VALUE_INTEGER;
            value.as.integer = sqlite3_column_int64(statement->handle, column);
            break;
        case SQLITE_FLOAT:
            value.kind = MAL_SQLITE_VALUE_REAL;
            value.as.real = sqlite3_column_double(statement->handle, column);
            break;
        case SQLITE_TEXT:
            value.kind = MAL_SQLITE_VALUE_TEXT;
            value.as.bytes.data =
                (const byte *) sqlite3_column_text(statement->handle, column);
            value.as.bytes.length =
                (usize) sqlite3_column_bytes(statement->handle, column);
            break;
        case SQLITE_BLOB:
            value.kind = MAL_SQLITE_VALUE_BLOB;
            value.as.bytes.data =
                (const byte *) sqlite3_column_blob(statement->handle, column);
            value.as.bytes.length =
                (usize) sqlite3_column_bytes(statement->handle, column);
            break;
        case SQLITE_NULL:
        default:
            break;
    }
    return value;
}

i64 mal_sqlite_statement_changes(const MalSqliteStatement *statement) {
    return mal_sqlite_statement_is_open(statement)
        ? sqlite3_changes64(statement->database->handle)
        : 0;
}

i64 mal_sqlite_statement_last_insert_rowid(const MalSqliteStatement *statement) {
    return mal_sqlite_statement_is_open(statement)
        ? sqlite3_last_insert_rowid(statement->database->handle)
        : 0;
}
