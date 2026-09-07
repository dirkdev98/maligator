/// <reference lib="webworker" />
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
import type { ExplorerResponse } from "../src/explorer/api.ts";
import {
	EXPLORER_LIMITS,
	EXPLORER_SCHEMA,
	utf8ByteLength,
} from "../src/explorer/config.ts";
import type {
	ExplorerWorkerRequest,
	ExplorerWorkerResponse,
} from "../src/explorer/protocol.ts";
import { WasmEngine } from "../src/wasm-embedding.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let engine: WasmEngine | undefined;
let identity: string | undefined;
let initializing = false;

function send(message: ExplorerWorkerResponse): void {
	scope.postMessage(message);
}

scope.onmessage = async (event: MessageEvent<ExplorerWorkerRequest>) => {
	try {
		const request = event.data;
		if (request.type === "init") {
			if (initializing || engine !== undefined)
				throw new Error("Compiler worker was already initialized");
			initializing = true;
			identity = request.identity;
			const started = performance.now();
			const wasi = new WASI(
				[],
				["TZ=UTC"],
				[
					new OpenFile(new File([])),
					ConsoleStdout.lineBuffered(() => {}),
					ConsoleStdout.lineBuffered(() => {}),
				],
			);
			let module = request.module;
			let instance: WebAssembly.Instance;
			if (module === undefined) {
				const response = await fetch(request.wasmUrl);
				if (!response.ok)
					throw new Error(
						`Compiler download failed (${response.status}); reload the page and retry`,
					);
				if (response.headers.get("Content-Type")?.split(";")[0] !== "application/wasm")
					throw new Error("The server returned an invalid compiler asset");
				const result = await WebAssembly.instantiateStreaming(response, {
					wasi_snapshot_preview1: wasi.wasiImport,
				});
				module = result.module;
				instance = result.instance;
			} else {
				instance = await WebAssembly.instantiate(module, {
					wasi_snapshot_preview1: wasi.wasiImport,
				});
			}
			if (!(instance.exports.memory instanceof WebAssembly.Memory))
				throw new Error("Missing compiler memory");
			wasi.initialize(
				instance as WebAssembly.Instance & {
					exports: { memory: WebAssembly.Memory };
				},
			);
			engine = new WasmEngine(instance);
			send({
				type: "ready",
				identity,
				module,
				milliseconds: performance.now() - started,
				memoryBytes: engine.memoryBytes,
			});
		} else {
			if (engine === undefined || request.identity !== identity)
				throw new Error("Compiler version mismatch; reload the page");
			if (utf8ByteLength(request.source) > EXPLORER_LIMITS.sourceBytes)
				throw new RangeError("Source exceeds the 64 KiB limit");
			const started = performance.now();
			const output = engine.call(
				"__compileExplorer",
				JSON.stringify({
					schema: EXPLORER_SCHEMA,
					source: request.source,
					config: request.config,
				}),
			);
			const response = JSON.parse(output) as ExplorerResponse;
			if (
				typeof response.ok !== "boolean" ||
				(response.ok && response.result.schema !== EXPLORER_SCHEMA)
			)
				throw new Error("Invalid compiler response version");
			send({
				type: "result",
				id: request.id,
				identity,
				response,
				milliseconds: performance.now() - started,
				memoryBytes: engine.memoryBytes,
			});
		}
	} catch (error) {
		send({
			type: "fatal",
			message: error instanceof Error ? error.message : String(error),
		});
	}
};
