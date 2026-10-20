# TLS fixtures

`forged-name-*.pem` and `forged-san-*.pem` are self-signed P-256 certificates whose names hold
bytes certificate tooling refuses to write: a UTF8String CN with embedded NUL bytes, BMPString,
T61String and UniversalString attributes, and subject alternative names containing `, DNS:`,
quotes, non-ASCII bytes, an IPv6 and a malformed IP address. `make-forged-certs.mjs` builds
their DER by hand and signs it with `node:crypto`; run it with Node to regenerate them, then
update the copies embedded in `tests/local/node-tls-server.mjs` and
`tests/local/node-crypto-asymmetric.mjs`.
