import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function candidateRankingReplay(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 100 * scale; round++) {
		const candidates = Array.from({ length: 4_096 }, (_, index) => ({
			id: index,
			benefit: (index * 4_099 + round) & 65_535,
			cost: (index * 17 + round) & 1_023,
		}));
		candidates.sort(
			(left, right) =>
				right.benefit - right.cost - (left.benefit - left.cost) || left.id - right.id,
		);
		const selected = candidates.filter(
			(candidate) => candidate.benefit > candidate.cost * 8,
		);
		checksum = (checksum + selected.length + selected[0].id) % MODULUS;
		operations += candidates.length * 2;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("candidate-ranking", candidateRankingReplay);
