# Isolate, reactor, and host roadmap

The engine/host/runtime split, completion reactor, timers, bounded DNS/TCP transport,
incremental llhttp codec, streaming HTTP server/client paths, optional Rustls layer,
partial WinterTC object surface, URL support, fibers, and reduction-budget scheduler
substrate are implemented. Native tests under `tests/native/` and the curated
server-main corpus under `tests/wpt/` are the current acceptance entry points.

## Host architecture checkpoint

The accepted contract is
[`03-wave-0-host-architecture.md`](../decisions/03-wave-0-host-architecture.md).
Its ownership, streaming, cancellation, event-loop, build, and verification gates
are normative for host work.

## Active host work

- [ ] Finish H1 with Happy Eyeballs, pumped turns, and runtime-owned timer state.
      Generation-checked operation handles, owned FIFO tasks, exactly-once terminal
      transitions, checked readiness registration, and independent read/write fd
      interests are implemented. The thread-safe completion queue, pollable wake
      source, and retained-work accounting now drive a bounded pthread DNS pool
      with numeric-literal bypass, owned ordered IPv4/IPv6 results, queue saturation,
      cancellation, shutdown joining, and reactor-side completion ownership tests.
      Happy Eyeballs connection racing, bounded teardown for a system resolver stuck
      inside `getaddrinfo`, a public one-turn pump, embedder access to the existing
      wake source, and timer ownership remain.
- [ ] Finish H2 hard limits, pipelining, and parser fuzzing around the implemented
      shared llhttp codec and streaming server.
- [ ] Finish H3 connection pooling and global WinterTC `fetch()` over the implemented
      neutral streaming HTTP/1 client and Node adapter, with no host
      auto-decompression.
- [ ] Finish H4 production sanitizer, fuzz, leak, symbol/size, and benchmark gates for
      the implemented optional Rustls layer.

WinterTC runtime semantics are owned by the
[server-profile roadmap](wintertc.md). Node API semantics are owned by the
[Node compatibility roadmap](node-compat.md); both depend on H1-H4 here.

## Long-term actors

- [ ] Build rooted actor mailboxes and `spawn`, `send`, and `receive` semantics on
      the existing fiber substrate.
- [ ] Wire the existing reduction-budget scheduler into actor execution and prove a
      tight-loop actor cannot starve peers.
- [ ] Copy messages with structured-clone semantics and support transferables for
      large buffers.
- [ ] Add supervision primitives: link, monitor, kill, cancellation, and teardown.

## Long-term SMP

- [ ] Make current fiber, scheduler, GC, root, and hook globals thread-local or
      isolate-owned.
- [ ] Run one isolate and scheduler per OS thread.
- [ ] Implement cross-isolate send as copy plus MPSC enqueue and backend wake.
- [ ] Add work stealing between local run queues.
- [ ] Verify independent per-isolate collection with no cross-heap pointers or
      global stop-the-world coordination.
- [ ] Validate the x86_64 fiber switch on Linux.

## Long-term embedding targets

- [ ] Expose the H1 one-turn pump and wake source through an embedding API for foreign
      GUI loops.
- [ ] Drive a Rust GUI stack through the FFI as an embedding spike.
- [ ] Build the scheduler/reactor/GC core without libc over a fixed arena.
- [ ] Add a poll/ISR backend and fixed-size fiber stacks.
- [ ] Define a minimal-core profile that drops unused bytecode, Intl data, and host
      modules.

## Watch items

- Choose a fiber stack sizing and growth policy when measured actor counts require
  it.
- Consider separate heaps for actors within one isolate only if idle actor density
  becomes a real constraint; preserve copy-message semantics meanwhile.
- Add io_uring only after epoll validates the completion interface.
