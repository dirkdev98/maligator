// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * The native fetch behind `maligator:http`'s `fetch` export.
 */
declare module "maligator:internal/fetch" {
	/**
	 * fetch() over the runtime's HTTP client.
	 */
	export const fetch: typeof globalThis.fetch;
}
