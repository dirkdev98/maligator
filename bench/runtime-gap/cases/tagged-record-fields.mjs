import { runRuntimeGapCase } from "../case-runner.mjs";
const nodes = [];
for (let i = 0; i < 128; i++)
	nodes.push(
		i % 4
			? { kind: "Binary", left: i, right: i + 1, operator: i & 7 }
			: { kind: "Literal", value: i },
	);
function visit(node) {
	switch (node.kind) {
		case "Binary":
			return node.left + node.right + node.operator;
		case "Literal":
			return node.value;
		default:
			return 0;
	}
}
function run(scale) {
	let checksum = 0;
	const rounds = 50000 * scale;
	for (let i = 0; i < rounds; i++) checksum = (checksum + visit(nodes[i & 127])) | 0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("tagged-record-fields", run);
