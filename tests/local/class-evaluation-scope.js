"use strict";

function check(value, name) {
	if (!value) throw new Error(name);
}

function privateBrands() {
	const classes = [];
	for (var index = 0; index < 2; index++)
		classes.push(
			class {
				#value = 7;
				static has(value) {
					return #value in value;
				}
				read() {
					return this.#value;
				}
			},
		);
	const instances = classes.map((Class) => new Class());
	for (var owner = 0; owner < classes.length; owner++)
		for (var instance = 0; instance < instances.length; instance++)
			check(
				classes[owner].has(instances[instance]) === (owner === instance),
				"private brand identity",
			);
	check(
		instances[0].read() === 7 && instances[1].read() === 7,
		"retained private fields",
	);
}

function namedPrivateMembers() {
	const classes = [];
	for (var index = 0; index < 2; index++)
		classes.push(
			class Named {
				#field = 13;
				#method() {
					return Named;
				}
				get #accessor() {
					return Named;
				}
				read() {
					return [this.#method(), this.#accessor, eval("Named"), eval("this.#field")];
				}
			},
		);
	for (var index = 0; index < classes.length; index++) {
		const values = new classes[index]().read();
		check(
			values.slice(0, 3).every((value) => value === classes[index]),
			"named class identity",
		);
		check(values[3] === 13, "private environment in eval");
	}
}

function heritageAndHomes() {
	class First {
		value() {
			return 1;
		}
		static value() {
			return 10;
		}
	}
	class Second {
		value() {
			return 2;
		}
		static value() {
			return 20;
		}
	}
	const bases = [First, Second],
		classes = [];
	for (var index = 0; index < bases.length; index++)
		classes.push(
			class extends bases[index] {
				value() {
					return super.value();
				}
				static value() {
					return super.value();
				}
			},
		);
	check(
		new classes[0]().value() === 1 && new classes[1]().value() === 2,
		"instance home identity",
	);
	check(classes[0].value() === 10 && classes[1].value() === 20, "static home identity");
	Object.setPrototypeOf(classes[0].prototype, {
		value() {
			return 3;
		},
	});
	Object.setPrototypeOf(classes[0], Second);
	check(
		new classes[0]().value() === 3 && classes[0].value() === 20,
		"mutable home prototype",
	);
}

function computedFields() {
	const classes = [];
	for (var index = 0; index < 2; index++)
		classes.push(
			class {
				["field" + index] = 9;
			},
		);
	check(Object.keys(new classes[0]()).join() === "field0", "first computed field");
	check(Object.keys(new classes[1]()).join() === "field1", "second computed field");
}

function throwingDefinitions() {
	class Base {}
	for (var phase = 0; phase < 3; phase++) {
		const retained = [];
		function step(at) {
			if (phase === at) throw new Error("definition");
			return Base;
		}
		for (let index = 0; index < 2; index++) {
			retained.push(() => index);
			try {
				class Definition extends step(0) {
					[step(1)]() {}
					static {
						step(2);
					}
				}
				throw new Error("missing definition failure");
			} catch (error) {
				check(error.message === "definition", "definition failure identity");
			}
		}
		check(
			retained[0]() === 0 && retained[1]() === 1,
			"environment after definition failure",
		);
	}
}

function suspendedDefinition() {
	function* pending() {
		const seen = [];
		for (let index = 0; index < 2; index++) {
			try {
				const Class = class Named {
					[yield index]() {}
					self() {
						return Named;
					}
				};
				check(new Class().self() === Class, "resumed class identity");
				seen.push("made:" + index);
			} finally {
				seen.push("finally:" + index);
				if (index === 0) continue;
			}
		}
		return seen;
	}
	const iterator = pending();
	check(iterator.next().value === 0, "first class suspension");
	const overridden = iterator.return("stop");
	check(!overridden.done && overridden.value === 1, "finally overrides suspended return");
	const completed = iterator.next("method");
	check(
		completed.done && completed.value.join() === "finally:0,made:1,finally:1",
		"scope after suspended return",
	);
}

function nestedPrivateEnvironment() {
	const classes = [];
	for (var index = 0; index < 2; index++)
		classes.push(
			class {
				#value = 17;
				inner() {
					return class {
						read(value) {
							return value.#value;
						}
					};
				}
			},
		);
	const first = new classes[0](),
		second = new classes[1]();
	const Reader = first.inner();
	check(new Reader().read(first) === 17, "outer private environment");
	try {
		new Reader().read(second);
		throw new Error("cross-class private access accepted");
	} catch (error) {
		check(error instanceof TypeError, "nested private brand identity");
	}
}

function throwingIteratorClose() {
	const sentinel = {};
	const iterable = {
		[Symbol.iterator]() {
			return {
				next() {
					return { value: 1, done: false };
				},
				return() {
					throw sentinel;
				},
			};
		},
	};
	function* pending() {
		const seen = [];
		for (let index = 0; index < 2; index++) {
			const saved = () => index;
			try {
				for (const value of iterable) {
					const Class = class {
						#field = 1;
						[yield index]() {}
						read() {
							return this.#field;
						}
					};
					check(new Class().read() === value, "completed iterator class");
				}
			} catch (error) {
				check(error === sentinel, "iterator close failure identity");
				seen.push(saved());
			}
		}
		return seen;
	}
	const iterator = pending();
	check(iterator.next().value === 0, "iterator class suspension");
	const resumed = iterator.return("stop");
	check(
		!resumed.done && resumed.value === 1,
		"environment after throwing iterator close",
	);
	const completed = iterator.return("stop");
	check(
		completed.done && completed.value.join() === "0,1",
		"retained loop environment after iterator close",
	);
}

async function awaitedDefinition() {
	const classes = [],
		retained = [];
	for (let index = 0; index < 2; index++) {
		retained.push(() => index);
		try {
			class Rejected extends (await Promise.reject("heritage")) {}
			throw new Error("missing awaited heritage failure");
		} catch (error) {
			check(error === "heritage", "awaited heritage failure");
		}
		classes.push(
			class Named {
				#value = 23;
				[await Promise.resolve("field" + index)] = 29;
				self() {
					return Named;
				}
				read() {
					return this.#value;
				}
			},
		);
	}
	check(
		retained[0]() === 0 && retained[1]() === 1,
		"environment after awaited class evaluation",
	);
	for (let index = 0; index < classes.length; index++) {
		const instance = new classes[index]();
		check(
			instance.self() === classes[index] && instance.read() === 23,
			"awaited class identity",
		);
		check(Object.keys(instance).join() === "field" + index, "awaited computed field");
	}
}

privateBrands();
namedPrivateMembers();
heritageAndHomes();
computedFields();
throwingDefinitions();
suspendedDefinition();
nestedPrivateEnvironment();
throwingIteratorClose();
awaitedDefinition().then(() => console.log("class evaluation state preserved"));
