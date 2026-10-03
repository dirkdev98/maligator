import type { Transferable, TransferResult } from "maligator:workers";

const transferTag = Symbol("worker transfer result");

interface TransferEnvelope {
	readonly value: unknown;
	readonly transferList: ReadonlyArray<Transferable>;
	readonly [transferTag]: true;
}

export function transfer<Value>(
	value: Value,
	transferList: ReadonlyArray<Transferable>,
): TransferResult<Value> {
	if (!Array.isArray(transferList))
		throw new TypeError("transfer requires an array of transferables");
	// The public brand is erased; runtime recognition uses this module's private symbol.
	return Object.freeze({
		value,
		transferList,
		[transferTag]: true,
	}) as unknown as TransferResult<Value>;
}

export function unwrapTransfer(value: unknown): {
	value: unknown;
	transfer: ReadonlyArray<Transferable>;
} {
	return value !== null &&
		typeof value === "object" &&
		(value as TransferEnvelope)[transferTag] === true
		? {
				value: (value as TransferEnvelope).value,
				transfer: (value as TransferEnvelope).transferList,
			}
		: { value, transfer: [] };
}
