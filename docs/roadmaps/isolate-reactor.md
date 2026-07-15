# Isolate, reactor, and host roadmap

The engine/host/runtime split, completion reactor, timers, numeric IPv4 TCP client,
HTTP server, WinterTC object surface, URL support, fibers, and reduction-budget
scheduler substrate are implemented. Current native tests under `tests/native/`
are the acceptance entry points.

## Runtime surface

- [ ] Finish the small WinterTC residuals: `AbortSignal.any`, DOMException,
      multi-value `Set-Cookie`, live `url.searchParams`, `request.json()` parse-error
      rejection, remaining Headers normalization/combination behavior, and required
      TypeErrors in timers and `Mal.serve`.
- [ ] Encode non-ASCII console output as UTF-8.
- [ ] Add a WPT harness for the web runtime surface.
- [ ] Move runtime timer state out of `MalHost` into a runtime/embedder context.

## Outbound I/O

- [ ] Add DNS through a completion-facing thread-pool backend, plus IPv6 and the
      production TCP client transport.
- [ ] Add an opt-in TLS layer above sockets using a DCE-droppable FFI implementation.
- [ ] Implement outbound `fetch()` using the existing Request, Response, and Headers
      types.

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
