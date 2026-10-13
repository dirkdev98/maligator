import { runRuntimeGapCase } from "../case-runner.mjs";

const nodes = [];
for (let index = 0; index < 128; index++) {
	const left = { value: index };
	const right = { value: index + 1 };
	nodes.push(
		index % 4
			? { kind: "Binary", left, right, operator: index & 1 ? "+" : "-" }
			: { kind: "Literal", value: left },
	);
}

function select(node) {
	if (node.kind === "Binary") return node.operator === "+" ? node.left : node.right;
	return node.value;
}

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + select(nodes[index & 127]).value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("tagged-record-branches", run);
