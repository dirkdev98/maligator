import { runRuntimeGapCase } from "../case-runner.mjs";

// Each escaped keeper makes the intermediate lexical owner observable.
function make(seed) {
	let value = seed;
	const retained1 = seed + 1;
	return {
		keep: () => retained1,
		next: function layer1() {
			const retained2 = seed + 2;
			return {
				keep: () => retained2,
				next: function layer2() {
					const retained3 = seed + 3;
					return {
						keep: () => retained3,
						next: function layer3() {
							const retained4 = seed + 4;
							return {
								keep: () => retained4,
								next: function layer4() {
									const retained5 = seed + 5;
									return {
										keep: () => retained5,
										next: function layer5() {
											const retained6 = seed + 6;
											return {
												keep: () => retained6,
												next: function layer6() {
													const retained7 = seed + 7;
													return {
														keep: () => retained7,
														next: function layer7() {
															const retainedLeaf = seed + 8;
															return {
																keep: () => retainedLeaf,
																read: function read(delta) {
																	let sum = 0;
																	for (let step = 0; step < 16; step++) {
																		value = (value + delta + step) & 255;
																		sum += value;
																	}
																	return sum;
																},
															};
														},
													};
												},
											};
										},
									};
								},
							};
						},
					};
				},
			};
		},
	};
}

function run(scale) {
	const retained = [];
	const readers = [];
	const seed = Number(process.argv[2] ?? "1") & 255;
	for (let index = 0; index < 2; index++) {
		let next = make(seed + index);
		for (let depth = 1; depth < 8; depth++) {
			retained.push(next);
			next = next.next();
		}
		retained.push(next);
		readers.push(next.read);
	}
	globalThis.retainedCaptureScopes = retained;
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const read = readers[index & 1];
		checksum = (checksum + read(index & 15)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("escaped-mutable-capture-depth-8", run);
