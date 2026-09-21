const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

check(
	"forEach mutable capture",
	(() => {
		let sum = 0;
		[1, 2, 3, 4].forEach((value) => {
			sum += value;
		});
		return sum === 10;
	})(),
);

check(
	"multiple mutable captures",
	(() => {
		let sum = 0;
		let count = 0;
		[2, 4, 6].forEach((value) => {
			sum += value;
			count++;
		});
		return sum === 12 && count === 3;
	})(),
);

check(
	"callback receiver mutation preserves later holes",
	(() => {
		let visits = 0;
		[1, 2, 3].forEach((_value, index, array) => {
			if (index === 0) delete array[2];
			visits++;
		});
		return visits === 2;
	})(),
);

check(
	"reduce side capture",
	(() => {
		let count = 0;
		const sum = [1, 2, 3].reduce((accumulator, value) => {
			count++;
			return accumulator + value;
		}, 0);
		return sum === 6 && count === 3;
	})(),
);

check(
	"early exit commits capture",
	(() => {
		let visits = 0;
		const found = [1, 2, 3, 4].some((value) => {
			visits++;
			return value === 3;
		});
		return found && visits === 3;
	})(),
);

check(
	"own override retains callback",
	(() => {
		let retained;
		let state = 1;
		const values = [2];
		values.forEach = (callback) => {
			retained = callback;
		};
		values.forEach((value) => {
			state += value;
		});
		state = 10;
		retained(5);
		return state === 15;
	})(),
);

check(
	"loaded own override remains authoritative after argument effects",
	(() => {
		const values = [1];
		let customCalls = 0;
		let callbackTotal = 0;
		values.forEach = function (callback) {
			customCalls++;
			callback(7);
		};
		const callback = (value) => {
			callbackTotal += value;
		};
		values.forEach((delete values.forEach, callback));
		return customCalls === 1 && callbackTotal === 7;
	})(),
);

check(
	"prototype override retains callback",
	(() => {
		const original = Array.prototype.forEach;
		let retained;
		let state = 3;
		Array.prototype.forEach = function (callback) {
			retained = callback;
		};
		[1].forEach((value) => {
			state *= value;
		});
		Array.prototype.forEach = original;
		state = 7;
		retained(6);
		return state === 42;
	})(),
);

check(
	"observable closure rejects shadow",
	(() => {
		let state = 0;
		const observations = [];
		const read = () => state;
		[2, 3].forEach((value) => {
			observations.push(read());
			state += value;
		});
		return observations.join(",") === "0,2" && state === 5;
	})(),
);

check(
	"abrupt callback preserves observable environment",
	(() => {
		let read;
		function run() {
			let state = 0;
			read = () => state;
			[1, 2, 3].forEach((value) => {
				state += value;
				if (value === 2) throw "stop";
			});
		}
		try {
			run();
		} catch (error) {
			if (error !== "stop") return false;
		}
		return read() === 3;
	})(),
);

check(
	"map preserves holes and observes receiver mutation",
	(() => {
		const values = [1, , 3, 4];
		let visits = 0;
		const mapped = values.map((value, index, receiver) => {
			visits++;
			if (index === 0) delete receiver[3];
			return value * 2;
		});
		return (
			visits === 2 &&
			mapped.length === 4 &&
			mapped[0] === 2 &&
			!(1 in mapped) &&
			mapped[2] === 6 &&
			!(3 in mapped)
		);
	})(),
);

check(
	"map falls back after indexed prototype mutation",
	(() => {
		const values = [1, , , 4];
		const mapped = values.map((value, index) => {
			if (index === 0) Array.prototype[2] = 9;
			return value + index;
		});
		delete Array.prototype[2];
		return mapped.join(",") === "1,,11,7";
	})(),
);

check(
	"non-throwing exact callback preserves result",
	[0, 1, 2].every(() => true),
);

check(
	"every virtualizes immutable per-iteration captures",
	(() => {
		const groups = [
			[1, 2, 3],
			[4, 5, 6],
		];
		let matches = 0;
		for (let index = 0; index < groups.length; index++) {
			const expected = groups[index];
			const values = expected.slice();
			if (values.every((value, position) => value === expected[position])) matches++;
		}
		return matches === 2;
	})(),
);

check(
	"paired every preserves strict equality",
	(() => {
		const shared = {};
		const expected = [0, "same", shared];
		const values = [-0, "same", shared];
		const nanExpected = [NaN];
		const nanValues = [NaN];
		return (
			values.every((value, position) => value === expected[position]) &&
			!nanValues.every((value, position) => value === nanExpected[position])
		);
	})(),
);

check(
	"paired every falls back for inherited holes",
	(() => {
		const expected = [1, , 3];
		Array.prototype[1] = 2;
		const result = [1, 2, 3].every((value, position) => value === expected[position]);
		delete Array.prototype[1];
		return result;
	})(),
);

check(
	"paired every falls back for expected accessors",
	(() => {
		let reads = 0;
		const expected = [1, 2];
		Object.defineProperty(expected, 1, {
			get() {
				reads++;
				return 2;
			},
		});
		return [1, 2].every((value, position) => value === expected[position]) && reads === 1;
	})(),
);

check(
	"every fallback materializes distinct captured callbacks",
	(() => {
		const retained = [];
		const values = [1];
		values.every = (callback) => {
			retained.push(callback);
			return callback(1, 0);
		};
		for (const expected of [[1], [2]]) values.every((value) => value === expected[0]);
		return retained[0](1) && !retained[1](1);
	})(),
);

check(
	"every snapshots length and observes deletion",
	(() => {
		const values = [1, 2, 3];
		const visits = [];
		const result = values.every((value, index, receiver) => {
			visits.push(value);
			if (index === 0) {
				delete receiver[1];
				receiver.push(4);
			}
			return true;
		});
		return result && visits.join(",") === "1,3";
	})(),
);

check(
	"some observes inherited holes and thisArg",
	(() => {
		Array.prototype[1] = 7;
		const context = { expected: 7 };
		const values = [, , 3];
		const result = values.some(function (value, index, receiver) {
			return this === context && receiver === values && index === 1 && value === 7;
		}, context);
		delete Array.prototype[1];
		return result;
	})(),
);

check(
	"empty every rejects a non-callable callback",
	(() => {
		try {
			[].every(0);
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	})(),
);

check(
	"every override remains authoritative",
	(() => {
		const values = [1];
		values.every = (callback) => callback(9);
		return values.every((value) => value === 9);
	})(),
);

function captureCallbackStack() {
	return new Error("callback").stack;
}
const callbackStack = [0].map(captureCallbackStack)[0];
check(
	"stack-observing callback retains its native frame",
	typeof callbackStack === "string" &&
		callbackStack.indexOf("captureCallbackStack (") !== -1,
);

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
