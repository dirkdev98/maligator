function assert(value, message) {
	if (!value) throw new Error(message);
}
function collect() {
	return Array.prototype.slice.call(arguments);
}
function gc() {
	if (typeof globalThis.__mal_collect_garbage === "function")
		globalThis.__mal_collect_garbage();
}
let mutate;
function sink() {
	if (mutate) mutate();
	gc();
	return collect.apply(null, arguments);
}
function mapped(first, second) {
	first = { value: 10 };
	second = 20;
	mutate = () => {
		first = 90;
		second = 91;
	};
	const values = sink(...arguments);
	return [values, first, second];
}
const snapshot = mapped(1, 2, { extra: 3 });
assert(
	snapshot[0][0].value === 10 && snapshot[0][1] === 20 && snapshot[0][2].extra === 3,
	"mapped values are snapshotted before callee reentry",
);
assert(snapshot[1] === 90 && snapshot[2] === 91, "owning cells remain live");
mutate = undefined;
function duplicate(value, value) {
	value = 8;
	return sink(...arguments);
}
assert(duplicate(1, 2, 3).join() === "1,8,3", "last duplicate formal owns the map");
assert(duplicate(1).join() === "1", "unpassed duplicate does not map an earlier index");
function missing(first, second) {
	first = 4;
	second = 5;
	return sink(...arguments);
}
assert(missing(1).join() === "4", "actual count excludes absent formals");
console.log("mapped snapshots, duplicates and incoming extras");

function Record(...values) {
	this.values = values;
	this.target = new.target;
}
function construct(C, prefix, ...tail) {
	return new C(prefix, ...tail);
}
const Bound = Record.bind(null, 6);
const object = construct(Bound, { retained: 7 }, 8, 9);
assert(
	object instanceof Record && object.target === Record,
	"forwarded bound constructor identity",
);
assert(
	object.values[0] === 6 &&
		object.values[1].retained === 7 &&
		object.values.slice(2).join() === "8,9",
	"forwarded constructor prefix and rest values",
);
function mappedConstruct(first) {
	first = { retained: 11 };
	return new Record(...arguments);
}
assert(
	mappedConstruct(1, 2).values[0].retained === 11,
	"construction snapshots current mapped cells",
);
console.log("rest and mapped construction");

if (process.env.FORWARDING_POLICY !== "locked") {
	const originalApply = collect.apply;
	let exposed;
	let calls = 0;
	collect.apply = function (receiver, list) {
		assert(list.callee === repeated, "fallback keeps the owning callee");
		if (calls++ === 0) {
			exposed = list;
			list[0] = 9;
		} else {
			assert(
				list === exposed && list[0] === 8,
				"fallback reuses identity and current cells",
			);
			delete list[0];
			collect.apply = originalApply;
		}
		gc();
		return originalApply.call(collect, receiver, list);
	};
	function repeated(value) {
		const first = collect.apply(null, arguments);
		assert(value === 9, "fallback writes alias the parameter");
		value = 8;
		const second = collect.apply(null, arguments);
		value = 12;
		const third = collect.apply(null, arguments);
		return [first, second, third];
	}
	const fallback = repeated(1, 2);
	assert(
		fallback[0].join() === "9,2" &&
			fallback[1].join() === ",2" &&
			fallback[2].join() === ",2",
		"unmapped deletion stays authoritative after apply recovers",
	);
	collect.apply = function (receiver, list) {
		assert(list.callee === zeroFormals, "zero-formal fallback keeps its callee");
		return originalApply.call(collect, receiver, list);
	};
	function zeroFormals() {
		return collect.apply(null, arguments);
	}
	assert(zeroFormals(3, 4).join() === "3,4", "zero-formal incoming extras");
	collect.apply = function (receiver, list) {
		let threw = false;
		try {
			list.callee;
		} catch (error) {
			threw = error instanceof TypeError;
		}
		assert(threw, "unmapped fallback has a throwing callee accessor");
		return originalApply.call(collect, receiver, list);
	};
	function strictForward() {
		"use strict";
		return collect.apply(null, arguments);
	}
	function nonsimpleForward(...unused) {
		return collect.apply(null, arguments);
	}
	assert(
		strictForward(5).join() === "5" && nonsimpleForward(6).join() === "6",
		"unmapped fallback values",
	);
	collect.apply = originalApply;

	const originalIterator = Array.prototype[Symbol.iterator];
	let retained;
	let constructions = 0;
	Array.prototype[Symbol.iterator] = function () {
		retained = this;
		return originalIterator.call(this);
	};
	function Change(first) {
		this.first = first;
		if (constructions++ === 0) {
			retained[0] = 44;
			Array.prototype[Symbol.iterator] = originalIterator;
		}
	}
	function twice(C, ...tail) {
		return [new C(...tail), new C(...tail)];
	}
	const pair = twice(Change, 1);
	assert(
		pair[0].first === 1 && pair[1].first === 44,
		"constructor fallback remains authoritative after iterator recovery",
	);
	console.log("owning fallback identity, aliasing and protocol recovery");
}

function evalOwner(value) {
	eval("var scope = 1;");
	value = 7;
	return collect(...arguments);
}
assert(evalOwner(1).join() === "7", "eval-prepended environments preserve ownership");
console.log("eval activation ownership");
