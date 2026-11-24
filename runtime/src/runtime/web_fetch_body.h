#pragma once

#include "vm.h"

typedef struct MalFetchBody {
    MalObject *owner;
    byte *bytes;
    usize length;
    MalValue *stream;
    bool *used;
} MalFetchBody;

typedef enum MalFetchBodyConsumeKind {
    MAL_FETCH_BODY_CONSUME_TEXT,
    MAL_FETCH_BODY_CONSUME_JSON,
    MAL_FETCH_BODY_CONSUME_ARRAY_BUFFER,
    MAL_FETCH_BODY_CONSUME_BYTES,
    MAL_FETCH_BODY_CONSUME_BLOB,
    MAL_FETCH_BODY_CONSUME_FORM_DATA,
} MalFetchBodyConsumeKind;

typedef struct MalFetchStreamOps {
    MalObject *(*ensure)(MalVm *vm);
    MalValue (*from_bytes)(MalVm *vm, const byte *bytes, usize length);
    MalValue (*from_node_body)(MalVm *vm, MalValue body);
    bool (*consume)(MalVm *vm, MalValue stream);
    MalValue (*proxy)(MalVm *vm, MalValue stream);
    bool (*tee)(MalVm *vm, MalValue stream, MalValue *first, MalValue *second);
    MalValue (*collect)(MalVm *vm, MalValue self, MalFetchBody *body, MalFetchBodyConsumeKind kind);
} MalFetchStreamOps;

extern const MalFetchStreamOps *mal_fetch_streams;

MalValue mal_fetch_new_uint8array(MalVm *vm, const byte *data, usize len);
MalValue mal_fetch_reject_type_error(MalVm *vm);
MalValue mal_fetch_collect_conversion(
    MalVm *vm, MalValue self, MalFetchBody *body, MalFetchBodyConsumeKind kind);

void mal_host_install_web_fetch_streams(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
