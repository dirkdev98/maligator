#include "utf8.h"

#include <stdlib.h>
#include <string.h>

#include "heap_string.h"
#include "text_buffer.h"
#include "utf16.h"

usize mal_utf8_encoded_length(const c16 *units, usize len) {
    usize output_length = 0;
    for (usize index = 0; index < len; index++) {
        u32 scalar;
        usize width;
        if (!mal_utf16_read_scalar(units, len, index, &scalar, &width)) {
            scalar = 0xFFFD;
        }
        index += width - 1;
        output_length += scalar < 0x80 ? 1
            : scalar < 0x800 ? 2
            : scalar < 0x10000 ? 3 : 4;
    }
    return output_length;
}

byte *mal_utf8_encode(const c16 *units, usize len, usize *out_len) {
    *out_len = 0;
    if (len > (SIZE_MAX - 1) / 3) return nullptr;
    byte *out = malloc(len * 3 + 1); // <= 3 bytes/BMP unit; a surrogate pair is 2 units -> 4 bytes
    if (out == nullptr) return nullptr;
    mal_utf8_encode_into(units, len, out, len * 3 + 1, nullptr, out_len);
    return out;
}

void mal_utf8_encode_into(
    const c16 *units, usize len, byte *output, usize capacity,
    usize *read_out, usize *written_out
) {
    usize read = 0;
    usize written = 0;
    while (read < len) {
        u32 c;
        usize width;
        if (!mal_utf16_read_scalar(units, len, read, &c, &width)) c = 0xFFFD;
        usize encoded_width = c < 0x80 ? 1
            : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (encoded_width > capacity - written) {
            break;
        }
        if (c < 0x80) {
            output[written] = (byte) c;
        } else if (c < 0x800) {
            output[written] = (byte) (0xC0 | (c >> 6));
            output[written + 1] = (byte) (0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            output[written] = (byte) (0xE0 | (c >> 12));
            output[written + 1] = (byte) (0x80 | ((c >> 6) & 0x3F));
            output[written + 2] = (byte) (0x80 | (c & 0x3F));
        } else {
            output[written] = (byte) (0xF0 | (c >> 18));
            output[written + 1] = (byte) (0x80 | ((c >> 12) & 0x3F));
            output[written + 2] = (byte) (0x80 | ((c >> 6) & 0x3F));
            output[written + 3] = (byte) (0x80 | (c & 0x3F));
        }
        read += width;
        written += encoded_width;
    }
    if (read_out != nullptr) *read_out = read;
    if (written_out != nullptr) *written_out = written;
}

c16 *mal_utf8_decode(const byte *bytes, usize len, usize *out_count) {
    bool had_error;
    return mal_utf8_decode_report(bytes, len, out_count, &had_error);
}

static u32 mal_utf8_read_scalar(
    const byte *bytes, usize len, usize *offset, bool *had_error
) {
    usize i = *offset;
    u8 b = (u8) bytes[i];
    u32 cp;
    usize n = 1;
    u8 second_min = 0x80;
    u8 second_max = 0xBF;
    if (b < 0x80) {
        cp = b;
    } else if (b >= 0xC2 && b <= 0xDF) {
        cp = b & 0x1Fu;
        n = 2;
    } else if (b >= 0xE0 && b <= 0xEF) {
        cp = b & 0x0Fu;
        n = 3;
        if (b == 0xE0) second_min = 0xA0;
        if (b == 0xED) second_max = 0x9F;
    } else if (b >= 0xF0 && b <= 0xF4) {
        cp = b & 0x07u;
        n = 4;
        if (b == 0xF0) second_min = 0x90;
        if (b == 0xF4) second_max = 0x8F;
    } else {
        cp = 0xFFFD;
        *had_error = true;
    }
    if (n > 1) {
        usize consumed = 1;
        for (usize k = 1; k < n; k++) {
            if (k >= len - i) {
                cp = 0xFFFD;
                n = consumed;
                *had_error = true;
                break;
            }
            u8 cont = (u8) bytes[i + k];
            u8 minimum = k == 1 ? second_min : 0x80;
            u8 maximum = k == 1 ? second_max : 0xBF;
            if (cont < minimum || cont > maximum) {
                cp = 0xFFFD;
                n = consumed;
                *had_error = true;
                break;
            }
            cp = (cp << 6) | (cont & 0x3Fu);
            consumed++;
        }
    }
    *offset = i + n;
    return cp;
}

bool mal_utf8_is_valid(const byte *bytes, usize len) {
    usize offset = 0;
    bool had_error = false;
    while (offset < len && !had_error) {
        mal_utf8_read_scalar(bytes, len, &offset, &had_error);
    }
    return !had_error;
}

c16 *mal_utf8_decode_report(const byte *bytes, usize len, usize *out_count, bool *had_error) {
    *out_count = 0;
    *had_error = false;
    if (len > SIZE_MAX / sizeof(c16) - 1) return nullptr;
    c16 *out = malloc(sizeof(c16) * (len + 1));
    if (out == nullptr) return nullptr;
    usize o = 0;
    usize i = 0;
    while (i < len) {
        u32 cp = mal_utf8_read_scalar(bytes, len, &i, had_error);
        if (cp <= 0xFFFF) {
            out[o++] = (c16) cp;
        } else {
            mal_utf16_emit_pair(cp, out + o);
            o += 2;
        }
    }
    *out_count = o;
    return out;
}

typedef struct MalUtf8StringCursor {
    MalStringIterator iterator;
    MalStringSegment segment;
    usize offset;
} MalUtf8StringCursor;

/** First index in [start, end) whose byte is not ASCII, or `end`. Word tests only
 * pay off for long runs, so callers keep byte loops for the short runs between
 * multi-byte sequences. */
static usize mal_utf8_ascii_run_end(const u8 *bytes, usize start, usize end) {
    const u64 high_bits = UINT64_C(0x8080808080808080);
    usize i = start;
    for (; end - i >= 32; i += 32) {
        u64 words[4];
        memcpy(words, bytes + i, sizeof(words));
        if (((words[0] | words[1] | words[2] | words[3]) & high_bits) != 0) break;
    }
    for (; end - i >= 8; i += 8) {
        u64 word;
        memcpy(&word, bytes + i, sizeof(word));
        if ((word & high_bits) != 0) break;
    }
    while (i < end && bytes[i] < 0x80) i++;
    return i;
}

static bool mal_utf8_string_cursor_ready(MalUtf8StringCursor *cursor) {
    if (cursor->offset < cursor->segment.length) return true;
    cursor->offset = 0;
    if (mal_string_iterator_next(&cursor->iterator, &cursor->segment)) return true;
    cursor->segment.length = 0;
    return false;
}

static usize mal_utf8_scalar_width(u32 scalar) {
    return scalar < 0x80 ? 1 : scalar < 0x800 ? 2 : scalar < 0x10000 ? 3 : 4;
}

static void mal_utf8_write_scalar(byte *output, u32 scalar, usize width) {
    if (width == 1) {
        output[0] = (byte) scalar;
    } else if (width == 2) {
        output[0] = (byte) (0xC0 | (scalar >> 6));
        output[1] = (byte) (0x80 | (scalar & 0x3F));
    } else if (width == 3) {
        output[0] = (byte) (0xE0 | (scalar >> 12));
        output[1] = (byte) (0x80 | ((scalar >> 6) & 0x3F));
        output[2] = (byte) (0x80 | (scalar & 0x3F));
    } else {
        output[0] = (byte) (0xF0 | (scalar >> 18));
        output[1] = (byte) (0x80 | ((scalar >> 12) & 0x3F));
        output[2] = (byte) (0x80 | ((scalar >> 6) & 0x3F));
        output[3] = (byte) (0x80 | (scalar & 0x3F));
    }
}

static void mal_string_utf8_process(
    const MalString *string, byte *output, usize capacity,
    usize *read_out, usize *written_out
) {
    MalUtf8StringCursor cursor = {0};
    mal_string_iterator_init(&cursor.iterator, string, 0, mal_string_length(string));
    usize read = 0;
    usize written = 0;
    bool all_fits = mal_string_length(string) <= capacity / 3;
    while (written < capacity && mal_utf8_string_cursor_ready(&cursor)) {
        if (cursor.segment.latin1) {
            const u8 *units = cursor.segment.latin1_units;
            usize start = cursor.offset;
            usize available = cursor.segment.length - start;
            if (!all_fits && available > capacity - written) available = capacity - written;
            usize end = start + available;
            if (start == 0) {
                cursor.offset = mal_utf8_ascii_run_end(units, 0, end);
            } else {
                while (cursor.offset < end && units[cursor.offset] < 0x80) cursor.offset++;
            }
            usize count = cursor.offset - start;
            if (count != 0) {
                if (output != nullptr) memcpy(output + written, units + start, count);
                read += count;
                written += count;
                continue;
            }
            while (cursor.offset < cursor.segment.length && units[cursor.offset] >= 0x80) {
                if (!all_fits && capacity - written < 2) goto finished;
                u8 unit = units[cursor.offset++];
                if (output != nullptr) {
                    output[written] = (byte) (0xC0 | (unit >> 6));
                    output[written + 1] = (byte) (0x80 | (unit & 0x3F));
                }
                read++;
                written += 2;
            }
            continue;
        }
        while (cursor.offset < cursor.segment.length) {
            c16 unit = cursor.segment.utf16_units[cursor.offset];
            if (mal_utf16_is_lead_surrogate(unit)) break;
            u32 scalar = mal_utf16_is_trail_surrogate(unit) ? 0xFFFD : unit;
            usize encoded_width = mal_utf8_scalar_width(scalar);
            if (!all_fits && encoded_width > capacity - written) goto finished;
            if (output != nullptr) mal_utf8_write_scalar(output + written, scalar, encoded_width);
            cursor.offset++;
            read++;
            written += encoded_width;
        }
        if (cursor.offset == cursor.segment.length) continue;

        c16 first = mal_string_segment_code_unit_at(&cursor.segment, cursor.offset++);
        u32 scalar = first;
        usize width = 1;
        if (mal_utf16_is_lead_surrogate(first)) {
            // A pair can span any two leaves, including a slice of a rope.
            if (mal_utf8_string_cursor_ready(&cursor)) {
                c16 second = mal_string_segment_code_unit_at(&cursor.segment, cursor.offset);
                if (mal_utf16_is_trail_surrogate(second)) {
                    cursor.offset++;
                    scalar = mal_utf16_compose_pair(first, second);
                    width = 2;
                } else {
                    scalar = 0xFFFD;
                }
            } else {
                scalar = 0xFFFD;
            }
        } else if (mal_utf16_is_trail_surrogate(first)) {
            scalar = 0xFFFD;
        }
        usize encoded_width = mal_utf8_scalar_width(scalar);
        if (!all_fits && encoded_width > capacity - written) break;
        if (output != nullptr) mal_utf8_write_scalar(output + written, scalar, encoded_width);
        read += width;
        written += encoded_width;
    }
finished:
    mal_string_iterator_dispose(&cursor.iterator);
    if (read_out != nullptr) *read_out = read;
    if (written_out != nullptr) *written_out = written;
}

void mal_string_utf8_encode_into(
    const MalString *string, byte *output, usize capacity,
    usize *read_out, usize *written_out
) {
    mal_string_utf8_process(string, output, capacity, read_out, written_out);
}

byte *mal_string_to_utf8(const MalString *string, usize *out_len) {
    *out_len = 0;
    usize length = mal_string_length(string);
    if (length > (SIZE_MAX - 1) / 3) return nullptr;
    byte *bytes = malloc(length * 3 + 1);
    if (bytes == nullptr) return nullptr;
    mal_string_utf8_encode_into(string, bytes, length * 3 + 1, nullptr, out_len);
    return bytes;
}

usize mal_string_utf8_length(const MalString *string) {
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, mal_string_length(string));
    u64 length = 0;
    bool pending_lead = false;
    while (mal_string_iterator_next(&iterator, &segment)) {
        if (segment.latin1) {
            if (pending_lead) {
                length += 3;
                pending_lead = false;
            }
            length += segment.length;
            for (usize i = 0; i < segment.length; i++) {
                length += segment.latin1_units[i] >> 7;
            }
            continue;
        }
        for (usize i = 0; i < segment.length; i++) {
            c16 unit = segment.utf16_units[i];
            if (pending_lead) {
                pending_lead = false;
                if (mal_utf16_is_trail_surrogate(unit)) {
                    length += 4;
                    continue;
                }
                length += 3;
            }
            if (mal_utf16_is_lead_surrogate(unit)) pending_lead = true;
            else length += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
        }
    }
    mal_string_iterator_dispose(&iterator);
    if (pending_lead) length += 3;
    return length > SIZE_MAX ? SIZE_MAX : (usize) length;
}

static inline usize mal_utf8_ascii_count(const byte *bytes, usize start, usize stop) {
    usize end = start;
    while (end < stop && (u8) bytes[end] < 0x80) end++;
    return end - start;
}

// Decodes well-formed sequences that fit the buffer's encoding without growth;
// everything else stops the run so the scalar path classifies it. Kept out of
// line so the scalar decoder stays within its inlining budget.
__attribute__((noinline))
static usize mal_utf8_decode_run(MalTextBuffer *buffer, const byte *bytes, usize len, usize i) {
    usize output = buffer->length;
    // A sequence never yields more units than bytes, so this byte budget fits the capacity.
    usize stop = len - i > buffer->capacity - output ? i + (buffer->capacity - output) : len;
    if (buffer->utf16) {
        c16 *units = buffer->data;
        while (i < stop) {
            u8 lead = (u8) bytes[i];
            if (lead < 0x80) {
                usize run = mal_utf8_ascii_count(bytes, i, stop);
                for (usize k = 0; k < run; k++) units[output + k] = (u8) bytes[i + k];
                output += run;
                i += run;
            } else if (lead >= 0xc2 && lead <= 0xdf) {
                if (stop - i < 2 || ((u8) bytes[i + 1] & 0xc0) != 0x80) break;
                units[output++] = (c16) (((lead & 0x1fu) << 6) | ((u8) bytes[i + 1] & 0x3fu));
                i += 2;
            } else if (lead >= 0xe0 && lead <= 0xef) {
                if (stop - i < 3 || ((u8) bytes[i + 1] & 0xc0) != 0x80 ||
                    ((u8) bytes[i + 2] & 0xc0) != 0x80) break;
                u32 cp = ((lead & 0x0fu) << 12) | (((u8) bytes[i + 1] & 0x3fu) << 6) |
                    ((u8) bytes[i + 2] & 0x3fu);
                if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) break;
                units[output++] = (c16) cp;
                i += 3;
            } else if (lead >= 0xf0 && lead <= 0xf4) {
                if (stop - i < 4 || ((u8) bytes[i + 1] & 0xc0) != 0x80 ||
                    ((u8) bytes[i + 2] & 0xc0) != 0x80 || ((u8) bytes[i + 3] & 0xc0) != 0x80) break;
                u32 cp = ((lead & 0x07u) << 18) | (((u8) bytes[i + 1] & 0x3fu) << 12) |
                    (((u8) bytes[i + 2] & 0x3fu) << 6) | ((u8) bytes[i + 3] & 0x3fu);
                if (cp < 0x10000 || cp > 0x10ffff) break;
                mal_utf16_emit_pair(cp, units + output);
                output += 2;
                i += 4;
            } else {
                break;
            }
        }
    } else {
        u8 *units = buffer->data;
        while (i < stop) {
            u8 lead = (u8) bytes[i];
            if (lead < 0x80) {
                usize run = mal_utf8_ascii_count(bytes, i, stop);
                memcpy(units + output, bytes + i, run);
                output += run;
                i += run;
            } else if ((lead & 0xfe) == 0xc2) {
                // Validate the whole pair run first so the decode loop stays branch-free.
                usize run_end = i;
                while (stop - run_end >= 2 && ((u8) bytes[run_end] & 0xfe) == 0xc2 &&
                    ((u8) bytes[run_end + 1] & 0xc0) == 0x80) run_end += 2;
                if (run_end == i) break;
                usize count = (run_end - i) / 2;
                for (usize k = 0; k < count; k++) {
                    units[output + k] = (u8)
                        ((((u8) bytes[i + 2 * k] & 3u) << 6) | ((u8) bytes[i + 2 * k + 1] & 0x3fu));
                }
                output += count;
                i = run_end;
            } else {
                break;
            }
        }
    }
    buffer->length = output;
    return i;
}

MalString *mal_string_from_utf8_report(
    MalHeap *heap, const byte *bytes, usize len,
    bool *had_error_out, MalUtf8DecodeStatus *status_out
) {
    bool had_error = false;
    MalUtf8DecodeStatus status = MAL_UTF8_DECODE_OK;
    MalString *string = nullptr;
    usize prefix = mal_utf8_ascii_run_end((const u8 *) bytes, 0, len);
    if (prefix == len) {
        if (len > MAL_STRING_MAX_CODE_UNITS) status = MAL_UTF8_DECODE_LENGTH_OVERFLOW;
        else string = mal_string_new_ascii(heap, bytes, len);
        goto done;
    }

    MalTextBuffer buffer = {.heap = heap};
    // The ASCII prefix is exact; the rest is a growth hint, not a decoded-length bound.
    usize hint = prefix + (len - prefix) / 2;
    if (hint > MAL_STRING_MAX_CODE_UNITS) hint = MAL_STRING_MAX_CODE_UNITS;
    mal_text_buffer_hint_capacity(&buffer, hint);
    mal_text_buffer_append_latin1(&buffer, (const u8 *) bytes, prefix);
    usize i = prefix;
    while (i < len && buffer.status == MAL_TEXT_BUFFER_OK) {
        if (buffer.data != nullptr) {
            i = mal_utf8_decode_run(&buffer, bytes, len, i);
            if (i == len) break;
        }
        usize start = i;
        while (i < len && (u8) bytes[i] < 0x80) i++;
        if (i != start) {
            mal_text_buffer_append_latin1(&buffer, (const u8 *) bytes + start, i - start);
            continue;
        }
        u32 cp = mal_utf8_read_scalar(bytes, len, &i, &had_error);
        usize width = cp > 0xFFFF ? 2 : 1;
        if (cp > UINT8_MAX && !buffer.utf16) {
            mal_text_buffer_reserve_utf16(&buffer, width);
        } else if (buffer.data == nullptr || width > buffer.capacity - buffer.length) {
            mal_text_buffer_reserve(&buffer, width);
        }
        if (buffer.status != MAL_TEXT_BUFFER_OK) break;
        if (!buffer.utf16) {
            ((u8 *) buffer.data)[buffer.length] = (u8) cp;
        } else if (width == 1) {
            ((c16 *) buffer.data)[buffer.length] = (c16) cp;
        } else {
            mal_utf16_emit_pair(cp, (c16 *) buffer.data + buffer.length);
        }
        buffer.length += width;
    }
    if (buffer.status == MAL_TEXT_BUFFER_OK) {
        // This decoder never truncates, so promotion proves a wide unit remains.
        string = buffer.utf16
            ? mal_string_new_utf16_owned(heap, buffer.data, buffer.length)
            : mal_text_buffer_finish(heap, &buffer);
    } else {
        status = buffer.status == MAL_TEXT_BUFFER_LENGTH_OVERFLOW
            ? MAL_UTF8_DECODE_LENGTH_OVERFLOW : MAL_UTF8_DECODE_ALLOCATION_FAILURE;
        mal_text_buffer_dispose(&buffer);
    }
done:
    if (had_error_out != nullptr) *had_error_out = had_error;
    if (status_out != nullptr) *status_out = status;
    return string;
}

MalString *mal_string_from_utf8(MalHeap *heap, const byte *bytes, usize len) {
    return mal_string_from_utf8_report(heap, bytes, len, nullptr, nullptr);
}

MalUtf8CStringResult mal_string_to_utf8_c_string(
    const MalString *string, char **out, usize *out_len
) {
    *out = nullptr;
    *out_len = 0;
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, mal_string_length(string));
    bool embedded_nul = false;
    while (!embedded_nul && mal_string_iterator_next(&iterator, &segment)) {
        if (segment.latin1) {
            embedded_nul = memchr(segment.latin1_units, 0, segment.length) != nullptr;
        } else {
            for (usize i = 0; i < segment.length; i++) {
                if (segment.utf16_units[i] == 0) {
                    embedded_nul = true;
                    break;
                }
            }
        }
    }
    mal_string_iterator_dispose(&iterator);
    if (embedded_nul) return MAL_UTF8_C_STRING_EMBEDDED_NUL;
    byte *bytes = mal_string_to_utf8(string, out_len);
    if (bytes == nullptr) return MAL_UTF8_C_STRING_ALLOCATION_FAILED;
    bytes[*out_len] = '\0';
    *out = (char *) bytes;
    return MAL_UTF8_C_STRING_OK;
}
