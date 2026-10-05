Use a worker pool to run exported functions in parallel, with work isolated from the main application. Declare the worker entry before building the application. Each worker keeps its own module state, VM, heap, and event loop.

Use a pool for request/result tasks. Use a long-lived [Worker](/api/workers#Worker) when you need a message protocol or an independent event loop. The public `maligator:workers` API does not require a surface flag; worker execution requires a threaded host.

Use an [ES module project](/guides/typescript#use-es-modules) for the `.ts` files below.

## Create a pool

Save both files in the same directory:

{{example:workers.tasks}}

{{example:workers.pool}}

```shell
maligator run pool.ts
```

The application prints `6`, then `3` and `7`, then `true` for the cancellation check. The `finally` block drains and joins the pool.

[createWorkerUrl](/api/workers#createWorkerUrl) takes a static specifier and `import.meta.url`. The compiler bundles the worker graph into the application image. Workers do not load arbitrary source files at runtime. The erased generic describes the module you expect; it is not runtime type validation.

## Submit arguments and receive results

A task is an exported function whose first argument is [TaskContext](/api/workers#TaskContext). Pass only the remaining arguments to [run](/api/workers#WorkerPool.run). In the example, `[[1, 2, 3]]` is a one-element argument tuple containing an array.

Admission failures throw synchronously. An accepted task returns a promise that resolves with its result or rejects with its failure. Await `pool.ready` to catch entry startup failures before submitting work.

Each worker executes one task until the task's returned promise settles. Keep independent work in different tasks; an `await` inside one task does not free that worker to run another pool task. A worker failure does not replay accepted tasks.

## Bound pending work

Set a pool size and queue bounds that fit your workload. Defaults and ranges are in [PoolOptions](/api/workers#PoolOptions). A full queue rejects admission with `QueueFullError`; increasing its size also increases retained inputs.

[map](/api/workers#WorkerPool.map) reads an iterable with a bounded window and yields results in input order. Its window counts pulled inputs and buffered results together. A slow early input can delay later results even if those tasks have completed.

A size-one pool preserves serial dispatch, but its module state still lives in a separate isolate. Closing the pool stops new admission and drains accepted work. To cancel it, see [Cancel work and shut down](/guides/workers/cancellation).

Continue with [Messages and transfers](/guides/workers/messages) to choose how values cross isolate boundaries.
