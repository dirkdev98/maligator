import { runRuntimeGapCase } from "../case-runner.mjs";

const nodes = [];
for (let index = 0; index < 128; index++) {
	const first = { value: index };
	const second = { value: index + 1 };
	nodes.push(
		index % 3 === 0
			? { kind: index, first, last: second }
			: index % 3 === 1
				? { kind: "pair", enabled: 0, left: first, right: second }
				: { kind: "value", enabled: {}, value: first, label: second },
	);
}

function select(node) {
	const kind = node.kind;
	if (typeof kind === "string") {
		const enabled = node.enabled;
		if (!enabled) {
			const left = node.left;
			const right = node.right;
			return left.value + right.value;
		}
		const value = node.value;
		const label = node.label;
		return value.value + label.value;
	}
	const first = node.first;
	const last = node.last;
	return first.value + last.value;
}

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + select(nodes[index & 127])) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("tagged-record-typeof-truthiness", run);
