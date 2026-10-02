#include "mal_tls.h"
#include <stdio.h>
#include <stdlib.h>

static int passed;
static int checks;
static void check(int condition, const char *message) {
    checks++;
    if (condition) passed++;
    else printf("FAIL: %s\n", message);
}

int main(void) {
    MalTlsClient *client = NULL;
    check(mal_tls_client_create((const uint8_t *)"localhost", 9, NULL, 0,
        NULL, 0, 1, &client) == MAL_TLS_STATUS_OK, "create record probe");
    if (client == NULL) return 1;
    check(mal_tls_client_has_pending_input(client) == 0, "initial record boundary");
    const uint8_t header[] = {22, 3, 3, 0, 16};
    size_t consumed = 0;
    check(mal_tls_client_read_ciphertext(client, header, 2, &consumed) == MAL_TLS_STATUS_OK
        && consumed == 2 && mal_tls_client_has_pending_input(client) == 1,
        "partial TLS header is not an idle boundary");
    check(mal_tls_client_read_ciphertext(client, header + 2, 3, &consumed) == MAL_TLS_STATUS_OK
        && consumed == 3 && mal_tls_client_has_pending_input(client) == 1,
        "complete header with missing payload is not an idle boundary");
    mal_tls_client_free(&client);
    const char *path = "tests/fixtures/tls/localhost-cert.pem";
    FILE *file = fopen(path, "rb");
    if (file == NULL) return 1;
    uint8_t pem[8192];
    size_t length = fread(pem, 1, sizeof(pem) - 1, file);
    fclose(file);
    check(length > 0 && length < sizeof(pem) - 1, "bounded fixture CA input");
    MalTlsClient *first = NULL;
    MalTlsClient *second = NULL;
    check(mal_tls_client_create((const uint8_t *)"localhost", 9, pem, length,
        (const uint8_t *)"http/1.1", 8, 0, &first) == MAL_TLS_STATUS_OK, "first verified config");
    check(mal_tls_client_create((const uint8_t *)"other.example", 13, pem, length,
        (const uint8_t *)"http/1.1", 8, 0, &second) == MAL_TLS_STATUS_OK, "same trust with separate hostname");
    check(mal_tls_client_config_id(first) != 0
        && mal_tls_client_config_id(first) == mal_tls_client_config_id(second), "verified policy cache reuses identity");
    mal_tls_client_free(&second);
    pem[length] = '\n';
    check(mal_tls_client_create((const uint8_t *)"localhost", 9, pem, length + 1,
        (const uint8_t *)"http/1.1", 8, 0, &second) == MAL_TLS_STATUS_OK, "changed trust input remains valid");
    check(mal_tls_client_config_id(second) != mal_tls_client_config_id(first), "different trust bytes cannot alias policy identity");
    mal_tls_client_free(&first);
    mal_tls_client_free(&second);
    check(mal_tls_client_create((const uint8_t *)"localhost", 9, (const uint8_t *)"bad", 3,
        NULL, 0, 0, &client) == MAL_TLS_STATUS_INVALID_ARGUMENT, "malformed CA never borrows cached config");
    printf("RESULT %d/%d\n", passed, checks);
    return passed == checks ? 0 : 1;
}
