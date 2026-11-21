// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Reactor-backed filesystem change notifications.
 */
declare module "maligator:internal/fs-watch" {
	/**
	 * The listener identifies its watch until it is stopped.
	 */
	export type WatchListener = (
		kind: "create" | "modify" | "delete" | "rename" | "error",
		path: string,
		failure?: unknown,
	) => void;

	/**
	 * Register change notifications on the reactor.
	 */
	export const openWatch: (
		path: string,
		recursive: boolean,
		listener: WatchListener,
	) => void;
	/**
	 * Stop change notifications and close the watch.
	 */
	export const closeWatch: (listener: WatchListener) => void;
}
