// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Embed files and directory trees into the application. Each call must take a string
 * literal specifier, resolved like an import from the calling module, and literal
 * options. `maligator build` captures the files of every declaration the program can
 * reach; other commands read the source files live, so edits need no rebuild.
 */
declare module "maligator:assets" {
	/**
	 * Where an embedded copy is written. Outside `maligator build` the source file is
	 * used in place and this option is ignored.
	 *
	 * @see https://maligator.ddv.tools/api/assets#MaterializeOptions
	 */
	export type MaterializeOptions = {
		/** Parent directory for a materialized copy. Defaults to the OS temporary directory. */
		baseDirectory?: string;
	};

	/**
	 * A file the build embeds. `maligator build` fixes its contents; other commands read
	 * the source file each time.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbeddedFile
	 */
	export interface EmbeddedFile {
		/** The path below its directory declaration, or the file name. */
		readonly path: string;
		/** The size in bytes. */
		readonly size: number;
		/** Lowercase hexadecimal SHA-256 of the contents. */
		readonly digest: string;
		/** The media type implied by the file extension; text types carry `charset=utf-8`. */
		readonly type: string;
		/** The contents as a Uint8Array over an immutable ArrayBuffer. */
		bytes(): Uint8Array<ArrayBuffer>;
		/** The contents decoded as UTF-8, without a byte order mark. */
		text(): string;
		/** The contents parsed as JSON. */
		json(): unknown;
		/** A filesystem path to the contents. Treat it as read-only. */
		materialize(options?: MaterializeOptions): string;
	}

	/**
	 * A directory tree the build embeds. `maligator build` fixes its member files; other
	 * commands list the source directory each time.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbeddedDirectory
	 */
	export interface EmbeddedDirectory {
		/** The member files in code point order of their paths. */
		files(): ReadonlyArray<EmbeddedFile>;
		/** The member file at a slash-separated path, if any. */
		get(path: string): EmbeddedFile | undefined;
		/** A filesystem path to a directory holding the member files. Treat it as read-only. */
		materialize(options?: MaterializeOptions): string;
	}

	/**
	 * A command that writes the declared files.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbedProducer
	 */
	export type EmbedProducer = {
		/** The executable and its arguments; no shell interprets them. */
		command: ReadonlyArray<string>;
		/** The working directory, resolved from the declaring module. Defaults to its directory. */
		cwd?: string;
	};

	/**
	 * A long-running command that keeps the declared files current, such as a frontend
	 * dev server.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbedWatchProducer
	 */
	export type EmbedWatchProducer = EmbedProducer & {
		/** A server the watcher starts; the command waits until it answers. */
		url?: string;
	};

	/**
	 * Which producer each command runs. `existing` uses the files already on disk; a
	 * selected producer must be declared.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbedProducerUse
	 */
	export type EmbedProducerUse = {
		/** Defaults to build. */
		build?: "build" | "existing";
		/** Defaults to build. */
		run?: "build" | "watch" | "existing";
		/** Defaults to existing. */
		test?: "build" | "watch" | "existing";
		/** Defaults to watch, or build without a watcher. */
		dev?: "build" | "watch" | "existing";
	};

	/**
	 * How the declared files are produced. Only the project's own modules may name
	 * commands; they never reach a built executable.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbedFileOptions
	 */
	export type EmbedFileOptions = {
		/** Runs before the files are read: once per run or test, once per dev session, before a build embeds them. */
		build?: EmbedProducer;
		/** Runs alongside the command and stops with it. */
		watch?: EmbedWatchProducer;
		use?: EmbedProducerUse;
	};

	/**
	 * Which files of the directory belong to the declaration, and how they are produced.
	 * Patterns are relative to the directory and use `/` separators.
	 *
	 * @see https://maligator.ddv.tools/api/assets#EmbedDirectoryOptions
	 */
	export type EmbedDirectoryOptions = EmbedFileOptions & {
		/** Patterns of member paths, with `*`, `?` and whole-segment `**`. Defaults to every file. Each pattern must match a file. */
		include?: ReadonlyArray<string>;
		/** Patterns of paths to leave out, even when included. */
		exclude?: ReadonlyArray<string>;
		/** Let wildcards match names that start with a dot. Defaults to false. */
		dot?: boolean;
	};

	/**
	 * Declare a file to embed and return its handle. Repeated declarations of the same
	 * file share one handle.
	 *
	 * @example
	 * import { embedFile } from "maligator:assets";
	 *
	 * const certificate = embedFile("./certs/ca.pem");
	 * console.log(certificate.text().length);
	 *
	 * @see https://maligator.ddv.tools/api/assets#embedFile
	 */
	export const embedFile: (specifier: string, options?: EmbedFileOptions) => EmbeddedFile;
	/**
	 * Declare a directory tree to embed and return its handle. Repeated declarations
	 * with the same options share one handle.
	 *
	 * @example
	 * import { embedDirectory } from "maligator:assets";
	 *
	 * const migrations = embedDirectory("./migrations", { include: ["*.sql"] });
	 * for (const file of migrations.files()) console.log(file.path);
	 *
	 * @see https://maligator.ddv.tools/api/assets#embedDirectory
	 */
	export const embedDirectory: (
		specifier: string,
		options?: EmbedDirectoryOptions,
	) => EmbeddedDirectory;
}
