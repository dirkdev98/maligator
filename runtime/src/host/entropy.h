#pragma once

#include "./defaults.h"

/*
 * Cryptographically secure entropy (host layer). This engine-neutral boundary
 * keeps platform random-device access out of runtime adapters such as node:crypto
 * and the web crypto global. The implementation lives in its own archive member,
 * so builds that install neither crypto surface do not retain random support.
 */

/* Fill `buffer[0..length)` with host entropy. Returns 0 on success or a positive
 * errno on failure. A zero-length request succeeds without touching `buffer`. */
int mal_host_entropy(void *buffer, usize length);
