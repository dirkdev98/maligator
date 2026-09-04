const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function kernel(id, group, owner, category, sourceSeam, run) {
	return { id, group, owner, category, sourceSeam, run };
}

function numericScalarLoops(scale) {
	const iterations = 500_000 * scale;
	let checksum = 17;
	for (let index = 0; index < iterations; index++) {
		checksum = (checksum + ((index * 31) ^ (checksum >>> 3))) % MODULUS;
	}
	return result(checksum, iterations);
}

function typedArrayOperations(scale) {
	const values = new Uint32Array(4_096);
	let checksum = 0;
	for (let round = 0; round < 80 * scale; round++) {
		for (let index = 0; index < values.length; index++) {
			values[index] = (index * 31 + round * 17) >>> 0;
		}
		for (let index = 0; index < values.length; index++) {
			values[index] = (values[index] + values[(index + 1) & 4_095]) >>> 0;
			checksum = (checksum + values[index]) % MODULUS;
		}
	}
	return result(checksum, values.length * 160 * scale);
}

function dynamicArrayOperations(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 250 * scale; round++) {
		const values = [];
		for (let index = 0; index < 1_024; index++) {
			values.push(index ^ round);
			operations++;
		}
		for (let index = 0; index < values.length; index++) {
			checksum = (checksum + values[index]) % MODULUS;
			operations++;
		}
		while (values.length > 512) {
			checksum ^= values.pop();
			operations++;
		}
	}
	return result(checksum, operations);
}

function mapOperations(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 80 * scale; round++) {
		const values = new Map();
		for (let index = 0; index < 2_048; index++) {
			values.set(index, index ^ round);
			operations++;
		}
		for (let index = 0; index < 2_048; index++) {
			checksum += values.has(index) ? values.get(index) : 0;
			operations += 2;
		}
		for (const [key, value] of values) {
			checksum = (checksum + key + value) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

function setOperations(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 100 * scale; round++) {
		const values = new Set();
		for (let index = 0; index < 2_048; index++) {
			values.add((index * 17 + round) & 4_095);
			operations++;
		}
		for (let index = 0; index < 2_048; index++) {
			checksum += values.has(index) ? index : 0;
			operations++;
		}
		for (const value of values) {
			checksum = (checksum + value) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

function stableShapeProperties(scale) {
	const values = Array.from({ length: 2_048 }, (_, index) => ({
		id: index,
		kind: index & 15,
		generation: index & 255,
		flags: 0,
	}));
	let checksum = 0;
	const operations = values.length * 120 * scale * 4;
	for (let round = 0; round < 120 * scale; round++) {
		for (const value of values) {
			value.flags = value.kind ^ round;
			checksum = (checksum + value.id + value.generation + value.flags) % MODULUS;
		}
	}
	return result(checksum, operations);
}

function shortLivedRecords(scale) {
	let checksum = 0;
	const operations = 350_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = {
			id: index,
			left: index & 1_023,
			right: (index * 17) & 1_023,
			kind: index & 31,
		};
		checksum =
			(checksum + record.id + record.left - record.right + record.kind) % MODULUS;
	}
	return result(checksum, operations);
}

function spreadCopies(scale) {
	const template = { kind: 7, flags: 3, generation: 11, block: 13, value: 17 };
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const copy = { ...template, value: index, next: index + 1 };
		checksum = (checksum + copy.kind + copy.flags + copy.value + copy.next) % MODULUS;
	}
	return result(checksum, operations);
}

function frozenRecords(scale) {
	let checksum = 0;
	const operations = 90_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = Object.freeze({ id: index, kind: index & 31, value: index * 3 });
		checksum = (checksum + record.id + record.kind + record.value) % MODULUS;
	}
	return result(checksum, operations);
}

function* numberSequence(seed) {
	for (let index = 0; index < 8; index++) yield seed + index * 3;
}

function iteratorGeneratorTraversal(scale) {
	let checksum = 0;
	const operations = 120_000 * scale * 8;
	for (let round = 0; round < 120_000 * scale; round++) {
		for (const value of numberSequence(round)) checksum = (checksum + value) % MODULUS;
	}
	return result(checksum, operations);
}

function forOfCollections(scale) {
	const array = Array.from({ length: 512 }, (_, index) => index * 3);
	const map = new Map(array.map((value, index) => [index, value]));
	const set = new Set(array);
	let checksum = 0;
	for (let round = 0; round < 300 * scale; round++) {
		for (const value of array) checksum = (checksum + value) % MODULUS;
		for (const [key, value] of map) checksum = (checksum + key + value) % MODULUS;
		for (const value of set) checksum = (checksum + value) % MODULUS;
	}
	return result(checksum, array.length * 3 * 300 * scale);
}

function arrayCallbacks(scale) {
	const values = Array.from({ length: 1_024 }, (_, index) => index);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 160 * scale; round++) {
		const mapped = values.map((value) => value + round);
		const filtered = mapped.filter((value) => (value & 3) === 0);
		checksum += filtered.find((value) => value > 700) ?? 0;
		checksum += filtered.some((value) => value === round + 512) ? 1 : 0;
		checksum += filtered.includes(round + 768) ? 1 : 0;
		operations += values.length * 2 + filtered.length * 3;
	}
	return result(checksum, operations);
}

function addThree(left, middle, right) {
	return left + middle + right;
}

function directCalls(scale) {
	let checksum = 0;
	const operations = 1_200_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + addThree(index & 255, index & 127, index & 63)) % MODULUS;
	}
	return result(checksum, operations);
}

function indirectCalls(scale) {
	const functions = [
		(value) => value + 1,
		(value) => value * 3,
		(value) => value ^ 0x55,
		(value) => value - 7,
	];
	let checksum = 0;
	const operations = 900_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + functions[index & 3](index & 1_023)) % MODULUS;
	}
	return result(checksum, operations);
}

function closureCalls(scale) {
	const functions = Array.from(
		{ length: 64 },
		(_, offset) => (value) => value + offset * 7,
	);
	let checksum = 0;
	const operations = 900_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + functions[index & 63](index & 1_023)) % MODULUS;
	}
	return result(checksum, operations);
}

function stringKeys(scale) {
	let checksum = 0;
	const values = new Map();
	const operations = 180_000 * scale;
	for (let index = 0; index < operations; index++) {
		const key = `function:${index & 1_023}:block:${(index * 17) & 255}`;
		values.set(key, (values.get(key) ?? 0) + 1);
		checksum = (checksum + key.length + values.get(key)) % MODULUS;
	}
	return result(checksum, operations * 3);
}

function sorting(scale) {
	const seed = Array.from({ length: 1_024 }, (_, index) => (index * 4_099) & 65_535);
	let checksum = 0;
	for (let round = 0; round < 120 * scale; round++) {
		const numeric = seed.slice().sort((left, right) => left - right);
		const keys = seed.map((value, index) => ({
			functionId: value & 255,
			score: value,
			index,
		}));
		keys.sort(
			(left, right) => right.score - left.score || left.functionId - right.functionId,
		);
		checksum = (checksum + numeric[round & 1_023] + keys[round & 1_023].index) % MODULUS;
	}
	return result(checksum, seed.length * 2 * 120 * scale);
}

function lowRetentionChurn(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		const row = [index, index + 1, index + 2, index + 3];
		checksum = (checksum + row[0] + row[3]) % MODULUS;
	}
	return result(checksum, operations);
}

function moderateRetentionChurn(scale) {
	let checksum = 0;
	const retained = [];
	const operations = 400_000 * scale;
	for (let index = 0; index < operations; index++) {
		const row = {
			id: index,
			operands: [index & 255, (index + 1) & 255],
			flags: index & 31,
		};
		if ((index & 31) === 0) retained.push(row);
		checksum = (checksum + row.id + row.operands[1] + row.flags) % MODULUS;
	}
	for (const row of retained) checksum = (checksum + row.id) % MODULUS;
	return result(checksum, operations + retained.length);
}

function prunedSsaReplay(scale) {
	const definitions = new Int32Array(4_096);
	definitions.fill(-1);
	const incomplete = new Map();
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 160 * scale; round++) {
		for (let index = 0; index < definitions.length; index += 3) {
			definitions[index] = round + index;
			operations++;
		}
		for (let index = 0; index < definitions.length; index++) {
			const value = definitions[index];
			if (value === -1) incomplete.set(index, round);
			else checksum = (checksum + value) % MODULUS;
			operations++;
		}
		incomplete.clear();
	}
	return result(checksum, operations);
}

function denseRelocationReplay(scale) {
	const relocation = new Uint32Array(32_768);
	const operands = new Uint32Array(131_072);
	let checksum = 0;
	for (let round = 0; round < 30 * scale; round++) {
		for (let index = 0; index < relocation.length; index++)
			relocation[index] = index ^ round;
		for (let index = 0; index < operands.length; index++) {
			operands[index] = relocation[(index * 17) & 32_767];
			checksum = (checksum + operands[index]) % MODULUS;
		}
	}
	return result(checksum, (relocation.length + operands.length) * 30 * scale);
}

function optimizerQueueReplay(scale) {
	const pending = new Uint8Array(16_384);
	const queue = new Uint32Array(16_384);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 120 * scale; round++) {
		let length = 0;
		for (let index = 0; index < pending.length; index += 3) {
			if (pending[index] !== 0) continue;
			pending[index] = 1;
			queue[length++] = index;
			operations++;
		}
		for (let cursor = 0; cursor < length; cursor++) {
			const value = queue[cursor];
			pending[value] = 0;
			checksum = (checksum + value) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

function blockParameterReplay(scale) {
	const blocks = Array.from({ length: 1_024 }, (_, block) => ({
		parameters: Array.from({ length: 12 }, (_, index) => block * 16 + index),
		incoming: Array.from({ length: 3 }, (_, edge) =>
			Array.from({ length: 12 }, (_, index) => block * 48 + edge * 12 + index),
		),
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 50 * scale; round++) {
		for (const block of blocks) {
			const parameter = block.parameters[(round + block.parameters.length) % 12];
			for (const incoming of block.incoming)
				checksum = (checksum + incoming[round % 12]) % MODULUS;
			checksum = (checksum + parameter) % MODULUS;
			operations += 4;
		}
	}
	return result(checksum, operations);
}

function cfgEdgesReplay(scale) {
	const terminators = Array.from({ length: 8_192 }, (_, block) => ({
		block,
		targets: block + 2 < 8_192 ? [block + 1, block + 2] : [],
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 35 * scale; round++) {
		const predecessors = Array.from({ length: terminators.length }, () => []);
		for (const terminator of terminators) {
			for (const target of terminator.targets) {
				predecessors[target].push(terminator.block);
				checksum = (checksum + target + terminator.block) % MODULUS;
				operations++;
			}
		}
	}
	return result(checksum, operations);
}

function immediateDominatorsReplay(scale) {
	const blocks = 16_384;
	const dominators = new Int32Array(blocks);
	let checksum = 0;
	const operations = blocks * 50 * scale;
	for (let round = 0; round < 50 * scale; round++) {
		dominators[0] = 0;
		for (let block = 1; block < blocks; block++) {
			const first = block - 1;
			const second = block > 2 && (block & 3) === 0 ? block - 3 : first;
			let finger = first;
			while (finger > second) finger = dominators[finger];
			dominators[block] = finger;
			checksum = (checksum + finger + block) % MODULUS;
		}
	}
	return result(checksum, operations);
}

function valueKindReplay(scale) {
	const kinds = new Uint16Array(65_536);
	const operands = Uint32Array.from(kinds, (_, index) => (index * 17) & 65_535);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 30 * scale; round++) {
		let changed = true;
		for (let pass = 0; pass < 4 && changed; pass++) {
			changed = false;
			for (let index = 1; index < kinds.length; index++) {
				const kind = kinds[operands[index]] | (1 << ((index + round) & 7));
				if (kind !== kinds[index]) {
					kinds[index] = kind;
					changed = true;
				}
				checksum = (checksum + kind) % MODULUS;
				operations++;
			}
		}
	}
	return result(checksum, operations);
}

function canonicalRootsReplay(scale) {
	const parents = Uint32Array.from({ length: 131_072 }, (_, index) =>
		index === 0 || (index & 7) === 0 ? index : index - 1,
	);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 45 * scale; round++) {
		for (let value = 0; value < parents.length; value++) {
			let root = value;
			while (parents[root] !== root) {
				root = parents[root];
				operations++;
			}
			parents[value] = root;
			checksum = (checksum + root) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

function provenanceReplay(scale) {
	const facts = new Map();
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 45 * scale; round++) {
		facts.clear();
		for (let value = 0; value < 24_000; value++) {
			const source = value === 0 ? 0 : (value * 17) % value;
			const fact = (facts.get(source) ?? source & 31) | (1 << (value & 7));
			facts.set(value, fact);
			checksum = (checksum + fact) % MODULUS;
			operations += 2;
		}
	}
	return result(checksum, operations);
}

function memoryEventReplay(scale) {
	const instructions = Array.from({ length: 40_000 }, (_, index) => ({
		id: index,
		operation: index % 7 === 0 ? "store" : index % 5 === 0 ? "load" : "pure",
		location: index & 511,
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 35 * scale; round++) {
		const events = [];
		for (const instruction of instructions) {
			if (instruction.operation !== "pure")
				events.push(instruction.id, instruction.location);
			operations++;
		}
		for (const event of events) checksum = (checksum + event) % MODULUS;
	}
	return result(checksum, operations);
}

function memoryVersionsReplay(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 30 * scale; round++) {
		const versions = new Map();
		for (let event = 0; event < 45_000; event++) {
			const block = event & 1_023;
			let state = versions.get(block);
			if (state === undefined) {
				state = new Map();
				versions.set(block, state);
			}
			const location = (event * 17) & 511;
			const version = (state.get(location) ?? 0) + 1;
			state.set(location, version);
			checksum = (checksum + version + location) % MODULUS;
			operations += 3;
		}
	}
	return result(checksum, operations);
}

function programFlowExtractionReplay(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 45 * scale; round++) {
		const rows = new Map();
		for (let caller = 0; caller < 12_000; caller++) {
			const targets = [];
			for (let edge = 0; edge < 4; edge++)
				targets.push((caller * 17 + edge * 31) % 12_000);
			rows.set(caller, targets);
			checksum = (checksum + targets[round & 3]) % MODULUS;
			operations += 5;
		}
	}
	return result(checksum, operations);
}

function programFlowConvergenceReplay(scale) {
	const count = 16_384;
	const state = new Uint16Array(count);
	const queue = new Uint32Array(count * 4);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 60 * scale; round++) {
		let length = count;
		for (let index = 0; index < count; index++) queue[index] = index;
		for (let cursor = 0; cursor < length; cursor++) {
			const node = queue[cursor];
			const next = (node + 1) & (count - 1);
			const merged = state[next] | state[node] | (1 << ((node + round) & 15));
			if (merged !== state[next] && length < queue.length) {
				state[next] = merged;
				queue[length++] = next;
			}
			checksum = (checksum + merged) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
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

function loweringReplay(scale) {
	const instructions = Array.from({ length: 60_000 }, (_, index) => ({
		id: index,
		kind: index & 31,
		operands: [index === 0 ? 0 : index - 1, (index * 17) % (index + 1)],
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 25 * scale; round++) {
		const operationsImage = new Uint16Array(instructions.length);
		const operandsImage = new Uint32Array(instructions.length * 2);
		for (const instruction of instructions) {
			operationsImage[instruction.id] = instruction.kind;
			operandsImage[instruction.id * 2] = instruction.operands[0];
			operandsImage[instruction.id * 2 + 1] = instruction.operands[1];
			checksum = (checksum + instruction.kind + instruction.operands[1]) % MODULUS;
			operations += 3;
		}
	}
	return result(checksum, operations);
}

const kernels = [
	kernel(
		"numeric-scalar-loops",
		"primitive",
		"numeric scalar loops",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-local-optimizer.ts",
		numericScalarLoops,
	),
	kernel(
		"typed-array-operations",
		"primitive",
		"typed-array fill, scan and indexed update",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-ir.ts",
		typedArrayOperations,
	),
	kernel(
		"dynamic-array-operations",
		"primitive",
		"dynamic Array push, pop and indexed traversal",
		"runtime-collections-properties",
		"runtime/src/builtin_array.c",
		dynamicArrayOperations,
	),
	kernel(
		"map-operations",
		"primitive",
		"Map get, set, has and iteration",
		"runtime-collections-properties",
		"src/compiler/core/core-ir-memory.ts",
		mapOperations,
	),
	kernel(
		"set-operations",
		"primitive",
		"Set add, has and iteration",
		"runtime-collections-properties",
		"src/compiler/core/core-ir-verifier.ts",
		setOperations,
	),
	kernel(
		"stable-shape-properties",
		"primitive",
		"stable-shape object reads and writes",
		"runtime-collections-properties",
		"src/compiler/core/core-ir.ts",
		stableShapeProperties,
	),
	kernel(
		"short-lived-records",
		"primitive",
		"object allocation and short-lived records",
		"allocation-gc",
		"src/compiler/core/core-store.ts",
		shortLivedRecords,
	),
	kernel(
		"spread-copies",
		"primitive",
		"spread and shallow object copies",
		"allocation-gc",
		"src/compiler/core/core-ir-shape-provenance.ts",
		spreadCopies,
	),
	kernel(
		"frozen-records",
		"primitive",
		"Object.freeze on compiler-shaped records",
		"allocation-gc",
		"src/compiler/core/core-ir.ts",
		frozenRecords,
	),
	kernel(
		"iterator-generator-traversal",
		"primitive",
		"iterator and generator traversal",
		"iterators-callbacks",
		"src/compiler/core/core-local-optimizer.ts",
		iteratorGeneratorTraversal,
	),
	kernel(
		"for-of-collections",
		"primitive",
		"for-of over arrays, maps and sets",
		"iterators-callbacks",
		"src/compiler/core/core-local-optimizer.ts",
		forOfCollections,
	),
	kernel(
		"array-callbacks",
		"primitive",
		"Array map, filter, find, some and includes",
		"iterators-callbacks",
		"src/compiler/core/core-local-optimizer.ts",
		arrayCallbacks,
	),
	kernel(
		"direct-calls",
		"primitive",
		"direct function calls",
		"function-closure-dispatch",
		"src/compiler/core/core-local-optimizer.ts",
		directCalls,
	),
	kernel(
		"indirect-calls",
		"primitive",
		"indirect function calls",
		"function-closure-dispatch",
		"src/compiler/core/core-program-flow.ts",
		indirectCalls,
	),
	kernel(
		"closure-calls",
		"primitive",
		"closure calls and captured state",
		"function-closure-dispatch",
		"src/compiler/core/core-local-optimizer.ts",
		closureCalls,
	),
	kernel(
		"string-keys",
		"primitive",
		"string key construction and hashing",
		"runtime-collections-properties",
		"src/compiler/core/core-ir-shape-provenance.ts",
		stringKeys,
	),
	kernel(
		"sorting",
		"primitive",
		"sorting numeric and compiler-key arrays",
		"iterators-callbacks",
		"src/compiler/core/core-transform-candidates.ts",
		sorting,
	),
	kernel(
		"low-retention-churn",
		"primitive",
		"allocation churn with low retention",
		"allocation-gc",
		"src/compiler/core/core-store.ts",
		lowRetentionChurn,
	),
	kernel(
		"moderate-retention-churn",
		"primitive",
		"allocation churn with moderate retention",
		"allocation-gc",
		"src/compiler/core/core-ir.ts",
		moderateRetentionChurn,
	),
	kernel(
		"pruned-ssa",
		"algorithm",
		"pruned SSA definition lookup and virtual phi resolution",
		"compiler-algorithms",
		"src/compiler/core/core-frontend-construction.ts",
		prunedSsaReplay,
	),
	kernel(
		"dense-relocation",
		"algorithm",
		"dense generation relocation",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-store.ts",
		denseRelocationReplay,
	),
	kernel(
		"optimizer-queue",
		"algorithm",
		"fused local optimizer queue",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-function-optimization-session.ts",
		optimizerQueueReplay,
	),
	kernel(
		"block-parameters",
		"algorithm",
		"block-parameter simplification",
		"runtime-collections-properties",
		"src/compiler/core/core-control-flow-passes.ts",
		blockParameterReplay,
	),
	kernel(
		"cfg-edges",
		"algorithm",
		"CFG edge construction",
		"allocation-gc",
		"src/compiler/core/core-ir-control-flow.ts",
		cfgEdgesReplay,
	),
	kernel(
		"immediate-dominators",
		"algorithm",
		"immediate dominators",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-ir-control-flow.ts",
		immediateDominatorsReplay,
	),
	kernel(
		"value-kinds",
		"algorithm",
		"local value-kind propagation",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-ir-value-kinds.ts",
		valueKindReplay,
	),
	kernel(
		"canonical-roots",
		"algorithm",
		"canonical root calculation",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-ir-value-classes.ts",
		canonicalRootsReplay,
	),
	kernel(
		"fact-provenance",
		"algorithm",
		"local fact/provenance analysis",
		"runtime-collections-properties",
		"src/compiler/core/core-ir-shape-provenance.ts",
		provenanceReplay,
	),
	kernel(
		"memory-events",
		"algorithm",
		"memory event extraction",
		"allocation-gc",
		"src/compiler/core/core-ir-memory.ts",
		memoryEventReplay,
	),
	kernel(
		"memory-versions",
		"algorithm",
		"memoryVersions",
		"runtime-collections-properties",
		"src/compiler/core/core-ir-memory.ts",
		memoryVersionsReplay,
	),
	kernel(
		"program-flow-extraction",
		"algorithm",
		"program-flow transfer extraction",
		"allocation-gc",
		"src/compiler/core/core-program-flow.ts",
		programFlowExtractionReplay,
	),
	kernel(
		"program-flow-convergence",
		"algorithm",
		"program-flow SCC/worklist convergence",
		"typed-arrays-numeric-loops",
		"src/compiler/core/core-program-flow.ts",
		programFlowConvergenceReplay,
	),
	kernel(
		"candidate-ranking",
		"algorithm",
		"candidate ranking and plan selection",
		"iterators-callbacks",
		"src/compiler/core/core-transform-candidates.ts",
		candidateRankingReplay,
	),
	kernel(
		"core-to-execution",
		"algorithm",
		"Core-to-Execution lowering",
		"allocation-gc",
		"src/compiler/target/lower-execution.ts",
		loweringReplay,
	),
];

const argument = process.argv[2];
if (argument === "--list") {
	console.log(
		JSON.stringify(
			kernels.map(({ id, group, owner, category, sourceSeam }) => ({
				id,
				group,
				owner,
				category,
				sourceSeam,
			})),
		),
	);
} else {
	const selected = kernels.find(({ id }) => id === argument);
	if (selected === undefined)
		throw new Error(`unknown compiler host-gap kernel: ${argument}`);
	const scale = Number(process.argv[3] ?? "1");
	if (!Number.isSafeInteger(scale) || scale < 1)
		throw new Error("scale must be a positive integer");
	selected.run(1);
	const allocatedReader = Reflect.get(globalThis, "__mal_gc_allocated_bytes");
	const collectionsReader = Reflect.get(globalThis, "__mal_gc_collections");
	const beforeAllocated =
		typeof allocatedReader === "function" ? allocatedReader() : undefined;
	const beforeCollections =
		typeof collectionsReader === "function" ? collectionsReader() : undefined;
	const startedAt = Date.now();
	const measured = selected.run(scale);
	const elapsedMs = Date.now() - startedAt;
	const afterAllocated =
		typeof allocatedReader === "function" ? allocatedReader() : undefined;
	const afterCollections =
		typeof collectionsReader === "function" ? collectionsReader() : undefined;
	console.log(
		JSON.stringify({
			schema: 1,
			workload: "compiler-host-gap-v1",
			id: selected.id,
			group: selected.group,
			owner: selected.owner,
			category: selected.category,
			sourceSeam: selected.sourceSeam,
			scale,
			operations: measured.operations,
			checksum: measured.checksum,
			elapsedMs,
			...(beforeAllocated === undefined || afterAllocated === undefined
				? {}
				: { allocatedBytes: Math.max(0, afterAllocated - beforeAllocated) }),
			...(beforeCollections === undefined || afterCollections === undefined
				? {}
				: { collections: Math.max(0, afterCollections - beforeCollections) }),
		}),
	);
}
