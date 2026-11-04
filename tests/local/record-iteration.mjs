function update(rows, rounds) {
	let total = 0;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) {
			const { id, point, active } = row;
			point.x += row.delta;
			point.y = (point.y + round + id) & 1_023;
			const score = row.profile?.x ?? 7;
			if (active) total += point.x + point.y + score;
		}
	}
	return total;
}

function makeRows() {
	return Array.from({ length: 48 }, (_, id) => ({
		id,
		point: { x: id * 0.5, y: id & 7 },
		delta: (id & 3) - 1,
		active: (id & 7) !== 0,
		profile: (id & 3) === 0 ? undefined : { x: id & 15 },
	}));
}

function result(rows, rounds = 4) {
	const checksum = update(rows, rounds);
	return {
		checksum: String(checksum),
		points: rows.map((row) => [String(row.point.x), row.point.y]),
	};
}

const scenarios = {
	ordinary() {
		return result(makeRows());
	},
	aliases() {
		const rows = makeRows();
		rows[3].point = rows[2].point;
		rows[3].profile = rows[2].point;
		rows[7].profile = rows[7].point;
		return result(rows);
	},
	cycles() {
		const rows = makeRows();
		rows[3].x = 2;
		rows[3].y = 4;
		rows[3].point = rows[3];
		rows[3].profile = rows[3];
		return result(rows);
	},
	nullish() {
		const rows = makeRows();
		rows[1].profile = null;
		rows[2].profile = undefined;
		return result(rows);
	},
	getters() {
		const rows = makeRows(),
			events = [];
		Object.defineProperty(rows[3].profile, "x", {
			get() {
				events.push(rows[3].point.x);
				globalThis.recordIterationGarbage = [events.length, rows[3]];
				return 9;
			},
		});
		return { ...result(rows), events };
	},
	coercion() {
		const rows = makeRows(),
			events = [];
		rows[3].profile.x = {
			valueOf() {
				events.push(rows[3].point.x);
				return 9;
			},
		};
		return { ...result(rows), events };
	},
	proxy() {
		const rows = makeRows(),
			keys = [];
		rows[3] = new Proxy(rows[3], {
			get(target, key) {
				keys.push(String(key));
				return target[key];
			},
		});
		return { ...result(rows), keys };
	},
	inherited() {
		const rows = makeRows();
		rows[3].point = Object.create({ x: 3, y: 5 });
		return result(rows);
	},
	frozen() {
		const rows = makeRows();
		Object.freeze(rows[3].point);
		let error;
		try {
			update(rows, 4);
		} catch (caught) {
			error = caught.name;
		}
		return { error, points: rows.slice(0, 4).map((row) => [row.point.x, row.point.y]) };
	},
	specialNumbers() {
		const rows = makeRows();
		rows[1].point.x = NaN;
		rows[2].point.x = -0;
		rows[3].delta = Infinity;
		rows[4].point.x = -Infinity;
		return result(rows);
	},
	changedKinds() {
		let carry = 1,
			total = 0;
		for (const row of makeRows()) {
			total += carry;
			carry = !row.active;
		}
		return total;
	},
	sparse() {
		const rows = makeRows();
		delete rows[3];
		let error;
		try {
			update(rows, 4);
		} catch (caught) {
			error = caught.name;
		}
		return { error, first: rows[0].point.x };
	},
};

console.log(JSON.stringify(scenarios[process.env.RECORD_ITERATION_CASE || "ordinary"]()));
