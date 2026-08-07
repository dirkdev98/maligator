#pragma once

#include "./defaults.h"

/*
 * Cryptographically secure entropy (host layer). This engine-neutral boundary
 * keeps platform random-device access out of runtime adapters such as node:crypto
 * and the web crypto global. The implementation lives in its own archive member,
 * so builds that install neither crypto surface do not retain random support.
 *
 * There is no non-cryptographic fallback: a total platform failure is reported
 * as an errno and every caller turns that into a thrown JavaScript error. A
 * login path must never silently degrade to a predictable source.
 *
 * All three entry points are safe to call from any thread. The UUID cache and
 * the fallback device descriptor are process-global and internally locked; this
 * boundary assumes no reactor-thread affinity.
 */

/* Fill `buffer[0..length)` with host entropy. Returns 0 on success or a positive
 * errno on failure. A zero-length request succeeds without touching `buffer`. */
int mal_host_entropy(void *buffer, usize length);

/* RFC 4122 version 4 raw bytes (version/variant bits already set), served from a
 * 128-UUID cache to amortize the syscall — Node's kBatchSize. `fresh` bypasses
 * the cache and does not refill it (randomUUID's options.disableEntropyCache).
 * Returns 0 or a positive errno. */
int mal_host_entropy_uuid(void *out16, bool fresh);

/* Test seam: drop the cache so the next cached draw hits the platform again. */
void mal_host_entropy_cache_reset(void);
