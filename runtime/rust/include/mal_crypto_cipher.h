/*
 * mal_crypto_cipher.h - streaming AES-CBC/CTR/GCM and ChaCha20-Poly1305 for
 * node:crypto's Cipheriv/Decipheriv (Rust backend, Cargo feature `node-crypto`).
 *
 * Contract:
 *   * A state lives in caller storage of mal_cipher_state_size() bytes, aligned
 *     for any scalar (malloc alignment suffices). It owns no heap memory: the
 *     caller releases it by scrubbing and freeing the storage.
 *   * Pointers are borrowed for one call. update() needs out_cap >= in_len + 16
 *     and final() needs out_cap >= 16.
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
    MAL_CIPHER_OK = 0,
    MAL_CIPHER_INVALID_KEY = 1,
    MAL_CIPHER_INVALID_IV = 2,
    MAL_CIPHER_BAD_DECRYPT = 3,
    MAL_CIPHER_AUTH_FAILED = 4,
    MAL_CIPHER_INVALID_STATE = 5,
    MAL_CIPHER_UNKNOWN = 6,
    MAL_CIPHER_WRONG_FINAL_BLOCK_LENGTH = 7,
    MAL_CIPHER_BUFFER_TOO_SMALL = 8,
};

/* Kinds 1-3 AES-128/192/256-CBC, 4-6 CTR, 7-9 GCM, 10 ChaCha20-Poly1305. */
typedef struct MalCipher MalCipher;

size_t mal_cipher_state_size(void);
int32_t mal_cipher_init(uint8_t *storage, size_t size, uint32_t kind, bool encrypt,
    const uint8_t *key, size_t key_len, const uint8_t *iv, size_t iv_len);
int32_t mal_cipher_set_padding(MalCipher *cipher, bool padding);
int32_t mal_cipher_set_aad(MalCipher *cipher, const uint8_t *aad, size_t len);
int32_t mal_cipher_update(MalCipher *cipher, const uint8_t *input, size_t input_len,
    uint8_t *out, size_t out_cap, size_t *written);
int32_t mal_cipher_final(MalCipher *cipher, uint8_t *out, size_t out_cap, size_t *written);
/* After an encrypting final: the first `len` (<= 16) tag bytes. */
int32_t mal_cipher_get_tag(const MalCipher *cipher, uint8_t *out, size_t len);
/* Before a decrypting final: the expected tag; a shorter tag checks its prefix. */
int32_t mal_cipher_set_tag(MalCipher *cipher, const uint8_t *tag, size_t len);

#ifdef __cplusplus
}
#endif
