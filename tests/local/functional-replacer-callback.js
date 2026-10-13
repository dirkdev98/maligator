const mode = process.env.REPLACER_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(value, message) {
	if (!value) throw new Error(message);
}
function forwardReplace(subject, search, callback) {
	return subject.replace(search, callback);
}
function forwardAll(subject, search, callbacks, pick) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return subject.replaceAll(search, callback);
}
function forwardRegExp(receiver, subject, callback) {
	return RegExp.prototype[Symbol.replace].call(receiver, subject, callback);
}
globalThis.forwardReplace = forwardReplace;
globalThis.forwardAll = forwardAll;
globalThis.forwardRegExp = forwardRegExp;

function makeReplacers(subject, log) {
	function make(prefix) {
		let calls = 0;
		return function replace(match, offset, source, missing = "default", ...rest) {
			check(this === globalThis, "sloppy replacer this");
			check(
				arguments.length === 3 && missing === "default" && rest.length === 0,
				"string replacer arity",
			);
			check(
				source === subject && typeof match === "string" && typeof offset === "number",
				"string replacer roles",
			);
			calls++;
			log.push(prefix + offset + ":" + calls);
			collectGarbage();
			return {
				toString() {
					log.push("coerce" + offset);
					collectGarbage();
					return prefix + offset;
				},
			};
		};
	}
	return [make("A"), make("B")];
}
function runString() {
	let rope = "";
	for (let index = 0; index < 8; index++) rope += ("part" + index + "x").repeat(8);
	let ropeCalls = 0;
	const ropeResult = globalThis.forwardAll(
		rope,
		"x",
		[
			function ropeReplacement(match, offset, source) {
				check(
					source === rope && match === "x" && source[offset] === "x",
					"rope replacement arguments",
				);
				ropeCalls++;
				collectGarbage();
				return "Y";
			},
		],
		false,
	);
	check(
		ropeCalls === 64 && ropeResult.length === rope.length && !ropeResult.includes("x"),
		"rope match snapshots",
	);
	const subjects = ["x-x-x", "" + "wide😀x".repeat(4), "x\ud800x\udc00", ""];
	const output = [];
	for (const subject of subjects) {
		const log = [];
		const callbacks = makeReplacers(subject, log);
		const first = globalThis.forwardReplace(subject, "x", callbacks[0]);
		const all = globalThis.forwardAll(subject, "x", callbacks, true);
		const empty = globalThis.forwardAll(subject, "", callbacks, false);
		output.push([first, all, empty, log.join("|")]);
	}
	let effects = "";
	const result = globalThis.forwardAll(
		{
			replaceAll: String.prototype.replaceAll,
			toString() {
				effects += "receiver;";
				collectGarbage();
				return "aa";
			},
		},
		{
			toString() {
				effects += "search;";
				return "a";
			},
		},
		[
			function strictReplace(match, offset, source) {
				"use strict";
				check(
					this === undefined && arguments.length === 3 && source === "aa",
					"strict replacer",
				);
				effects += "call" + offset + ";";
				return "$&";
			},
		],
		false,
	);
	check(
		result === "$&$&" && effects === "receiver;search;call0;call1;",
		"coercion order and literal callback result",
	);
	let calls = 0;
	let error;
	try {
		globalThis.forwardAll(
			"aaa",
			"a",
			[
				function symbolResult() {
					calls++;
					return Symbol("replacement");
				},
			],
			false,
		);
	} catch (caught) {
		error = caught;
	}
	check(error instanceof TypeError && calls === 1, "string ToString throw once");
	console.log("string", JSON.stringify(output), effects);
}
function runRegExp() {
	const log = [];
	const subject = "a ab a";
	const pattern = /(?<letter>a)(b)?/g;
	let calls = 0;
	const result = globalThis.forwardAll(
		subject,
		pattern,
		[
			function named(match, letter, optional, offset, source, groups) {
				"use strict";
				check(
					this === undefined && arguments.length === 6 && source === subject,
					"named replacer arguments",
				);
				check(
					groups.letter === letter && Object.getPrototypeOf(groups) === null,
					"named groups",
				);
				log.push([
					match,
					letter,
					optional === undefined ? "missing" : optional,
					offset,
					groups.letter,
				]);
				calls++;
				collectGarbage();
				return {
					toString() {
						collectGarbage();
						return String(offset) + optional;
					},
				};
			},
		],
		false,
	);
	check(calls === 3 && pattern.lastIndex === 0, "global match collection");
	const empty = globalThis.forwardReplace(
		"😀x",
		/(?:)/gu,
		function emptyMatch(match, offset, source) {
			check(
				arguments.length === 3 && match === "" && source === "😀x",
				"empty unicode arguments",
			);
			return "[" + offset + "]";
		},
	);
	check(empty === "[0]😀[2]x[3]", "unicode advance");
	const direct = globalThis.forwardRegExp(
		/(x)?y/g,
		"y xy",
		function captures(match, capture, offset, source) {
			check(arguments.length === 4 && source === "y xy", "capture arity");
			collectGarbage();
			return capture === undefined ? "missing" : capture + offset;
		},
	);
	let conversions = 0;
	const marker = {};
	let caught;
	try {
		globalThis.forwardReplace("aa", /a/g, function throwCoercion() {
			return {
				toString() {
					conversions++;
					collectGarbage();
					throw marker;
				},
			};
		});
	} catch (error) {
		caught = error;
	}
	check(caught === marker && conversions === 1, "regexp ToString throw once");
	console.log("regexp", result, JSON.stringify(log), empty, direct);
}
function runCustom() {
	const log = [];
	const groups = { name: "before" };
	let executions = 0;
	const records = [
		{
			0: "a",
			1: undefined,
			2: {
				toString() {
					log.push("capture");
					collectGarbage();
					return "CAP";
				},
			},
			index: 0,
			length: 3,
			groups,
		},
		{ 0: "b", 1: "before", 2: undefined, index: 1, length: 3, groups: null },
	];
	const receiver = {
		global: true,
		unicode: false,
		lastIndex: 8,
		get flags() {
			log.push("flags");
			return "g";
		},
		exec(subject) {
			check(subject === "ab", "custom exec subject");
			log.push("exec" + executions);
			collectGarbage();
			return records[executions++] ?? null;
		},
	};
	const output = globalThis.forwardRegExp(
		receiver,
		"ab",
		function custom(match, first, second, offset, source, named) {
			check(
				executions === 3 && source === "ab" && arguments.length === 6,
				"eager matches and variable arguments",
			);
			log.push("replace" + offset + ":" + first + ":" + second);
			if (offset === 0) {
				check(
					named === groups && first === undefined && second === "CAP",
					"custom groups identity",
				);
				records[1][1] = "after";
				groups.name = "after";
			} else
				check(
					named === null && first === "after" && second === undefined,
					"live later capture and null group",
				);
			collectGarbage();
			return {
				get [Symbol.toPrimitive]() {
					log.push("get primitive" + offset);
					collectGarbage();
					return () => match.toUpperCase();
				},
			};
		},
	);
	check(output === "AB", "custom exec output");
	const marker = {};
	let beforeCallback = 0;
	let caught;
	try {
		globalThis.forwardRegExp(
			{
				flags: "",
				exec() {
					return {
						get length() {
							collectGarbage();
							throw marker;
						},
					};
				},
			},
			"a",
			function neverInvoked() {
				beforeCallback++;
				return "bad";
			},
		);
	} catch (error) {
		caught = error;
	}
	check(caught === marker && beforeCallback === 0, "result getter throw before callback");
	let supplied;
	const search = {
		[Symbol.replace](subject, callback) {
			supplied = callback;
			return "custom:" + subject;
		},
	};
	const callback = () => {
		throw new Error("custom dispatch invoked replacer");
	};
	check(
		globalThis.forwardReplace("source", search, callback) === "custom:source" &&
			supplied === callback,
		"custom Symbol.replace",
	);
	let groupReads = 0;
	const once = {
		flags: "",
		exec() {
			return {
				0: "a",
				index: 0,
				length: 1,
				get groups() {
					groupReads++;
					return undefined;
				},
			};
		},
	};
	check(
		globalThis.forwardRegExp(once, "a", function noGroups(match, offset, source) {
			check(arguments.length === 3, "undefined groups omitted");
			return source + offset + match;
		}) === "a0a" && groupReads === 1,
		"groups property once",
	);
	console.log("custom", output, log.join("|"));
}
function runOverlap() {
	let step = 0;
	const calls = [];
	const overlap = globalThis.forwardRegExp(
		{
			flags: "g",
			lastIndex: 0,
			exec() {
				return (
					[
						{ 0: "b", index: 1, length: 1 },
						{ 0: "a", index: 0, length: 1 },
					][step++] ?? null
				);
			},
		},
		"ab",
		function outOfOrder(match, offset) {
			calls.push(match + offset);
			collectGarbage();
			return {
				toString() {
					calls.push("coerce" + match + offset);
					collectGarbage();
					return match.toUpperCase();
				},
			};
		},
	);
	check(
		overlap === "aB" && calls.join(",") === "b1,coerceb1,a0,coercea0",
		"overlapping custom matches still invoke and coerce callbacks",
	);
	console.log("overlap", overlap, calls.join(","));
}
function runArity() {
	let outer = 0;
	const callback = function shared(value, index, owner) {
		let offset = index;
		for (let step = 0; step < 2; step++) offset += index;
		if (typeof owner === "object") {
			outer++;
			check(
				globalThis.forwardAll("xx", "x", [shared], false) === "03",
				"matching string context",
			);
			check(
				globalThis.forwardReplace("xx", /(x)/g, shared) === "xxxxxx",
				"matching regexp context",
			);
		} else
			check(
				typeof owner === "string" || typeof owner === "number",
				"actual replacement argument roles",
			);
		collectGarbage();
		return offset;
	};
	[4, 5].forEach(callback);
	check(outer === 2, "outer callback continuation");
	return outer;
}
function runReentry() {
	const arity = runArity();
	let calls = 0;
	const log = [];
	const callback = function growing(match, offset, source) {
		if (calls++ === 0) {
			let program = "return [";
			for (let index = 0; index < 80; index++)
				program += (index ? "," : "") + "function(){return " + index + ";}";
			check(Function(program + "]; ")()[79]() === 79, "function table growth");
			check(
				globalThis.forwardReplace("y", /(y)/, function nested() {
					collectGarbage();
					return "Y";
				}) === "Y",
				"nested regexp context",
			);
		}
		log.push(offset);
		collectGarbage();
		return match.toUpperCase();
	};
	check(
		globalThis.forwardAll("x-x-x", "x", [callback], false) === "X-X-X" &&
			log.join(",") === "0,2,4",
		"growth continuation",
	);
	const marker = {};
	let caught;
	try {
		globalThis.forwardReplace("x", /x/, function throwing() {
			throw marker;
		});
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && globalThis.forwardReplace("x", "x", callback) === "X",
		"throw restores context",
	);
	console.log("reentry", arity, log.join(","));
}
function runFallbacks() {
	function callback(match) {
		return match.toUpperCase();
	}
	let applies = 0;
	const proxy = new Proxy(callback, {
		apply(target, receiver, args) {
			applies++;
			return Reflect.apply(target, receiver, args);
		},
	});
	for (const replace of [
		callback.bind(null),
		proxy,
		String,
		Function("match", "return match.toUpperCase()"),
		async function asynchronous() {
			return "async";
		},
		function* generator() {
			yield "generator";
		},
	]) {
		globalThis.forwardReplace("x", "x", replace);
		globalThis.forwardReplace("x", /x/, replace);
	}
	check(applies === 2, "proxy replacer");
	const revoked = Proxy.revocable(callback, {});
	revoked.revoke();
	for (const replace of [revoked.proxy, class Invalid {}]) {
		let caught;
		try {
			globalThis.forwardReplace("x", /x/, replace);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, "unsupported replacer throw");
	}
	let calls = 0;
	const unused = () => {
		calls++;
		return "bad";
	};
	check(
		globalThis.forwardReplace("source", "missing", unused) === "source",
		"no string match",
	);
	check(
		globalThis.forwardReplace("source", /missing/g, unused) === "source" && calls === 0,
		"no regexp match",
	);
	check(globalThis.forwardReplace("x", "x", "$&") === "x", "nonfunctional substitution");
	console.log("fallbacks", applies);
}
if (mode === "all" || mode === "string") runString();
if (mode === "all" || mode === "regexp") runRegExp();
if (mode === "all" || mode === "custom") runCustom();
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "fallbacks") runFallbacks();
if (mode === "overlap") runOverlap();
if (mode === "arity") console.log("arity", runArity());
