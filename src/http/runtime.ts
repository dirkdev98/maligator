import type { EmbeddedDirectory, EmbeddedFile } from "maligator:assets";
import type {
	ErrorHandler,
	Handler,
	ServeAssetOptions,
	ServeOptions,
	Server,
} from "maligator:http";
import { assetProxy, assetResponse, listen } from "maligator:internal/http";

interface AssetRoute {
	readonly handle: EmbeddedFile | EmbeddedDirectory;
	readonly prefix: string;
	readonly fallback?: string;
	readonly immutable: ReadonlyArray<string>;
}

// A server whose whole handler is a serveAsset handler answers from native code.
const assetRoutes = new WeakMap<Handler, AssetRoute>();

// The log carries the failure; the response never shows a client its details.
function failed(error: unknown, request: Request, onError?: ErrorHandler) {
	if (onError !== undefined) return onError(error, request);
	// oxlint-disable-next-line no-console -- A failed request must reach the operator's log.
	console.error(error);
	return new Response("Internal Server Error\n", {
		status: 500,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

function isThenable(value: unknown): value is PromiseLike<Response> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

export function serve(options: ServeOptions): Server {
	if (typeof options !== "object" || options === null)
		throw new TypeError("serve options must be an object");
	const { fetch: respond, error: onError, signal } = options;
	if (typeof respond !== "function")
		throw new TypeError("serve option 'fetch' must be a function");
	if (onError !== undefined && typeof onError !== "function")
		throw new TypeError("serve option 'error' must be a function");
	if (signal !== undefined && !(signal instanceof AbortSignal))
		throw new TypeError("serve option 'signal' must be an AbortSignal");
	const handler = (request: Request) => {
		let result: Response | PromiseLike<Response>;
		try {
			result = respond(request);
		} catch (error) {
			return failed(error, request, onError);
		}
		return isThenable(result)
			? Promise.resolve(result).then(undefined, (error: unknown) =>
					failed(error, request, onError),
				)
			: result;
	};
	const hostname = options.hostname ?? "0.0.0.0";
	const native = listen({
		handler,
		asset: assetRoutes.get(respond),
		hostname,
		port: options.port,
		headersTimeout: options.headersTimeout,
		requestTimeout: options.requestTimeout,
		keepAliveTimeout: options.keepAliveTimeout,
		maxConnections: options.maxConnections,
	});
	const host =
		hostname === "0.0.0.0" || hostname === "::"
			? "localhost"
			: hostname.includes(":")
				? `[${hostname}]`
				: hostname;
	const close = () => native.close();
	if (signal !== undefined) {
		if (signal.aborted) void close();
		else signal.addEventListener("abort", () => void close(), { once: true });
	}
	return Object.freeze({
		port: native.port,
		hostname,
		url: `http://${host}:${native.port}/`,
		close,
		[Symbol.asyncDispose]: close,
	});
}

function isPatternList(value: unknown): value is ReadonlyArray<string> {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function serveAsset(
	asset: EmbeddedFile | EmbeddedDirectory,
	options: ServeAssetOptions = {},
): Handler {
	if (typeof options !== "object" || options === null)
		throw new TypeError("serveAsset options must be an object");
	const { fallback } = options;
	const immutable: unknown = options.immutable ?? [];
	let prefix = options.prefix ?? "";
	if (typeof prefix !== "string" || (prefix !== "" && !prefix.startsWith("/")))
		throw new TypeError("serveAsset option 'prefix' must be a path starting with '/'");
	while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
	if (fallback !== undefined && typeof fallback !== "string")
		throw new TypeError("serveAsset option 'fallback' must be a member path");
	if (!isPatternList(immutable))
		throw new TypeError("serveAsset option 'immutable' must be an array of patterns");
	// A watched declaration's files come from its dev server while one runs.
	const target = assetProxy(asset);
	if (target !== undefined) {
		// Global fetch comes from the Node surface until the web platform has its own.
		if (typeof fetch !== "function")
			throw new TypeError(
				`serveAsset forwards to the watcher at ${target}, which requires surface.node`,
			);
		return proxy(target);
	}
	const route: AssetRoute = Object.freeze({
		handle: asset,
		prefix,
		...(fallback === undefined ? {} : { fallback }),
		immutable: Object.freeze([...immutable]),
	});
	const handler = (request: Request) => assetResponse(asset, request, route);
	assetRoutes.set(handler, route);
	return handler;
}

// The fetch client decodes and frames bodies itself, so these describe the upstream
// message rather than the one the server sends.
const upstreamOnly = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"keep-alive",
	"transfer-encoding",
]);

const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

export function proxy(target: string): Handler {
	const base = new URL(target);
	return async (request: Request) => {
		const url = new URL(request.url);
		const upstream = await fetch(new URL(url.pathname + url.search, base), {
			method: request.method,
			headers: request.headers,
			body:
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: await request.arrayBuffer(),
			redirect: "manual",
		});
		const headers = new Headers();
		upstream.headers.forEach((value, name) => {
			if (!upstreamOnly.has(name)) headers.append(name, value);
		});
		const empty = request.method === "HEAD" || nullBodyStatuses.has(upstream.status);
		return new Response(empty ? null : await upstream.arrayBuffer(), {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	};
}
