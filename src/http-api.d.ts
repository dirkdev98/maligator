// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Serve HTTP with Fetch API handlers and embedded assets. Requires
 * `surface.webPlatform`. A server whose whole handler serves an asset answers without
 * running JavaScript per request.
 */
declare module "maligator:http" {
	import type * as Assets from "maligator:assets";
	/**
	 * Answers a buffered request. A thrown error or rejection reaches the server's error
	 * handler.
	 *
	 * @see https://maligator.ddv.tools/api/http#Handler
	 */
	export type Handler = (request: Request) => Response | PromiseLike<Response>;

	/**
	 * Turns a handler failure into a response.
	 *
	 * @see https://maligator.ddv.tools/api/http#ErrorHandler
	 */
	export type ErrorHandler = (
		error: unknown,
		request: Request,
	) => Response | PromiseLike<Response>;

	/**
	 * Where to listen and how to answer. Limits are integers from 0 through 2147483647.
	 *
	 * @see https://maligator.ddv.tools/api/http#ServeOptions
	 */
	export type ServeOptions = {
		/** Answers each request. */
		fetch: Handler;
		/** Answers instead when `fetch` throws or rejects. Defaults to logging the error and a plain 500 response. */
		error?: ErrorHandler;
		/** Bind address. Defaults to 0.0.0.0; use 127.0.0.1 for a local-only listener. */
		hostname?: string;
		/** TCP port, 0 through 65535. Defaults to 0, which lets the OS choose. */
		port?: number;
		/** Closes the server when aborted. */
		signal?: AbortSignal;
		/** Header deadline in milliseconds; 0 selects the default of 60000. */
		headersTimeout?: number;
		/** Request deadline in milliseconds; 0 selects the default of 300000. */
		requestTimeout?: number;
		/** Idle keep-alive deadline in milliseconds; 0 selects the default of 5000. */
		keepAliveTimeout?: number;
		/** Concurrent connection limit; 0 selects the default of 1024. */
		maxConnections?: number;
	};

	/**
	 * A listening server. `await using` closes it at the end of a scope.
	 *
	 * @see https://maligator.ddv.tools/api/http#Server
	 */
	export interface Server {
		/** The bound port, including one the OS chose. */
		readonly port: number;
		readonly hostname: string;
		/** A URL that reaches the server from this machine. */
		readonly url: string;
		/** Stops accepting and fulfills once in-flight requests finished. Repeated calls share one promise. */
		close(): Promise<void>;
		[Symbol.asyncDispose](): Promise<void>;
	}

	/**
	 * How request paths map onto the asset. A path ending in `/` serves its
	 * `index.html`.
	 *
	 * @see https://maligator.ddv.tools/api/http#ServeAssetOptions
	 */
	export type ServeAssetOptions = {
		/** The URL path the directory is served below, such as `/static`. Defaults to the root. */
		prefix?: string;
		/** The member served for paths below the prefix that name no file, such as `index.html` for a client-side router. */
		fallback?: string;
		/** Patterns of member paths with content-hashed names, served as cacheable forever. */
		immutable?: ReadonlyArray<string>;
	};

	/**
	 * Listen and answer each request with `fetch`. Invalid options and bind failures
	 * throw.
	 *
	 * @example
	 * import { serve } from "maligator:http";
	 *
	 * const server = serve({
	 *   hostname: "127.0.0.1",
	 *   port: 3000,
	 *   fetch: () => new Response("hello"),
	 * });
	 * console.log(server.url);
	 *
	 * @see https://maligator.ddv.tools/api/http#serve
	 */
	export const serve: (options: ServeOptions) => Server;
	/**
	 * A handler that serves an embedded file or directory with its media type, ETag,
	 * cache headers, conditional and range requests, and precompressed copies in
	 * production builds. While a declaration's watcher runs, the handler forwards to the
	 * watcher's URL instead.
	 *
	 * @example
	 * import { embedDirectory } from "maligator:assets";
	 * import { serve, serveAsset } from "maligator:http";
	 *
	 * const files = serveAsset(embedDirectory("./public"), { fallback: "index.html" });
	 * serve({ port: 3000, fetch: files });
	 *
	 * @see https://maligator.ddv.tools/api/http#serveAsset
	 */
	export const serveAsset: (
		asset: Assets.EmbeddedFile | Assets.EmbeddedDirectory,
		options?: ServeAssetOptions,
	) => Handler;
	/**
	 * A handler that forwards each request to the same path below `target` and returns
	 * the buffered answer.
	 *
	 * @see https://maligator.ddv.tools/api/http#proxy
	 */
	export const proxy: (target: string) => Handler;
}
