// Balanced core-JavaScript benchmark. The exact same ES module runs under Node
// and Maligator's closed/open x compiled/interpreted matrix. Each phase has an
// independent checksum and elapsed time so one fast or slow subsystem cannot hide
// another. Optional host surfaces (Node APIs, web APIs, Intl, Temporal, eval, and
// Realm construction) are intentionally outside this core-language workload.

const MOD = 1_000_000_007;

function countPrimes(limit) {
	let count = 0;
	let checksum = 0;
	for (let value = 2; value < limit; value++) {
		let prime = true;
		for (let divisor = 2; divisor * divisor <= value; divisor++) {
			if (value % divisor === 0) {
				prime = false;
				break;
			}
		}
		if (prime) {
			count++;
			checksum = (checksum + value) % MOD;
		}
	}
	return count + checksum;
}

function collatzSteps(start) {
	let steps = 0;
	let value = start;
	while (value > 1) {
		value = (value & 1) === 0 ? value / 2 : value * 3 + 1;
		steps++;
	}
	return steps;
}

function corePhase() {
	let checksum = 0;
	for (let round = 0; round < 12; round++) {
		checksum = (checksum + countPrimes(16_000)) % MOD;
		for (let value = 1; value < 18_000; value++) {
			checksum = (checksum + collatzSteps(value)) % MOD;
		}
	}
	const values = Array.from({ length: 1_500 }, (_, index) => index * 31 + 1);
	for (let round = 0; round < 1_500; round++) {
		for (const value of values) {
			try {
				if (value % 17 === 0) throw value;
				checksum = (checksum + (value % 101)) % MOD;
			} catch (reason) {
				checksum = (checksum + (reason % 97)) % MOD;
			}
		}
	}
	return checksum;
}

class StandardPricing {
	quote(order) {
		return order.net + 7;
	}
}

class VolumePricing {
	quote(order) {
		return order.net - Math.floor(order.net / 12);
	}
}

class PriorityPricing {
	quote(order) {
		return order.net + Math.max(15, order.quantity * 3);
	}
}

function argumentEdges(value = 11) {
	const first = arguments.length > 0 ? arguments[0] : value;
	const second = arguments.length > 1 ? arguments[1] : 13;
	const fourth = arguments.length > 3 ? arguments[3] : 19;
	return first * 3 + second * 5 + fourth * 7 + arguments.length;
}

function makeAccumulator(base) {
	return (value) => (base + value * 17) % MOD;
}

function objectsPhase() {
	const particles = [];
	for (let index = 0; index < 2_400; index++) {
		particles.push({
			x: index * 0.5,
			y: -index * 0.25,
			vx: (index % 13) - 6,
			vy: (index % 7) - 3,
			mass: (index % 9) + 1,
		});
	}
	let checksum = 0;
	for (let step = 0; step < 800; step++) {
		for (const particle of particles) {
			particle.vy += 0.01 * particle.mass;
			particle.x += particle.vx;
			particle.y += particle.vy;
			if (particle.y > 1_000) particle.y = -particle.y * 0.5;
			if (particle.x > 5_000) particle.x = particle.x % 97;
			checksum = (checksum + Math.round(particle.x - particle.y)) % MOD;
		}
	}

	const rules = [new StandardPricing(), new VolumePricing(), new PriorityPricing()];
	const accumulator = makeAccumulator(23);
	for (let index = 0; index < 3_600_000; index++) {
		const order = { net: (index * 47) % 800, quantity: (index % 9) + 1 };
		checksum =
			(checksum +
				rules[index % rules.length].quote(order) +
				argumentEdges(index, index + 1, index + 2, index + 3) +
				accumulator(index)) %
			MOD;
	}
	return checksum;
}

function collectionsPhase() {
	let checksum = 0;
	for (let round = 0; round < 1_000; round++) {
		const values = [];
		for (let index = 0; index < 1_200; index++)
			values.push((index * 37 + round) % 10_007);
		values.sort((left, right) => left - right);
		const counts = new Map();
		const unique = new Set();
		const histogram = new Uint32Array(16);
		for (const value of values) {
			const bucket = value & 15;
			counts.set(bucket, (counts.get(bucket) ?? 0) + value);
			unique.add(value % 257);
			histogram[bucket]++;
		}
		for (const [bucket, total] of counts) checksum = (checksum + bucket + total) % MOD;
		for (let index = 0; index < histogram.length; index++) {
			checksum = (checksum + histogram[index] * (index + 1)) % MOD;
		}
		checksum = (checksum + unique.size + values[round % values.length]) % MOD;
	}
	return checksum;
}

const TOKEN_PATTERN = /([A-Za-z]+)-(\d+):([a-z]+)=([^;]+);?/g;

function textPhase() {
	const records = [];
	for (let index = 0; index < 180; index++) {
		records.push(
			`item-${index}:region=${["north", "south", "east", "west"][index & 3]};`,
		);
	}
	const source = records.join("");
	let checksum = 0;
	for (let round = 0; round < 2_400; round++) {
		TOKEN_PATTERN.lastIndex = 0;
		let match;
		while ((match = TOKEN_PATTERN.exec(source)) !== null) {
			const normalized = `${match[1].toUpperCase()}:${match[3]}:${match[4]}`;
			checksum =
				(checksum +
					Number(match[2]) +
					normalized.length +
					normalized.charCodeAt(round % normalized.length)) %
				MOD;
		}
		const pieces = source.split(";");
		const selected = pieces[(round * 17) % (pieces.length - 1)];
		const encoded = JSON.stringify({ round, selected, count: pieces.length - 1 });
		const decoded = JSON.parse(encoded);
		checksum =
			(checksum + decoded.selected.length + decoded.count + encoded.length) % MOD;
	}
	return checksum;
}

function* generatedSequence(seed) {
	try {
		const sent = yield seed + 1;
		yield seed + 2 + (sent ?? 0);
		return seed + 3;
	} finally {
		yield seed + 5;
	}
}

async function asyncStep(seed) {
	let value = seed;
	for (let index = 0; index < 3; index++)
		value = (value + (await ((seed + index) & 15))) % MOD;
	return value;
}

async function asyncPhase() {
	let checksum = 0;
	for (let index = 0; index < 240_000; index++) {
		const iterator = generatedSequence(index);
		let step = iterator.next();
		checksum = (checksum + step.value) % MOD;
		step = iterator.next(index & 7);
		checksum = (checksum + step.value) % MOD;
		step = (index & 3) === 0 ? iterator.return(index + 11) : iterator.next();
		checksum = (checksum + step.value) % MOD;
	}

	const pending = [];
	for (let index = 0; index < 36_000; index++) {
		pending.push(asyncStep(index).then((value) => (value * 17 + index) % MOD));
	}
	const settled = await Promise.all(pending);
	for (const value of settled) checksum = (checksum + value) % MOD;
	const recovered = await Promise.reject(97).catch((reason) => reason + 3);
	return (checksum + recovered) % MOD;
}

const vector = (x, y, z) => ({ x, y, z });
const add = (left, right) => vector(left.x + right.x, left.y + right.y, left.z + right.z);
const scale = (value, factor) =>
	vector(value.x * factor, value.y * factor, value.z * factor);
const dot = (left, right) => left.x * right.x + left.y * right.y + left.z * right.z;

function allocationPhase() {
	let checksum = 0;
	const retained = [];
	for (let index = 0; index < 8_400_000; index++) {
		const first = vector(index % 101, (index * 3) % 103, (index * 7) % 107);
		const second = scale(first, 0.5);
		const result = add(first, second);
		checksum = (checksum + Math.round(dot(result, second))) % MOD;
		if ((index & 8_191) === 0) retained.push({ index, result, checksum });
	}
	for (const entry of retained) {
		checksum = (checksum + entry.index + Math.round(entry.result.x)) % MOD;
	}
	return checksum;
}

function measured(syncWork) {
	const start = Date.now();
	const checksum = syncWork();
	return { checksum, elapsedMs: Date.now() - start };
}

async function measuredAsync(asyncWork) {
	const start = Date.now();
	const checksum = await asyncWork();
	return { checksum, elapsedMs: Date.now() - start };
}

async function main() {
	const phases = {
		core: measured(corePhase),
		objects: measured(objectsPhase),
		collections: measured(collectionsPhase),
		text: measured(textPhase),
		async: await measuredAsync(asyncPhase),
		allocation: measured(allocationPhase),
	};
	const expected = {
		core: 299_544_852,
		objects: 338_353_713,
		collections: 742_032_359,
		text: 87_308_370,
		async: 79_845_414,
		allocation: 77_034_407,
	};
	for (const [name, result] of Object.entries(phases)) {
		if (result.checksum !== expected[name]) {
			throw new Error(`${name} checksum ${result.checksum} expected ${expected[name]}`);
		}
	}
	console.log(JSON.stringify({ workload: "javascript-v1", phases }));
}

main().catch((error) => {
	console.error(error);
	throw error;
});
