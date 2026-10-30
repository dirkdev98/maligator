function recordsPhase() {
	const records = Array.from({ length: 2_048 }, (_, id) => ({
		id,
		position: { x: id * 0.5, y: id & 31 },
		velocity: (id & 7) - 3,
		profile: (id & 3) === 0 ? undefined : { score: id & 63 },
		active: (id & 7) !== 0,
	}));
	let checksum = 0;
	for (let round = 0; round < 2_400; round++) {
		for (const record of records) {
			const { id, position, active } = record;
			position.x += record.velocity;
			position.y = (position.y + round + id) & 1_023;
			const score = record.profile?.score ?? 7;
			if (active) checksum += Math.trunc(position.x) + position.y + score;
		}
	}
	return checksum >>> 0;
}

class BasicAccount {
	constructor(id) {
		this.id = id;
		this.balance = id & 255;
	}
	get score() {
		return this.balance + 3;
	}
	set score(value) {
		this.balance = value - 3;
	}
	quote(value) {
		return value + this.balance;
	}
}

class DiscountAccount extends BasicAccount {
	quote(value) {
		return value - (this.balance & 15);
	}
}

function dynamicObjectsPhase() {
	const accounts = Array.from({ length: 64 }, (_, id) =>
		(id & 1) === 0 ? new BasicAccount(id) : new DiscountAccount(id),
	);
	const prototype = { category: 7 };
	let checksum = 0;
	for (let index = 0; index < 80_000; index++) {
		const account = accounts[index & 63];
		account.score = (index + account.id) & 255;
		const key = `field${index & 7}`;
		const entry = Object.create(prototype);
		entry.id = index;
		entry[key] = account.score;
		entry.optional = index & 15;
		if ((index & 3) === 0) delete entry.optional;
		const copy = { ...entry, selected: account.quote(index & 127) };
		Object.assign(copy, { revision: index & 31 });
		for (const [name, value] of Object.entries(copy)) checksum += name.length + value;
		checksum += entry.category + (Object.hasOwn(copy, "optional") ? 11 : 3);
	}
	return checksum >>> 0;
}

function adjust(value, offset = 3) {
	return (value * 3 + offset) & 65_535;
}

function collectArguments(base, ...values) {
	let result = base;
	for (const value of values) result += value;
	return result;
}

function observedArguments(value) {
	return value + arguments.length + (arguments[2] ?? 7);
}

function receiverCall(prefix, value) {
	return prefix + value + this.offset;
}

function callsPhase() {
	let shared = 0;
	const callbacks = Array.from(
		{ length: 16 },
		(_, bias) => (value) => adjust(value, bias + shared),
	);
	const receiver = { offset: 11, calculate: receiverCall };
	const bound = receiver.calculate.bind(receiver, 5);
	let checksum = 0;
	for (let index = 0; index < 2_800_000; index++) {
		shared = index & 31;
		const value = index & 1_023;
		checksum += adjust(value) + callbacks[index & 15](value) + bound(value);
		checksum += receiver.calculate(7, value);
		if ((index & 7) === 0) {
			const argumentsList = [value, shared, 13];
			checksum += collectArguments(3, ...argumentsList);
			checksum += observedArguments(...argumentsList);
			checksum += receiverCall.call(receiver, 5, value);
			checksum += receiverCall.apply(receiver, [7, value]);
		}
	}
	return checksum >>> 0;
}

function arraysPhase() {
	let checksum = 0;
	for (let round = 0; round < 2_400; round++) {
		const values = [];
		for (let index = 0; index < 256; index++) values.push((index * 37 + round) & 1_023);
		const transformed = values
			.map((value, index) => ({ id: index, score: value + (index & 7) }))
			.filter((record) => (record.score & 3) !== 0);
		transformed.sort((left, right) => right.score - left.score || left.id - right.id);
		const selected = transformed.slice(4, 28);
		selected.splice(3, 2, { id: round, score: round & 255 });
		checksum += selected.reduce((total, record) => total + record.score, 0);
		checksum += transformed.find((record) => record.id > 128)?.score ?? 0;
		checksum += values.some((value) => value > 1_000) ? 17 : 3;
		checksum += values.every((value) => value >= 0) ? 11 : 1;
		checksum += values.pop() + values[round & 127];
	}
	return checksum >>> 0;
}

function mapsSetsPhase() {
	const identities = Array.from({ length: 128 }, (_, id) => ({ id }));
	let checksum = 0;
	for (let round = 0; round < 1_200; round++) {
		const groups = new Map();
		const selected = new Set();
		const byIdentity = new Map();
		for (let index = 0; index < 256; index++) {
			const key = `group${index & 31}`;
			groups.set(key, (groups.get(key) ?? 0) + index + round);
			selected.add((index * 17 + round) & 127);
			byIdentity.set(identities[index & 127], index + round);
		}
		for (let index = 0; index < 48; index++) {
			checksum += groups.get(`group${index}`) ?? 5;
			if ((index & 3) === 0) selected.delete(index);
			checksum += selected.has(index) ? 7 : 3;
		}
		for (const [key, value] of groups) checksum += key.length + value;
		for (const value of selected) checksum += value;
		for (const identity of identities) checksum += byIdentity.get(identity);
		checksum += groups.delete("group3") ? groups.size : 0;
	}
	return checksum >>> 0;
}

const TOKEN_PATTERN = /([a-z]+)=(\d+)/g;

function textPhase() {
	const sources = Array.from(
		{ length: 64 },
		(_, index) =>
			`  item=${index};price=${index * 17};quantity=${(index & 7) + 1}; café-Σ-😀  `,
	);
	let checksum = 0;
	for (let index = 0; index < 50_000; index++) {
		const source = sources[index & 63].trim();
		const pieces = source.split(";");
		const joined = pieces.slice(0, 3).join("|");
		const replaced = joined.replaceAll("=", ":").replace(/\d+/g, "#");
		const upper = source.toUpperCase();
		checksum += upper.length + replaced.length + source.indexOf("price");
		checksum += source.includes("café") ? 13 : 0;
		checksum += source.slice(-9).codePointAt(0);
		TOKEN_PATTERN.lastIndex = 0;
		let match;
		while ((match = TOKEN_PATTERN.exec(source)) !== null)
			checksum += match[1].length + Number(match[2]);
	}
	return checksum >>> 0;
}

function jsonPhase() {
	const batches = Array.from({ length: 16 }, (_, batch) => ({
		batch,
		records: Array.from({ length: 24 }, (_, id) => ({
			id: batch * 24 + id,
			name: `item "${id}"\n café 😀`,
			price: id * 1.25,
			active: (id & 3) !== 0,
			tags: ["local", id & 1 ? "sale" : "regular"],
			details: { quantity: id & 7, note: id & 1 ? null : "available" },
		})),
	}));
	let checksum = 0;
	for (let index = 0; index < 2_000; index++) {
		const encoded = JSON.stringify(batches[index & 15]);
		const parsed = JSON.parse(encoded);
		const selected = parsed.records
			.filter((record) => record.active)
			.map(({ id, price, details }) => ({ id, total: price * (details.quantity + 1) }));
		const output = JSON.stringify({ batch: parsed.batch, selected });
		checksum += encoded.length + output.length;
		for (const record of selected) checksum += record.id + record.total;
	}
	return checksum >>> 0;
}

function numbersPhase() {
	let checksum = 0;
	for (let index = 1; index <= 240_000; index++) {
		const value = ((index * 37) & 65_535) / 8 - 2_048.25;
		const bounded = Math.min(1_000, Math.max(-1_000, value));
		checksum += Math.round(Math.sqrt(Math.abs(value)) * 100);
		checksum += Math.trunc(bounded) + Math.floor(value / 7) + Math.ceil(value / 13);
		const formatted = value.toFixed(2);
		checksum += Number.parseInt(formatted, 10) + Math.trunc(Number.parseFloat(formatted));
		checksum += Number.isFinite(Number(formatted)) ? formatted.length : 0;
		checksum += ((index << 5) ^ (index >>> 3)) & 255;
		if ((index & 15) === 0) {
			const date = new Date(1_700_000_000_000 + index * 1_000);
			const iso = date.toISOString();
			checksum += new Date(Date.parse(iso)).getUTCSeconds() + date.getUTCMonth();
		}
	}
	return checksum >>> 0;
}

function binaryPhase() {
	const integers = new Uint32Array(256);
	const floats = new Float64Array(256);
	const copy = new Uint32Array(128);
	const view = new DataView(new ArrayBuffer(1_028));
	let checksum = 0;
	for (let round = 0; round < 30_000; round++) {
		for (let index = 0; index < integers.length; index++) {
			integers[index] = (round * 37 + index * 17) >>> 0;
			floats[index] = integers[index] * 0.25 + index;
			view.setUint32(index * 4 + 1, integers[index], (index & 1) === 0);
		}
		copy.set(integers.subarray(64, 192));
		for (let index = 0; index < copy.length; index++)
			checksum += copy[index] + Math.trunc(floats[index]);
		checksum += view.getUint32((round & 255) * 4 + 1, (round & 1) === 0);
	}
	return checksum >>> 0;
}

function* sequence(seed) {
	for (let index = 0; index < 12; index++) yield (seed + index * 7) & 255;
}

function range(limit) {
	return {
		[Symbol.iterator]() {
			let value = 0;
			return {
				next() {
					return value < limit ? { value: value++, done: false } : { done: true };
				},
			};
		},
	};
}

function iterationsPhase() {
	let checksum = 0;
	for (let index = 0; index < 120_000; index++) {
		for (const value of sequence(index)) checksum += value;
		const early = sequence(index);
		for (const value of early) {
			checksum += value;
			if (value & 1) break;
		}
		for (const value of range(8)) checksum += value;
		try {
			if ((index & 63) === 0) throw new Error(`invalid ${index & 255}`);
			checksum += index & 15;
		} catch (error) {
			checksum += error.message.length;
		} finally {
			checksum += 3;
		}
	}
	return checksum >>> 0;
}

async function asyncValue(seed) {
	const value = await Promise.resolve(seed + 1);
	return (await value) + 3;
}

async function asyncPhase() {
	let checksum = 0;
	for (let batch = 0; batch < 24_000; batch++) {
		const pending = [];
		for (let index = 0; index < 8; index++)
			pending.push(asyncValue((batch + index) & 255).then((value) => value * 3));
		for (const value of await Promise.all(pending)) checksum += value;
		if ((batch & 31) === 0)
			checksum += await Promise.reject(batch & 127).catch((reason) => reason + 7);
	}
	return checksum >>> 0;
}

function makeRetainedRecord(id, value) {
	return {
		id,
		data: { value, previous: value - 1 },
		read: () => value + id,
	};
}

function allocationPhase() {
	const retained = new Array(256).fill(null);
	let checksum = 0;
	for (let index = 0; index < 2_400_000; index++) {
		const values = [index & 255, (index * 3) & 255, (index * 7) & 255];
		const temporary = { left: { value: values[0] }, right: { value: values[1] } };
		const result = makeRetainedRecord(index & 1_023, temporary.left.value + values[2]);
		checksum += result.read() + temporary.right.value;
		if ((index & 15) === 0) {
			const slot = (index >>> 4) & 255;
			const previous = retained[slot];
			if (previous !== null) checksum += previous.read() + previous.data.previous;
			retained[slot] = result;
		}
	}
	for (const record of retained) checksum += record.read() + record.data.value;
	return checksum >>> 0;
}

function measured(work) {
	const start = Date.now();
	const checksum = work();
	return { checksum, elapsedMs: Date.now() - start };
}

async function main() {
	const phases = {
		records: measured(recordsPhase),
		dynamicObjects: measured(dynamicObjectsPhase),
		calls: measured(callsPhase),
		arrays: measured(arraysPhase),
		mapsSets: measured(mapsSetsPhase),
		text: measured(textPhase),
		json: measured(jsonPhase),
		numbers: measured(numbersPhase),
		binary: measured(binaryPhase),
		iteration: measured(iterationsPhase),
	};
	const asyncStart = Date.now();
	const asyncChecksum = await asyncPhase();
	phases.async = { checksum: asyncChecksum, elapsedMs: Date.now() - asyncStart };
	phases.allocation = measured(allocationPhase);
	const expected = {
		records: 1096241408,
		dynamicObjects: 3225153856,
		calls: 3773120928,
		arrays: 54120258,
		mapsSets: 578338800,
		text: 38600879,
		json: 17195500,
		numbers: 2359267014,
		binary: 1577977840,
		iteration: 211220690,
		async: 75653858,
		allocation: 2292945808,
	};
	for (const [name, checksum] of Object.entries(expected)) {
		if (phases[name].checksum !== checksum)
			throw new Error(`${name} checksum ${phases[name].checksum} expected ${checksum}`);
	}
	console.log(JSON.stringify({ workload: "javascript-v2", phases }));
}

main().catch((error) => {
	console.error(error);
	throw error;
});
