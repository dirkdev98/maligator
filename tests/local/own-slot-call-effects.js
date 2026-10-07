function check(actual, expected) {
	if (!Object.is(actual, expected))
		throw new Error(`own-slot call: ${actual} != ${expected}`);
}
const collect = globalThis.__mal_collect_garbage;
function untouched(payload) {
	const write = (o, value) => {
		o.y = value;
	};
	const o = { x: payload, y: 0 };
	const before = o.x;
	write(o, 8);
	if (typeof collect === "function") collect();
	return [before, o.x, o.y];
}
for (const payload of [11, "payload", { alive: true }]) {
	const result = untouched(payload);
	check(result[0], payload);
	check(result[1], payload);
	check(result[2], 8);
}

function aliased(payload) {
	const write = (a, b) => {
		a.y = 1;
		b.x = 2;
	};
	const o = { x: payload, y: 0 };
	write(o, o);
	return o.x;
}
check(aliased(11), 2);

function missing() {
	const write = (o) => {
		o.y = 1;
	};
	const o = { x: 11 };
	write(o);
	return o.x;
}
Object.defineProperty(Object.prototype, "y", {
	set() {
		this.x = 99;
	},
	configurable: true,
});
try {
	check(missing(), 99);
} finally {
	delete Object.prototype.y;
}

function observed(o) {
	const write = (target) => {
		target.y = 1;
	};
	const before = o.x;
	write(o);
	return [before, o.x];
}
let reads = 0;
const accessor = {
	y: 0,
	get x() {
		reads++;
		if (typeof collect === "function") collect();
		return reads;
	},
};
const access = observed(accessor);
check(access[0], 1);
check(access[1], 2);
const target = { x: 11, y: 0 };
const proxy = new Proxy(target, {
	set(object, key, value) {
		object[key] = value;
		object.x = 77;
		return true;
	},
});
const trapped = observed(proxy);
check(trapped[0], 11);
check(trapped[1], 77);

function coercive() {
	const update = (o) => {
		o.y = +o.y;
	};
	const o = {
		x: 11,
		y: {
			valueOf() {
				o.x = 42;
				if (typeof collect === "function") collect();
				return 1;
			},
		},
	};
	update(o);
	return o.x;
}
check(coercive(), 42);

function exceptional(fail) {
	const update = (o, value) => {
		o.y = value;
		if (value) throw value;
	};
	const o = { x: 11, y: 0 };
	try {
		update(o, fail);
	} catch (error) {
		check(error, fail);
	}
	return [o.x, o.y];
}
const token = { marker: "thrown" };
const thrown = exceptional(token);
check(thrown[0], 11);
check(thrown[1], token);
check(exceptional(0)[1], 0);
console.log("own-slot-call-effects PASS");
