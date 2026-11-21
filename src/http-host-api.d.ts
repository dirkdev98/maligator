// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Native listeners and asset responses under `maligator:http`.
 */
declare module "maligator:internal/http" {
	import type * as Assets from "maligator:assets";
	import type * as Http from "maligator:http";
	/**
	 * Bind a listener; with `asset`, requests are answered from the handle natively.
	 */
	export const listen: (options: {
		handler: Http.Handler;
		asset?: {
			readonly handle: Assets.EmbeddedFile | Assets.EmbeddedDirectory;
			readonly prefix: string;
			readonly fallback?: string;
			readonly immutable: ReadonlyArray<string>;
		};
		hostname: string;
		port?: number;
		headersTimeout?: number;
		requestTimeout?: number;
		keepAliveTimeout?: number;
		maxConnections?: number;
	}) => { readonly port: number; close(): Promise<void> };
	/**
	 * The response an asset route gives a request.
	 */
	export const assetResponse: (
		handle: Assets.EmbeddedFile | Assets.EmbeddedDirectory,
		request: Request,
		route: {
			readonly prefix: string;
			readonly fallback?: string;
			readonly immutable: ReadonlyArray<string>;
		},
	) => Response;
	/**
	 * The URL of the watcher a handle's files come from in this command.
	 */
	export const assetProxy: (
		handle: Assets.EmbeddedFile | Assets.EmbeddedDirectory,
	) => string | undefined;
}
