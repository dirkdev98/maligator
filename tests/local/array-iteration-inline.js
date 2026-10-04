"use strict";

// Every call site sits in a loop so the compiler may expand it inline. Each case
// compares against values computed without the method under test.
const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

const values = Array.from({ length: 2048 }, (_, index) => index);

check(
	"forEach visits each element with index and receiver",
	(() => {
		let total = 0;
		let indexes = 0;
		let receivers = 0;
		for (let round = 0; round < 4; round++) {
			values.forEach((value, index, receiver) => {
				total += value + round;
				indexes += index;
				if (receiver === values) receivers++;
			});
		}
		return (
			total === 4 * 2096128 + 2048 * 6 && indexes === 4 * 2096128 && receivers === 8192
		);
	})(),
);

check(
	"forEach returns undefined and passes thisArg",
	(() => {
		const context = { hits: 0 };
		let returned = 0;
		for (let round = 0; round < 3; round++) {
			const result = [1, 2, 3].forEach(function () {
				this.hits++;
			}, context);
			if (result === undefined) returned++;
		}
		return context.hits === 9 && returned === 3;
	})(),
);

check(
	"forEach skips holes and observes deletion",
	(() => {
		const visits = [];
		for (let round = 0; round < 2; round++) {
			const sparse = [0, , 2, 3, 4];
			sparse.forEach((value, index, receiver) => {
				if (index === 0) delete receiver[3];
				visits.push(value);
			});
		}
		return visits.join(",") === "0,2,4,0,2,4";
	})(),
);

check(
	"forEach snapshots length before the first call",
	(() => {
		let visits = 0;
		for (let round = 0; round < 2; round++) {
			const growing = [1, 2, 3];
			growing.forEach((value, index, receiver) => {
				receiver.push(value);
				visits++;
			});
		}
		return visits === 6;
	})(),
);

check(
	"map transforms dense arrays",
	(() => {
		let matches = 0;
		for (let round = 0; round < 4; round++) {
			const mapped = values.map((value) => value * 2 + round);
			let ok = mapped.length === values.length && Array.isArray(mapped);
			for (let index = 0; ok && index < mapped.length; index++)
				ok = mapped[index] === index * 2 + round;
			if (ok && Object.getPrototypeOf(mapped) === Array.prototype) matches++;
		}
		return matches === 4;
	})(),
);

check(
	"map preserves inner and trailing holes",
	(() => {
		let matches = 0;
		for (let round = 0; round < 2; round++) {
			const sparse = [1, , 3, , ,];
			const mapped = sparse.map((value) => value * 10);
			if (
				mapped.length === 5 &&
				mapped[0] === 10 &&
				!(1 in mapped) &&
				mapped[2] === 30 &&
				!(3 in mapped) &&
				!(4 in mapped)
			)
				matches++;
		}
		return matches === 2;
	})(),
);

check(
	"map observes receiver mutation and inherited elements",
	(() => {
		let matches = 0;
		for (let round = 0; round < 2; round++) {
			Array.prototype[1] = 5;
			const sparse = [1, , 3, 4];
			const mapped = sparse.map((value, index, receiver) => {
				if (index === 0) delete receiver[3];
				return value + index;
			});
			delete Array.prototype[1];
			if (mapped.join(",") === "1,6,5," && mapped.length === 4 && !(3 in mapped))
				matches++;
		}
		return matches === 2;
	})(),
);

check(
	"map defines results without inherited setters",
	(() => {
		let setterCalls = 0;
		Object.defineProperty(Array.prototype, "0", {
			configurable: true,
			set() {
				setterCalls++;
			},
			get() {
				return "inherited";
			},
		});
		let own = 0;
		for (let round = 0; round < 2; round++) {
			const mapped = [7, 8].map((value) => value + 1);
			if (Object.getOwnPropertyDescriptor(mapped, "0")?.value === 8) own++;
		}
		delete Array.prototype[0];
		return setterCalls === 0 && own === 2;
	})(),
);

check(
	"map honors a species subclass",
	(() => {
		class Tracked extends Array {}
		let tracked = 0;
		for (let round = 0; round < 2; round++) {
			const source = Tracked.from([1, 2, 3]);
			const mapped = source.map((value) => value * 2);
			if (mapped instanceof Tracked && mapped.join(",") === "2,4,6") tracked++;
		}
		return tracked === 2;
	})(),
);

check(
	"filter keeps selected elements in order",
	(() => {
		let matches = 0;
		for (let round = 0; round < 8; round++) {
			const filtered = values.filter((value) => (value & 7) === (round & 7));
			let ok = filtered.length === 256;
			for (let index = 0; ok && index < filtered.length; index++)
				ok = filtered[index] === index * 8 + (round & 7);
			if (ok) matches++;
		}
		return matches === 8;
	})(),
);

check(
	"filter keeps the value read before the callback",
	(() => {
		let matches = 0;
		for (let round = 0; round < 2; round++) {
			const source = [1, 2, 3];
			const filtered = source.filter((value, index, receiver) => {
				receiver[index] = value * 100;
				return value !== 2;
			});
			if (filtered.join(",") === "1,3" && source.join(",") === "100,200,300") matches++;
		}
		return matches === 2;
	})(),
);

check(
	"filter skips holes and compacts the result",
	(() => {
		let matches = 0;
		for (let round = 0; round < 2; round++) {
			const filtered = [, 1, , 2, , 3].filter(() => true);
			if (filtered.length === 3 && filtered.join(",") === "1,2,3" && 0 in filtered)
				matches++;
		}
		return matches === 2;
	})(),
);

check(
	"filter defines results without inherited setters",
	(() => {
		let setterCalls = 0;
		Object.defineProperty(Array.prototype, "1", {
			configurable: true,
			set() {
				setterCalls++;
			},
		});
		let own = 0;
		for (let round = 0; round < 2; round++) {
			const filtered = [4, 5, 6].filter((value) => value > 4);
			if (Object.getOwnPropertyDescriptor(filtered, "1")?.value === 6) own++;
		}
		delete Array.prototype[1];
		return setterCalls === 0 && own === 2;
	})(),
);

check(
	"filter truthiness follows ToBoolean",
	(() => {
		let matches = 0;
		const verdicts = [0, "", "x", null, {}, NaN, -1, undefined];
		for (let round = 0; round < 2; round++) {
			const filtered = verdicts.filter((verdict) => verdict);
			if (filtered.length === 3 && filtered[0] === "x" && filtered[2] === -1) matches++;
		}
		return matches === 2;
	})(),
);

check(
	"find returns the first match or undefined",
	(() => {
		let total = 0;
		for (let round = 0; round < 16; round++) {
			total += values.find((value) => value > round * 100) ?? -1;
			if (values.find((value) => value < 0) === undefined) total++;
		}
		// Each round finds round * 100 + 1 and counts one miss.
		return total === 100 * 120 + 16 + 16;
	})(),
);

check(
	"find visits holes as undefined",
	(() => {
		let visits = 0;
		let found = 0;
		for (let round = 0; round < 2; round++) {
			const result = [1, , 3].find((value, index) => {
				visits++;
				return value === undefined && index === 1;
			});
			if (result === undefined) found++;
		}
		return visits === 4 && found === 2;
	})(),
);

check(
	"find returns the element read before the callback",
	(() => {
		let matches = 0;
		for (let round = 0; round < 2; round++) {
			const source = [1, 2, 3];
			const result = source.find((value, index, receiver) => {
				receiver[index] = -value;
				return value === 2;
			});
			if (result === 2 && source[1] === -2) matches++;
		}
		return matches === 2;
	})(),
);

check(
	"findIndex returns the first matching index or -1",
	(() => {
		let total = 0;
		let visits = 0;
		for (let round = 0; round < 8; round++) {
			total += values.findIndex((value) => value === round * 3);
			total += [1, , 3].findIndex((value) => {
				visits++;
				return value === undefined;
			});
			if ([1, 2].findIndex((value) => value > 5) === -1) total++;
		}
		// Rounds find indexes 0, 3, ..., 21 and the hole at index 1 each time.
		return total === 84 + 8 + 8 && visits === 16;
	})(),
);

check(
	"reduce accumulates from its initial value",
	(() => {
		let total = 0;
		for (let round = 0; round < 4; round++) {
			total += values.reduce((sum, value) => sum + value, round);
		}
		return total === 4 * 2096128 + 6;
	})(),
);

check(
	"reduce passes its arguments and skips holes",
	(() => {
		const calls = [];
		let receivers = 0;
		for (let round = 0; round < 2; round++) {
			const sparse = ["a", , "c"];
			const joined = sparse.reduce(function (text, value, index, receiver) {
				calls.push(index + ":" + (this === undefined));
				if (receiver === sparse) receivers++;
				return text + value;
			}, "<");
			if (joined !== "<ac") return false;
		}
		return calls.join(",") === "0:true,2:true,0:true,2:true" && receivers === 4;
	})(),
);

check(
	"reduce without an initial value seeds from the first element",
	(() => {
		let total = 0;
		let thrown = 0;
		for (let round = 0; round < 3; round++) {
			total += [, round + 1, 10].reduce((sum, value) => sum + value);
			try {
				[].reduce((sum, value) => sum + value);
			} catch (error) {
				if (error instanceof TypeError) thrown++;
			}
			if ([].reduce((sum, value) => sum + value, round) === round) total++;
		}
		return total === 6 + 30 + 3 && thrown === 3;
	})(),
);

check(
	"some and every keep early exits",
	(() => {
		let visits = 0;
		let verdicts = 0;
		for (let round = 0; round < 4; round++) {
			if (
				[1, 2, 3, 4].some((value) => {
					visits++;
					return value === 2;
				})
			)
				verdicts++;
			if (
				![1, 2, 3, 4].every((value) => {
					visits++;
					return value < 3;
				})
			)
				verdicts++;
		}
		return visits === 4 * (2 + 3) && verdicts === 8;
	})(),
);

check(
	"array-likes and overrides keep their own methods",
	(() => {
		let calls = 0;
		const likes = [
			{ length: 2, 0: 1, 1: 2, map: () => (calls++, "own map") },
			Object.assign([1, 2], { filter: () => (calls++, "own filter") }),
		];
		let matches = 0;
		for (let round = 0; round < 2; round++) {
			if (likes[0].map((value) => value) === "own map") matches++;
			if (likes[1].filter((value) => value) === "own filter") matches++;
		}
		return calls === 4 && matches === 4;
	})(),
);

check(
	"a prototype override applies mid-loop",
	(() => {
		const original = Array.prototype.forEach;
		let custom = 0;
		let visits = 0;
		for (let round = 0; round < 4; round++) {
			if (round === 2)
				Array.prototype.forEach = function () {
					custom++;
				};
			[1, 2].forEach(() => {
				visits++;
			});
		}
		Array.prototype.forEach = original;
		return custom === 2 && visits === 4;
	})(),
);

check(
	"a throwing callback propagates and the loop recovers",
	(() => {
		let caught = 0;
		let total = 0;
		for (let round = 0; round < 4; round++) {
			try {
				total += [1, 2, 3]
					.map((value) => {
						if (value === round) throw new RangeError("stop");
						return value;
					})
					.reduce((sum, value) => sum + value, 0);
			} catch (error) {
				if (error instanceof RangeError) caught++;
			}
		}
		return caught === 3 && total === 6;
	})(),
);

check(
	"non-callable callbacks throw TypeError",
	(() => {
		let thrown = 0;
		const callbacks = [undefined, 1, {}];
		for (const callback of callbacks) {
			try {
				[1].filter(callback);
			} catch (error) {
				if (error instanceof TypeError) thrown++;
			}
		}
		return thrown === 3;
	})(),
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
