import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const inputs = ["café", "Ångström", "résumé", "naive"];
	const peers = ["CAFE", "angstrom", "resume", "zebra"];
	const expectedNormalized = ["café", "Ångström", "résumé", "naive"];
	const expectedOrder = [0, -1, 0, 1];
	const operations = 350 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const inputIndex = round & 3;
		const normalized = inputs[inputIndex].normalize("NFC");
		const other = peers[(round + (round & 1)) & 3];
		const compared = normalized.localeCompare(other, "en", { sensitivity: "base" });
		const order = compared < 0 ? -1 : compared > 0 ? 1 : 0;
		if (
			normalized !== expectedNormalized[inputIndex] ||
			!Number.isFinite(compared) ||
			order !== expectedOrder[inputIndex]
		)
			throw new Error("normalization or collation mismatch");
		checksum += (order + 2) * (17 + inputIndex) + normalized.length;
		for (let index = 0; index < normalized.length; index++)
			checksum += normalized.charCodeAt(index) * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-normalize-collation", run);
