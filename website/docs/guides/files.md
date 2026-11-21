Read and write files on disk with `maligator:fs`. It needs no surface flag. Every operation returns a promise and runs on a background thread, so the event loop keeps running while a file is read or written.

## Read a file

```typescript src/index.ts
import { file } from "maligator:fs";

const settings = file("settings.json");
if (await settings.exists()) {
	const { name } = (await settings.json()) as { name: string };
	console.log(`hello ${name}`);
}
console.log((await file("notes.txt").text()).length);
```

`file()` returns a handle without touching the disk, so the file need not exist yet. A relative path resolves against the working directory when an operation runs. A `file:` URL works too, where the web surface provides `URL`.

`text()` decodes UTF-8 and drops a byte order mark, `bytes()` returns a fresh `Uint8Array` and `json()` parses the text. A handle reads like an [embedded file](/guides/assets), except that each method returns a promise, so code that awaits `bytes()`, `text()` or `json()` takes either.

## Write a file

```typescript src/report.ts
import { file } from "maligator:fs";

const report = file("out/report.json");
await report.write(JSON.stringify({ ok: true }), {
	createDirectories: true,
	atomic: true,
});
await file("out/events.log").append(`${new Date().toISOString()} report written\n`);
```

`write()` replaces the contents and `append()` adds to the end. Both create a missing file and fulfill with the number of bytes written. They take a string, which they write as UTF-8, an `ArrayBuffer` or a view over one.

- `createDirectories` creates missing parent directories first.
- `atomic` writes a temporary file in the same directory, flushes it and renames it over the target. Readers see the old or the new contents, never a partial file, and a failed write removes the temporary file. The replaced file keeps its permission bits unless you pass `mode`, and a symbolic link keeps pointing at its target.
- `mode` sets the permission bits of a file the write creates, before the umask.

## Inspect, copy, move and delete

```typescript src/archive.ts
import { file } from "maligator:fs";

const upload = file("photo.jpg");
const { size, mtime } = await upload.stat();
console.log(upload.type, size, mtime.toISOString());
await upload.copyTo("photo-backup.jpg");
await upload.moveTo("photo-archived.jpg", { overwrite: true });
await file("photo-backup.jpg").delete();
```

`type` is the media type the extension implies. `stat()` describes the target of a symbolic link; pass `followSymlinks: false` to describe the link itself, the only case where `isSymbolicLink` is true.

`copyTo()` and `moveTo()` take a path, a URL or another handle. They reject with `EEXIST` when the destination exists, unless you pass `overwrite: true`. `moveTo()` renames the file, copying it when the destination is on another file system, and the handle keeps naming the old path. `delete()` removes a file and rejects for a missing file or a directory.

## Handle failures

A failed operation rejects with a `FileSystemError`. Its `code` is the system error name, such as `ENOENT` for a missing file, `EISDIR` for a directory, `EEXIST` for an existing destination or `EACCES` for missing permission. `syscall` names the failed call, `path` the path it failed on and `destination` the target of a copy or move. The message reads like Node's:

```typescript src/notes.ts
import { file, FileSystemError } from "maligator:fs";

try {
	console.log(await file("notes.txt").text());
} catch (error) {
	if (!(error instanceof FileSystemError) || error.code !== "ENOENT") throw error;
	console.log(error.message); // ENOENT: no such file or directory, open 'notes.txt'
}
```

Invalid arguments throw a `TypeError` instead. `file()` throws for an empty path, a path with a null byte or a URL that is not a `file:` URL, and the methods reject for data or options they don't take.

Libraries written against Node can keep using `node:fs`, which needs the Node surface. Both modules run file operations on the same pool of threads.
