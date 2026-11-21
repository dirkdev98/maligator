// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Native file operations under `maligator:fs`. Failures reject with `{ code,
 * description, syscall, path, destination }`.
 */
declare module "maligator:internal/fs" {
	/**
	 * The media type the extension of `path` implies.
	 */
	export const mediaType: (path: string) => string;
	/**
	 * Whether `path` resolves, following symbolic links.
	 */
	export const exists: (path: string) => Promise<boolean>;
	/**
	 * stat(2), or lstat(2) without `follow`. `type` is the host's file type code: 1
	 * file, 2 directory, 3 symbolic link.
	 */
	export const stat: (
		path: string,
		follow: boolean,
	) => Promise<{
		readonly type: number;
		readonly size: number;
		readonly mtimeMs: number;
		readonly mode: number;
	}>;
	/**
	 * The whole file as bytes, or as UTF-8 text without a byte order mark.
	 */
	export const read: {
		(path: string, text: false): Promise<Uint8Array<ArrayBuffer>>;
		(path: string, text: true): Promise<string>;
	};
	/**
	 * Write `data`; flags: 1 append, 2 atomic, 4 create parent directories.
	 */
	export const write: (
		path: string,
		data: string | ArrayBufferView | ArrayBuffer,
		flags: number,
		mode: number | undefined,
	) => Promise<number>;
	/**
	 * Unlink a file.
	 */
	export const remove: (path: string) => Promise<void>;
	/**
	 * Copy a file with its permission bits.
	 */
	export const copy: (
		source: string,
		destination: string,
		overwrite: boolean,
	) => Promise<void>;
	/**
	 * Rename a file, copying it across file systems.
	 */
	export const move: (
		source: string,
		destination: string,
		overwrite: boolean,
	) => Promise<void>;
}
