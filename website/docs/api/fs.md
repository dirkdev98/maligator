Relative paths resolve against the working directory when an operation runs. Child paths and listing patterns use `/` and resolve below their directory handle. Directory listings order results by the code points of their relative paths and do not descend through symbolic links.

Failed filesystem operations reject with a `FileSystemError`. See [Read and write files](/guides/files) for walkthroughs.
