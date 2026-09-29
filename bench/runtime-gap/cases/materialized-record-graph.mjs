import { runRuntimeGapCase } from "../case-runner.mjs";

const COUNT = 8_192;
const MODULUS = 1_000_000_007;
let retained = [];
let expectedRounds = 0;

function makeRecord(id, parent) {
	return { id, weight: (id & 255) + 0.5, parent, visited: false };
}

function updateRecord(record) {
	record.id++;
	record.weight += 0.25;
	record.visited = true;
	return record.id + record.weight + (record.parent === null ? 0 : record.parent.id);
}

function materializedRecordGraph(scale) {
	const rows = [];
	let parent = { id: -1 };
	for (let index = 0; index < COUNT; index++) {
		const record = makeRecord(index, parent);
		rows.push(record);
		parent = record;
	}
	retained = rows;
	for (let index = 0; index < COUNT; index += 128) rows[index].parent = null;
	const rounds = 32 * scale;
	expectedRounds = rounds;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < COUNT; index++) {
			checksum = (checksum + updateRecord(rows[index])) % MODULUS;
		}
		const reflected = rows[(round * 131) & (COUNT - 1)];
		const descriptor = Object.getOwnPropertyDescriptor(reflected, "weight");
		checksum = (checksum + descriptor.value + Object.keys(reflected).length) % MODULUS;
	}
	return { checksum, operations: COUNT * rounds };
}

function verify() {
	for (let index = 0; index < retained.length; index++) {
		const row = retained[index];
		if (
			row.id !== index + expectedRounds ||
			row.weight !== (index & 255) + 0.5 + expectedRounds * 0.25 ||
			row.parent !== (index % 128 === 0 ? null : retained[index - 1]) ||
			!row.visited
		) {
			throw new Error("retained record graph differs");
		}
	}
}

runRuntimeGapCase("materialized-record-graph", materializedRecordGraph, verify);
