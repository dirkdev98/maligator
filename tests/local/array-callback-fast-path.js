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
	"nested some and every keep independent callback arguments",
	[1, 2].every((outer) => [3, 4].some((inner) => inner === outer + 2)),
);

check(
	"some preserves callable Proxy dispatch and early exit",
	(() => {
		let calls = 0;
		const callback = new Proxy((value) => value === 2, {
			apply(target, thisArg, args) {
				calls++;
				return Reflect.apply(target, thisArg, args);
			},
		});
		return [1, 2, 3].some(callback) && calls === 2;
	})(),
);

check(
	"every roots fresh getter results across callback allocation",
	(() => {
		const values = {
			length: 2,
			get 0() {
				return { id: 1 };
			},
			get 1() {
				return { id: 2 };
			},
		};
		let expected = 1;
		return Array.prototype.every.call(values, (value) => {
			const allocated = { copy: value };
			return allocated.copy.id === expected++;
		});
	})(),
);

check(
	"some stops on abrupt callback completion",
	(() => {
		let visits = 0;
		try {
			[1, 2, 3].some((value) => {
				visits++;
				if (value === 2) throw "some-stop";
				return false;
			});
		} catch (error) {
			return error === "some-stop" && visits === 2;
		}
		return false;
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
