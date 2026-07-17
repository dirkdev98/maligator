#pragma once

#include "object.h"

typedef struct MalVm MalVm;

typedef enum MalReadableStreamKind : u8 {
    MAL_READABLE_STREAM,
    MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
    MAL_READABLE_STREAM_DEFAULT_READER,
} MalReadableStreamKind;

typedef enum MalReadableStreamState : u8 {
    MAL_READABLE_STREAM_READABLE,
    MAL_READABLE_STREAM_CLOSED,
    MAL_READABLE_STREAM_ERRORED,
} MalReadableStreamState;

typedef struct MalReadableStreamQueueEntry {
    struct MalReadableStreamQueueEntry *next;
    MalValue chunk;
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
        } stream;
        struct {
            MalValue stream;
            MalValue underlying_source;
            MalValue pull_method;
            MalValue cancel_method;
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
    } as;
} MalReadableStreamObject;

/** Install ReadableStream and its default controller/reader globals. */
void mal_readable_stream_install(MalVm *vm, MalObject *global_this);
