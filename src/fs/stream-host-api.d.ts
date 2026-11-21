// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * The filesystem's access to the runtime's readable stream constructor.
 */
declare module "maligator:internal/fs-stream" {
	/**
	 * Create a readable stream without installing web globals.
	 */
	export const readableStream: (
		source: UnderlyingDefaultSource<Uint8Array<ArrayBuffer>>,
		strategy: QueuingStrategy<Uint8Array<ArrayBuffer>>,
	) => ReadableStream<Uint8Array<ArrayBuffer>>;
}
