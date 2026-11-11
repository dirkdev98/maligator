import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const pattern = new RegExp("(?<tag>ab)\\k<tag>", "gu");
	const repeated = "abab".repeat(100);
	const rounds = 4000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		pattern.lastIndex = (i % 80) * 4;
		const match = pattern.exec(repeated);
		checksum += match
			? match[0].length +
				match.index +
				(match.groups ? match.groups.tag.length : match[1].length)
			: 1;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("regexp-owned-repeat", run);
