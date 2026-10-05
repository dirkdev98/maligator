Aborting a running task signals cancellation. The worker stays occupied until the task settles. Break long work into bounded pieces and check the task's local signal between them.

## Pass a cancellation signal

Use `tasks.ts` from [Run tasks in workers](/guides/workers), then create:

{{example:cancel.ts}}

```shell
maligator run cancel.ts
```

The application prints `cancelled`. An already-aborted signal throws before admission. Cancellation of queued work prevents its execution. A running task observes cancellation through [TaskContext.signal](/api/workers#TaskContext.signal) or [throwIfCancelled](/api/workers#TaskContext.throwIfCancelled).

Do not catch and discard that exception inside an unbounded loop. The task must settle for its worker to become available. Cancel the task's own asynchronous resources as part of its cleanup when they otherwise remain active.

## Choose close or terminate

[close](/api/workers#WorkerPool.close) stops new submissions, drains all accepted tasks, shuts down workers, and resolves after native threads are joined. Use it after successful work, usually in `finally`.

[terminate](/api/workers#WorkerPool.terminate) rejects outstanding tasks with `AbortError` and asks running tasks to stop. It joins workers after those tasks cooperate and settle. It does not preempt arbitrary JavaScript. An infinite task that never checks cancellation can prevent termination from finishing.

Returning from `pool.map` cancels only that iterator's work and closes its input iterator. Other submissions to the same pool remain independent.

## Handle failures and process lifetime

Keep handlers on accepted task promises. A synchronous admission error and a later task rejection require different handling; wrap submission in `try` when either can fail. After worker failure, accepted work is not replayed automatically.

Workers and pools are referenced by default. [unref](/api/workers#WorkerPool.unref) lets the process exit without waiting for them; it is not cleanup and does not make a result durable. Use `ref()` to restore that lifetime dependency.

A [Worker.closed](/api/workers#Worker.closed) terminal record is published only after thread reaping and slot release. Use that boundary before treating host worker capacity as available again.
