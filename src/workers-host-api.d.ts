// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Toolchain-owned worker substrate used by the public source API and Node
 * compatibility personality.
 */
declare module "maligator:internal/workers" {
	/**
	 * Internal host operation.
	 */
	export const Worker: (...args: Array<unknown>) => unknown;
	/**
	 * Internal host operation.
	 */
	export const MessageChannel: (...args: Array<unknown>) => unknown;
	/**
	 * Internal host operation.
	 */
	export const MessagePort: (...args: Array<unknown>) => unknown;
	/**
	 * Internal host operation.
	 */
	export const receiveMessageOnPort: (...args: Array<unknown>) => unknown;
	/**
	 * Internal host operation.
	 */
	export const capabilities: (...args: Array<unknown>) => unknown;
	/**
	 * Internal host operation.
	 */
	export const failCurrent: (...args: Array<unknown>) => unknown;
	/**
	 * Internal static entry declaration.
	 */
	export const createWorkerUrl: (
		specifier: string,
		base: string,
	) => { readonly href: string };
	/**
	 * Isolate-owned worker state.
	 */
	export const parentPort: unknown;
	/**
	 * Isolate-owned worker state.
	 */
	export const workerData: unknown;
	/**
	 * The task-pool bootstrap entry.
	 */
	export const poolEntry: { readonly href: string };
}
