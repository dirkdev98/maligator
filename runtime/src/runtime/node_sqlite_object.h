#pragma once

#include "object.h"
#include "sqlite.h"

typedef struct MalNodeSqliteDatabaseObject {
    MalObject object;
    MalSqliteDatabase *database;
    bool read_bigints;
    bool return_arrays;
    bool allow_bare_named_parameters;
    bool allow_unknown_named_parameters;
} MalNodeSqliteDatabaseObject;

typedef struct MalNodeSqliteBindScratch {
    byte *data[2];
    usize capacity[2];
    u8 active;
    u8 pending;
} MalNodeSqliteBindScratch;

typedef struct MalNodeSqliteStatementObject {
    MalObject object;
    MalSqliteStatement *statement;
    MalNodeSqliteBindScratch *bind_scratch;
    i32 bind_scratch_count;
    bool read_bigints;
    bool return_arrays;
    bool allow_bare_named_parameters;
    bool allow_unknown_named_parameters;
} MalNodeSqliteStatementObject;
