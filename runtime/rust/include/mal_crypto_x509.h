/* node:crypto X509Certificate primitives (Cargo feature `node-crypto`). Inputs are borrowed for
 * one call; each output reports its full length so callers can size a second call. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mal_x509_records.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
    MAL_X509_PART_SPKI = 0,
    MAL_X509_PART_TBS = 1,
    MAL_X509_PART_SIGNATURE = 2,
    MAL_X509_PART_ISSUER = 3,
    MAL_X509_PART_SUBJECT = 4,
};

/* DER of the first certificate in PEM or DER input; -1 when text has no certificate block,
 * -2 for malformed DER. */
intptr_t mal_x509_from_input(const uint8_t *data, size_t len, uint8_t *output, size_t capacity);
/* MalX509Record records: F text, T Unix seconds, B "0"/"1", K one keyUsage OID. */
intptr_t mal_x509_info(const uint8_t *der, size_t len, uint8_t *output, size_t capacity);
/* Node's toLegacyObject records: S/I subject/issuer attributes and F fields. */
intptr_t mal_x509_legacy(const uint8_t *der, size_t len, uint8_t *output, size_t capacity);
bool mal_x509_part(const uint8_t *der, size_t len, uint32_t part, size_t *offset, size_t *length);
intptr_t mal_x509_pem(const uint8_t *der, size_t len, uint8_t *output, size_t capacity);

#ifdef __cplusplus
}
#endif
