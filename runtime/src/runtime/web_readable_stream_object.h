#pragma once

#include "object.h"

typedef struct MalVm MalVm;

typedef enum MalReadableStreamKind : u8 {
    MAL_READABLE_STREAM,
    MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
    MAL_READABLE_BYTE_STREAM_CONTROLLER,
    MAL_READABLE_STREAM_DEFAULT_READER,
    MAL_READABLE_STREAM_BYOB_READER,
    MAL_READABLE_STREAM_BYOB_REQUEST,
    MAL_COUNT_QUEUING_STRATEGY,
    MAL_BYTE_LENGTH_QUEUING_STRATEGY,
    MAL_WRITABLE_STREAM,
    MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER,
    MAL_WRITABLE_STREAM_DEFAULT_WRITER,
} MalReadableStreamKind;

typedef enum MalReadableStreamState : u8 {
    MAL_READABLE_STREAM_READABLE,
    MAL_READABLE_STREAM_CLOSED,
    MAL_READABLE_STREAM_ERRORED,
} MalReadableStreamState;

typedef struct MalReadableStreamQueueEntry {
    struct MalReadableStreamQueueEntry *next;
    MalValue chunk;
    f64 size;
    usize byte_offset;
} MalReadableStreamQueueEntry;

typedef struct MalReadableStreamReadRequest {
    struct MalReadableStreamReadRequest *next;
    MalValue promise;
    MalValue view;
    usize bytes_filled;
} MalReadableStreamReadRequest;

typedef struct MalWritableStreamWriteRequest {
    struct MalWritableStreamWriteRequest *next;
    MalValue chunk;
    MalValue promise;
    f64 size;
    bool close;
} MalWritableStreamWriteRequest;

typedef struct MalReadableStreamObject {
    MalObject object;
    MalReadableStreamKind kind;
    union {
        struct {
            MalReadableStreamState state;
            MalValue controller;
            MalValue reader;
            MalValue stored_error;
            bool disturbed;
            bool byte_stream;
        } stream;
        struct {
            MalValue stream;
            MalValue underlying_source;
            MalValue pull_method;
            MalValue cancel_method;
            MalValue size_algorithm;
            MalValue byob_request;
            MalValue orphaned_pull_into_view;
            usize orphaned_bytes_filled;
            MalReadableStreamQueueEntry *queue_head;
            MalReadableStreamQueueEntry *queue_tail;
            f64 queue_total_size;
            f64 high_water_mark;
            u32 auto_allocate_chunk_size;
            bool started;
            bool close_requested;
            bool pulling;
            bool pull_again;
        } controller;
        struct {
            MalValue stream;
            MalValue closed_promise;
            MalReadableStreamReadRequest *requests_head;
            MalReadableStreamReadRequest *requests_tail;
        } reader;
        struct {
            MalValue controller;
            MalValue view;
        } byob_request;
        struct {
            f64 high_water_mark;
        } strategy;
        struct {
            MalReadableStreamState state;
            MalValue controller;
            MalValue writer;
            MalValue stored_error;
        } writable_stream;
        struct {
            MalValue stream;
            MalValue underlying_sink;
            MalValue write_method;
            MalValue close_method;
            MalValue abort_method;
            MalValue size_algorithm;
            MalWritableStreamWriteRequest *queue_head;
            MalWritableStreamWriteRequest *queue_tail;
            f64 queue_total_size;
            f64 high_water_mark;
            bool started;
            bool writing;
            bool close_requested;
        } writable_controller;
        struct {
            MalValue stream;
            MalValue closed_promise;
            MalValue ready_promise;
        } writer;
    } as;
} MalReadableStreamObject;

/** Install default readable streams and queuing-strategy globals. */
void mal_readable_stream_install(MalVm *vm, MalObject *global_this);

/** Install default writable streams. Shares the native web-stream cell. */
void mal_writable_stream_install(MalVm *vm, MalObject *global_this);

/** Create a default stream containing one owned Uint8Array copy of `bytes`. */
MalValue mal_readable_stream_from_bytes(MalVm *vm, const byte *bytes, usize length);

/** Internal Body-state hooks shared with the Fetch runtime. */
bool mal_readable_stream_is_locked(MalValue value);
bool mal_readable_stream_is_disturbed(MalValue value);
bool mal_readable_stream_consume(MalVm *vm, MalValue value);

/** Internal reader algorithms used by Fetch Body consumption. */
MalValue mal_readable_stream_acquire_default_reader(MalVm *vm, MalValue value);
MalValue mal_readable_stream_default_reader_closed(MalValue value);
bool mal_readable_stream_default_reader_is_readable(MalValue value);
MalValue mal_readable_stream_default_reader_read(MalVm *vm, MalValue value);
MalValue mal_readable_stream_default_reader_cancel(
    MalVm *vm, MalValue value, MalValue reason);
void mal_readable_stream_default_reader_release(MalVm *vm, MalValue value);

/** Internal writer algorithms used by ReadableStream piping. */
bool mal_writable_stream_is_stream(MalValue value);
bool mal_writable_stream_is_locked(MalValue value);
MalValue mal_writable_stream_acquire_default_writer(MalVm *vm, MalValue value);
MalValue mal_writable_stream_default_writer_ready(MalValue value);
MalValue mal_writable_stream_default_writer_closed(MalValue value);
bool mal_writable_stream_default_writer_is_writable(MalValue value);
MalValue mal_writable_stream_default_writer_write(
    MalVm *vm, MalValue value, MalValue chunk);
MalValue mal_writable_stream_default_writer_close(MalVm *vm, MalValue value);
MalValue mal_writable_stream_default_writer_abort(
    MalVm *vm, MalValue value, MalValue reason);
void mal_writable_stream_default_writer_release(MalVm *vm, MalValue value);

/** Create a distinct stream that forwards reads and cancellation to `value`. */
MalValue mal_readable_stream_create_proxy(MalVm *vm, MalValue value);

/** Tee `value` into two independently consumable default streams. */
bool mal_readable_stream_tee(
    MalVm *vm, MalValue value, MalValue *branch1_out, MalValue *branch2_out);
