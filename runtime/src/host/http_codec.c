#include "http_codec.h"

#include <stdlib.h>
#include <string.h>

#include "../perf_stats.h"

static_assert(LLHTTP_VERSION_MAJOR == 9 && LLHTTP_VERSION_MINOR == 4
                  && LLHTTP_VERSION_PATCH == 3,
              "update the pinned llhttp ABI assertion");
static_assert(sizeof(MalHttpCodecHead) <= 2048,
              "the HTTP head common case should remain below 2 KiB");

static MalHttpCodec *codec_from_parser(llhttp_t *parser) {
    return parser->data;
}

static bool codec_head_reserve(MalHttpCodec *codec, usize added) {
    if (codec->head == nullptr || added > MAL_HTTP_CODEC_HEAD_MAX
        || codec->head->arena_length > MAL_HTTP_CODEC_HEAD_MAX - added) {
        return false;
    }
    usize required = codec->head->arena_length + added;
    if (required <= codec->head->arena_capacity) return true;
    usize capacity = codec->head->arena_capacity;
    while (capacity < required) {
        if (capacity > MAL_HTTP_CODEC_HEAD_MAX / 2) {
            capacity = MAL_HTTP_CODEC_HEAD_MAX;
            break;
        }
        capacity *= 2;
    }
    byte *arena;
    if (codec->head->arena == codec->head->inline_arena) {
        arena = malloc(capacity);
        if (arena != nullptr) {
            memcpy(arena, codec->head->inline_arena, codec->head->arena_length);
        }
    } else {
        arena = realloc(codec->head->arena, capacity);
    }
    if (arena == nullptr) return false;
    codec->head->arena = arena;
    codec->head->arena_capacity = capacity;
    MAL_PERF_COUNT(http_codec_arena_spills);
    return true;
}

static bool codec_fields_reserve(MalHttpCodecHead *head, usize required) {
    if (required > MAL_HTTP_CODEC_FIELDS_MAX) return false;
    if (required <= head->field_capacity) return true;
    usize capacity = head->field_capacity;
    while (capacity < required) {
        capacity *= 2;
    }
    if (capacity > MAL_HTTP_CODEC_FIELDS_MAX) {
        capacity = MAL_HTTP_CODEC_FIELDS_MAX;
    }
    MalHttpCodecField *fields;
    if (head->fields == head->inline_fields) {
        fields = malloc(capacity * sizeof(*fields));
        if (fields != nullptr) {
            memcpy(fields, head->inline_fields,
                   head->field_count * sizeof(*fields));
        }
    } else {
        fields = realloc(head->fields, capacity * sizeof(*fields));
    }
    if (fields == nullptr) return false;
    head->fields = fields;
    head->field_capacity = capacity;
    MAL_PERF_COUNT(http_codec_field_spills);
    return true;
}

static bool codec_head_append(
    MalHttpCodec *codec, const char *bytes, usize length, usize *offset) {
    if (!codec_head_reserve(codec, length)) return false;
    if (offset != nullptr) *offset = codec->head->arena_length;
    if (length > 0) {
        memcpy(codec->head->arena + codec->head->arena_length, bytes, length);
    }
    codec->head->arena_length += length;
    return true;
}

static int codec_fail(llhttp_t *parser, const char *reason) {
    llhttp_set_error_reason(parser, reason);
    return HPE_USER;
}

static int codec_message_begin(llhttp_t *parser) {
    MalHttpCodec *codec = codec_from_parser(parser);
    if (codec->head != nullptr || codec->event_head != nullptr) {
        return codec_fail(parser, "HTTP head was not consumed");
    }
    codec->head = calloc(1, sizeof(*codec->head));
    if (codec->head == nullptr) return codec_fail(parser, "HTTP head allocation failed");
    codec->head->arena = codec->head->inline_arena;
    codec->head->arena_capacity = MAL_HTTP_CODEC_INLINE_ARENA;
    codec->head->fields = codec->head->inline_fields;
    codec->head->field_capacity = MAL_HTTP_CODEC_INLINE_FIELDS;
    codec->head->content_length = -1;
    MAL_PERF_COUNT(http_codec_head_allocations);
    codec->skip_header_bytes = false;
    codec->header_name_open = false;
    return 0;
}

static int codec_url(llhttp_t *parser, const char *at, size_t length) {
    MalHttpCodec *codec = codec_from_parser(parser);
    MalHttpCodecHead *head = codec->head;
    if (head == nullptr) return codec_fail(parser, "HTTP URL without a head");
    if (head->target_length == 0) head->target_offset = head->arena_length;
    if (!codec_head_append(codec, at, length, nullptr)) {
        return codec_fail(parser, "HTTP head exceeds its limit");
    }
    head->target_length += length;
    return 0;
}

static int codec_status(llhttp_t *parser, const char *at, size_t length) {
    MalHttpCodec *codec = codec_from_parser(parser);
    MalHttpCodecHead *head = codec->head;
    if (head == nullptr) return codec_fail(parser, "HTTP status without a head");
    if (head->status_length == 0) head->status_offset = head->arena_length;
    if (!codec_head_append(codec, at, length, nullptr)) {
        return codec_fail(parser, "HTTP head exceeds its limit");
    }
    head->status_length += length;
    return 0;
}

static int codec_header_field(llhttp_t *parser, const char *at, size_t length) {
    MalHttpCodec *codec = codec_from_parser(parser);
    if (codec->head == nullptr) {
        codec->skip_header_bytes = true;
        return 0;
    }
    MalHttpCodecHead *head = codec->head;
    if (!codec->header_name_open) {
        if (head->field_count == MAL_HTTP_CODEC_FIELDS_MAX) {
            return codec_fail(parser, "HTTP field count exceeds its limit");
        }
        if (!codec_fields_reserve(head, head->field_count + 1)) {
            return codec_fail(parser, "HTTP field allocation failed");
        }
        MalHttpCodecField *field = &head->fields[head->field_count++];
        *field = (MalHttpCodecField) { .value_offset = SIZE_MAX };
        field->name_offset = head->arena_length;
    }
    codec->header_name_open = true;
    MalHttpCodecField *field = &head->fields[head->field_count - 1];
    if (length > MAL_HTTP_CODEC_FIELD_MAX
        || field->name_length > MAL_HTTP_CODEC_FIELD_MAX - length) {
        return codec_fail(parser, "HTTP field name exceeds its limit");
    }
    if (!codec_head_append(codec, at, length, nullptr)) {
        return codec_fail(parser, "HTTP head exceeds its limit");
    }
    field->name_length += length;
    return 0;
}

static int codec_header_field_complete(llhttp_t *parser) {
    MalHttpCodec *codec = codec_from_parser(parser);
    codec->header_name_open = false;
    return 0;
}

static int codec_header_value(llhttp_t *parser, const char *at, size_t length) {
    MalHttpCodec *codec = codec_from_parser(parser);
    if (codec->skip_header_bytes) return 0;
    MalHttpCodecHead *head = codec->head;
    if (head == nullptr || head->field_count == 0) {
        return codec_fail(parser, "HTTP field value without a name");
    }
    MalHttpCodecField *field = &head->fields[head->field_count - 1];
    if (field->value_offset == SIZE_MAX) field->value_offset = head->arena_length;
    if (length > MAL_HTTP_CODEC_FIELD_MAX
        || field->value_length > MAL_HTTP_CODEC_FIELD_MAX - length) {
        return codec_fail(parser, "HTTP field value exceeds its limit");
    }
    if (!codec_head_append(codec, at, length, nullptr)) {
        return codec_fail(parser, "HTTP head exceeds its limit");
    }
    field->value_length += length;
    return 0;
}

static int codec_headers_complete(llhttp_t *parser) {
    MalHttpCodec *codec = codec_from_parser(parser);
    MalHttpCodecHead *head = codec->head;
    if (head == nullptr) return codec_fail(parser, "HTTP headers without a head");
    const char *method = llhttp_method_name((llhttp_method_t) parser->method);
    if (parser->type == HTTP_REQUEST) {
        if (method == nullptr
            || !codec_head_append(
                codec, method, strlen(method), &head->method_offset)) {
            return codec_fail(parser, "HTTP method allocation failed");
        }
        head->method_length = strlen(method);
    }
    head->status_code = parser->status_code;
    head->major_version = parser->http_major;
    head->minor_version = parser->http_minor;
    head->chunked = (parser->flags & F_CHUNKED) != 0;
    if ((parser->flags & F_CONTENT_LENGTH) != 0
        && parser->content_length > INT64_MAX) {
        return codec_fail(parser, "HTTP content length exceeds its limit");
    }
    head->content_length = (parser->flags & F_CONTENT_LENGTH) != 0
        ? (i64) parser->content_length : -1;
    head->keep_alive = llhttp_should_keep_alive(parser) != 0;
    head->upgrade = parser->upgrade != 0;
    if (parser->type == HTTP_RESPONSE && codec->skip_body) {
        parser->flags |= F_SKIPBODY;
    }
    for (usize i = 0; i < head->field_count; i++) {
        if (head->fields[i].value_offset == SIZE_MAX) {
            head->fields[i].value_offset = head->arena_length;
        }
    }
    codec->event_head = head;
    codec->head = nullptr;
    if (mal_perf_stats_enabled) {
        if (head->field_count > mal_perf_stats.http_codec_max_fields) {
            mal_perf_stats.http_codec_max_fields = head->field_count;
        }
        if (head->arena_length > mal_perf_stats.http_codec_max_head_bytes) {
            mal_perf_stats.http_codec_max_head_bytes = head->arena_length;
        }
    }
    codec->event = MAL_HTTP_CODEC_EVENT_HEAD;
    return HPE_PAUSED;
}

static int codec_body(llhttp_t *parser, const char *at, size_t length) {
    MalHttpCodec *codec = codec_from_parser(parser);
    if (length == 0) return 0;
    if (length > MAL_HTTP_CODEC_BODY_MAX
        || codec->event_body_length > MAL_HTTP_CODEC_BODY_MAX - length) {
        return codec_fail(parser, "HTTP body event exceeds its limit");
    }
    usize required = codec->event_body_length + length;
    if (required > codec->event_body_capacity) {
        usize capacity = codec->event_body_capacity == 0 ? 1024
            : codec->event_body_capacity;
        while (capacity < required) {
            if (capacity > MAL_HTTP_CODEC_BODY_MAX / 2) {
                capacity = MAL_HTTP_CODEC_BODY_MAX;
                break;
            }
            capacity *= 2;
        }
        byte *body = realloc(codec->event_body, capacity);
        if (body == nullptr) {
            return codec_fail(parser, "HTTP body allocation failed");
        }
        codec->event_body = body;
        codec->event_body_capacity = capacity;
        MAL_PERF_COUNT(http_codec_body_growths);
    }
    memcpy(codec->event_body + codec->event_body_length, at, length);
    codec->event_body_length = required;
    return 0;
}

static int codec_message_complete(llhttp_t *parser) {
    MalHttpCodec *codec = codec_from_parser(parser);
    if (codec->event_body_length > 0) {
        codec->complete_pending = true;
    } else {
        codec->event = MAL_HTTP_CODEC_EVENT_COMPLETE;
    }
    return HPE_PAUSED;
}

bool mal_http_codec_init(MalHttpCodec *codec, llhttp_type_t type) {
    if (codec == nullptr || (type != HTTP_REQUEST && type != HTTP_RESPONSE)) {
        return false;
    }
    memset(codec, 0, sizeof(*codec));
    llhttp_settings_init(&codec->settings);
    codec->settings.on_message_begin = codec_message_begin;
    codec->settings.on_url = codec_url;
    codec->settings.on_status = codec_status;
    codec->settings.on_header_field = codec_header_field;
    codec->settings.on_header_field_complete = codec_header_field_complete;
    codec->settings.on_header_value = codec_header_value;
    codec->settings.on_headers_complete = codec_headers_complete;
    codec->settings.on_body = codec_body;
    codec->settings.on_message_complete = codec_message_complete;
    llhttp_init(&codec->parser, type, &codec->settings);
    codec->parser.data = codec;
    return true;
}

void mal_http_codec_set_skip_body(MalHttpCodec *codec, bool skip_body) {
    if (codec != nullptr) codec->skip_body = skip_body;
}

void mal_http_codec_head_free(MalHttpCodecHead *head) {
    if (head == nullptr) return;
    if (head->arena != head->inline_arena) free(head->arena);
    if (head->fields != head->inline_fields) free(head->fields);
    free(head);
}

void mal_http_codec_free(MalHttpCodec *codec) {
    if (codec == nullptr) return;
    mal_http_codec_head_free(codec->head);
    mal_http_codec_head_free(codec->event_head);
    free(codec->event_body);
    memset(codec, 0, sizeof(*codec));
}

static MalHttpCodecResult codec_publish_result(
    MalHttpCodec *codec, llhttp_errno_t error,
    const byte *bytes, usize length, usize *consumed) {
    if (error == HPE_PAUSED) {
        const char *position = llhttp_get_error_pos(&codec->parser);
        *consumed = position == nullptr ? length : (usize) (position - (const char *) bytes);
        codec->paused = true;
    } else if (error != HPE_OK) {
        return MAL_HTTP_CODEC_ERROR;
    } else {
        *consumed = length;
    }
    if (codec->event == MAL_HTTP_CODEC_EVENT_HEAD
        || codec->event == MAL_HTTP_CODEC_EVENT_COMPLETE) {
        return MAL_HTTP_CODEC_EVENT;
    }
    if (codec->event_body_length > 0) {
        codec->event = MAL_HTTP_CODEC_EVENT_BODY;
        return MAL_HTTP_CODEC_EVENT;
    }
    return MAL_HTTP_CODEC_OK;
}

MalHttpCodecResult mal_http_codec_execute(
    MalHttpCodec *codec, const byte *bytes, usize length, usize *consumed) {
    if (codec == nullptr || consumed == nullptr
        || (bytes == nullptr && length != 0)
        || codec->event != MAL_HTTP_CODEC_EVENT_NONE) {
        return MAL_HTTP_CODEC_ERROR;
    }
    *consumed = 0;
    if (codec->complete_pending) {
        codec->complete_pending = false;
        codec->event = MAL_HTTP_CODEC_EVENT_COMPLETE;
        return MAL_HTTP_CODEC_EVENT;
    }
    if (length > MAL_HTTP_CODEC_BODY_MAX) length = MAL_HTTP_CODEC_BODY_MAX;
    if (codec->paused) {
        llhttp_resume(&codec->parser);
        codec->paused = false;
    }
    const char *input = length == 0 ? "" : (const char *) bytes;
    llhttp_errno_t error = llhttp_execute(&codec->parser, input, length);
    return codec_publish_result(
        codec, error, (const byte *) input, length, consumed);
}

MalHttpCodecResult mal_http_codec_finish(MalHttpCodec *codec) {
    if (codec == nullptr || codec->event != MAL_HTTP_CODEC_EVENT_NONE) {
        return MAL_HTTP_CODEC_ERROR;
    }
    if (codec->complete_pending) {
        codec->complete_pending = false;
        codec->event = MAL_HTTP_CODEC_EVENT_COMPLETE;
        return MAL_HTTP_CODEC_EVENT;
    }
    if (codec->paused) {
        llhttp_resume(&codec->parser);
        codec->paused = false;
    }
    llhttp_errno_t error = llhttp_finish(&codec->parser);
    if (error != HPE_OK && error != HPE_PAUSED) return MAL_HTTP_CODEC_ERROR;
    if (error == HPE_PAUSED) codec->paused = true;
    if (codec->event_body_length > 0) codec->event = MAL_HTTP_CODEC_EVENT_BODY;
    return codec->event == MAL_HTTP_CODEC_EVENT_NONE
        ? MAL_HTTP_CODEC_OK : MAL_HTTP_CODEC_EVENT;
}

MalHttpCodecEventKind mal_http_codec_event(const MalHttpCodec *codec) {
    return codec == nullptr ? MAL_HTTP_CODEC_EVENT_NONE : codec->event;
}

MalHttpCodecHead *mal_http_codec_take_head(MalHttpCodec *codec) {
    if (codec == nullptr || codec->event != MAL_HTTP_CODEC_EVENT_HEAD) return nullptr;
    MalHttpCodecHead *head = codec->event_head;
    codec->event_head = nullptr;
    codec->event = MAL_HTTP_CODEC_EVENT_NONE;
    return head;
}

byte *mal_http_codec_take_body(MalHttpCodec *codec, usize *length) {
    if (codec == nullptr || length == nullptr
        || codec->event != MAL_HTTP_CODEC_EVENT_BODY) {
        return nullptr;
    }
    byte *body = codec->event_body;
    *length = codec->event_body_length;
    codec->event_body = nullptr;
    codec->event_body_length = 0;
    codec->event_body_capacity = 0;
    codec->event = MAL_HTTP_CODEC_EVENT_NONE;
    return body;
}

void mal_http_codec_clear_event(MalHttpCodec *codec) {
    if (codec == nullptr) return;
    if (codec->event == MAL_HTTP_CODEC_EVENT_HEAD) {
        mal_http_codec_head_free(codec->event_head);
        codec->event_head = nullptr;
    } else if (codec->event == MAL_HTTP_CODEC_EVENT_BODY) {
        free(codec->event_body);
        codec->event_body = nullptr;
        codec->event_body_length = 0;
        codec->event_body_capacity = 0;
    }
    codec->event = MAL_HTTP_CODEC_EVENT_NONE;
}

const byte *mal_http_codec_head_method(const MalHttpCodecHead *head) {
    return head == nullptr ? nullptr : head->arena + head->method_offset;
}

const byte *mal_http_codec_head_target(const MalHttpCodecHead *head) {
    return head == nullptr ? nullptr : head->arena + head->target_offset;
}

const byte *mal_http_codec_head_status(const MalHttpCodecHead *head) {
    return head == nullptr ? nullptr : head->arena + head->status_offset;
}

const byte *mal_http_codec_field_name(
    const MalHttpCodecHead *head, const MalHttpCodecField *field) {
    return head == nullptr || field == nullptr ? nullptr
        : head->arena + field->name_offset;
}

const byte *mal_http_codec_field_value(
    const MalHttpCodecHead *head, const MalHttpCodecField *field) {
    return head == nullptr || field == nullptr ? nullptr
        : head->arena + field->value_offset;
}
