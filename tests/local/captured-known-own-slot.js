const ok = function (name, condition) {
	if (!condition) throw new Error("captured-known-own-slot failure: " + name);
};

const exercise = function (secondOrigin) {
	let state;
	if (secondOrigin) state = { tag: "second", x: 2 };
	else state = { x: 1 };

	const sum = function (count) {
		let total = 0;
		for (let index = 0; index < count; index++) total += state.x;
		return total;
	};

	ok("initial slot", sum(4) === (secondOrigin ? 8 : 4));
	state.x = 3;
	ok("same-shape overwrite", sum(4) === 12);

	let getterCalls = 0;
	delete state.x;
	Object.defineProperty(state, "x", {
		configurable: true,
		get() {
			getterCalls++;
			return 4;
		},
	});
	ok("accessor fallback", sum(4) === 16 && getterCalls === 4);

	let proxyCalls = 0;
	state = new Proxy(
		{ x: 5 },
		{
			get(target, key) {
				proxyCalls++;
				return target[key];
			},
		},
	);
	ok("proxy fallback", sum(4) === 20 && proxyCalls === 4);

	state = { y: 0, x: 6 };
	ok("different-shape fallback", sum(4) === 24);
};

exercise(false);
exercise(true);
console.log("captured-known-own-slot PASS");
