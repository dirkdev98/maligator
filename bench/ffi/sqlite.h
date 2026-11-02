typedef struct FfiBenchDb FfiBenchDb;
typedef struct FfiBenchStatement FfiBenchStatement;

FfiBenchDb *ffi_bench_sql_open(void);
FfiBenchStatement *ffi_bench_sql_prepare(FfiBenchDb *db, const char *sql);
int ffi_bench_sql_bind(FfiBenchStatement *statement, int value);
int ffi_bench_sql_bind_text(FfiBenchStatement *statement, const char *value);
int ffi_bench_sql_column_bytes(FfiBenchStatement *statement);
unsigned int ffi_bench_sql_text_hash(FfiBenchStatement *statement);
int ffi_bench_sql_step(FfiBenchStatement *statement);
int ffi_bench_sql_column(FfiBenchStatement *statement);
int ffi_bench_sql_reset(FfiBenchStatement *statement);
int ffi_bench_sql_finalize(FfiBenchStatement *statement);
int ffi_bench_sql_close(FfiBenchDb *db);
const char *ffi_bench_library_identity(void);
