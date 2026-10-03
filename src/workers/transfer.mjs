const transferTag = Symbol("worker transfer result");

export function transfer(value, transferList) {
	if (!Array.isArray(transferList))
		throw new TypeError("transfer requires an array of transferables");
	return Object.freeze({ value, transferList, [transferTag]: true });
}

export function unwrapTransfer(value) {
	return value !== null && typeof value === "object" && value[transferTag] === true
		? { value: value.value, transfer: value.transferList }
		: { value, transfer: [] };
}
