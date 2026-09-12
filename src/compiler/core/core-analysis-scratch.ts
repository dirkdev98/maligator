export interface CoreNumericScratchLease<ArrayType extends Int32Array | Uint8Array> {
	readonly values: ArrayType;
	release(): void;
}

export interface CoreAnalysisScratchStatistics {
	readonly retainedBytes: number;
	readonly int32Buffers: number;
	readonly uint8Buffers: number;
}

const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERS_PER_KIND = 3;

export class CoreAnalysisScratchPool {
	readonly #maxRetainedBytes: number;
	readonly #int32: Array<Int32Array> = [];
	readonly #uint8: Array<Uint8Array> = [];
	#retainedBytes = 0;

	constructor(maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES) {
		if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) {
			throw new Error("Core analysis scratch limit must be a non-negative integer");
		}
		this.#maxRetainedBytes = maxRetainedBytes;
	}

	leaseInt32(length: number): CoreNumericScratchLease<Int32Array> {
		return this.#lease(this.#int32, length, Int32Array);
	}

	leaseUint8(length: number): CoreNumericScratchLease<Uint8Array> {
		return this.#lease(this.#uint8, length, Uint8Array);
	}

	statistics(): CoreAnalysisScratchStatistics {
		return Object.freeze({
			retainedBytes: this.#retainedBytes,
			int32Buffers: this.#int32.length,
			uint8Buffers: this.#uint8.length,
		});
	}

	#lease<ArrayType extends Int32Array | Uint8Array>(
		available: Array<ArrayType>,
		length: number,
		construct: new (length: number) => ArrayType,
	): CoreNumericScratchLease<ArrayType> {
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new Error("Core analysis scratch length must be a non-negative integer");
		}
		let selected = -1;
		for (let index = 0; index < available.length; index++) {
			if (available[index]!.length < length) continue;
			if (selected < 0 || available[index]!.length < available[selected]!.length) {
				selected = index;
			}
		}
		const values =
			selected < 0 ? new construct(length) : available.splice(selected, 1)[0]!;
		if (selected >= 0) this.#retainedBytes -= values.byteLength;
		let active = true;
		return Object.freeze({
			values,
			release: () => {
				if (!active) throw new Error("Core analysis scratch lease already released");
				active = false;
				if (available.length >= MAX_BUFFERS_PER_KIND) {
					let smallest = 0;
					for (let index = 1; index < available.length; index++) {
						if (available[index]!.length < available[smallest]!.length) smallest = index;
					}
					const replaced = available[smallest]!;
					const retainedBytes =
						this.#retainedBytes - replaced.byteLength + values.byteLength;
					// Small early functions must not pin every slot against later, larger analyses.
					if (values.length <= replaced.length || retainedBytes > this.#maxRetainedBytes)
						return;
					available[smallest] = values;
					this.#retainedBytes = retainedBytes;
					return;
				}
				if (this.#retainedBytes + values.byteLength > this.#maxRetainedBytes) return;
				available.push(values);
				this.#retainedBytes += values.byteLength;
			},
		});
	}
}
