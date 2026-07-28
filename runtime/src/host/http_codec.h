#pragma once

#include "./defaults.h"
#include "llhttp.h"

#define MAL_HTTP_CODEC_HEAD_MAX (64 * 1024)
#define MAL_HTTP_CODEC_FIELD_MAX (16 * 1024)
#define MAL_HTTP_CODEC_FIELDS_MAX 256
#define MAL_HTTP_CODEC_BODY_MAX (64 * 1024)

typedef struct MalHttpCodecField {
    usize name_offset;
    usize name_length;
    usize value_offset;
    usize value_length;
} MalHttpCodecField;

typedef struct MalHttpCodecHead {
    byte *arena;
    usize arena_length;
    usize method_offset;
    usize method_length;
    usize target_offset;
    usize target_length;
    usize status_offset;
    usize status_length;
    MalHttpCodecField fields[MAL_HTTP_CODEC_FIELDS_MAX];
    usize field_count;
    i64 content_length;
    int status_code;
    int major_version;
    int minor_version;
    bool chunked;
    bool keep_alive;
    bool upgrade;
} MalHttpCodecHead;

typedef enum MalHttpCodecEventKind {
    MAL_HTTP_CODEC_EVENT_NONE = 0,
    MAL_HTTP_CODEC_EVENT_HEAD,
    MAL_HTTP_CODEC_EVENT_BODY,
    MAL_HTTP_CODEC_EVENT_COMPLETE,
} MalHttpCodecEventKind;

typedef enum MalHttpCodecResult {
    MAL_HTTP_CODEC_OK = 0,
    MAL_HTTP_CODEC_EVENT,
    MAL_HTTP_CODEC_ERROR,
} MalHttpCodecResult;

typedef struct MalHttpCodec {
    llhttp_t parser;
    llhttp_settings_t settings;
    MalHttpCodecHead *head;
    MalHttpCodecHead *event_head;
    byte *event_body;
    usize event_body_length;
    usize arena_capacity;
    MalHttpCodecEventKind event;
    bool paused;
    bool complete_pending;
    bool skip_header_bytes;
    bool header_name_open;
    bool skip_body;
} MalHttpCodec;

bool mal_http_codec_init(MalHttpCodec *codec, llhttp_type_t type);
void mal_http_codec_set_skip_body(MalHttpCodec *codec, bool skip_body);
void mal_http_codec_free(MalHttpCodec *codec);

/* Execute at most one bounded input slice. `consumed` is always relative to the
 * supplied slice. An event remains owned by the codec until taken or cleared. */
MalHttpCodecResult mal_http_codec_execute(
    MalHttpCodec *codec, const byte *bytes, usize length, usize *consumed);
MalHttpCodecResult mal_http_codec_finish(MalHttpCodec *codec);

MalHttpCodecEventKind mal_http_codec_event(const MalHttpCodec *codec);
MalHttpCodecHead *mal_http_codec_take_head(MalHttpCodec *codec);
byte *mal_http_codec_take_body(MalHttpCodec *codec, usize *length);
void mal_http_codec_clear_event(MalHttpCodec *codec);

const byte *mal_http_codec_head_method(const MalHttpCodecHead *head);
const byte *mal_http_codec_head_target(const MalHttpCodecHead *head);
const byte *mal_http_codec_head_status(const MalHttpCodecHead *head);
const byte *mal_http_codec_field_name(
    const MalHttpCodecHead *head, const MalHttpCodecField *field);
const byte *mal_http_codec_field_value(
    const MalHttpCodecHead *head, const MalHttpCodecField *field);
void mal_http_codec_head_free(MalHttpCodecHead *head);
