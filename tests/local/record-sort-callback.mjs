function compareRecords(left, right) {
	return right.score - left.score || left.id - right.id;
}

function sortRecords(values) {
	return values.sort(compareRecords);
}

function copyRecords(values) {
	return values.toSorted(compareRecords);
}

function detachedSort(values) {
	const sort = values.sort;
	return sort.call(values, compareRecords);
}

function detachedCopy(values) {
	return values.toSorted.call(values, compareRecords);
}

function records() {
	return Array.from({ length: 96 }, (_, index) => ({
		score: (index * 37) & 31,
		id: index % 3,
		name: `row${index}`,
	}));
}

function labels(values) {
	return values.map((value) => (value === undefined ? "undefined" : value.name));
}

// Relational comparisons of two Strings order by code units; any other pair converts.
function compareNames(left, right) {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function compareScoreThenName(left, right) {
	return right.score - left.score || (left.name <= right.name ? -1 : 1);
}

const scenarios = {
	strings() {
		const names = [
			"row10",
			"row1",
			"Row2",
			"row",
			"é",
			"€",
			"😀",
			"\uffff",
			"",
			"row1",
			"10",
			"9",
		];
		const rows = names.map((name, index) => ({ name, score: index & 1 }));
		const mixed = [
			{ name: 10 },
			{ name: "9" },
			{ name: "10" },
			{ name: 9 },
			{ name: "a" },
		];
		return {
			names: labels(rows.toSorted(compareNames)),
			scored: labels(rows.toSorted(compareScoreThenName)),
			mixed: mixed.toSorted(compareNames).map((row) => typeof row.name + ":" + row.name),
		};
	},
	inPlace() {
		return labels(sortRecords(records()));
	},
	copy() {
		return labels(copyRecords(records()));
	},
	stable() {
		const input = records();
		const copy = copyRecords(input);
		const original = labels(input);
		return { original, copy: labels(copy), sorted: labels(sortRecords(input)) };
	},
	mixedShapes() {
		const input = records().map((record, index) =>
			index & 1 ? record : { name: record.name, id: record.id, score: record.score },
		);
		return labels(sortRecords(input));
	},
	frozen() {
		return labels(sortRecords(records().map(Object.freeze)));
	},
	identities() {
		const input = records();
		const shared = input[3];
		input.push(shared, shared);
		const result = sortRecords(input);
		return {
			labels: labels(result),
			shared: result.filter((value) => value === shared).length,
		};
	},
	specialNumbers() {
		let comparisons = 0;
		const rows = [NaN, Infinity, -Infinity, -0, 0, 3, NaN, 3].map((score, id) => ({
			score,
			id,
			name: `number${id}`,
		}));
		const generic = rows.slice().sort((left, right) => {
			comparisons++;
			return compareRecords(left, right);
		});
		const fast = sortRecords(rows.slice());
		return {
			same: labels(fast).join() === labels(generic).join(),
			compared: comparisons > 0,
		};
	},
	getters() {
		let reads = 0;
		const makeRows = () =>
			records().map((record) => ({
				get score() {
					reads++;
					globalThis.recordSortGarbage = [record, reads];
					return record.score;
				},
				id: record.id,
				name: record.name,
			}));
		const sorted = sortRecords(makeRows());
		const fastReads = reads;
		reads = 0;
		let comparisons = 0;
		makeRows().sort((left, right) => {
			comparisons++;
			return compareRecords(left, right);
		});
		return {
			labels: labels(sorted),
			read: reads > 0 && comparisons > 0,
			sameReads: fastReads === reads,
		};
	},
	proxies() {
		let reads = 0;
		const rows = records().map(
			(record) =>
				new Proxy(record, {
					get(target, key) {
						if (key === "score") reads++;
						return target[key];
					},
				}),
		);
		return { labels: labels(sortRecords(rows)), read: reads > 0 };
	},
	inherited() {
		const rows = records().map((record) =>
			Object.assign(Object.create({ score: record.score }), {
				id: record.id,
				name: record.name,
			}),
		);
		return labels(sortRecords(rows));
	},
	coercion() {
		let conversions = 0;
		const rows = records();
		rows[0].score = "12";
		rows[1].score = {
			valueOf() {
				conversions++;
				return 20;
			},
		};
		return { labels: labels(sortRecords(rows)), converted: conversions > 0 };
	},
	collection() {
		const rows = records();
		const first = rows[0];
		const events = [];
		Object.defineProperty(rows, 0, {
			get() {
				events.push("collect");
				rows[1].score = 1_000;
				return first;
			},
			configurable: true,
		});
		return { result: labels(copyRecords(rows)), events };
	},
	mutation() {
		let comparisons = 0;
		const rows = records();
		rows.sort((left, right) => {
			comparisons++;
			left.visited = true;
			return compareRecords(left, right);
		});
		return {
			labels: labels(rows),
			compared: comparisons > 0,
			visited: rows.some((row) => row.visited),
		};
	},
	exception() {
		const rows = records();
		const before = labels(rows).join();
		let error;
		try {
			rows.sort((left, right) => {
				if (left !== right) throw new Error("record comparison");
				return compareRecords(left, right);
			});
		} catch (caught) {
			error = caught.message;
		}
		return { error, unchanged: before === labels(rows).join() };
	},
	detached() {
		const rows = records();
		return { copy: labels(detachedCopy(rows)), sorted: labels(detachedSort(rows)) };
	},
	override() {
		const rows = records();
		rows.sort = function (comparator) {
			return comparator({ score: 2, id: 1 }, { score: 7, id: 0 });
		};
		return rows.sort(compareRecords);
	},
	sparse() {
		const rows = records();
		rows[3] = undefined;
		delete rows[7];
		const copy = copyRecords(rows);
		const sorted = sortRecords(rows);
		return {
			copy: labels(copy),
			copyKeys: Object.keys(copy),
			sorted: labels(sorted),
			sortedKeys: Object.keys(sorted),
		};
	},
};

console.log(JSON.stringify(scenarios[process.env.RECORD_SORT_CASE || "stable"]()));
