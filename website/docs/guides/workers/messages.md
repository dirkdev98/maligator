Choose whether each value is copied, moved, or shared before sending it between isolates. Ordinary messages are structured clones; objects do not keep a shared identity across heaps.

## Transfer an ArrayBuffer

Save these files together:

{{example:workers.transferTask}}

{{example:workers.transfer}}

```shell
maligator run transfer.ts
```

The application prints `0`, then `3,2,1`. The input buffer detaches when `run` returns normally, before the task promise settles. The worker mutates its owned buffer and uses [transfer](/api/workers#transfer) to publish the result without copying that buffer back.

Creating a transfer result envelope does not detach a buffer. Publication commits the transfer. Validation failures, closed pools, already-aborted signals, and queue saturation occur before admission and leave the sender's transferables unchanged.

`SharedArrayBuffer` shares its backing memory when cloned and cannot appear in a transfer list. Coordinate shared access with Atomics. A transferred [MessagePort](/api/workers#MessagePort) moves endpoint ownership to the receiver.

## Exchange messages with a worker

{{example:workers.echo}}

{{example:workers.worker}}

```shell
maligator run worker.ts
```

The application prints `workers` and then the terminal reason after shutdown. Install the receiving handler before sending. Setting `onmessage` starts delivery; call `start()` when using `addEventListener`. Messages on one endpoint retain admission order.

`parentPort` is `null` in the main isolate. In a worker it is the endpoint connected to the parent. `workerData` is the worker-owned snapshot of `WorkerOptions.data`; validate its shape because its type is `unknown`. Later changes to the caller's original object are not shared.

## Set queue limits

Use [WorkerOptions](/api/workers#WorkerOptions) and [MessageChannelOptions](/api/workers#MessageChannelOptions) to bound pending messages and bytes. Defaults are 4096 messages, 64 MiB queued, and 16 MiB per message per endpoint. Native process-wide admission limits also apply: 65536 pending messages and 512 MiB across endpoints. A large local limit does not reserve host capacity.

A rejected message can throw `DataCloneError` for unsupported values or transfer lists, and `QueueFullError` for saturation. Keep a retry policy at the application layer and retain ownership until admission succeeds. Do not repeatedly post a detached buffer.

Close standalone channel endpoints when finished. Join workers with `terminate()` or `closed`; see [cancellation and shutdown](/guides/workers/cancellation).
