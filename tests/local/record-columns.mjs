function traverse(rounds, change, stop, fail) {
	const retained = { nested: { rounds } };
	const rows = Array.from({ length: 48 }, (_, id) => ({
		id,
		point: { x: id * 0.5, y: id & 7 },
		delta: (id & 3) - 1,
		active: (id & 7) !== 0,
		profile: (id & 3) === 0 ? null : (id & 3) === 1 ? undefined : { x: id & 15 },
	}));
	let total = 0;
	for (let round = 0; round < rounds; round++) {
		if (round === 3 && change) total = "sum:";
		if (round === 4 && stop) return total;
		if (round === 4 && fail) throw total;
		for (const row of rows) {
			const { id, point, active } = row;
			point.x += row.delta;
			point.y = (point.y + round + id) & 1_023;
			const score = row.profile?.x ?? 7;
			if (active) total += point.x + point.y + score;
		}
	}
	return [total, retained];
}

function aliased() {
	const rows = Array.from({ length: 16 }, (_, id) => {
		const point = { x: id };
		return { point, profile: point, delta: id & 3 };
	});
	let total = 0;
	for (let round = 0; round < 8; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.profile.x;
		}
	}
	return total;
}

function external(input) {
	const rows = Array.from(input, (point, id) => ({ point, delta: id & 3 }));
	let total = 0;
	for (let round = 0; round < 8; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
	}
	return total;
}

function captured(point) {
	const rows = Array.from({ length: 16 }, (_, id) => ({ point, delta: id & 3 }));
	let total = 0;
	for (let round = 0; round < 8; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
	}
	return total;
}

function escaped() {
	const rows = Array.from({ length: 16 }, (_, id) => ({
		point: { x: id },
		delta: id & 3,
	}));
	for (let round = 0; round < 8; round++) {
		for (const row of rows) row.point.x += row.delta;
	}
	return rows.map((row) => row.point.x);
}

function special(rounds) {
	const rows = Array.from({ length: 1 }, (_, id) => ({ point: { x: id }, delta: 1 }));
	let total = 0;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) {
			row.point.x = -row.point.x;
			total = row.delta / row.point.x;
		}
	}
	return String(total);
}

const scenarios = {
	ordinary: () => traverse(12),
	changedKind: () => traverse(8, true),
	earlyReturn: () => traverse(8, false, true),
	throw() {
		try {
			traverse(8, false, false, true);
		} catch (value) {
			return value;
		}
	},
	aliases: aliased,
	external() {
		const points = [{ x: 1 }, { x: 3 }, { x: 5 }];
		return [external(points), points.map((point) => point.x)];
	},
	captured() {
		const point = { x: 1 };
		return [captured(point), point.x];
	},
	escaped,
	specialNumbers: () => [special(3), special(4)],
	mutableIterator() {
		const original = Array.prototype[Symbol.iterator];
		Array.prototype[Symbol.iterator] = function* () {
			for (const value of original.call(this)) yield { ...value, delta: 9 };
		};
		try {
			return traverse(8);
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
	},
};
console.log(JSON.stringify(scenarios[process.env.RECORD_COLUMNS_CASE || "ordinary"]()));
