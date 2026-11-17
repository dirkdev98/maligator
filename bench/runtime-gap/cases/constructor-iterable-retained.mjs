import { runRuntimeGapCase } from "../case-runner.mjs";

function Packet(prefix, ...values) {
	this.prefix = prefix;
	this.values = values;
	this.target = new.target;
}

const target = Reflect.get({ target: Packet }, process.argv[4] ?? "target");
if (typeof target !== "function") throw new Error("unknown construction target");
const tails = [0, 4, 16, 64].map((length) => Array.from({ length }, (_, index) => index));

function run(scale) {
	const operations = 40_000 * scale;
	const retained = new Array(64);
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		const value = new target(index & 31, ...tails[index & 3]);
		retained[index & 63] = value;
		checksum = (checksum + value.prefix + value.values.length) | 0;
	}
	for (let index = 0; index < retained.length; index++) {
		const value = retained[index];
		if (
			Object.getPrototypeOf(value) !== Packet.prototype ||
			value.target !== target ||
			value.values.length !== tails[index & 3].length ||
			value.values.some((item, offset) => item !== offset)
		) {
			throw new Error("retained constructor state mismatch");
		}
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("constructor-iterable-retained", run, ({ checksum, operations }) => {
	if (checksum !== (operations * 36.5) >>> 0)
		throw new Error("construction checksum mismatch");
});
