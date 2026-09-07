import type { ExplorerResult } from "./api.ts";
import {
	EXPLORER_LIMITS,
	EXPLORER_SCHEMA,
	explorerSourcePath,
	normalizeExplorerLanguage,
	normalizeExplorerConfig,
	utf8ByteLength,
} from "./config.ts";
import type { ExplorerConfig, ExplorerLanguage } from "./config.ts";
import type {
	ExplorerSiteData,
	ExplorerWorkerRequest,
	ExplorerWorkerResponse,
} from "./protocol.ts";

export interface ExplorerCompilation {
	result: ExplorerResult;
	cached: boolean;
	milliseconds: number;
	memoryBytes: number;
}

export class ExplorerClientError extends Error {
	readonly kind: "cancelled" | "timeout" | "unavailable" | "compile" | "syntax" | "limit";
	constructor(kind: ExplorerClientError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}

export class ExplorerClient {
	readonly #data: ExplorerSiteData;
	readonly #onState: (state: "loading" | "compiling") => void;
	readonly #cache = new Map<string, { result: ExplorerResult; bytes: number }>();
	#cacheBytes = 0;
	#serial = 0;
	#module?: WebAssembly.Module;
	#worker?: Worker;
	#ready?: Promise<void>;
	#rejectReady?: (error: Error) => void;
	#loadTimer?: ReturnType<typeof setTimeout>;
	#idleTimer?: ReturnType<typeof setTimeout>;
	#inflight?: { signature: string; promise: Promise<ExplorerCompilation> };
	#pending?: {
		id: number;
		resolve: (result: ExplorerCompilation) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};

	constructor(data: ExplorerSiteData, onState: (state: "loading" | "compiling") => void) {
		if (data.schema !== EXPLORER_SCHEMA)
			throw new Error("Incompatible explorer page; reload to update");
		this.#data = data;
		this.#onState = onState;
	}

	compile(
		source: string,
		settings: unknown,
		inputLanguage: unknown = "javascript",
	): Promise<ExplorerCompilation> {
		if (utf8ByteLength(source) > EXPLORER_LIMITS.sourceBytes)
			return Promise.reject(
				new ExplorerClientError("limit", "Source exceeds the 64 KiB UTF-8 limit"),
			);
		const config = normalizeExplorerConfig(settings);
		const language = normalizeExplorerLanguage(inputLanguage);
		const signature = JSON.stringify({ source, config, language });
		if (this.#inflight?.signature === signature) return this.#inflight.promise;
		if (this.#inflight !== undefined) this.cancel();
		const id = ++this.#serial;
		const promise = this.#compile(id, source, config, language).finally(() => {
			if (id === this.#serial) this.#inflight = undefined;
		});
		this.#inflight = { signature, promise };
		return promise;
	}

	cancel(): void {
		this.#serial++;
		this.#inflight = undefined;
		this.#terminate(new ExplorerClientError("cancelled", "Compilation cancelled"));
	}

	dispose(): void {
		this.cancel();
		this.#cache.clear();
		this.#cacheBytes = 0;
		this.#module = undefined;
	}

	async #compile(
		id: number,
		source: string,
		config: ExplorerConfig,
		language: ExplorerLanguage,
	): Promise<ExplorerCompilation> {
		if (
			typeof Worker === "undefined" ||
			typeof WebAssembly === "undefined" ||
			globalThis.crypto?.subtle === undefined
		)
			throw new ExplorerClientError(
				"unavailable",
				"This explorer needs a current browser with WebAssembly, workers and HTTPS (or localhost)",
			);
		const input = JSON.stringify({
			identity: this.#data.identity,
			schema: EXPLORER_SCHEMA,
			path: explorerSourcePath(language),
			goal: "module",
			source,
			config,
			language,
		});
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
		const key = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		this.#checkCurrent(id);
		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			this.#cache.delete(key);
			this.#cache.set(key, cached);
			return {
				result: cached.result,
				cached: true,
				milliseconds: 0,
				memoryBytes: 0,
			};
		}
		clearTimeout(this.#idleTimer);
		await this.#ensureWorker();
		this.#checkCurrent(id);
		this.#onState("compiling");
		const output = await new Promise<ExplorerCompilation>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					this.#terminate(
						new ExplorerClientError(
							"timeout",
							"Compilation exceeded 10 seconds; try a smaller snippet",
						),
					),
				EXPLORER_LIMITS.compileMs,
			);
			this.#pending = { id, resolve, reject, timer };
			try {
				this.#worker!.postMessage({
					type: "compile",
					id,
					identity: this.#data.identity,
					source,
					config,
					language,
				} satisfies ExplorerWorkerRequest);
			} catch {
				this.#terminate(
					new ExplorerClientError(
						"unavailable",
						"The browser could not send the compiler request",
					),
				);
			}
		});
		this.#checkCurrent(id);
		const bytes =
			JSON.stringify(output.result).length * 2 +
			(output.result.modes.full.wire.length + output.result.modes.generic.wire.length) *
				8 +
			4096;
		if (bytes <= EXPLORER_LIMITS.cacheBytes) {
			while (
				this.#cache.size >= EXPLORER_LIMITS.cacheEntries ||
				this.#cacheBytes + bytes > EXPLORER_LIMITS.cacheBytes
			) {
				const oldest = this.#cache.keys().next().value!;
				this.#cacheBytes -= this.#cache.get(oldest)!.bytes;
				this.#cache.delete(oldest);
			}
			this.#cache.set(key, { result: output.result, bytes });
			this.#cacheBytes += bytes;
		}
		return output;
	}

	#checkCurrent(id: number): void {
		if (id !== this.#serial)
			throw new ExplorerClientError("cancelled", "Compilation cancelled");
	}

	#ensureWorker(): Promise<void> {
		if (this.#ready !== undefined) return this.#ready;
		this.#onState("loading");
		const worker = new Worker(this.#data.workerUrl, {
			type: "module",
			name: "Maligator compiler",
		});
		this.#worker = worker;
		this.#ready = new Promise<void>((resolve, reject) => {
			this.#rejectReady = reject;
			this.#loadTimer = setTimeout(
				() =>
					this.#terminate(
						new ExplorerClientError(
							"timeout",
							"Compiler download or initialization timed out; retry when your connection is ready",
						),
					),
				EXPLORER_LIMITS.loadMs,
			);
			worker.onerror = () => {
				if (this.#worker === worker)
					this.#terminate(
						new ExplorerClientError(
							"unavailable",
							"The compiler worker failed to load or run; reload and retry",
						),
					);
			};
			worker.onmessageerror = () => {
				if (this.#worker === worker)
					this.#terminate(
						new ExplorerClientError(
							"unavailable",
							"The browser could not receive the compiler response",
						),
					);
			};
			worker.onmessage = (event: MessageEvent<ExplorerWorkerResponse>) => {
				if (this.#worker !== worker) return;
				const message = event.data;
				if (message.type === "fatal") {
					this.#terminate(new ExplorerClientError("unavailable", message.message));
				} else if (message.identity !== this.#data.identity) {
					this.#terminate(
						new ExplorerClientError(
							"unavailable",
							"Compiler version mismatch; reload the page",
						),
					);
				} else if (message.type === "ready") {
					clearTimeout(this.#loadTimer);
					this.#rejectReady = undefined;
					this.#module = message.module;
					resolve();
				} else if (this.#pending?.id === message.id) {
					const pending = this.#pending;
					this.#pending = undefined;
					clearTimeout(pending.timer);
					if (message.response.ok) {
						pending.resolve({
							result: message.response.result,
							cached: false,
							milliseconds: message.milliseconds,
							memoryBytes: message.memoryBytes,
						});
					} else {
						pending.reject(
							new ExplorerClientError(
								message.response.category,
								message.response.message,
							),
						);
					}
					if (message.memoryBytes >= EXPLORER_LIMITS.recycleBytes) this.#terminate();
					else
						this.#idleTimer = setTimeout(() => this.#terminate(), EXPLORER_LIMITS.idleMs);
				}
			};
		});
		const ready = this.#ready;
		try {
			worker.postMessage({
				type: "init",
				identity: this.#data.identity,
				wasmUrl: this.#data.wasmUrl,
				module: this.#module,
			} satisfies ExplorerWorkerRequest);
		} catch {
			this.#terminate(
				new ExplorerClientError(
					"unavailable",
					"The browser could not initialize the compiler worker",
				),
			);
		}
		return ready;
	}

	#terminate(
		error = new ExplorerClientError("cancelled", "Compiler worker released"),
	): void {
		clearTimeout(this.#idleTimer);
		clearTimeout(this.#loadTimer);
		this.#worker?.terminate();
		this.#worker = undefined;
		this.#ready = undefined;
		this.#rejectReady?.(error);
		this.#rejectReady = undefined;
		if (this.#pending !== undefined) {
			clearTimeout(this.#pending.timer);
			this.#pending.reject(error);
			this.#pending = undefined;
		}
	}
}
