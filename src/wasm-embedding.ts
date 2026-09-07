export interface WasmEngineExports extends WebAssembly.Exports {
	memory: WebAssembly.Memory;
	mal_wasm_abi_version: () => number;
	mal_wasm_init: () => number;
	mal_wasm_call: (
		name: number,
		nameLength: number,
		input: number,
		inputLength: number,
	) => number;
	mal_wasm_output_length: () => number;
	mal_wasm_status: () => number;
	mal_wasm_collection_count: () => bigint;
	mal_wasm_release: () => void;
	mal_wasm_dispose: () => void;
	malloc: (bytes: number) => number;
	free: (pointer: number) => void;
}

export class WasmEngine {
	readonly api: WasmEngineExports;
	readonly #encoder = new TextEncoder();
	readonly #decoder = new TextDecoder("utf-8", { fatal: true });
	#disposed = false;

	constructor(instance: WebAssembly.Instance) {
		const api = instance.exports;
		for (const name of [
			"mal_wasm_abi_version",
			"mal_wasm_init",
			"mal_wasm_call",
			"mal_wasm_output_length",
			"mal_wasm_status",
			"mal_wasm_collection_count",
			"mal_wasm_release",
			"mal_wasm_dispose",
			"malloc",
			"free",
		]) {
			if (typeof api[name] !== "function")
				throw new Error(`Missing Wasm embedding export: ${name}`);
		}
		if (!(api.memory instanceof WebAssembly.Memory))
			throw new Error("Missing Wasm memory");
		this.api = api as WasmEngineExports;
		if (this.api.mal_wasm_abi_version() !== 1)
			throw new Error("Incompatible Wasm embedding ABI");
		const status = this.api.mal_wasm_init();
		if (status !== 0) throw new Error(`Engine initialization failed (${status})`);
	}

	get memoryBytes(): number {
		return this.api.memory.buffer.byteLength;
	}
	get collections(): number {
		return Number(this.api.mal_wasm_collection_count());
	}

	call(name: string, input: string): string {
		if (this.#disposed) throw new Error("The Wasm engine has been disposed");
		const nameBytes = this.#encoder.encode(name);
		const inputBytes = this.#encoder.encode(input);
		if (
			nameBytes.length === 0 ||
			nameBytes.length > 256 ||
			inputBytes.length > 512 * 1024
		)
			throw new RangeError("Wasm call exceeds the embedding input limits");
		let namePointer = 0;
		let inputPointer = 0;
		try {
			namePointer = this.#allocate(nameBytes);
			inputPointer = this.#allocate(inputBytes);
			const output = this.api.mal_wasm_call(
				namePointer,
				nameBytes.length,
				inputPointer,
				inputBytes.length,
			);
			const length = this.api.mal_wasm_output_length();
			const status = this.api.mal_wasm_status();
			if (status === 3) throw new RangeError("Wasm allocation or output limit exceeded");
			if (
				length > 8 * 1024 * 1024 ||
				output < 0 ||
				length < 0 ||
				output + length > this.memoryBytes
			)
				throw new Error("Invalid Wasm output buffer");
			const text = this.#decoder.decode(
				new Uint8Array(this.api.memory.buffer, output, length),
			);
			if (status !== 0) throw new Error(text || `Wasm call failed (${status})`);
			return text;
		} finally {
			this.api.mal_wasm_release();
			if (inputPointer !== 0) this.api.free(inputPointer);
			if (namePointer !== 0) this.api.free(namePointer);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.api.mal_wasm_dispose();
		this.#disposed = true;
	}

	#allocate(bytes: Uint8Array): number {
		const pointer = this.api.malloc(Math.max(1, bytes.length));
		if (pointer === 0) throw new RangeError("Wasm input allocation failed");
		// malloc and compiler calls may grow memory and detach every previous view.
		new Uint8Array(this.api.memory.buffer, pointer, bytes.length).set(bytes);
		return pointer;
	}
}
