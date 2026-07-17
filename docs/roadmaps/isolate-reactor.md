# Isolate, reactor, and host roadmap

The engine/host/runtime split, completion reactor, timers, numeric IPv4 TCP client,
HTTP server, WinterTC object surface, URL support, fibers, and reduction-budget
scheduler substrate are implemented. Current native tests under `tests/native/`
are the acceptance entry points.

## Host architecture checkpoint

The accepted contract is
[`03-wave-0-host-architecture.md`](../decisions/03-wave-0-host-architecture.md).
Its ownership, streaming, cancellation, event-loop, build, and verification gates
are normative for host work.

- [x] H0: fix the architecture: no Hyper dependency, llhttp HTTP/1, C-owned
      sockets/DNS, optional Rustls FFI, neutral streaming APIs, raw headers, and
      exactly one host task per runtime turn.
- [ ] H1: implement the neutral task/stream substrate, exactly-once terminal state,
      bounded DNS/IPv6/Happy Eyeballs, pumped turns, and runtime-owned timer state.
      Generation-checked operation handles, owned FIFO tasks, exactly-once terminal
      transitions, checked readiness registration, and independent read/write fd
      interests are implemented. The thread-safe completion queue, pollable wake
      source, and retained-work accounting now drive a bounded pthread DNS pool
      with numeric-literal bypass, owned ordered IPv4/IPv6 results, queue saturation,
      cancellation, shutdown joining, and reactor-side completion ownership tests.
      Happy Eyeballs connection racing, bounded teardown for a system resolver stuck
      inside `getaddrinfo`, one-turn dispatch, and timer ownership remain.
- [ ] H2: replace the buffered project parser/server with the bounded llhttp HTTP/1
      codec, raw-header transport, streaming server, and parser fuzzing.
- [ ] H3: add the pooled outbound HTTP/1 client and build WinterTC and Node adapters
      over the same host API, with no host auto-decompression.
- [ ] H4: add optional Rustls through the existing Rust static library and pass the
      production sanitizer, fuzz, leak, symbol/size, and benchmark gates.

## Runtime surface

- [ ] Finish the small WinterTC residuals: `AbortSignal.any`, DOMException,
      multi-value `Set-Cookie`, live `url.searchParams`, `request.json()` parse-error
      rejection, remaining Headers normalization/combination behavior, and required
      TypeErrors in timers and `Mal.serve`.
- [ ] Encode non-ASCII console output as UTF-8.
- [ ] Add a WPT harness for the web runtime surface.
- [ ] Move runtime timer state out of `MalHost` into a runtime/embedder context.

## Outbound I/O

- [ ] Complete H1-H4 above; outbound DNS, TCP, HTTP/1, optional TLS, and `fetch()`
      are accepted only through the decision's neutral streaming host boundary.

## Actors

- [ ] Implement actor fibers with rooted mailboxes and `spawn`, `send`, and
      `receive`.
- [ ] Wire the existing reduction-budget scheduler into actor execution and prove a
      tight-loop actor cannot starve peers.
- [ ] Copy messages with structured-clone semantics and support transferables for
      large buffers.
- [ ] Add supervision primitives: link, monitor, kill, cancellation, and teardown.

## SMP

- [ ] Make current fiber, scheduler, GC, root, and hook globals thread-local or
      isolate-owned.
- [ ] Run one isolate and scheduler per OS thread.
- [ ] Implement cross-isolate send as copy plus MPSC enqueue and backend wake.
- [ ] Add work stealing between local run queues.
- [ ] Verify independent per-isolate collection with no cross-heap pointers or
      global stop-the-world coordination.
- [ ] Validate the x86_64 fiber switch on Linux.

## Embedding targets

- [ ] Add pumped reactor mode with a one-turn entry point and a pollable wake source
      for foreign GUI loops.
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
