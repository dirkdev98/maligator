Start with [Run tasks in workers](/guides/workers) for a complete pool example. Use [messages and transfers](/guides/workers/messages) for buffer ownership, or [cancellation and shutdown](/guides/workers/cancellation) for lifecycle handling.

Task submissions can throw before admission: invalid task names or argument tuples (`TypeError`), a closed pool (`InvalidStateError`), saturation (`QueueFullError`), clone/transfer validation (`DataCloneError`), and an already-aborted signal's reason. Once admitted, execution and cancellation settle through the returned promise. A failed worker does not replay accepted work.

A running task must cooperate with cancellation. `close()` drains work; `terminate()` rejects outstanding work and waits for running tasks to settle and workers to be joined. Pool queue defaults differ from direct worker/channel message defaults; use the corresponding option type below.
