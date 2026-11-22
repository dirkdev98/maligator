import {
	NO_EFFECT_SUMMARY,
	EVERY_EFFECT_SUMMARY,
} from "../compiler/shared/effect-summary.ts";
import type { EffectSummary } from "../compiler/shared/effect-summary.ts";

export type PlatformData =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<PlatformData>
	| { readonly [key: string]: PlatformData };

export type PlatformType =
	| { readonly kind: "signature"; readonly source: string }
	| { readonly kind: "primitive"; readonly name: "string" | "number" | "boolean" }
	| { readonly kind: "literal"; readonly value: string | boolean | null }
	| { readonly kind: "reference"; readonly name: string }
	| { readonly kind: "array"; readonly element: PlatformType }
	| { readonly kind: "record"; readonly value: PlatformType }
	| { readonly kind: "object"; readonly properties: ReadonlyArray<PlatformProperty> }
	| {
			readonly kind: "union" | "intersection";
			readonly types: ReadonlyArray<PlatformType>;
	  };

export interface PlatformDocumentation {
	readonly description: string;
	readonly examples?: ReadonlyArray<string>;
}

export interface PlatformProperty extends PlatformDocumentation {
	readonly name: string;
	readonly type: PlatformType;
}

export type PlatformTypeDefinition = PlatformProperty &
	(
		| { readonly declaration?: "type" }
		| {
				readonly declaration: "interface";
				readonly extends?: ReadonlyArray<string>;
		  }
	);

export interface PlatformExport extends PlatformDocumentation {
	readonly name: string;
	readonly type: PlatformType;
	readonly contract: {
		readonly phase: "preparation" | "runtime";
		readonly value: "deep-frozen-data" | "callable" | "runtime-data";
		readonly identity: "application-context" | "module";
		readonly provider?: "execution";
		/** The compiler replaces each literal call with what it declares. */
		readonly declaration?: "worker-entry" | "embed";
		readonly workerSource?: string;
		readonly effects: EffectSummary;
	};
}

interface PlatformModuleDefinition extends PlatformDocumentation {
	readonly id: `maligator:${string}`;
	readonly stability: "experimental";
	readonly evaluation: "side-effect-free";
	readonly declarationFile: string;
	readonly internal?: true;
	readonly typeImports?: ReadonlyArray<{
		readonly namespace: string;
		readonly from: string;
	}>;
	readonly types: ReadonlyArray<PlatformTypeDefinition>;
	readonly exports: ReadonlyArray<PlatformExport>;
}

export interface NativeHostInstaller {
	readonly installer: string;
	readonly requiresUrlParser?: true;
}

export type PlatformModule = PlatformModuleDefinition &
	(
		| ({ readonly kind: "native" } & NativeHostInstaller)
		| { readonly kind: "source"; readonly sourceFile: string }
	);

const string: PlatformType = { kind: "primitive", name: "string" };
const number: PlatformType = { kind: "primitive", name: "number" };
const boolean: PlatformType = { kind: "primitive", name: "boolean" };
const reference = (name: string): PlatformType => ({ kind: "reference", name });
const literal = (value: string | boolean | null): PlatformType => ({
	kind: "literal",
	value,
});
const union = (...types: Array<PlatformType>): PlatformType => ({ kind: "union", types });
const array = (element: PlatformType): PlatformType => ({ kind: "array", element });
const object = (properties: Array<PlatformProperty>): PlatformType => ({
	kind: "object",
	properties,
});
const property = (
	name: string,
	type: PlatformType,
	description: string,
): PlatformProperty => ({ name, type, description });

const executionTypes: ReadonlyArray<PlatformTypeDefinition> = [
	property(
		"ExecutionProfile",
		union(literal("none"), literal("sampling"), literal("compiler")),
		"Profiling instrumentation: none by default; sampling for --profile; compiler for --profile=compiler. Both profiling modes select full optimization without selecting production application behavior.",
	),
	property(
		"ExecutionTarget",
		object([
			property(
				"platform",
				union(literal("darwin"), literal("linux"), literal("wasi")),
				"Application operating-system target, not the compiler host. Native builds use darwin or linux; WebAssembly uses wasi.",
			),
			property(
				"arch",
				union(literal("arm64"), literal("x64"), literal("wasm32")),
				"Application architecture. Cross builds report the destination architecture.",
			),
			property(
				"triple",
				string,
				"Resolved target triple, including when --target was omitted; for example aarch64-apple-darwin.",
			),
		]),
		"The fixed platform contract of the application image.",
	),
	property(
		"ExecutionOptions",
		object([
			property(
				"profile",
				reference("ExecutionProfile"),
				"Selected application profiling instrumentation. Defaults to none; does not imply execution.production.",
			),
		]),
		"Options shared by build, run, and dev. Output paths, verbosity, and compiler scheduling are tool settings and are not exposed.",
	),
	property(
		"TestExecutionOptions",
		object([
			property(
				"profile",
				reference("ExecutionProfile"),
				"Selected test profiling instrumentation. Defaults to none; profiling preserves command: test.",
			),
			property(
				"nameFilter",
				union(string, literal(null)),
				"Hierarchical test-name filter from --run, or null when all discovered names are eligible.",
			),
			property(
				"repeat",
				number,
				"Number of requested test repetitions from --repeat; defaults to 1. This is not the currently executing repetition.",
			),
			property(
				"bail",
				boolean,
				"Whether --bail stops the test run after its first failure. Defaults to false.",
			),
			property(
				"timeoutMs",
				number,
				"Test callback timeout in milliseconds from --timeout. Defaults to 5000.",
			),
			property(
				"shuffleSeed",
				union(number, literal(null)),
				"Resolved positive shuffle seed, or null when shuffling is disabled. --shuffle without a seed chooses it once before compilation; the same seed drives execution and cache identity.",
			),
		]),
		"Normalized test settings, fixed for the application image. Changing these values invalidates specialized test artifacts.",
	),
	property(
		"ExecutionEngineConfig",
		object([
			property(
				"primordials",
				union(literal("locked"), literal("mutable")),
				"Requested primordial mutation policy. Defaults to locked. The execution snapshot itself is immutable in either policy.",
			),
			property(
				"eval",
				union(boolean, literal("compile-check")),
				"Dynamic compilation policy. false (default) rejects eval/Function execution at runtime; true enables the runtime compiler; compile-check additionally rejects statically visible dynamic compilation calls.",
			),
			property(
				"realms",
				boolean,
				"Whether additional realms are enabled. Defaults to false.",
			),
			property(
				"regexp",
				boolean,
				"Whether regular expressions are enabled. Defaults to true.",
			),
			property(
				"temporal",
				boolean,
				"Whether Temporal and its required data are enabled. Defaults to false.",
			),
			property(
				"intl",
				object([
					property("enabled", boolean, "Whether Intl is enabled. Defaults to false."),
					property(
						"features",
						array(string),
						"Requested Intl service names. An empty array selects the default complete service set when Intl is enabled; it does not mean every service survived tree shaking.",
					),
					property(
						"languages",
						array(string),
						"Requested locale selection. Defaults to an empty array. Unsupported locale selections are rejected by configuration validation.",
					),
				]),
				"Requested Intl policy after applying configuration defaults.",
			),
		]),
		"Resolved engine policies. These describe build inputs, never post-DCE native feature inclusion.",
	),
	property(
		"ExecutionConfig",
		object([
			property(
				"engine",
				reference("ExecutionEngineConfig"),
				"Engine configuration after validation and default resolution.",
			),
			property(
				"modules",
				object([
					property(
						"aliases",
						{ kind: "record", value: string },
						"Exact module-specifier replacements from configuration. Defaults to an empty object. Alias entries are immutable own data properties.",
					),
				]),
				"Resolved module-resolution policy.",
			),
		]),
		"Resolved application engine and module policies. Excludes build-host paths, asset declarations, and output controls.",
	),
	property(
		"ExecutionCommon",
		object([
			property(
				"production",
				boolean,
				"Explicit production application intent. True only when production was selected for the application; independent of NODE_ENV, profiling, and optimization. Currently --production is a build option. Defaults to false.",
			),
			property(
				"compiled",
				boolean,
				"Whether the application image executes as native compiled code. A native executable hosting an interpreted image reports false. This is fixed for the image, not a query about the current stack frame or an eval-created function.",
			),
			property(
				"optimization",
				union(literal("development"), literal("full")),
				"Actual selected frontend optimization policy. Ordinary commands currently use development; production builds and profiling use full. Backend choice is independent.",
			),
			property(
				"target",
				reference("ExecutionTarget"),
				"Resolved application target. The compiler's host platform is not substituted during a cross build.",
			),
			property(
				"config",
				reference("ExecutionConfig"),
				"Validated configuration policies with defaults applied, captured before compilation.",
			),
		]),
		"Fields shared by every execution workflow. All nested objects and arrays are deeply frozen at runtime.",
	),
	property(
		"Execution",
		{
			kind: "intersection",
			types: [
				reference("ExecutionCommon"),
				union(
					object([
						property(
							"command",
							literal("build"),
							"Prepared by maligator build. Remains build when the resulting executable runs later; application statements are not executed by the build itself.",
						),
						property(
							"options",
							reference("ExecutionOptions"),
							"Normalized build options relevant to application execution.",
						),
					]),
					object([
						property(
							"command",
							union(literal("run"), literal("dev")),
							"Prepared by maligator run or maligator dev. dev denotes the watch/restart workflow even when profiling selects native compilation.",
						),
						property(
							"options",
							reference("ExecutionOptions"),
							"Normalized run/dev options. Arguments after -- remain runtime argv and do not specialize application compilation.",
						),
					]),
					object([
						property(
							"command",
							literal("test"),
							"Prepared by maligator test. Preserved for interpreted tests, profiled native tests, and every fragment of the test application.",
						),
						property(
							"options",
							reference("TestExecutionOptions"),
							"Normalized test options. Narrow command to test before accessing test-only fields.",
						),
					]),
				),
			],
		},
		"An immutable application-image description, discriminated by command. The command describes the workflow that prepared the image, not a transient process phase.",
	),
];

const workerType = (
	name: string,
	source: string,
	description: string,
): PlatformTypeDefinition => property(name, { kind: "signature", source }, description);

const assetTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"MaterializeOptions",
		"{\n /** Parent directory for a materialized copy. Defaults to the OS temporary directory. */\n baseDirectory?: string;\n}",
		"Where an embedded copy is written. Outside `maligator build` the source file is used in place and this option is ignored.",
	),
	{
		...workerType(
			"EmbeddedFile",
			"{\n /** The path below its directory declaration, or the file name. */\n readonly path: string;\n /** The size in bytes. */\n readonly size: number;\n /** Lowercase hexadecimal SHA-256 of the contents. */\n readonly digest: string;\n /** The media type implied by the file extension; text types carry `charset=utf-8`. */\n readonly type: string;\n /** The contents as a Uint8Array over an immutable ArrayBuffer. */\n bytes(): Uint8Array<ArrayBuffer>;\n /** The contents decoded as UTF-8, without a byte order mark. */\n text(): string;\n /** The contents parsed as JSON. */\n json(): unknown;\n /** A filesystem path to the contents. Treat it as read-only. */\n materialize(options?: MaterializeOptions): string;\n}",
			"A file the build embeds. `maligator build` fixes its contents; other commands read the source file each time.",
		),
		declaration: "interface",
	},
	{
		...workerType(
			"EmbeddedDirectory",
			"{\n /** The member files in code point order of their paths. */\n files(): ReadonlyArray<EmbeddedFile>;\n /** The member file at a slash-separated path, if any. */\n get(path: string): EmbeddedFile | undefined;\n /** A filesystem path to a directory holding the member files. Treat it as read-only. */\n materialize(options?: MaterializeOptions): string;\n}",
			"A directory tree the build embeds. `maligator build` fixes its member files; other commands list the source directory each time.",
		),
		declaration: "interface",
	},
	workerType(
		"EmbedProducer",
		"{\n /** The executable and its arguments; no shell interprets them. */\n command: ReadonlyArray<string>;\n /** The working directory, resolved from the declaring module. Defaults to its directory. */\n cwd?: string;\n}",
		"A command that writes the declared files.",
	),
	workerType(
		"EmbedWatchProducer",
		"EmbedProducer & {\n /** A server the watcher starts; the command waits until it answers. */\n url?: string;\n}",
		"A long-running command that keeps the declared files current, such as a frontend dev server.",
	),
	workerType(
		"EmbedProducerUse",
		"{\n /** Defaults to build. */\n build?: 'build' | 'existing';\n /** Defaults to build. */\n run?: 'build' | 'watch' | 'existing';\n /** Defaults to existing. */\n test?: 'build' | 'watch' | 'existing';\n /** Defaults to watch, or build without a watcher. */\n dev?: 'build' | 'watch' | 'existing';\n}",
		"Which producer each command runs. `existing` uses the files already on disk; a selected producer must be declared.",
	),
	workerType(
		"EmbedFileOptions",
		"{\n /** Runs before the files are read: once per run or test, once per dev session, before a build embeds them. */\n build?: EmbedProducer;\n /** Runs alongside the command and stops with it. */\n watch?: EmbedWatchProducer;\n use?: EmbedProducerUse;\n}",
		"How the declared files are produced. Only the project's own modules may name commands; they never reach a built executable.",
	),
	workerType(
		"EmbedDirectoryOptions",
		"EmbedFileOptions & {\n /** Patterns of member paths, with `*`, `?` and whole-segment `**`. Defaults to every file. Each pattern must match a file. */\n include?: ReadonlyArray<string>;\n /** Patterns of paths to leave out, even when included. */\n exclude?: ReadonlyArray<string>;\n /** Let wildcards match names that start with a dot. Defaults to false. */\n dot?: boolean;\n}",
		"Which files of the directory belong to the declaration, and how they are produced. Patterns are relative to the directory and use `/` separators.",
	),
];

const httpTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"Handler",
		"(request: Request) => Response | PromiseLike<Response>",
		"Answers a buffered request. A thrown error or rejection reaches the server's error handler.",
	),
	workerType(
		"ErrorHandler",
		"(error: unknown, request: Request) => Response | PromiseLike<Response>",
		"Turns a handler failure into a response.",
	),
	workerType(
		"ServeOptions",
		"{\n /** Answers each request. */\n fetch: Handler;\n /** Answers instead when `fetch` throws or rejects. Defaults to logging the error and a plain 500 response. */\n error?: ErrorHandler;\n /** Bind address. Defaults to 0.0.0.0; use 127.0.0.1 for a local-only listener. */\n hostname?: string;\n /** TCP port, 0 through 65535. Defaults to 0, which lets the OS choose. */\n port?: number;\n /** Closes the server when aborted. */\n signal?: AbortSignal;\n /** Header deadline in milliseconds; 0 selects the default of 60000. */\n headersTimeout?: number;\n /** Request deadline in milliseconds; 0 selects the default of 300000. */\n requestTimeout?: number;\n /** Idle keep-alive deadline in milliseconds; 0 selects the default of 5000. */\n keepAliveTimeout?: number;\n /** Concurrent connection limit; 0 selects the default of 1024. */\n maxConnections?: number;\n}",
		"Where to listen and how to answer. Limits are integers from 0 through 2147483647.",
	),
	{
		...workerType(
			"Server",
			"{\n /** The bound port, including one the OS chose. */\n readonly port: number;\n readonly hostname: string;\n /** A URL that reaches the server from this machine. */\n readonly url: string;\n /** Stops accepting and fulfills once in-flight requests finished. Repeated calls share one promise. */\n close(): Promise<void>;\n [Symbol.asyncDispose](): Promise<void>;\n}",
			"A listening server. `await using` closes it at the end of a scope.",
		),
		declaration: "interface",
	},
	workerType(
		"ServeAssetOptions",
		"{\n /** The URL path the directory is served below, such as `/static`. Defaults to the root. */\n prefix?: string;\n /** The member served for paths below the prefix that name no file, such as `index.html` for a client-side router. */\n fallback?: string;\n /** Patterns of member paths with content-hashed names, served as cacheable forever. */\n immutable?: ReadonlyArray<string>;\n}",
		"How request paths map onto the asset. A path ending in `/` serves its `index.html`.",
	),
];

const fsTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"FilePath",
		"string | URL",
		"A path, or a `file:` URL. A relative path resolves against the working directory when an operation runs.",
	),
	workerType(
		"FileData",
		"string | ArrayBufferView | ArrayBuffer",
		"Contents to write. Strings are written as UTF-8; views write the bytes they cover.",
	),
	workerType(
		"WriteOptions",
		"{\n /** Write a temporary file next to the target and rename it over the target, so readers see the old or the new contents and never a partial file. Defaults to false. */\n atomic?: boolean;\n /** Create missing parent directories first. Defaults to false. */\n createDirectories?: boolean;\n /** Create the file exclusively. Rejects with EEXIST if the path names any entry, including a dangling link. Combines with atomic to publish the complete file in one step. Defaults to false. */\n exclusive?: boolean;\n /** Permission bits for a created file, before the umask. Defaults to 0o666. An atomic replacement uses existing permission bits when this option is omitted. */\n mode?: number;\n}",
		"How `write` stores the contents.",
	),
	workerType(
		"AppendOptions",
		"{\n /** Create missing parent directories first. Defaults to false. */\n createDirectories?: boolean;\n /** Permission bits for a created file, before the umask. Defaults to 0o666. */\n mode?: number;\n}",
		"How `append` creates a missing file.",
	),
	workerType(
		"FileStreamOptions",
		"{\n /** First byte to read, inclusive. Defaults to 0. */\n start?: number;\n /** Last byte to read, inclusive. Defaults to the end of the file. */\n end?: number;\n /** Maximum bytes per chunk. Defaults to 64 KiB. */\n chunkSize?: number;\n}",
		"Byte range and read size for `DiskFile.stream()`.",
	),
	workerType(
		"FileWriterOptions",
		"AppendOptions & {\n /** Append to the existing file. Defaults to false, which truncates it when opened. */\n append?: boolean;\n}",
		"How `DiskFile.writer()` opens its file.",
	),
	{
		...workerType(
			"FileWriter",
			"{\n /** Write a chunk and fulfill with the number of bytes written. */\n write(data: FileData): Promise<number>;\n /** Flush preceding writes to the filesystem with fsync. */\n flush(): Promise<void>;\n /** Close after preceding operations. Repeated calls share the same result. */\n close(): Promise<void>;\n /** Close after preceding operations. */\n end(): Promise<void>;\n [Symbol.asyncDispose](): Promise<void>;\n}",
			"A sink that opens the file on its first operation and queues operations in call order. Await a write before reusing its input buffer.",
		),
		declaration: "interface",
	},
	workerType(
		"WatchOptions",
		"{\n /** Also watch subdirectories. Defaults to false. */\n recursive?: boolean;\n /** Reject with the signal's reason and close the watcher when it aborts. */\n signal?: AbortSignal;\n}",
		"How `watch()` observes changes.",
	),
	workerType(
		"FileChange",
		'{\n /** The change reported by the filesystem. */\n kind: "create" | "modify" | "delete" | "rename";\n /** The changed path, including the watched path for a child. */\n path: string;\n}',
		"A filesystem notification. The OS can coalesce changes and may report a move as creation or deletion.",
	),
	workerType(
		"TransferOptions",
		"{\n /** Replace an existing destination. Defaults to false, which rejects with `EEXIST`. */\n overwrite?: boolean;\n}",
		"How `copyTo` and `moveTo` treat an existing destination.",
	),
	workerType(
		"StatOptions",
		"{\n /** Describe the target of a symbolic link instead of the link. Defaults to true. */\n followSymlinks?: boolean;\n}",
		"Which entry `stat` describes.",
	),
	workerType(
		"FileStat",
		"{\n /** The size in bytes. */\n readonly size: number;\n /** The last modification time. */\n readonly mtime: Date;\n readonly isFile: boolean;\n readonly isDirectory: boolean;\n /** True only when `followSymlinks` is false and the path is a link. */\n readonly isSymbolicLink: boolean;\n /** The file type and permission bits, as `st_mode` reports them. */\n readonly mode: number;\n}",
		"Metadata of a filesystem entry.",
	),
	{
		...workerType(
			"DiskFile",
			"{\n /** The path as given, or the path of a `file:` URL. */\n readonly path: string;\n /** The media type implied by the file extension; text types carry `charset=utf-8`. */\n readonly type: string;\n /** Whether the path resolves, following symbolic links. Never rejects. */\n exists(): Promise<boolean>;\n /** Metadata of the entry; rejects when it is missing. */\n stat(options?: StatOptions): Promise<FileStat>;\n /** The contents as a Uint8Array over a fresh ArrayBuffer. */\n bytes(): Promise<Uint8Array<ArrayBuffer>>;\n /** The contents decoded as UTF-8, without a byte order mark. */\n text(): Promise<string>;\n /** The contents parsed as JSON. */\n json(): Promise<unknown>;\n /** Read a range incrementally. Cancellation closes the file. */\n stream(options?: FileStreamOptions): ReadableStream<Uint8Array<ArrayBuffer>>;\n /** Open a sink for incremental writes. */\n writer(options?: FileWriterOptions): FileWriter;\n /** Replace the contents, creating the file when it is missing. Fulfills with the number of bytes written. */\n write(data: FileData, options?: WriteOptions): Promise<number>;\n /** Add to the end of the file, creating it when it is missing. Fulfills with the number of bytes written. */\n append(data: FileData, options?: AppendOptions): Promise<number>;\n /** Set the permission bits of the entry, following symbolic links. */\n chmod(mode: number): Promise<void>;\n /** Unlink the file or symbolic link. */\n delete(options?: DeleteOptions): Promise<void>;\n /** Copy the contents and permission bits to another path. */\n copyTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void>;\n /** Rename the file, copying across file systems. This handle keeps naming the old path. */\n moveTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void>;\n}",
			"A file on disk. Creating a handle does no I/O; each method reads or changes the file when called. Failed operations reject with a `FileSystemError`.",
		),
		declaration: "interface",
	},
	workerType(
		"DirectoryListOptions",
		"{\n /** Include paths that match any of these patterns. Defaults to `['**']`. */\n include?: ReadonlyArray<string>;\n /** Leave out paths that match any of these patterns, even when included. */\n exclude?: ReadonlyArray<string>;\n /** Let wildcards match segments starting with a dot. Defaults to false. */\n dot?: boolean;\n /** Visit subdirectories. Defaults to true for `files()` and false for `entries()`. */\n recursive?: boolean;\n}",
		"Which entries to list. Patterns use `*`, `?` and whole-segment `**` on slash-separated paths relative to the directory. A pattern can match zero entries.",
	),
	workerType(
		"DirectoryEntry",
		'{\n /** The final component of the entry\'s path. */\n name: string;\n /** A slash-separated path relative to the listed directory. */\n path: string;\n /** The entry\'s own kind. */\n kind: "file" | "directory" | "symlink" | "other";\n}',
		"An entry returned by `DiskDirectory.entries()`.",
	),
	workerType(
		"CreateDirectoryOptions",
		"{\n /** Create missing parents and succeed if the directory already exists. Defaults to false. */\n recursive?: boolean;\n /** Permission bits for created directories before the umask. Defaults to 0o777. */\n mode?: number;\n}",
		"How `DiskDirectory.create()` creates a directory.",
	),
	workerType(
		"DeleteOptions",
		"{\n /** Succeed when the path is missing. Defaults to false. */\n missingOk?: boolean;\n}",
		"How a delete handles a missing entry.",
	),
	workerType(
		"DeleteDirectoryOptions",
		"DeleteOptions & {\n /** Remove the directory and its contents. Defaults to false. */\n recursive?: boolean;\n}",
		"How `DiskDirectory.delete()` removes a directory.",
	),
	workerType(
		"TemporaryDirectoryOptions",
		"{\n /** Existing parent directory. Defaults to the system temporary directory. */\n parent?: FilePath;\n /** Prefix for the unique directory name, without slashes or null bytes. Defaults to maligator-. */\n prefix?: string;\n}",
		"Where to create a private temporary directory and how to name it.",
	),
	{
		...workerType(
			"DiskDirectory",
			"{\n /** The path as given, or the path of a `file:` URL. */\n readonly path: string;\n /** Whether the path resolves, following symbolic links. */\n exists(): Promise<boolean>;\n /** Metadata of the entry at `path`. */\n stat(options?: StatOptions): Promise<FileStat>;\n /** A lazy file handle at a slash-separated path below the directory. */\n file(relative: string): DiskFile;\n /** A lazy directory handle at a slash-separated path below the directory. */\n directory(relative: string): DiskDirectory;\n /** A handle if the named entry is a regular file, or undefined if absent or another kind. */\n get(relative: string): Promise<DiskFile | undefined>;\n /** Regular files ordered by the code points of their relative paths. Visits subdirectories by default. */\n files(options?: DirectoryListOptions): Promise<Array<DiskFile>>;\n /** Entries ordered by the code points of their relative paths. Lists direct children by default. */\n entries(options?: DirectoryListOptions): Promise<Array<DirectoryEntry>>;\n /** Create the directory. A non-recursive create rejects if the path already exists. */\n create(options?: CreateDirectoryOptions): Promise<void>;\n /** Set the permission bits of the entry, following symbolic links. */\n chmod(mode: number): Promise<void>;\n /** Remove the directory. A non-recursive delete requires an empty directory. */\n delete(options?: DeleteDirectoryOptions): Promise<void>;\n /** Rename the directory in one operation on the same file system. This handle keeps naming the old path. */\n moveTo(destination: FilePath | DiskDirectory, options?: TransferOptions): Promise<void>;\n}",
			"A directory on disk. Creating a handle does no I/O. Directory walks report symbolic links as entries and skip descending into them.",
		),
		declaration: "interface",
	},
	{
		...workerType(
			"FileSystemError",
			"{\n /** The error name, such as `ENOENT` or `EACCES`. */\n readonly code: string;\n /** The system call that failed, such as `open` or `rename`. */\n readonly syscall: string;\n /** The path the call failed on. */\n readonly path: string;\n /** The second path of a failed copy, move or symlink. */\n readonly destination?: string;\n}",
			"A failed filesystem operation. The message reads like Node's: the code, a description, the system call and the paths.",
		),
		declaration: "interface",
		extends: ["Error"],
	},
];

function embedExport(
	name: string,
	source: string,
	description: string,
	examples: ReadonlyArray<string>,
): PlatformExport {
	return {
		name,
		type: { kind: "signature", source },
		description,
		examples,
		contract: {
			phase: "preparation",
			value: "callable",
			identity: "module",
			effects: NO_EFFECT_SUMMARY,
			declaration: "embed",
		},
	};
}

const workerTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"WorkerUrl<Module = unknown>",
		"{ readonly href: string; readonly __workerModule?: Module }",
		"An immutable image-local worker entry declaration. The compiler resolves the declaration independently of how libraries pass the descriptor or its href onward. Erased module types express the caller's assertion; runtime entry identity is validated.",
	),
	workerType(
		"Transferable",
		"ArrayBuffer | MessagePort",
		"ArrayBuffer stores move at admission. MessagePort endpoints transfer ownership. SharedArrayBuffer is cloned by sharing its backing and cannot be transferred.",
	),
	workerType(
		"TaskContext",
		"{\n /** Worker-local cancellation signal. Cancellation does not preempt JavaScript. */\n readonly signal: AbortSignal;\n /** Throws if cancelled. Check between bounded pieces of work. */\n throwIfCancelled(): void;\n}",
		"Cancellation is cooperative while a pool task runs. The worker remains occupied until the task's returned promise settles.",
	),
	workerType(
		"TransferResult<Value>",
		"{ readonly value: Value; readonly __transferResult: unique symbol }",
		"An opaque result envelope. Constructing it does not detach buffers; publication commits transfers.",
	),
	workerType(
		"TaskNames<Module>",
		"{ [Key in keyof Module]-?: Module[Key] extends (context: TaskContext, ...args: infer Args) => unknown ? Key : never }[keyof Module] & string",
		"Names of context-first exported task functions.",
	),
	workerType(
		"TaskArgs<Function>",
		"Function extends (context: TaskContext, ...args: infer Args) => unknown ? Args : never",
		"The task's argument tuple, excluding its local cancellation context.",
	),
	workerType(
		"TaskValue<Function>",
		"Function extends (...args: Array<never>) => infer Result ? Awaited<Result> extends TransferResult<infer Value> ? Value : Awaited<Result> : never",
		"The settled task result after unwrapping an explicit transfer envelope.",
	),
	workerType(
		"PoolOptions",
		"{\n /** Positive safe integer; defaults to host parallelism, falling back to 1. */\n size?: number;\n /** Nonnegative safe integer; defaults to four times size. Zero disables the waiting queue. */\n maxQueuedTasks?: number;\n /** Positive safe integer in bytes; defaults to 67108864 (64 MiB). */\n maxQueuedBytes?: number;\n /** Positive safe integer in bytes; defaults to maxQueuedBytes. */\n maxMessageBytes?: number;\n /** Worker name prefix; each worker receives a one-based suffix. */\n name?: string;\n}",
		"Fixed persistent worker count and admission bounds. Every worker has independent module state. A size-one pool dispatches admitted tasks serially.",
	),
	workerType(
		"RunOptions",
		"{\n /** Already-aborted signals throw before admission. Running cancellation is cooperative. */\n signal?: AbortSignal;\n /** Ownership moves synchronously on successful admission; rejection leaves values unchanged. */\n transfer?: ReadonlyArray<Transferable>;\n}",
		"The transfer list commits synchronously when run returns normally. Validation, saturation, closed pools and already-aborted signals throw before admission.",
	),
	workerType(
		"MapOptions<Args>",
		"{\n /** Cancels only work owned by this map; running tasks must cooperate. */\n signal?: AbortSignal;\n /** Positive safe integer; defaults to pool size. Bounds pulled inputs and buffered results together. */\n window?: number;\n /** Called for each input before admission to choose values whose ownership moves. */\n transfer?: (args: Args, index: number) => ReadonlyArray<Transferable>;\n}",
		"The window bounds pulled inputs and buffered results together. Results are yielded in input order; iterator return cancels this map's work and closes its input.",
	),
	workerType(
		"PoolStats",
		"{ readonly size: number; readonly active: number; readonly queued: number; readonly completed: number; readonly failed: number; readonly cancelled: number }",
		"A snapshot of this pool's scheduling and settled operations.",
	),
	workerType(
		"WorkerPool<Module>",
		"{\n /** Resolves after every worker evaluates the entry; rejects on startup failure. */\n readonly ready: Promise<void>;\n /** Throws on failed admission; returns a promise for the accepted task's result or failure. */\n run<Key extends TaskNames<Module>>(name: Key, args: TaskArgs<Module[Key]>, options?: RunOptions): Promise<TaskValue<Module[Key]>>;\n /** Yields in input order. Returning from the iterator cancels its work and closes its input. */\n map<Key extends TaskNames<Module>>(name: Key, args: Iterable<TaskArgs<Module[Key]>> | AsyncIterable<TaskArgs<Module[Key]>>, options?: MapOptions<TaskArgs<Module[Key]>>): AsyncIterable<TaskValue<Module[Key]>>;\n /** Stops admission, drains accepted tasks, then joins every worker. Idempotent. */\n close(): Promise<void>;\n /** Rejects outstanding tasks with AbortError; joins workers after running tasks cooperate and settle. */\n terminate(): Promise<void>;\n /** Returns a scheduling snapshot; counts are not a subscription. */\n stats(): PoolStats;\n /** Keeps the process alive while pool workers exist; returns this pool. */\n ref(): WorkerPool<Module>;\n /** Allows the process to exit without waiting for this pool; returns this pool. */\n unref(): WorkerPool<Module>;\n /** Reports whether this pool currently keeps the process alive. */\n hasRef(): boolean;\n}",
		"A bounded task scheduler over isolated persistent workers. Each worker executes one task through asynchronous settlement. No accepted task is replayed after worker failure.",
	),
	workerType(
		"WorkerExit",
		"{ readonly id: number; readonly code: number; readonly reason: 'completed' | 'terminated' | 'error'; readonly error?: unknown }",
		"A terminal record published only after the native worker is joined and its slot is released.",
	),
	workerType(
		"WorkerOptions",
		"{\n name?: string;\n /** Cloned into workerData before startup; later caller mutations are not shared. */\n data?: unknown;\n /** Values moved as part of startup-data admission. */\n transfer?: ReadonlyArray<Transferable>;\n /** Positive safe integer, at most 4294967295; defaults to 4096 messages per endpoint. */\n maxQueuedMessages?: number;\n /** Positive safe integer in bytes; defaults to 67108864 (64 MiB) per endpoint. */\n maxQueuedBytes?: number;\n /** Positive safe integer in bytes; defaults to 16777216 (16 MiB) per message. */\n maxMessageBytes?: number;\n}",
		"Worker data is snapshotted before startup. The native host bounds live workers and message admission process-wide.",
	),
	workerType(
		"MessageChannelOptions",
		"{\n /** Positive safe integer, at most 4294967295; defaults to 4096 messages per endpoint. */\n maxQueuedMessages?: number;\n /** Positive safe integer in bytes; defaults to 67108864 (64 MiB) per endpoint. */\n maxQueuedBytes?: number;\n /** Positive safe integer in bytes; defaults to 16777216 (16 MiB) per message. */\n maxMessageBytes?: number;\n}",
		"Each endpoint bounds its pending message count and bytes. Rejection leaves the sender's transferables unchanged.",
	),
	{
		...workerType(
			"MessagePort<Send = unknown, Receive = unknown>",
			"{\n /** Clones and admits a message synchronously. Transfer commits only after successful validation/admission. */\n postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): void;\n /** Setting this handler starts delivery. addEventListener listeners need start(). */\n onmessage: ((event: Omit<MessageEvent, 'data'> & { readonly data: Receive }) => void) | null;\n /** Receives message decoding failures in the receiving isolate. */\n onmessageerror: ((event: Omit<MessageEvent, 'data'> & { readonly data: unknown }) => void) | null;\n /** Enables delivery to event listeners; repeated calls are harmless. */\n start(): void;\n /** Discards queued messages and closes this endpoint. */\n close(): void;\n /** Keeps the receiving isolate alive; returns this port. */\n ref(): MessagePort<Send, Receive>;\n /** Allows the receiving isolate to exit; returns this port. */\n unref(): MessagePort<Send, Receive>;\n hasRef(): boolean;\n}",
			"An ordered bidirectional endpoint with transactional transfer and bounded queues. Message listeners and values are owned by the receiving isolate.",
		),
		// An interface permits Transferable's recursion through this generic port contract.
		declaration: "interface",
		extends: ["EventTarget"],
	},
	workerType(
		"MessageChannel",
		"{ readonly port1: MessagePort; readonly port2: MessagePort }",
		"A standalone channel whose endpoints may be transferred to workers.",
	),
	workerType(
		"Worker<Send = unknown, Receive = unknown>",
		"EventTarget & {\n readonly id: number;\n /** Resolves after entry evaluation; rejects on startup failure. */\n readonly ready: Promise<void>;\n /** Resolves with a terminal record after the native thread is joined and its slot released. */\n readonly closed: Promise<WorkerExit>;\n readonly port: MessagePort<Send, Receive>;\n /** Requests shutdown and resolves after thread reaping. */\n terminate(): Promise<WorkerExit>;\n ref(): Worker<Send, Receive>;\n unref(): Worker<Send, Receive>;\n hasRef(): boolean;\n}",
		"A long-lived isolated module and its parent communication port. Startup completes after module evaluation; shutdown completes after native thread reaping.",
	),
];

const internalWorkerTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"Transferable",
		"Workers.Transferable",
		"Values whose ownership moves when a message is admitted.",
	),
	workerType(
		"WorkerExit",
		"{ readonly id: number; readonly code: number; readonly reason: 'completed' | 'terminated' | 'error'; readonly error?: unknown }",
		"A terminal record. The error is the uncaught value as thrown.",
	),
	workerType(
		"WorkerErrorEvent",
		"Event & { readonly error: unknown; readonly message: string }",
		"A worker's uncaught value as thrown and its own string message, or the empty string.",
	),
	workerType(
		"MessagePort<Send = unknown, Receive = unknown>",
		"{ postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): number | undefined; _discard(ticket: number): boolean; addEventListener(type: 'message', listener: (event: Omit<MessageEvent, 'data'> & { readonly data: Receive }) => void | Promise<void>, options?: AddEventListenerOptions | boolean): void; onmessage: ((event: Omit<MessageEvent, 'data'> & { readonly data: Receive }) => void) | null; onmessageerror: ((event: Omit<MessageEvent, 'data'> & { readonly data: unknown }) => void) | null; start(): void; close(): void; ref(): MessagePort<Send, Receive>; unref(): MessagePort<Send, Receive>; hasRef(): boolean } & EventTarget",
		"A transactional endpoint. postMessage returns the admission ticket, or undefined when nothing was queued; _discard drops a posted message the peer has not received.",
	),
	workerType(
		"MessageChannel<Forward = unknown, Backward = unknown>",
		"{ readonly port1: MessagePort<Forward, Backward>; readonly port2: MessagePort<Backward, Forward> }",
		"A channel whose first port sends Forward messages and receives Backward messages.",
	),
	workerType(
		"Worker<Send = unknown, Receive = unknown>",
		"{ readonly id: number; readonly ready: Promise<void>; readonly closed: Promise<WorkerExit>; readonly port: MessagePort<Send, Receive>; addEventListener(type: 'error', listener: (event: WorkerErrorEvent) => void, options?: AddEventListenerOptions | boolean): void; terminate(): Promise<WorkerExit>; ref(): Worker<Send, Receive>; unref(): Worker<Send, Receive>; hasRef(): boolean } & EventTarget",
		"A source-API worker handle over a transactional parent port.",
	),
];

export const workerExamples = {
	sum: `// sum.ts
import type { TaskContext } from "maligator:workers";

export function sum(context: TaskContext, values: Array<number>): number {
	context.throwIfCancelled();
	return values.reduce((total, value) => total + value, 0);
}`,
	tasks: `// tasks.ts
import type { TaskContext } from "maligator:workers";

export function sum(context: TaskContext, values: Array<number>): number {
	let total = 0;
	for (const value of values) {
		context.throwIfCancelled();
		total += value;
	}
	return total;
}

export async function waitForCancellation(context: TaskContext): Promise<void> {
	context.throwIfCancelled();
	await new Promise<void>((resolve) => {
		context.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	context.throwIfCancelled();
}`,
	declaration: `// declaration.ts
import { createWorkerUrl } from "maligator:workers";

export const tasks = createWorkerUrl<typeof import("./sum.ts")>(
	"./sum.ts",
	import.meta.url,
);

console.log(Object.isFrozen(tasks), tasks.href.startsWith("file:"));`,
	pool: `// pool.ts
import { createPool, createWorkerUrl } from "maligator:workers";

const tasks = createWorkerUrl<typeof import("./tasks.ts")>(
	"./tasks.ts",
	import.meta.url,
);
const pool = createPool(tasks, { size: 2, maxQueuedTasks: 4 });

try {
	await pool.ready;
	console.log(await pool.run("sum", [[1, 2, 3]]));

	const inputs: Array<[Array<number>]> = [[[1, 2]], [[3, 4]]];
	for await (const total of pool.map("sum", inputs, { window: 2 })) {
		console.log(total);
	}

	const controller = new AbortController();
	const pending = pool.run("waitForCancellation", [], {
		signal: controller.signal,
	});
	const cancelled = pending.then(
		() => false,
		(reason: unknown) => reason === controller.signal.reason,
	);
	controller.abort();
	console.log(await cancelled);
} finally {
	await pool.close();
}`,
	transferTask: `// transfer-task.ts
import { transfer } from "maligator:workers";
import type { TaskContext } from "maligator:workers";

export function reverse(context: TaskContext, buffer: ArrayBuffer) {
	context.throwIfCancelled();
	new Uint8Array(buffer).reverse();
	return transfer(buffer, [buffer]);
}`,
	transfer: `// transfer.ts
import { createPool, createWorkerUrl } from "maligator:workers";

const tasks = createWorkerUrl<typeof import("./transfer-task.ts")>(
	"./transfer-task.ts",
	import.meta.url,
);
const pool = createPool(tasks, { size: 1 });

try {
	await pool.ready;
	const bytes = new Uint8Array([1, 2, 3]);
	const pending = pool.run("reverse", [bytes.buffer], {
		transfer: [bytes.buffer],
	});
	console.log(bytes.byteLength);
	const result = new Uint8Array(await pending);
	console.log(Array.from(result).join(","));
} finally {
	await pool.close();
}`,
	echo: `// echo.ts
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("Run this module as a worker");
const port = parentPort;
port.onmessage = (event) => {
	port.postMessage(String(event.data));
};
port.start();`,
	worker: `// worker.ts
import { createWorkerUrl, Worker } from "maligator:workers";

const entry = createWorkerUrl("./echo.ts", import.meta.url);
const worker = new Worker<string, string>(entry);

try {
	const reply = new Promise<string>((resolve) => {
		worker.port.onmessage = (event) => resolve(event.data);
	});
	worker.port.start();
	await worker.ready;
	worker.port.postMessage("workers");
	console.log(await reply);
} finally {
	const exit = await worker.terminate();
	console.log(exit.reason);
}`,
	workerData: `// worker-data.ts
import { workerData } from "maligator:workers";

function readConfig(value: unknown): { label: string } {
	if (
		typeof value !== "object" ||
		value === null ||
		!("label" in value) ||
		typeof value.label !== "string"
	) {
		throw new TypeError("Expected worker data with a string label");
	}
	return { label: value.label };
}

const config = readConfig(workerData);
console.log(config.label);`,
	configuration: `// configuration.ts
import { createWorkerUrl, Worker } from "maligator:workers";

const entry = createWorkerUrl("./worker-data.ts", import.meta.url);
const worker = new Worker(entry, { data: { label: "thumbnail" } });
try {
	await worker.ready;
	const exit = await worker.closed;
	if (exit.code !== 0) throw new Error("Worker failed");
} finally {
	await worker.terminate();
}`,
	channel: `// channel.ts
import { MessageChannel, MessagePort } from "maligator:workers";

const channel = new MessageChannel();
try {
	console.log(channel.port1 instanceof MessagePort);
	const received = new Promise<unknown>((resolve) => {
		channel.port2.onmessage = (event) => resolve(event.data);
	});
	channel.port2.start();
	channel.port1.postMessage({ answer: 42 });
	console.log(JSON.stringify(await received));
} finally {
	channel.port1.close();
	channel.port2.close();
}`,
	port: `// port.ts
import { MessageChannel, type MessagePort } from "maligator:workers";

function installResponder(port: MessagePort): void {
	port.onmessage = (event) => port.postMessage("reply:" + String(event.data));
	port.start();
}

const { port1, port2 } = new MessageChannel();
try {
	installResponder(port2);
	const reply = new Promise<unknown>((resolve) => {
		port1.onmessage = (event) => resolve(event.data);
	});
	port1.start();
	port1.postMessage("hello");
	console.log(await reply);
} finally {
	port1.close();
	port2.close();
}`,
	receive: `// receive.ts
import { MessageChannel, receiveMessageOnPort } from "maligator:workers";

const channel = new MessageChannel();
try {
	channel.port1.postMessage("first");
	channel.port1.postMessage("second");
	console.log(receiveMessageOnPort(channel.port2)?.message);
	console.log(receiveMessageOnPort(channel.port2)?.message);
	console.log(receiveMessageOnPort(channel.port2));
} finally {
	channel.port1.close();
	channel.port2.close();
}`,
	capabilities: `// capabilities.ts
import { capabilities } from "maligator:workers";

const host = capabilities();
console.log(host.threads, host.sharedMemory);
console.log(host.parallelism >= 1, host.maxWorkers >= 1);`,
} as const;

function workerExport(
	name: string,
	source: string,
	description: string,
	declaration = false,
	examples?: ReadonlyArray<string>,
): PlatformExport {
	return {
		name,
		type: { kind: "signature", source },
		description,
		...(examples === undefined ? {} : { examples }),
		contract: {
			phase: "runtime",
			value: "callable",
			identity: "module",
			effects: EVERY_EFFECT_SUMMARY,
			...(declaration ? { declaration: "worker-entry" as const } : {}),
		},
	};
}

export const PLATFORM_CATALOG_VERSION = 3;

export const PLATFORM_MODULES: ReadonlyArray<PlatformModule> = [
	{
		kind: "native",
		id: "maligator:application",
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_application",
		declarationFile: "application-api.d.ts",
		description:
			"Runtime lifecycle notifications for supervised applications. Module evaluation and application readiness are separate events; readiness means the application has finished its own startup work.",
		types: [],
		exports: [
			{
				name: "ready",
				type: { kind: "signature", source: "() => boolean" },
				description:
					"Notify the development supervisor that this application is ready. Repeated calls are harmless. Returns true in a supervised application and false in a standalone application or ordinary worker. Call after resources such as a server listener are accepting work; this does not reserve ports or transfer traffic.",
				examples: [
					'import { ready } from "maligator:application";\nimport { createServer } from "node:http";\n\ncreateServer((_request, response) => response.end("hello")).listen(3000, () => ready());',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "source",
		id: "maligator:workers",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "workers/runtime.ts",
		declarationFile: "workers-api.d.ts",
		description:
			"Parallel computation and isolated event loops. Declared entries are bundled into the application image; workers do not compile or load source files at runtime. Native executors and GC helpers are shared across JavaScript isolates.",
		types: workerTypes,
		exports: [
			workerExport(
				"createWorkerUrl",
				"<Module = unknown>(specifier: string, base: string) => WorkerUrl<Module>",
				"Declare an entry using a static string literal and explicit import.meta.url base. The immutable href projection can be passed to existing worker libraries.",
				true,
				[workerExamples.declaration, workerExamples.sum],
			),
			workerExport(
				"createPool",
				"<Module>(entry: WorkerUrl<Module>, options?: PoolOptions) => WorkerPool<Module>",
				"Create a bounded pool of persistent workers for a declared entry. Submission failures throw synchronously; admitted tasks settle asynchronously. Await ready before submitting startup-dependent work and close the pool when finished. Throws NotSupportedError without threads and RangeError for invalid bounds.",
				false,
				[workerExamples.pool, workerExamples.tasks],
			),
			workerExport(
				"transfer",
				"<Value>(value: Value, transfer: ReadonlyArray<Transferable>) => TransferResult<Value>",
				"Wrap a result for transfer when the worker publishes it.",
				false,
				[workerExamples.transferTask, workerExamples.transfer],
			),
			workerExport(
				"Worker",
				"{ new<Send = unknown, Receive = unknown>(entry: WorkerUrl, options?: WorkerOptions): Worker<Send, Receive> }",
				"Start a declared isolated module and expose its ordered port and complete lifecycle.",
				false,
				[workerExamples.worker, workerExamples.echo],
			),
			workerExport(
				"MessageChannel",
				"{ new(options?: MessageChannelOptions): MessageChannel }",
				"Create two transferable endpoints independently of worker startup.",
				false,
				[workerExamples.channel],
			),
			workerExport(
				"MessagePort",
				"{ readonly prototype: MessagePort }",
				"The port prototype for type and identity checks. Ports are created by channels and workers.",
				false,
				[workerExamples.port],
			),
			workerExport(
				"receiveMessageOnPort",
				"<Receive>(port: MessagePort<unknown, Receive>) => { message: Receive } | undefined",
				"Synchronously dequeue one pending message without running unrelated callbacks.",
				false,
				[workerExamples.receive],
			),
			workerExport(
				"capabilities",
				"() => { readonly threads: boolean; readonly sharedMemory: boolean; readonly parallelism: number; readonly maxWorkers: number }",
				"Report the running host's worker facilities and capacity.",
				false,
				[workerExamples.capabilities],
			),
			{
				name: "parentPort",
				type: { kind: "signature", source: "MessagePort | null" },
				description: "The worker's parent endpoint; null in the main isolate.",
				examples: [workerExamples.echo],
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			},
			{
				name: "workerData",
				type: { kind: "signature", source: "unknown" },
				description: "The worker-owned clone of startup data.",
				examples: [workerExamples.workerData, workerExamples.configuration],
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "native",
		id: "maligator:internal/workers",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_workers",
		declarationFile: "workers-host-api.d.ts",
		typeImports: [{ namespace: "Workers", from: "maligator:workers" }],
		description:
			"Toolchain-owned worker substrate used by the public source API and Node compatibility personality.",
		types: internalWorkerTypes,
		exports: [
			workerExport(
				"Worker",
				"{ new <Send = unknown, Receive = unknown>(entry: { readonly href: string }, options?: Workers.WorkerOptions): Worker<Send, Receive> }",
				"Start a declared isolated module with a transactional parent port.",
			),
			workerExport(
				"MessageChannel",
				"{ new <Forward = unknown, Backward = unknown>(options?: Workers.MessageChannelOptions): MessageChannel<Forward, Backward> }",
				"Create two transactional endpoints.",
			),
			workerExport(
				"MessagePort",
				"{ readonly prototype: MessagePort }",
				"The transactional port prototype.",
			),
			workerExport(
				"receiveMessageOnPort",
				"<Receive>(port: MessagePort<unknown, Receive>) => { readonly message: Receive } | undefined",
				"Synchronously dequeue one pending message without running unrelated callbacks.",
			),
			workerExport(
				"capabilities",
				"typeof Workers.capabilities",
				"Report the running host's worker facilities and capacity.",
			),
			workerExport(
				"failCurrent",
				"() => void",
				"Fail the current worker after its outcome cannot be published.",
			),
			workerExport(
				"createWorkerUrl",
				"(specifier: string, base: string) => { readonly href: string }",
				"Internal static entry declaration.",
				true,
			),
			...[
				{ name: "parentPort", source: "MessagePort | null" },
				{ name: "workerData", source: "unknown" },
			].map(({ name, source }): PlatformExport => ({
				name,
				type: { kind: "signature", source },
				description: "Isolate-owned worker state.",
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			})),
			{
				name: "poolEntry",
				type: { kind: "signature", source: "{ readonly href: string }" },
				description: "The task-pool bootstrap entry.",
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
					declaration: "worker-entry",
					workerSource: "workers/pool-worker.ts",
				},
			},
		],
	},
	{
		kind: "source",
		id: "maligator:assets",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "assets/runtime.ts",
		declarationFile: "assets-api.d.ts",
		description:
			"Embed files and directory trees into the application. Each call must take a string literal specifier, resolved like an import from the calling module, and literal options. `maligator build` captures the files of every declaration the program can reach; other commands read the source files live, so edits need no rebuild.",
		types: assetTypes,
		exports: [
			embedExport(
				"embedFile",
				"(specifier: string, options?: EmbedFileOptions) => EmbeddedFile",
				"Declare a file to embed and return its handle. Repeated declarations of the same file share one handle.",
				[
					'import { embedFile } from "maligator:assets";\n\nconst certificate = embedFile("./certs/ca.pem");\nconsole.log(certificate.text().length);',
				],
			),
			embedExport(
				"embedDirectory",
				"(specifier: string, options?: EmbedDirectoryOptions) => EmbeddedDirectory",
				"Declare a directory tree to embed and return its handle. Repeated declarations with the same options share one handle.",
				[
					'import { embedDirectory } from "maligator:assets";\n\nconst migrations = embedDirectory("./migrations", { include: ["*.sql"] });\nfor (const file of migrations.files()) console.log(file.path);',
				],
			),
		],
	},
	{
		kind: "source",
		id: "maligator:http",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "http/runtime.ts",
		declarationFile: "http-api.d.ts",
		typeImports: [{ namespace: "Assets", from: "maligator:assets" }],
		description:
			"Serve HTTP with Fetch API handlers and embedded assets. A server whose whole handler serves an asset answers without running JavaScript per request.",
		types: httpTypes,
		exports: [
			{
				name: "serve",
				type: { kind: "signature", source: "(options: ServeOptions) => Server" },
				description:
					"Listen and answer each request with `fetch`. Invalid options and bind failures throw.",
				examples: [
					'import { serve } from "maligator:http";\n\nconst server = serve({\n  hostname: "127.0.0.1",\n  port: 3000,\n  fetch: () => new Response("hello"),\n});\nconsole.log(server.url);',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
			{
				name: "serveAsset",
				type: {
					kind: "signature",
					source:
						"(asset: Assets.EmbeddedFile | Assets.EmbeddedDirectory, options?: ServeAssetOptions) => Handler",
				},
				description:
					"A handler that serves an embedded file or directory with its media type, ETag, cache headers, conditional and range requests, and precompressed copies in production builds. While a declaration's watcher runs, the handler forwards to the watcher's URL instead.",
				examples: [
					'import { embedDirectory } from "maligator:assets";\nimport { serve, serveAsset } from "maligator:http";\n\nconst files = serveAsset(embedDirectory("./public"), { fallback: "index.html" });\nserve({ port: 3000, fetch: files });',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
			{
				name: "proxy",
				type: { kind: "signature", source: "(target: string) => Handler" },
				description:
					"A handler that forwards each request to the same path below `target` and returns the answer.",
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
			{
				name: "fetch",
				type: { kind: "signature", source: "typeof globalThis.fetch" },
				description:
					"The Fetch API's `fetch`, the same function as the global one. Importing it links the HTTP client without installing the global.",
				examples: [
					'import { fetch } from "maligator:http";\n\nconst response = await fetch("https://example.com/");\nconsole.log(response.status);',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "native",
		id: "maligator:internal/fetch",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_fetch",
		requiresUrlParser: true,
		declarationFile: "fetch-host-api.d.ts",
		description: "The native fetch behind `maligator:http`'s `fetch` export.",
		types: [],
		exports: [
			workerExport(
				"fetch",
				"typeof globalThis.fetch",
				"fetch() over the runtime's HTTP client.",
			),
		],
	},
	{
		kind: "native",
		id: "maligator:internal/http",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_http",
		requiresUrlParser: true,
		declarationFile: "http-host-api.d.ts",
		typeImports: [
			{ namespace: "Http", from: "maligator:http" },
			{ namespace: "Assets", from: "maligator:assets" },
		],
		description: "Native listeners and asset responses under `maligator:http`.",
		types: [],
		exports: [
			workerExport(
				"listen",
				"(options: { handler: Http.Handler; asset?: { readonly handle: Assets.EmbeddedFile | Assets.EmbeddedDirectory; readonly prefix: string; readonly fallback?: string; readonly immutable: ReadonlyArray<string> }; hostname: string; port?: number; headersTimeout?: number; requestTimeout?: number; keepAliveTimeout?: number; maxConnections?: number }) => { readonly port: number; close(): Promise<void> }",
				"Bind a listener; with `asset`, requests are answered from the handle natively.",
			),
			workerExport(
				"assetResponse",
				"(handle: Assets.EmbeddedFile | Assets.EmbeddedDirectory, request: Request, route: { readonly prefix: string; readonly fallback?: string; readonly immutable: ReadonlyArray<string> }) => Response",
				"The response an asset route gives a request.",
			),
			workerExport(
				"assetProxy",
				"(handle: Assets.EmbeddedFile | Assets.EmbeddedDirectory) => string | undefined",
				"The URL of the watcher a handle's files come from in this command.",
			),
			{
				name: "watching",
				type: boolean,
				description:
					"Whether a declaration may be served from its watcher. A whole-program build knows its declarations, so the compiler folds this and drops forwarding when none watches.",
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "source",
		id: "maligator:fs",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "fs/runtime.ts",
		declarationFile: "fs-api.d.ts",
		description:
			"Read, write, and stream files, work with directories, and watch for changes.",
		types: fsTypes,
		exports: [
			{
				name: "file",
				type: { kind: "signature", source: "(path: FilePath) => DiskFile" },
				description:
					"A handle for the file at `path`. It does no I/O, so the file need not exist yet. Throws a TypeError for an empty path, a path with a null byte or a URL that is not a `file:` URL.",
				examples: [
					'import { file } from "maligator:fs";\n\nconst settings = file("settings.json");\nif (await settings.exists()) console.log(await settings.json());\nawait file("out/report.txt").write("done\\n", { atomic: true, createDirectories: true });',
					'import { file } from "maligator:fs";\n\nawait using output = file("copy.bin").writer();\nfor await (const chunk of file("input.bin").stream()) await output.write(chunk);',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
			{
				name: "directory",
				type: { kind: "signature", source: "(path: FilePath) => DiskDirectory" },
				description:
					"A handle for the directory at `path`. It does no I/O, so the directory need not exist yet. Throws a TypeError for an empty path, a path with a null byte or a URL that is not a `file:` URL.",
				examples: [
					'import { directory } from "maligator:fs";\n\nconst reports = directory("out/reports");\nawait reports.create({ recursive: true });\nawait reports.file("latest.txt").write("done\\n");\nfor (const report of await reports.files({ include: ["*.txt"] })) console.log(report.path);',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
			workerExport(
				"realpath",
				"(path: FilePath) => Promise<string>",
				"Return the absolute path of an existing entry after resolving symbolic links.",
			),
			workerExport(
				"readlink",
				"(path: FilePath) => Promise<string>",
				"Read the target stored in a symbolic link, keeping relative targets relative.",
			),
			workerExport(
				"symlink",
				"(target: string, link: FilePath) => Promise<void>",
				"Create a symbolic link to `target`. A relative target resolves from the link's parent. The target can be missing.",
			),
			workerExport(
				"temporaryDirectory",
				"(options?: TemporaryDirectoryOptions) => Promise<DiskDirectory>",
				"Create a directory accessible only by its owner and return its absolute handle. Call `delete()` when done.",
				false,
				[
					'import { temporaryDirectory } from "maligator:fs";\n\nconst scratch = await temporaryDirectory({ prefix: "report-" });\ntry {\n  await scratch.file("report.txt").write("done");\n} finally {\n  await scratch.delete({ recursive: true, missingOk: true });\n}',
				],
			),
			workerExport(
				"watch",
				"(path: FilePath, options?: WatchOptions) => AsyncIterableIterator<FileChange>",
				"Watch a file or directory using an async iterator. The first `next()` starts the watch. Breaking out of the loop, calling `return()`, or aborting the signal closes it.",
				false,
				[
					'import { watch } from "maligator:fs";\n\nfor await (const change of watch("inbox", { recursive: true })) {\n  console.log(change.kind, change.path);\n  if (change.kind === "create") break;\n}',
				],
			),
			{
				name: "FileSystemError",
				type: {
					kind: "signature",
					source:
						"{\n new (message: string, options: { code: string; syscall: string; path: string; destination?: string }): FileSystemError;\n readonly prototype: FileSystemError;\n}",
				},
				description: "The class of every rejection a failed filesystem operation causes.",
				examples: [
					'import { file, FileSystemError } from "maligator:fs";\n\ntry {\n  console.log(await file("notes.txt").text());\n} catch (error) {\n  if (!(error instanceof FileSystemError) || error.code !== "ENOENT") throw error;\n  console.log("no notes yet");\n}',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "native",
		id: "maligator:internal/fs",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_fs",
		declarationFile: "fs-host-api.d.ts",
		description:
			"Native file operations under `maligator:fs`. Failures reject with `{ code, description, syscall, path, destination }`.",
		types: [],
		exports: [
			workerExport(
				"mediaType",
				"(path: string) => string",
				"The media type the extension of `path` implies.",
			),
			workerExport(
				"exists",
				"(path: string) => Promise<boolean>",
				"Whether `path` resolves, following symbolic links.",
			),
			workerExport(
				"stat",
				"(path: string, follow: boolean) => Promise<{ readonly type: number; readonly size: number; readonly mtimeMs: number; readonly mode: number }>",
				"stat(2), or lstat(2) without `follow`. `type` is the host's file type code: 1 file, 2 directory, 3 symbolic link.",
			),
			workerExport(
				"read",
				"{ (path: string, text: false): Promise<Uint8Array<ArrayBuffer>>; (path: string, text: true): Promise<string> }",
				"The whole file as bytes, or as UTF-8 text without a byte order mark.",
			),
			workerExport(
				"write",
				"(path: string, data: string | ArrayBufferView | ArrayBuffer, flags: number, mode: number | undefined) => Promise<number>",
				"Write `data` with the requested flags and creation mode.",
			),
			workerExport(
				"remove",
				"(path: string, missingOk: boolean) => Promise<void>",
				"Unlink a file.",
			),
			workerExport(
				"copy",
				"(source: string, destination: string, overwrite: boolean) => Promise<void>",
				"Copy a file with its permission bits.",
			),
			workerExport(
				"move",
				"(source: string, destination: string, overwrite: boolean, directoryOnly: boolean) => Promise<void>",
				"Rename an entry. A regular file can move across file systems unless `directoryOnly` is set.",
			),
			workerExport(
				"list",
				"{ (path: string, recursive: boolean, filesOnly: true, dot: boolean, include: ReadonlyArray<string> | undefined, exclude: ReadonlyArray<string> | undefined): Promise<Array<string>>; (path: string, recursive: boolean, filesOnly: false, dot: boolean, include: ReadonlyArray<string> | undefined, exclude: ReadonlyArray<string> | undefined): Promise<Array<{ path: string; type: number }>> }",
				"Find matching entries and sort their relative paths by code point. With `filesOnly`, return only the paths of regular files.",
			),
			workerExport(
				"createDirectory",
				"(path: string, recursive: boolean, mode: number | undefined) => Promise<void>",
				"Create a directory with optional parents and permission bits.",
			),
			workerExport(
				"removeDirectory",
				"(path: string, recursive: boolean, missingOk: boolean) => Promise<void>",
				"Remove a directory, with its contents when requested.",
			),
			workerExport(
				"chmod",
				"(path: string, mode: number) => Promise<void>",
				"Set the permission bits of an existing entry.",
			),
			workerExport("realpath", "(path: string) => Promise<string>", "Resolve a path."),
			workerExport(
				"readlink",
				"(path: string) => Promise<string>",
				"Read a symbolic link target.",
			),
			workerExport(
				"symlink",
				"(target: string, path: string) => Promise<void>",
				"Create a symbolic link.",
			),
			workerExport(
				"temporaryDirectory",
				"(parent: string | undefined, prefix: string) => Promise<string>",
				"Create a private temporary directory and return its absolute path.",
			),
		],
	},
	{
		kind: "native",
		id: "maligator:internal/fs-descriptor",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_fs_descriptor",
		declarationFile: "fs-descriptor-host-api.d.ts",
		description: "Descriptor operations for incremental I/O on the blocking-work pool.",
		types: [
			workerType(
				"Descriptor",
				"{ readonly __descriptor: unique symbol }",
				"An opaque, GC-owned file descriptor.",
			),
		],
		exports: [
			workerExport(
				"openDescriptor",
				"(path: string, access: 0 | 1 | 2, createDirectories: boolean, mode: number | undefined) => Promise<Descriptor>",
				"Open a descriptor for reading, writing, or appending.",
			),
			workerExport(
				"readChunk",
				"(path: string, descriptor: Descriptor, offset: number, length: number) => Promise<Uint8Array<ArrayBuffer> | undefined>",
				"Read up to length bytes, or return undefined at EOF.",
			),
			workerExport(
				"writeChunk",
				"(path: string, descriptor: Descriptor, data: string | ArrayBufferView | ArrayBuffer) => Promise<number>",
				"Write the chunk in full at the descriptor's current write position.",
			),
			workerExport(
				"flushDescriptor",
				"(path: string, descriptor: Descriptor) => Promise<void>",
				"Sync an open descriptor to disk.",
			),
			workerExport(
				"closeDescriptor",
				"(path: string, descriptor: Descriptor) => Promise<void>",
				"Close an open descriptor.",
			),
		],
	},
	{
		kind: "native",
		id: "maligator:internal/fs-stream",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_fs_stream",
		declarationFile: "fs-stream-host-api.d.ts",
		description: "The filesystem's access to the runtime's readable stream constructor.",
		types: [],
		exports: [
			workerExport(
				"readableStream",
				"(source: UnderlyingDefaultSource<Uint8Array<ArrayBuffer>>, strategy: QueuingStrategy<Uint8Array<ArrayBuffer>>) => ReadableStream<Uint8Array<ArrayBuffer>>",
				"Create a readable stream without installing web globals.",
			),
		],
	},
	{
		kind: "native",
		id: "maligator:internal/fs-watch",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_fs_watch",
		declarationFile: "fs-watch-host-api.d.ts",
		description: "Reactor-backed filesystem change notifications.",
		types: [
			workerType(
				"WatchListener",
				'(kind: "create" | "modify" | "delete" | "rename" | "error", path: string, failure?: unknown) => void',
				"The listener identifies its watch until it is stopped.",
			),
		],
		exports: [
			workerExport(
				"openWatch",
				"(path: string, recursive: boolean, listener: WatchListener) => void",
				"Register change notifications on the reactor.",
			),
			workerExport(
				"closeWatch",
				"(listener: WatchListener) => void",
				"Stop change notifications and close the watch.",
			),
		],
	},
	{
		kind: "native",
		id: "maligator:process",
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_process",
		declarationFile: "process-api.d.ts",
		description:
			"Read the compile-time command, target, and resolved application configuration. Runtime arguments, environment, working directory, and PID are separate process values.",
		types: executionTypes,
		exports: [
			{
				name: "execution",
				type: reference("Execution"),
				description:
					"An immutable snapshot of the workflow, target, and resolved configuration, fixed before compilation. Known property reads can specialize application branches. Runtime arguments, environment, working directory, and PID are outside this snapshot. Profiling does not change production intent. Static and dynamic imports share its identity, and reflection sees the complete deeply frozen shape.",
				examples: [
					'import { execution } from "maligator:process";\n\nif (execution.compiled && execution.production) {\n  console.log("native production application");\n}',
					'import { execution } from "maligator:process";\n\nif (execution.command === "test") {\n  console.log(execution.options.repeat);\n}',
				],
				contract: {
					phase: "preparation",
					value: "deep-frozen-data",
					identity: "application-context",
					provider: "execution",
					effects: NO_EFFECT_SUMMARY,
				},
			},
		],
	},

	{
		kind: "source",
		id: "maligator:test",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "testing/runtime.mjs",
		declarationFile: "test-api.d.ts",
		description:
			"Test authoring and assertions. Importing this module does not register tests or install runner globals. Registration and assertions are ordinary effectful calls; the test command initializes its internal runner explicitly. Unused imports can be eliminated.",
		types: [
			{
				name: "TestCallback",
				type: {
					kind: "signature",
					source: "() => unknown",
				},
				description:
					"A test or hook body. Maligator waits for a returned promise or thenable before advancing the lifecycle.",
			},
			{
				name: "HookCallback",
				type: {
					kind: "signature",
					source: "TestCallback",
				},
				description:
					"A lifecycle hook body, with the same async completion contract as a test.",
			},
			{
				name: "Constructor",
				type: {
					kind: "signature",
					source: "abstract new (...args: Array<never>) => unknown",
				},
				description: "A constructable value accepted by {@link expect.any}.",
			},
			{
				name: "AsymmetricMatcher",
				type: {
					kind: "signature",
					source: "{\n\t\treadonly __maligator_asymmetric__: string;\n\t}",
				},
				description:
					"Opaque partial-match value produced by helpers such as {@link expect.objectContaining}. It may be nested inside `toEqual`, `toStrictEqual`, and `toMatchObject` expectations.",
			},
			{
				name: "Matchers",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Negate the following matcher. */\n\t\treadonly not: Matchers;\n\t\t/** Wait for the received promise to fulfill, then match its value. */\n\t\treadonly resolves: AsyncMatchers;\n\t\t/** Wait for the received promise to reject, then match its reason. */\n\t\treadonly rejects: AsyncMatchers;\n\t\t/** Require ECMAScript `Object.is` identity. */\n\t\ttoBe(expected: unknown): void;\n\t\t/** Recursively compare enumerable object properties and array elements. */\n\t\ttoEqual(expected: unknown): void;\n\t\t/**\n\t\t * Recursively compare values while also requiring matching prototypes and\n\t\t * matching sparse-array holes.\n\t\t */\n\t\ttoStrictEqual(expected: unknown): void;\n\t\t/** Require a value other than `undefined`. */\n\t\ttoBeDefined(): void;\n\t\t/** Require `undefined`. */\n\t\ttoBeUndefined(): void;\n\t\t/** Require `null`. */\n\t\ttoBeNull(): void;\n\t\t/** Require a truthy value. */\n\t\ttoBeTruthy(): void;\n\t\t/** Require a falsy value. */\n\t\ttoBeFalsy(): void;\n\t\t/** Require a string substring or an array element matched by identity. */\n\t\ttoContain(expected: unknown): void;\n\t\t/** Require a numeric `.length` equal to `expected`. */\n\t\ttoHaveLength(expected: number): void;\n\t\t/** Match a string against a substring or regular expression. */\n\t\ttoMatch(expected: string | RegExp): void;\n\t\t/** Recursively require the enumerable properties present in `expected`. */\n\t\ttoMatchObject(expected: object): void;\n\t\t/**\n\t\t * Invoke the received function and require it to throw. The optional\n\t\t * expectation may be a message substring, regular expression, error\n\t\t * constructor, or error instance.\n\t\t */\n\t\ttoThrow(\n\t\t\texpected?:\n\t\t\t\t| string\n\t\t\t\t| RegExp\n\t\t\t\t| Error\n\t\t\t\t| (abstract new (...args: Array<never>) => Error),\n\t\t): void;\n\t}",
				},
				description: "Matchers for a synchronously received value.",
			},
			{
				name: "AsyncMatchers",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Negate the following asynchronous matcher. */\n\t\treadonly not: AsyncMatchers;\n\t\ttoBe(expected: unknown): Promise<void>;\n\t\ttoEqual(expected: unknown): Promise<void>;\n\t\ttoStrictEqual(expected: unknown): Promise<void>;\n\t\ttoBeDefined(): Promise<void>;\n\t\ttoBeUndefined(): Promise<void>;\n\t\ttoBeNull(): Promise<void>;\n\t\ttoBeTruthy(): Promise<void>;\n\t\ttoBeFalsy(): Promise<void>;\n\t\ttoContain(expected: unknown): Promise<void>;\n\t\ttoHaveLength(expected: number): Promise<void>;\n\t\ttoMatch(expected: string | RegExp): Promise<void>;\n\t\ttoMatchObject(expected: object): Promise<void>;\n\t\ttoThrow(\n\t\t\texpected?:\n\t\t\t\t| string\n\t\t\t\t| RegExp\n\t\t\t\t| Error\n\t\t\t\t| (abstract new (...args: Array<never>) => Error),\n\t\t): Promise<void>;\n\t}",
				},
				description:
					"Promise-returning matcher surface exposed by {@link Matchers.resolves} and {@link Matchers.rejects}. Await these calls so the test cannot finish before the assertion.",
			},
			{
				name: "ExpectFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Create matchers for `received`. The assertion position is captured here. */\n\t\t(received: unknown): Matchers;\n\t\t/** Match a primitive of the corresponding built-in kind or an instance. */\n\t\tany(constructorValue: Constructor): AsymmetricMatcher;\n\t\t/** Match any value except `null` and `undefined`. */\n\t\tanything(): AsymmetricMatcher;\n\t\t/** Match a string containing `pattern` or satisfying the regular expression. */\n\t\tstringMatching(pattern: string | RegExp): AsymmetricMatcher;\n\t\t/** Match an object containing all recursively matched properties in `value`. */\n\t\tobjectContaining(value: object): AsymmetricMatcher;\n\t\t/** Match an array containing a match for every element in `value`. */\n\t\tarrayContaining(value: Array<unknown>): AsymmetricMatcher;\n\t}",
				},
				description:
					"Assertion entrypoint and Maligator-owned asymmetric matcher factories.",
			},
			{
				name: "TestFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Register a test. Returned promises are awaited by the runner. */\n\t\t(name: string, callback: TestCallback): void;\n\t\t/** Register a skipped test without invoking its callback. */\n\t\tskip(name: string, callback: TestCallback): void;\n\t\t/** Register a named placeholder with no callback. */\n\t\ttodo(name: string): void;\n\t\t/**\n\t\t * Register a focused test. When any `.only` exists, non-focused tests are\n\t\t * skipped and the runner emits a warning.\n\t\t */\n\t\tonly(name: string, callback: TestCallback): void;\n\t\t/**\n\t\t * Register one test for each row. Use `%#` in `name` for the zero-based row\n\t\t * index. Array rows are spread into callback parameters.\n\t\t */\n\t\teach<const Row extends ReadonlyArray<unknown>>(\n\t\t\trows: ReadonlyArray<Row>,\n\t\t): (name: string, callback: (...values: [...Row]) => unknown) => void;\n\t}",
				},
				description: "Register tests in the current suite during module evaluation.",
			},
			{
				name: "DescribeFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Register a suite. Suite callbacks must not return a promise. */\n\t\t(name: string, callback: () => void): void;\n\t\t/** Register a suite whose descendants are skipped. */\n\t\tskip(name: string, callback: () => void): void;\n\t\t/** Register a focused suite and emit the runner's focused-test warning. */\n\t\tonly(name: string, callback: () => void): void;\n\t}",
				},
				description: "Register nested suites synchronously during module evaluation.",
			},
		],
		exports: [
			{
				name: "test",
				type: {
					kind: "reference",
					name: "TestFunction",
				},
				description: "Register a test in the current suite.",
			},
			{
				name: "describe",
				type: {
					kind: "reference",
					name: "DescribeFunction",
				},
				description: "Register a nested suite in the current suite.",
			},
			{
				name: "expect",
				type: {
					kind: "reference",
					name: "ExpectFunction",
				},
				description: "Create fluent matchers for a received value.",
			},
			{
				name: "beforeAll",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description: "Run once before tests in the current suite.",
			},
			{
				name: "afterAll",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run once after tests in the current suite, including after test failures.",
			},
			{
				name: "beforeEach",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run before every selected descendant test. Ancestor hooks run before hooks\ndeclared by a nested suite.",
			},
			{
				name: "afterEach",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run after every selected descendant test. Nested-suite hooks run before\nancestor hooks.",
			},
		].map((entry): PlatformExport => ({
			...entry,
			type: entry.type as PlatformType,
			contract: {
				phase: "runtime",
				value: "callable",
				identity: "module",
				effects: EVERY_EFFECT_SUMMARY,
			},
		})),
	},
];

export function lookupPlatformModule(specifier: string): PlatformModule | undefined {
	return PLATFORM_MODULES.find((module) => module.id === specifier);
}

/** Validate provider data against the same schema that generates the public types. */
export function validatePlatformValue(
	module: PlatformModule,
	type: PlatformType,
	value: unknown,
): value is PlatformData {
	switch (type.kind) {
		case "signature":
			return false;
		case "primitive":
			return (
				typeof value === type.name && (type.name !== "number" || Number.isFinite(value))
			);
		case "literal":
			return value === type.value;
		case "reference": {
			const definition = module.types.find((entry) => entry.name === type.name);
			if (!definition) throw new Error(`Unknown platform type ${module.id}/${type.name}`);
			return validatePlatformValue(module, definition.type, value);
		}
		case "array":
			return (
				Array.isArray(value) &&
				value.every((item: unknown) => validatePlatformValue(module, type.element, item))
			);
		case "record":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.values(value).every((item: unknown) =>
					validatePlatformValue(module, type.value, item),
				)
			);
		case "object":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				type.properties.every(
					(entry) =>
						Object.hasOwn(value, entry.name) &&
						validatePlatformValue(
							module,
							entry.type,
							(value as Record<string, unknown>)[entry.name],
						),
				)
			);
		case "union":
			return type.types.some((entry) => validatePlatformValue(module, entry, value));
		case "intersection":
			return type.types.every((entry) => validatePlatformValue(module, entry, value));
	}
}
