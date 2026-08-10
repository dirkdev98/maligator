#pragma once

#include "object.h"

typedef struct MalVm MalVm;

typedef enum MalReadableStreamKind : u8 {
    MAL_READABLE_STREAM,
    MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
    MAL_READABLE_STREAM_DEFAULT_READER,
    MAL_COUNT_QUEUING_STRATEGY,
    MAL_BYTE_LENGTH_QUEUING_STRATEGY,
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
} MalReadableStreamQueueEntry;

typedef struct MalReadableStreamReadRequest {
    struct MalReadableStreamReadRequest *next;
    MalValue promise;
} MalReadableStreamReadRequest;

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
        } stream;
        struct {
            MalValue stream;
            MalValue underlying_source;
            MalValue pull_method;
            MalValue cancel_method;
            MalValue size_algorithm;
            MalReadableStreamQueueEntry *queue_head;
            MalReadableStreamQueueEntry *queue_tail;
            f64 queue_total_size;
            f64 high_water_mark;
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
            f64 high_water_mark;
        } strategy;
    } as;
} MalReadableStreamObject;

/** Install default readable streams and queuing-strategy globals. */
void mal_readable_stream_install(MalVm *vm, MalObject *global_this);

/** Create a default stream containing one owned Uint8Array copy of `bytes`. */
MalValue mal_readable_stream_from_bytes(MalVm *vm, const byte *bytes, usize length);

/** Internal Body-state hooks shared with the Fetch runtime. */
bool mal_readable_stream_is_locked(MalValue value);
bool mal_readable_stream_is_disturbed(MalValue value);
bool mal_readable_stream_consume(MalVm *vm, MalValue value);

/** Internal reader algorithms used by Fetch Body consumption. */
MalValue mal_readable_stream_acquire_default_reader(MalVm *vm, MalValue value);
MalValue mal_readable_stream_default_reader_read(MalVm *vm, MalValue value);

/** Create a distinct stream that forwards reads and cancellation to `value`. */
MalValue mal_readable_stream_create_proxy(MalVm *vm, MalValue value);

/** Tee `value` into two independently consumable default streams. */
bool mal_readable_stream_tee(
    MalVm *vm, MalValue value, MalValue *branch1_out, MalValue *branch2_out);
