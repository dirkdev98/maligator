import { runRuntimeGapCase } from "../case-runner.mjs";
const nodes = [];
for (let index = 0; index < 128; index++) {
	const left = { value: index };
	const right = index & 1 ? left : { value: index + 1 };
	nodes.push(
		index % 4
			? { kind: "Binary", left, right }
			: { kind: "Literal", value: left, fallback: right },
	);
}
function select(node) {
	if (node.kind === "Binary") {
		const left = node.left,
			right = node.right;
		return left === right ? left : right;
	}
	const value = node.value,
		fallback = node.fallback;
	return value === fallback ? value : fallback;
}
function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++)
		checksum = (checksum + select(nodes[index & 127]).value) | 0;
	return { checksum: checksum >>> 0, operations };
}
runRuntimeGapCase("tagged-record-wide-distinct", run);
