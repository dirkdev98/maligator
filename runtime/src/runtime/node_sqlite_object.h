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

typedef struct MalNodeSqliteStatementObject {
    MalObject object;
    MalSqliteStatement *statement;
    bool read_bigints;
    bool return_arrays;
    bool allow_bare_named_parameters;
    bool allow_unknown_named_parameters;
} MalNodeSqliteStatementObject;
