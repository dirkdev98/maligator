#include <openssl/evp.h>

int ffi_bench_crypto_final(EVP_MD_CTX *context, unsigned char *output, unsigned int capacity);
