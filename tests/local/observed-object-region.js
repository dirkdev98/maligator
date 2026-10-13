const results = [];
const retained = [];
let initializers = 0;
function noise() {
	for (let index = 0; index < 12; index++) results.push(("noise" + index).length);
	if (typeof gc === "function") gc();
}
function snapshot(value, observe, again, escape) {
	const object = {
		start: (initializers++, +value),
		end: +value + 7,
		flag: true,
		label: "span",
	};
	const alias = object;
	if (observe) observe(object, alias);
	object.end = object.end + 2;
	if (again) again(alias, object);
	const result = [object.start, alias.end, object.flag, object.label];
	if (escape) return object;
	return result;
}
function mutate(first, second) {
	results.push(first === second);
	retained.push(first);
	first.start = "changed";
	Object.defineProperty(first, "end", {
		get() {
			results.push("get");
			return 13;
		},
		set(value) {
			results.push("set:" + value);
		},
		configurable: true,
	});
	first.flag = false;
	first.label = { value: "payload" };
	noise();
}
function observeAgain(first, second) {
	results.push(first === second, first === retained[retained.length - 1]);
	first.label = "twice";
	noise();
}
for (let index = 0; index < 10; index++) {
	results.push(
		snapshot(
			index,
			index % 3 === 0 ? mutate : null,
			index % 3 === 0 ? observeAgain : null,
			false,
		),
	);
}
const returned = snapshot(40, mutate, observeAgain, true);
results.push(
	returned === retained[retained.length - 1],
	returned.start,
	returned.end,
	returned.label,
);
function throwAfterRetention(object) {
	retained.push(object);
	noise();
	throw "observed";
}
try {
	snapshot(50, throwAfterRetention, null, false);
} catch (error) {
	results.push(error, retained[retained.length - 1].start);
}
function repeated(observer) {
	const object = { x: 1, y: 2 };
	for (let index = 0; index < 3; index++) observer(object);
	return object.x + object.y;
}
results.push(
	repeated((object) => {
		retained.push(object);
		object.x++;
	}),
);
results.push(retained[retained.length - 1] === retained[retained.length - 2]);
function loop(observer) {
	let total = 0;
	for (let index = 0; index < 20; index++) {
		const object = { x: index, y: index + 1 };
		if (index % 4 === 0) observer(object);
		total += object.x + object.y;
	}
	return total;
}
results.push(
	loop((object) => {
		retained.push(object);
		object.x += 10;
	}),
);
for (let index = retained.length - 5; index < retained.length; index++)
	results.push(retained[index].x);
results.push(initializers);
function mixed(input, choose, observer) {
	const object = choose ? { start: 1, end: 4 } : input;
	if (observer) observer(object);
	object.end = object.end + 2;
	return [object.start, object.end];
}
for (const choose of [false, true]) {
	results.push(mixed({ start: "fallback", end: 10 }, choose, null));
	results.push(
		mixed({ start: "fallback", end: 10 }, choose, (object) => {
			object.start = "trace";
			object.end = 20;
		}),
	);
}
const proxied = new Proxy(
	{ start: 100, end: 200 },
	{
		get(target, key) {
			results.push("proxy-get:" + key);
			return target[key];
		},
		set(target, key, value) {
			results.push("proxy-set:" + key);
			target[key] = value;
			return true;
		},
	},
);
results.push(
	mixed(proxied, false, (object) => {
		object.end += 1;
	}),
);
function mixedLoop(fallback, observer) {
	let sum = 0;
	for (let index = 0; index < 12; index++) {
		const object = index % 2 ? { start: index, end: index + 3 } : fallback;
		if (index % 3 === 0) observer(object);
		sum += object.end - object.start;
	}
	return sum;
}
results.push(
	mixedLoop({ start: 20, end: 25 }, (object) => {
		retained.push(object);
		object.end++;
	}),
);
results.push(retained.slice(-4).map((object) => [object.start, object.end]));
console.log(JSON.stringify(results));
