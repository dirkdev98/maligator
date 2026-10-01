import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const symbols = [Symbol("first"), Symbol("second")];
	const operations = 700 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const symbol = symbols[round & 1];
		const record = { value: round, [symbol]: round + 3 };
		Object.defineProperty(record, "hidden", { value: round + 5, enumerable: false });
		const names = Object.getOwnPropertyNames(record);
		const keys = Object.getOwnPropertySymbols(record);
		const visible = Object.prototype.propertyIsEnumerable.call(record, symbol);
		const hidden = Object.prototype.propertyIsEnumerable.call(record, "hidden");
		const receiver =
			round % 3 === 0 ? record : round % 3 === 1 ? [round] : new Uint8Array(2);
		const tag = Object.prototype.toString.call(receiver);
		if (keys.length !== 1 || keys[0] !== symbol || !visible || hidden)
			throw new Error("own keys failed");
		for (let index = 0; index < names.length; index++)
			checksum += record[names[index]] + names[index].length;
		for (let index = 0; index < tag.length; index++) checksum += tag.charCodeAt(index);
		checksum += record[keys[0]];
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-object-symbols-and-tags", run);
