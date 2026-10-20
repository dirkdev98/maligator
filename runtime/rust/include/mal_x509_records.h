/* Records describing a certificate, written by the Rust x509 helpers for one process. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
    uint8_t kind;
    /* NUL-terminated: keys are attribute short names or dotted OIDs. */
    const char *key;
    /* Not NUL-terminated and may contain NUL. */
    const uint8_t *value;
    size_t value_length;
} MalX509Record;

/* Reads the record at `*at` (`kind | key length | value length | key | NUL | value`, lengths
 * as native-endian u64) and advances `*at`; false at the end or on a malformed record. */
static inline bool mal_x509_record_next(const uint8_t *records, size_t length, size_t *at, MalX509Record *record) {
    uint64_t key_length, value_length;
    size_t header = 1 + 2 * sizeof(uint64_t);
    if (*at > length || length - *at < header) return false;
    memcpy(&key_length, records + *at + 1, sizeof key_length);
    memcpy(&value_length, records + *at + 1 + sizeof key_length, sizeof value_length);
    size_t left = length - *at - header;
    if (key_length >= left || value_length > left - key_length - 1) return false;
    const uint8_t *key = records + *at + header;
    if (key[key_length] != '\0' || memchr(key, '\0', (size_t) key_length) != NULL) return false;
    record->kind = records[*at];
    record->key = (const char *) key;
    record->value = key + key_length + 1;
    record->value_length = (size_t) value_length;
    *at += header + (size_t) key_length + 1 + (size_t) value_length;
    return true;
}
