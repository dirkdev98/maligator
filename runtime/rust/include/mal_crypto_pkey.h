/*
 * mal_crypto_pkey.h - RSA, EC (P-256, P-384) and Ed25519 keys for node:crypto's
 * asymmetric KeyObjects, Sign/Verify and key generation (Rust backend, Cargo
 * feature `node-crypto`).
 *
 * Contract:
 *   * A MalPkey is heap-owned by Rust; every handle a call returns through `out`
 *     must be released with mal_pkey_free.
 *   * Pointers are borrowed for one call. Byte outputs use length-probe-then-fill:
 *     a null or too-small buffer returns MAL_PKEY_BUFFER_TOO_SMALL with the
 *     needed size in *written.
 *   * Only the fixed status codes below cross the boundary.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    MAL_PKEY_OK = 0,
    MAL_PKEY_INVALID_KEY = 1,
    MAL_PKEY_UNSUPPORTED = 2,
    MAL_PKEY_ENCRYPTED = 3,
    MAL_PKEY_BAD_SIGNATURE = 4,
    MAL_PKEY_BUFFER_TOO_SMALL = 5,
    MAL_PKEY_NOT_PRIVATE = 6,
    MAL_PKEY_INVALID_ARGUMENT = 7,
};

enum { MAL_PKEY_RSA = 1, MAL_PKEY_EC_P256 = 2, MAL_PKEY_EC_P384 = 3, MAL_PKEY_ED25519 = 4 };
enum { MAL_PKEY_FORMAT_PEM = 0, MAL_PKEY_FORMAT_DER = 1 };
enum { MAL_PKEY_TYPE_PKCS1 = 1, MAL_PKEY_TYPE_PKCS8 = 2, MAL_PKEY_TYPE_SPKI = 3, MAL_PKEY_TYPE_SEC1 = 4 };
enum { MAL_PKEY_HASH_NONE = 0, MAL_PKEY_HASH_SHA256 = 1, MAL_PKEY_HASH_SHA384 = 2, MAL_PKEY_HASH_SHA512 = 3 };
/* Node's RSA_PKCS1_PADDING and RSA_PKCS1_PSS_PADDING values. */
enum { MAL_PKEY_PADDING_PKCS1 = 1, MAL_PKEY_PADDING_PSS = 6 };

typedef struct MalPkey MalPkey;

/* PEM finds the first key block; a public import also accepts private input. */
int32_t mal_pkey_import(const uint8_t *data, size_t len, uint32_t format, uint32_t type, bool private_key,
    MalPkey **out);
/* Raw JWK components, eight slots: RSA n,e,d,p,q,dp,dq,qi; EC x,y,d; Ed25519 x,-,d. */
int32_t mal_pkey_import_jwk(uint32_t kind, const uint8_t *const *parts, const size_t *lens, size_t count,
    bool private_key, MalPkey **out);
int32_t mal_pkey_generate(uint32_t kind, MalPkey **out);
int32_t mal_pkey_public(const MalPkey *key, MalPkey **out);
void mal_pkey_free(MalPkey *key);

uint32_t mal_pkey_kind(const MalPkey *key);
bool mal_pkey_is_private(const MalPkey *key);
uint32_t mal_pkey_modulus_bits(const MalPkey *key);
int32_t mal_pkey_jwk_field(const MalPkey *key, uint32_t field, uint8_t *out, size_t cap, size_t *written);
int32_t mal_pkey_export(const MalPkey *key, uint32_t format, uint32_t type, bool private_key, uint8_t *out,
    size_t cap, size_t *written);
bool mal_pkey_equals(const MalPkey *a, const MalPkey *b);

/* PSS salt lengths other than the digest length are MAL_PKEY_UNSUPPORTED (ring's limit);
 * verify treats negative salt lengths as Node's digest/auto sentinels. */
int32_t mal_pkey_sign(const MalPkey *key, uint32_t hash, uint32_t padding, int32_t pss_salt, bool p1363,
    const uint8_t *message, size_t message_len, uint8_t *out, size_t cap, size_t *written);
int32_t mal_pkey_verify(const MalPkey *key, uint32_t hash, uint32_t padding, int32_t pss_salt, bool p1363,
    const uint8_t *message, size_t message_len, const uint8_t *sig, size_t sig_len);

#ifdef __cplusplus
}
#endif
