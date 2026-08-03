#include "node_sqlite.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_sqlite_object.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "sqlite.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define SQLITE_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define SQLITE_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)
#define SQLITE_MAX_SAFE_INTEGER 9007199254740991LL

static bool sqlite_is_database(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_NODE_SQLITE_DATABASE_OBJECT);
}

static bool sqlite_is_statement(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_NODE_SQLITE_STATEMENT_OBJECT);
}

static MalNodeSqliteDatabaseObject *sqlite_database(MalValue value) {
    return (MalNodeSqliteDatabaseObject *) mal_value_to_heap(value);
}

static MalNodeSqliteStatementObject *sqlite_statement(MalValue value) {
    return (MalNodeSqliteStatementObject *) mal_value_to_heap(value);
}

static MalValue sqlite_string(
    MalVm *vm, const byte *bytes, usize length) {
    MalString *string = mal_string_from_utf8(&vm->heap, bytes, length);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static void sqlite_throw(MalVm *vm, i32 status, const char *message) {
    if (status == MAL_SQLITE_NOMEM) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        (const byte *) (message == nullptr ? "SQLite operation failed" : message));
}

static void sqlite_throw_database(
    MalVm *vm, MalNodeSqliteDatabaseObject *database, i32 status) {
    sqlite_throw(
        vm, status,
        database == nullptr
            ? "SQLite database is not open"
            : mal_sqlite_database_error(database->database));
}

static void sqlite_throw_statement(
    MalVm *vm, MalNodeSqliteStatementObject *statement, i32 status) {
    sqlite_throw(
        vm, status,
        statement == nullptr
            ? "SQLite statement is not open"
            : mal_sqlite_statement_error(statement->statement));
}

static MalNodeSqliteDatabaseObject *sqlite_require_database(
    MalVm *vm, MalValue receiver) {
    if (!sqlite_is_database(receiver)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "DatabaseSync method called on incompatible receiver");
        return nullptr;
    }
    MalNodeSqliteDatabaseObject *database = sqlite_database(receiver);
    if (!mal_sqlite_database_is_open(database->database)) {
        sqlite_throw_database(vm, database, MAL_SQLITE_MISUSE);
        return nullptr;
    }
    return database;
}

static MalNodeSqliteStatementObject *sqlite_require_statement(
    MalVm *vm, MalValue receiver) {
    if (!sqlite_is_statement(receiver)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "StatementSync method called on incompatible receiver");
        return nullptr;
    }
    MalNodeSqliteStatementObject *statement = sqlite_statement(receiver);
    if (!mal_sqlite_statement_is_open(statement->statement)) {
        sqlite_throw_statement(vm, statement, MAL_SQLITE_MISUSE);
        return nullptr;
    }
    return statement;
}

static void sqlite_database_finalize(MalHeapHeader *cell) {
    MalNodeSqliteDatabaseObject *database =
        (MalNodeSqliteDatabaseObject *) cell;
    mal_sqlite_database_release(database->database);
    database->database = nullptr;
}

static void sqlite_statement_finalize(MalHeapHeader *cell) {
    MalNodeSqliteStatementObject *statement =
        (MalNodeSqliteStatementObject *) cell;
    mal_sqlite_statement_release(statement->statement);
    statement->statement = nullptr;
}

static bool sqlite_get_option(
    MalVm *vm, MalValue options, const char *name, MalValue *value) {
    if (!mal_value_is_object(options)) {
        *value = mal_value_new_undefined();
        return true;
    }
    return mal_vm_get_property(
        vm, options, mal_intrinsic_string_key(vm, (const byte *) name), value);
}

static bool sqlite_boolean_option(
    MalVm *vm, MalValue options, const char *name, bool fallback, bool *out) {
    MalValue value;
    if (!sqlite_get_option(vm, options, name, &value)) return false;
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    if (!mal_value_is_boolean(value)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "node:sqlite boolean option must be a boolean");
        return false;
    }
    *out = mal_value_to_boolean(value);
    return true;
}

static bool sqlite_timeout_option(
    MalVm *vm, MalValue options, i32 *out) {
    MalValue value;
    if (!sqlite_get_option(vm, options, "timeout", &value)) return false;
    if (mal_value_is_undefined(value)) {
        *out = 0;
        return true;
    }
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "node:sqlite timeout must be a non-negative number");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || number < 0 || number > INT32_MAX) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "node:sqlite timeout is out of range");
        return false;
    }
    *out = (i32) number;
    return true;
}

static char *sqlite_path(
    MalVm *vm, MalValue value) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return nullptr;
    char *path;
    usize length;
    MalUtf8CStringResult result =
        mal_string_to_utf8_c_string(string, &path, &length);
    (void) length;
    if (result == MAL_UTF8_C_STRING_OK) return path;
    if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
    } else {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "SQLite database path must not contain NUL");
    }
    return nullptr;
}

static MalObject *sqlite_instance_prototype(
    MalVm *vm, MalValue new_target, MalValue callee, MalIntrinsic fallback) {
    MalValue prototype = mal_vm_function_prototype(vm, new_target);
    if (!mal_value_is_object(prototype)) {
        prototype = mal_vm_function_prototype(vm, callee);
    }
    return mal_value_is_object(prototype)
        ? mal_value_to_object(prototype)
        : mal_value_to_object(vm->intrinsics[fallback]);
}

static MalValue sqlite_database_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor DatabaseSync cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue path_value =
        argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue options =
        argc > 1 ? args[1] : mal_value_new_undefined();
    char *path = sqlite_path(vm, path_value);
    if (path == nullptr) return mal_value_new_undefined();

    bool open;
    MalSqliteOpenOptions native = {
        .read_only = false,
        .foreign_keys = true,
        .double_quoted_strings = false,
        .defensive = true,
        .timeout_ms = 0,
    };
    bool read_bigints;
    bool return_arrays;
    bool allow_bare;
    bool allow_unknown;
    if (!sqlite_boolean_option(vm, options, "open", true, &open)
        || !sqlite_boolean_option(
            vm, options, "readOnly", false, &native.read_only)
        || !sqlite_boolean_option(
            vm, options, "enableForeignKeyConstraints", true,
            &native.foreign_keys)
        || !sqlite_boolean_option(
            vm, options, "enableDoubleQuotedStringLiterals", false,
            &native.double_quoted_strings)
        || !sqlite_boolean_option(
            vm, options, "defensive", true, &native.defensive)
        || !sqlite_boolean_option(
            vm, options, "readBigInts", false, &read_bigints)
        || !sqlite_boolean_option(
            vm, options, "returnArrays", false, &return_arrays)
        || !sqlite_boolean_option(
            vm, options, "allowBareNamedParameters", true, &allow_bare)
        || !sqlite_boolean_option(
            vm, options, "allowUnknownNamedParameters", false, &allow_unknown)
        || !sqlite_timeout_option(vm, options, &native.timeout_ms)) {
        free(path);
        return mal_value_new_undefined();
    }
    if (!open) {
        free(path);
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "DatabaseSync option open:false is not supported yet");
        return mal_value_new_undefined();
    }

    MalSqliteDatabase *handle = nullptr;
    i32 status = mal_sqlite_database_open(path, &native, &handle);
    free(path);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw(
            vm, status, mal_sqlite_database_error(handle));
        mal_sqlite_database_release(handle);
        return mal_value_new_undefined();
    }

    MalNodeSqliteDatabaseObject *database = mal_heap_alloc(
        &vm->heap, sizeof(MalNodeSqliteDatabaseObject),
        MAL_HEAP_NODE_SQLITE_DATABASE_OBJECT);
    mal_object_init(
        &vm->heap, &database->object,
        MAL_HEAP_NODE_SQLITE_DATABASE_OBJECT,
        sqlite_instance_prototype(
            vm, new_target, callee,
            MAL_INTRINSIC_NODE_SQLITE_DATABASE_PROTOTYPE));
    database->database = handle;
    database->read_bigints = read_bigints;
    database->return_arrays = return_arrays;
    database->allow_bare_named_parameters = allow_bare;
    database->allow_unknown_named_parameters = allow_unknown;
    return mal_value_from_heap((MalHeapHeader *) database);
}

static MalValue sqlite_statement_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "Illegal constructor");
    return mal_value_new_undefined();
}

static MalValue sqlite_database_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeSqliteDatabaseObject *database =
        sqlite_require_database(vm, receiver);
    if (database == nullptr) return mal_value_new_undefined();
    i32 status = mal_sqlite_database_close(database->database);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw_database(vm, database, status);
    }
    return mal_value_new_undefined();
}

static MalValue sqlite_database_is_open_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    if (!sqlite_is_database(receiver)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "DatabaseSync.isOpen getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(
        mal_sqlite_database_is_open(sqlite_database(receiver)->database));
}

static MalValue sqlite_database_is_transaction_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeSqliteDatabaseObject *database =
        sqlite_require_database(vm, receiver);
    if (database == nullptr) return mal_value_new_undefined();
    return mal_value_new_boolean(
        mal_sqlite_database_is_transaction(database->database));
}

static MalValue sqlite_database_exec(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeSqliteDatabaseObject *database =
        sqlite_require_database(vm, receiver);
    if (database == nullptr) return mal_value_new_undefined();
    MalString *sql;
    if (!mal_vm_to_string(
            vm, argc > 0 ? args[0] : mal_value_new_undefined(), &sql)) {
        return mal_value_new_undefined();
    }
    char *bytes;
    usize length;
    MalUtf8CStringResult converted =
        mal_string_to_utf8_c_string(sql, &bytes, &length);
    (void) length;
    if (converted != MAL_UTF8_C_STRING_OK) {
        if (converted == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
            mal_vm_throw_allocation_error(vm);
        } else {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "SQLite SQL must not contain NUL");
        }
        return mal_value_new_undefined();
    }
    i32 status = mal_sqlite_database_exec(database->database, bytes);
    free(bytes);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw_database(vm, database, status);
    }
    return mal_value_new_undefined();
}

static MalValue sqlite_database_prepare(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeSqliteDatabaseObject *database =
        sqlite_require_database(vm, receiver);
    if (database == nullptr) return mal_value_new_undefined();
    MalString *sql;
    if (!mal_vm_to_string(
            vm, argc > 0 ? args[0] : mal_value_new_undefined(), &sql)) {
        return mal_value_new_undefined();
    }
    usize length;
    byte *bytes = mal_string_to_utf8(sql, &length);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalSqliteStatement *handle = nullptr;
    i32 status = mal_sqlite_database_prepare(
        database->database, (const char *) bytes, length, &handle);
    free(bytes);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw_database(vm, database, status);
        return mal_value_new_undefined();
    }
    MalNodeSqliteStatementObject *statement = mal_heap_alloc(
        &vm->heap, sizeof(MalNodeSqliteStatementObject),
        MAL_HEAP_NODE_SQLITE_STATEMENT_OBJECT);
    mal_object_init(
        &vm->heap, &statement->object,
        MAL_HEAP_NODE_SQLITE_STATEMENT_OBJECT,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_STATEMENT_PROTOTYPE]));
    statement->statement = handle;
    statement->read_bigints = database->read_bigints;
    statement->return_arrays = database->return_arrays;
    statement->allow_bare_named_parameters =
        database->allow_bare_named_parameters;
    statement->allow_unknown_named_parameters =
        database->allow_unknown_named_parameters;
    return mal_value_from_heap((MalHeapHeader *) statement);
}

static bool sqlite_value_from_js(
    MalVm *vm, MalValue input, MalSqliteValue *value, byte **owned) {
    *owned = nullptr;
    if (mal_value_is_null(input)) {
        value->kind = MAL_SQLITE_VALUE_NULL;
        return true;
    }
    if (mal_ops_is_number(input)) {
        f64 number = mal_ops_number_as_f64(input);
        if (isnan(number)) {
            value->kind = MAL_SQLITE_VALUE_NULL;
        } else {
            value->kind = MAL_SQLITE_VALUE_REAL;
            value->as.real = number;
        }
        return true;
    }
    if (mal_value_is_bigint(input)) {
        i128 integer = mal_bigint_value(mal_value_to_bigint(input));
        if (integer < INT64_MIN || integer > INT64_MAX) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                (const byte *) "BigInt value is outside SQLite's 64-bit range");
            return false;
        }
        value->kind = MAL_SQLITE_VALUE_INTEGER;
        value->as.integer = (i64) integer;
        return true;
    }
    if (mal_value_is_string(input)) {
        usize length;
        *owned = mal_string_to_utf8(mal_value_to_string(input), &length);
        if (*owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        value->kind = MAL_SQLITE_VALUE_TEXT;
        value->as.bytes.data = *owned;
        value->as.bytes.length = length;
        return true;
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(input, &span) == MAL_BUFFER_SOURCE_SPAN_OK) {
        value->kind = MAL_SQLITE_VALUE_BLOB;
        value->as.bytes.data = span.data;
        value->as.bytes.length = span.length;
        return true;
    }
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "Provided value cannot be bound to a SQLite parameter");
    return false;
}

static bool sqlite_bind_one(
    MalVm *vm, MalNodeSqliteStatementObject *statement,
    i32 index, MalValue input) {
    MalSqliteValue value;
    byte *owned;
    if (!sqlite_value_from_js(vm, input, &value, &owned)) return false;
    i32 status =
        mal_sqlite_statement_bind(statement->statement, index, &value);
    free(owned);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw_statement(vm, statement, status);
        return false;
    }
    return true;
}

static bool sqlite_is_named_parameter_object(MalValue value) {
    return mal_value_is_object(value)
        && !mal_value_is_array_object(value)
        && !mal_value_is_array_buffer_object(value)
        && !mal_value_is_typed_array_object(value)
        && !mal_value_is_data_view_object(value);
}

static bool sqlite_named_value(
    MalVm *vm, MalValue object, const char *name, bool allow_bare,
    MalValue *value) {
    if (!mal_vm_get_property(
            vm, object,
            mal_intrinsic_string_key(vm, (const byte *) name), value)) {
        return false;
    }
    if (!mal_value_is_undefined(*value) || !allow_bare) return true;
    return mal_vm_get_property(
        vm, object,
        mal_intrinsic_string_key(vm, (const byte *) (name + 1)), value);
}

static bool sqlite_bind(
    MalVm *vm, MalNodeSqliteStatementObject *statement,
    const MalValue *args, i32 argc) {
    i32 status = mal_sqlite_statement_reset(statement->statement);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw_statement(vm, statement, status);
        return false;
    }
    status = mal_sqlite_statement_clear_bindings(statement->statement);
    if (status != MAL_SQLITE_OK) {
        sqlite_throw_statement(vm, statement, status);
        return false;
    }
    bool named = argc > 0 && sqlite_is_named_parameter_object(args[0]);
    i32 positional = named ? 1 : 0;
    i32 count =
        mal_sqlite_statement_parameter_count(statement->statement);
    for (i32 index = 1; index <= count; index++) {
        const char *name =
            mal_sqlite_statement_parameter_name(statement->statement, index);
        MalValue value = mal_value_new_undefined();
        if (named && name != nullptr && name[0] != '?') {
            if (!sqlite_named_value(
                    vm, args[0], name,
                    statement->allow_bare_named_parameters, &value)) {
                return false;
            }
        } else if (positional < argc) {
            value = args[positional++];
        }
        if (mal_value_is_undefined(value)) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                (const byte *) "SQLite statement has an unbound parameter");
            return false;
        }
        if (!sqlite_bind_one(vm, statement, index, value)) return false;
    }
    return true;
}

static MalValue sqlite_int64(
    MalVm *vm, i64 integer, bool read_bigints) {
    if (read_bigints) {
        return mal_value_from_bigint(
            mal_bigint_new(&vm->heap, (i128) integer));
    }
    if (integer < -SQLITE_MAX_SAFE_INTEGER
        || integer > SQLITE_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "SQLite integer is outside JavaScript's safe integer range");
        return mal_value_new_undefined();
    }
    return mal_value_from_f64_convert_nan((f64) integer);
}

static MalValue sqlite_blob(
    MalVm *vm, const byte *bytes, usize length) {
    if (length > UINT32_MAX) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "SQLite BLOB is too large");
        return mal_value_new_undefined();
    }
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &vm->heap,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) length, (u32) length, false, false);
    if (length > 0) memcpy(buffer->data, bytes, length);
    MalValue buffer_value = mal_value_from_array_buffer_object(buffer);
    MalRootSpan root;
    mal_gc_root(&root, &buffer_value, 1);
    MalTypedArrayObject *array = mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, (u32) length, false);
    mal_gc_unroot(&root);
    return mal_value_from_typed_array_object(array);
}

static MalValue sqlite_column_value(
    MalVm *vm, MalNodeSqliteStatementObject *statement, i32 column) {
    MalSqliteValue value =
        mal_sqlite_statement_column(statement->statement, column);
    switch (value.kind) {
        case MAL_SQLITE_VALUE_NULL:
            return mal_value_new_null();
        case MAL_SQLITE_VALUE_INTEGER:
            return sqlite_int64(vm, value.as.integer, statement->read_bigints);
        case MAL_SQLITE_VALUE_REAL:
            return mal_value_from_f64_convert_nan(value.as.real);
        case MAL_SQLITE_VALUE_TEXT:
            return sqlite_string(
                vm, value.as.bytes.data, value.as.bytes.length);
        case MAL_SQLITE_VALUE_BLOB:
            return sqlite_blob(
                vm, value.as.bytes.data, value.as.bytes.length);
    }
    return mal_value_new_undefined();
}

static MalValue sqlite_row(
    MalVm *vm, MalNodeSqliteStatementObject *statement) {
    i32 count =
        mal_sqlite_statement_column_count(statement->statement);
    MalValue row = statement->return_arrays
        ? mal_value_from_array_object(
            mal_intrinsic_new_array(vm, (u32) count))
        : mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan row_root;
    mal_gc_root(&row_root, &row, 1);
    for (i32 column = 0; column < count; column++) {
        MalValue held[2] = {
            mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan held_root;
        mal_gc_root(&held_root, held, countof(held));
        held[0] = sqlite_column_value(vm, statement, column);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&held_root);
            mal_gc_unroot(&row_root);
            return mal_value_new_undefined();
        }
        if (statement->return_arrays) {
            mal_object_set(
                mal_value_to_object(row), mal_key_index((u32) column), held[0]);
        } else {
            const char *name = mal_sqlite_statement_column_name(
                statement->statement, column);
            held[1] = sqlite_string(
                vm, (const byte *) name, strlen(name));
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_object_set(
                    mal_value_to_object(row),
                    mal_key_from_value(held[1]), held[0]);
            }
        }
        mal_gc_unroot(&held_root);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&row_root);
            return mal_value_new_undefined();
        }
    }
    mal_gc_unroot(&row_root);
    return row;
}

typedef enum SqliteQueryMode {
    SQLITE_QUERY_ALL,
    SQLITE_QUERY_GET,
    SQLITE_QUERY_RUN,
} SqliteQueryMode;

static MalValue sqlite_execute(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    SqliteQueryMode mode) {
    MalNodeSqliteStatementObject *statement =
        sqlite_require_statement(vm, receiver);
    if (statement == nullptr
        || !sqlite_bind(vm, statement, args, argc)) {
        return mal_value_new_undefined();
    }
    MalValue result = mode == SQLITE_QUERY_ALL
        ? mal_value_from_array_object(mal_intrinsic_new_array(vm, 0))
        : mal_value_new_undefined();
    MalRootSpan result_root;
    mal_gc_root(&result_root, &result, 1);
    u32 row_index = 0;
    while (true) {
        i32 status = mal_sqlite_statement_step(statement->statement);
        if (status == MAL_SQLITE_DONE) break;
        if (status != MAL_SQLITE_ROW) {
            sqlite_throw_statement(vm, statement, status);
            break;
        }
        if (mode == SQLITE_QUERY_RUN) continue;
        MalValue row = sqlite_row(vm, statement);
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        if (mode == SQLITE_QUERY_GET) {
            result = row;
            break;
        }
        MalRootSpan row_root;
        mal_gc_root(&row_root, &row, 1);
        mal_array_object_set(
            mal_value_to_array_object(result), mal_key_index(row_index++), row);
        mal_gc_unroot(&row_root);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && mode == SQLITE_QUERY_RUN) {
        MalObject *summary = mal_object_new(&vm->heap, nullptr);
        result = mal_value_from_object(summary);
        MalRootSpan summary_root;
        mal_gc_root(&summary_root, &result, 1);
        MalValue changes = sqlite_int64(
            vm, mal_sqlite_statement_changes(statement->statement),
            statement->read_bigints);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_object_set(
                summary, mal_intrinsic_string_key(vm, (const byte *) "changes"),
                changes);
            MalValue rowid = sqlite_int64(
                vm,
                mal_sqlite_statement_last_insert_rowid(statement->statement),
                statement->read_bigints);
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_object_set(
                    summary,
                    mal_intrinsic_string_key(
                        vm, (const byte *) "lastInsertRowid"),
                    rowid);
            }
        }
        mal_gc_unroot(&summary_root);
    }
    mal_sqlite_statement_reset(statement->statement);
    mal_gc_unroot(&result_root);
    return result;
}

#define SQLITE_QUERY_METHOD(name, mode)                                      \
    static MalValue name(                                                    \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,         \
        MalValue new_target, MalValue callee) {                               \
        (void) new_target;                                                    \
        (void) callee;                                                        \
        return sqlite_execute(vm, receiver, args, argc, mode);                \
    }

SQLITE_QUERY_METHOD(sqlite_statement_all, SQLITE_QUERY_ALL)
SQLITE_QUERY_METHOD(sqlite_statement_get, SQLITE_QUERY_GET)
SQLITE_QUERY_METHOD(sqlite_statement_run, SQLITE_QUERY_RUN)

static MalValue sqlite_statement_set_return_arrays(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeSqliteStatementObject *statement =
        sqlite_require_statement(vm, receiver);
    if (statement == nullptr) return mal_value_new_undefined();
    if (argc < 1 || !mal_value_is_boolean(args[0])) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "setReturnArrays requires a boolean");
        return mal_value_new_undefined();
    }
    statement->return_arrays = mal_value_to_boolean(args[0]);
    return mal_value_new_undefined();
}

static MalValue sqlite_statement_set_read_bigints(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeSqliteStatementObject *statement =
        sqlite_require_statement(vm, receiver);
    if (statement == nullptr) return mal_value_new_undefined();
    if (argc < 1 || !mal_value_is_boolean(args[0])) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "setReadBigInts requires a boolean");
        return mal_value_new_undefined();
    }
    statement->read_bigints = mal_value_to_boolean(args[0]);
    return mal_value_new_undefined();
}

static void sqlite_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    MalValue module, MalValue database_constructor,
    MalValue statement_constructor) {
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
        } else if (strcmp(slots[i].name, "DatabaseSync") == 0) {
            vm->globals[slots[i].slot] = database_constructor;
        } else if (strcmp(slots[i].name, "StatementSync") == 0) {
            vm->globals[slots[i].slot] = statement_constructor;
        }
    }
}

static MalValue sqlite_constructor(
    MalVm *vm, const char *name, i32 length,
    MalNativeFunctionCallback callback, MalValue prototype) {
    MalNativeFunctionObject *constructor =
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) name),
            length, callback);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(
        vm, (MalObject *) constructor, (const byte *) "prototype",
        prototype, MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(prototype), (const byte *) "constructor",
        value, SQLITE_METHOD);
    return value;
}

void mal_host_install_node_sqlite(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached =
        vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_MODULE];
    if (!mal_value_is_undefined(cached)) {
        sqlite_install_exports(
            vm, slots, count, cached,
            vm->intrinsics[
                MAL_INTRINSIC_NODE_SQLITE_DATABASE_CONSTRUCTOR],
            vm->intrinsics[
                MAL_INTRINSIC_NODE_SQLITE_STATEMENT_CONSTRUCTOR]);
        return;
    }
    mal_gc_register_finalizer(
        MAL_HEAP_NODE_SQLITE_DATABASE_OBJECT,
        sqlite_database_finalize);
    mal_gc_register_finalizer(
        MAL_HEAP_NODE_SQLITE_STATEMENT_OBJECT,
        sqlite_statement_finalize);

    MalValue roots[5] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    roots[1] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    roots[2] = sqlite_constructor(
        vm, "DatabaseSync", 1, sqlite_database_constructor, roots[0]);
    roots[3] = sqlite_constructor(
        vm, "StatementSync", 0, sqlite_statement_constructor, roots[1]);

    MalObject *database_prototype = mal_value_to_object(roots[0]);
    mal_intrinsic_define_method_n(
        vm, database_prototype, (const byte *) "close", 0,
        sqlite_database_close);
    mal_intrinsic_define_method_n(
        vm, database_prototype, (const byte *) "exec", 1,
        sqlite_database_exec);
    mal_intrinsic_define_method_n(
        vm, database_prototype, (const byte *) "prepare", 1,
        sqlite_database_prepare);
    mal_intrinsic_define_getter(
        vm, database_prototype, (const byte *) "isOpen",
        (const byte *) "get isOpen", sqlite_database_is_open_getter,
        MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_getter(
        vm, database_prototype, (const byte *) "isTransaction",
        (const byte *) "get isTransaction",
        sqlite_database_is_transaction_getter,
        MAL_PROPERTY_CONFIGURABLE);

    MalObject *statement_prototype = mal_value_to_object(roots[1]);
    mal_intrinsic_define_method_n(
        vm, statement_prototype, (const byte *) "all", 0,
        sqlite_statement_all);
    mal_intrinsic_define_method_n(
        vm, statement_prototype, (const byte *) "get", 0,
        sqlite_statement_get);
    mal_intrinsic_define_method_n(
        vm, statement_prototype, (const byte *) "run", 0,
        sqlite_statement_run);
    mal_intrinsic_define_method_n(
        vm, statement_prototype, (const byte *) "setReturnArrays", 1,
        sqlite_statement_set_return_arrays);
    mal_intrinsic_define_method_n(
        vm, statement_prototype, (const byte *) "setReadBigInts", 1,
        sqlite_statement_set_read_bigints);

    roots[4] =
        mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *module = mal_value_to_object(roots[4]);
    mal_intrinsic_define_data(
        vm, module, (const byte *) "DatabaseSync",
        roots[2], SQLITE_VISIBLE);
    mal_intrinsic_define_data(
        vm, module, (const byte *) "StatementSync",
        roots[3], SQLITE_VISIBLE);

    vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_DATABASE_PROTOTYPE] =
        roots[0];
    vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_STATEMENT_PROTOTYPE] =
        roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_DATABASE_CONSTRUCTOR] =
        roots[2];
    vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_STATEMENT_CONSTRUCTOR] =
        roots[3];
    vm->intrinsics[MAL_INTRINSIC_NODE_SQLITE_MODULE] = roots[4];
    sqlite_install_exports(
        vm, slots, count, roots[4], roots[2], roots[3]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
