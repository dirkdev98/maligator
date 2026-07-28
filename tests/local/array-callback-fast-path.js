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

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
