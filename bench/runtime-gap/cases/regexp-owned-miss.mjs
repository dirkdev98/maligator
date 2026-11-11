import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const pattern = new RegExp("^(?<tag>[^:]+):\\k<tag>:(\\d+)$", "u");
	const subjects = Array.from({ length: 32 }, (_, i) => {
		const word = "a".repeat(300 + i);
		return word + ":" + word + ":bad";
	});
	const rounds = 4000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const match = pattern.exec(subjects[i & 31]);
		checksum += match
			? match[0].length +
				match.index +
				(match.groups ? match.groups.tag.length : match[1].length)
			: 1;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("regexp-owned-miss", run);
