#pragma once

#include "defaults.h"

/*
 * Runtime-neutral synchronous SQLite host boundary. It deliberately contains no
 * MalValue or Node types so node:sqlite and future Mal APIs can share it.
 */

typedef struct MalSqliteDatabase MalSqliteDatabase;
typedef struct MalSqliteStatement MalSqliteStatement;

typedef struct MalSqliteOpenOptions {
    bool read_only;
    bool foreign_keys;
    bool double_quoted_strings;
    bool defensive;
    i32 timeout_ms;
} MalSqliteOpenOptions;

typedef enum MalSqliteValueKind {
    MAL_SQLITE_VALUE_NULL,
    MAL_SQLITE_VALUE_INTEGER,
    MAL_SQLITE_VALUE_REAL,
    MAL_SQLITE_VALUE_TEXT,
    MAL_SQLITE_VALUE_BLOB,
} MalSqliteValueKind;

typedef struct MalSqliteValue {
    MalSqliteValueKind kind;
    union {
        i64 integer;
        f64 real;
        struct {
            const byte *data;
            usize length;
        } bytes;
    } as;
} MalSqliteValue;

enum {
    MAL_SQLITE_OK = 0,
    MAL_SQLITE_ERROR = 1,
    MAL_SQLITE_INTERNAL = 2,
    MAL_SQLITE_PERM = 3,
    MAL_SQLITE_ABORT = 4,
    MAL_SQLITE_BUSY = 5,
    MAL_SQLITE_LOCKED = 6,
    MAL_SQLITE_NOMEM = 7,
    MAL_SQLITE_READONLY = 8,
    MAL_SQLITE_INTERRUPT = 9,
    MAL_SQLITE_IOERR = 10,
    MAL_SQLITE_CORRUPT = 11,
    MAL_SQLITE_NOTFOUND = 12,
    MAL_SQLITE_FULL = 13,
    MAL_SQLITE_CANTOPEN = 14,
    MAL_SQLITE_PROTOCOL = 15,
    MAL_SQLITE_EMPTY = 16,
    MAL_SQLITE_SCHEMA = 17,
    MAL_SQLITE_TOOBIG = 18,
    MAL_SQLITE_CONSTRAINT = 19,
    MAL_SQLITE_MISMATCH = 20,
    MAL_SQLITE_MISUSE = 21,
    MAL_SQLITE_NOLFS = 22,
    MAL_SQLITE_AUTH = 23,
    MAL_SQLITE_FORMAT = 24,
    MAL_SQLITE_RANGE = 25,
    MAL_SQLITE_NOTADB = 26,
    MAL_SQLITE_ROW = 100,
    MAL_SQLITE_DONE = 101,
};

i32 mal_sqlite_database_open(
    const char *path, const MalSqliteOpenOptions *options,
    MalSqliteDatabase **database);
void mal_sqlite_database_release(MalSqliteDatabase *database);
i32 mal_sqlite_database_close(MalSqliteDatabase *database);
bool mal_sqlite_database_is_open(const MalSqliteDatabase *database);
bool mal_sqlite_database_is_transaction(const MalSqliteDatabase *database);
const char *mal_sqlite_database_error(const MalSqliteDatabase *database);
i32 mal_sqlite_database_exec(MalSqliteDatabase *database, const char *sql);
i32 mal_sqlite_database_prepare(
    MalSqliteDatabase *database, const char *sql, usize length,
    MalSqliteStatement **statement);

void mal_sqlite_statement_release(MalSqliteStatement *statement);
bool mal_sqlite_statement_is_open(const MalSqliteStatement *statement);
const char *mal_sqlite_statement_error(const MalSqliteStatement *statement);
i32 mal_sqlite_statement_reset(MalSqliteStatement *statement);
i32 mal_sqlite_statement_clear_bindings(MalSqliteStatement *statement);
i32 mal_sqlite_statement_bind(
    MalSqliteStatement *statement, i32 index, const MalSqliteValue *value);
i32 mal_sqlite_statement_parameter_count(const MalSqliteStatement *statement);
const char *mal_sqlite_statement_parameter_name(
    const MalSqliteStatement *statement, i32 index);
i32 mal_sqlite_statement_step(MalSqliteStatement *statement);
i32 mal_sqlite_statement_column_count(const MalSqliteStatement *statement);
const char *mal_sqlite_statement_column_name(
    const MalSqliteStatement *statement, i32 column);
MalSqliteValue mal_sqlite_statement_column(
    const MalSqliteStatement *statement, i32 column);
i64 mal_sqlite_statement_changes(const MalSqliteStatement *statement);
i64 mal_sqlite_statement_last_insert_rowid(const MalSqliteStatement *statement);
