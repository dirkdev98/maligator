// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Descriptor operations for incremental I/O on the blocking-work pool.
 */
declare module "maligator:internal/fs-descriptor" {
	/**
	 * An opaque, GC-owned file descriptor.
	 */
	export type Descriptor = { readonly __descriptor: unique symbol };

	/**
	 * Open a descriptor for reading, writing, or appending.
	 */
	export const openDescriptor: (
		path: string,
		access: 0 | 1 | 2,
		createDirectories: boolean,
		mode: number | undefined,
	) => Promise<Descriptor>;
	/**
	 * Read up to length bytes, or return undefined at EOF.
	 */
	export const readChunk: (
		path: string,
		descriptor: Descriptor,
		offset: number,
		length: number,
	) => Promise<Uint8Array<ArrayBuffer> | undefined>;
	/**
	 * Write the chunk in full at the descriptor's current write position.
	 */
	export const writeChunk: (
		path: string,
		descriptor: Descriptor,
		data: string | ArrayBufferView | ArrayBuffer,
	) => Promise<number>;
	/**
	 * Sync an open descriptor to disk.
	 */
	export const flushDescriptor: (path: string, descriptor: Descriptor) => Promise<void>;
	/**
	 * Close an open descriptor.
	 */
	export const closeDescriptor: (path: string, descriptor: Descriptor) => Promise<void>;
}
