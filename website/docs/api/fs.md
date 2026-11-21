Relative paths resolve against the working directory when an operation runs. Child paths and listing patterns use `/` and resolve below their directory handle. Directory listings order results by the code points of their relative paths and do not descend through symbolic links.

`DiskFile.stream()` gives you a `ReadableStream` of fresh byte chunks. It opens on the first pull and closes on EOF or cancellation. Byte offsets are inclusive. `DiskFile.writer()` queues writes, flushes and close on one descriptor. `flush()` uses `fsync`. Closing an unopened writer creates the file or truncates it unless `append` is enabled.

`watch()` starts on the iterator's first `next()`. It reports changes to a file or to the children of a directory. Enable `recursive` for subdirectories. Event paths include the watched path. Breaking from the loop closes the watcher. An abort closes the watcher and rejects with the signal's reason.

Failed filesystem operations reject with a `FileSystemError`. See [Read and write files](/guides/files) for walkthroughs.
