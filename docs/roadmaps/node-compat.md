# Node and Express compatibility roadmap

The initial compatibility target is the unmodified CommonJS release
`express@5.2.1`, running with its unmodified dependency tree from
`tests/fixtures/express-5/package-lock.json`. Express 5 and several locked
dependencies require Node 18 or newer, so compatibility follows modern Node
behavior rather than historical Node quirks.

The fixture is both a real-Node baseline and a Maligator native acceptance target.
The suite now runs its unmodified smoke program through Maligator's inbound server
and outbound client in compiled and interpreted modes, including GC stress.

The pinned Express behavior baseline and its benchmark lane are established.
`tests/native/express-smoke.test.ts` is the compatibility acceptance test;
`bench/baseline.json` is the sole source for performance history. The fixture's
`node:assert/strict` module remains a three-method harness subset, not a general Node
assertion surface.

## Active compatibility work

- [ ] Complete `package.json#exports` wildcard matching, null targets, target
      validation, and remaining Node entry-resolution behavior. Exact subpaths,
      import/require conditions, and package encapsulation are implemented.
- [ ] Complete observable `node:http` and `node:net` semantics beyond the streaming
      Express and postgres.js baselines: richer socket APIs, Agent/connection reuse,
      and remaining validation and lifecycle edges.

Host sockets, DNS, streaming transport, pooling, and cancellation are owned by H1-H3
in the [isolate and reactor roadmap](isolate-reactor.md). This roadmap owns the
observable Node API adapters over that substrate.

## Queued performance work

- [ ] Close measured Express gaps without regressing fixture behavior or bare-server
      throughput. Profile call dispatch and object shaping; inherited-value caching
      depends on the per-chain validity cells owned by [`TODO.md`](../../TODO.md).

## Active ecosystem work

The exact pinned `postgres@3.4.9` release now passes its deterministic loading,
authentication, TCP/TLS, query, transaction, type, large-object, provider, and
lifecycle coverage without package-specific shims.

- [ ] Exercise logical replication subscriptions, prepared transactions,
      server-negotiated TLS, and primary/standby selection against a dedicated
      PostgreSQL topology. The local service currently has `wal_level=replica`,
      `max_prepared_transactions=0`, and `ssl=off`.

## Baseline workflow

Run from `tests/fixtures/express-5/`:

```sh
npm install
npm run smoke
```

`node_modules` remains ignored. The manifest, lockfile, application, and smoke
runner are the only fixture inputs that should be versioned.
