/* Flat bounded-buffer TLS client ABI. The opaque handle retains Rustls state but
 * never pointers supplied by C. Available with Cargo feature `node-tls`. */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MAL_TLS_STATUS_OK 0
#define MAL_TLS_STATUS_INVALID_ARGUMENT -1
#define MAL_TLS_STATUS_ERROR -2

typedef struct MalTlsClient MalTlsClient;

int32_t mal_tls_client_create(
    const uint8_t *server_name, size_t server_name_len,
    const uint8_t *ca_pem, size_t ca_pem_len,
    const uint8_t *alpn, size_t alpn_len,
    int32_t insecure, MalTlsClient **out_handle);
int32_t mal_tls_client_read_ciphertext(
    MalTlsClient *handle, const uint8_t *input, size_t input_len,
    size_t *consumed);
int32_t mal_tls_client_write_plaintext(
    MalTlsClient *handle, const uint8_t *input, size_t input_len,
    size_t *consumed);
int32_t mal_tls_client_read_plaintext(
    MalTlsClient *handle, uint8_t *output, size_t output_len,
    size_t *produced);
int32_t mal_tls_client_write_ciphertext(
    MalTlsClient *handle, uint8_t *output, size_t output_len,
    size_t *produced);
int32_t mal_tls_client_is_handshaking(const MalTlsClient *handle);
int32_t mal_tls_client_wants_write(const MalTlsClient *handle);
void mal_tls_client_free(MalTlsClient **handle);

#ifdef __cplusplus
}
#endif
