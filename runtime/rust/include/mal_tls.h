/* Flat bounded-buffer TLS session ABI for both roles. The opaque handle retains Rustls state but
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
#define MAL_TLS_STATUS_BAD_CERT -3
#define MAL_TLS_STATUS_BAD_KEY -4
#define MAL_TLS_STATUS_KEY_MISMATCH -5
#define MAL_TLS_STATUS_BAD_CA -6

#define MAL_TLS_INFO_ALPN 0
#define MAL_TLS_INFO_PROTOCOL 1
#define MAL_TLS_INFO_CIPHER 2
#define MAL_TLS_INFO_SERVER_NAME 3
#define MAL_TLS_INFO_PEER_CERTIFIED 4

typedef struct MalTlsClient MalTlsClient;
typedef struct MalTlsServerConfig MalTlsServerConfig;

/* A missing cert or key yields a context whose handshakes fail, as Node's does.
 * `alpn_wire` is the length-prefixed ALPN list in server preference order. */
int32_t mal_tls_server_config_create(
    const uint8_t *cert_pem, size_t cert_pem_len,
    const uint8_t *key_pem, size_t key_pem_len,
    const uint8_t *ca_pem, size_t ca_pem_len,
    const uint8_t *alpn_wire, size_t alpn_wire_len,
    int32_t request_cert, int32_t reject_unauthorized,
    MalTlsServerConfig **out_config);
void mal_tls_server_config_free(MalTlsServerConfig **config);
/* The session shares the client handle's record I/O entry points. */
int32_t mal_tls_server_create(
    const MalTlsServerConfig *config, MalTlsClient **out_handle);
/* Returns the full value length (copying at most `output_len`), or -1 if absent. */
intptr_t mal_tls_session_info(
    const MalTlsClient *handle, int32_t kind, uint8_t *output, size_t output_len);

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
int32_t mal_tls_client_peer_closed(const MalTlsClient *handle);
/* Equal nonzero identities denote the same verified trust and ALPN policy. */
uint64_t mal_tls_client_config_id(const MalTlsClient *handle);
int32_t mal_tls_client_has_pending_input(const MalTlsClient *handle);
int32_t mal_tls_client_is_handshaking(const MalTlsClient *handle);
int32_t mal_tls_client_wants_write(const MalTlsClient *handle);
void mal_tls_client_free(MalTlsClient **handle);

#ifdef __cplusplus
}
#endif
