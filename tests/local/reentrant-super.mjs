function parentReentry(evaluated) {
	let again;
	let inner;
	let calls = 0;
	let fields = 0;
	class Base {
		constructor() {
			if (++calls === 1) inner = again();
			this.tag = calls;
		}
	}
	class Derived extends Base {
		field = ++fields;
		constructor() {
			again = evaluated ? () => eval("super()") : () => super();
			super();
		}
	}
	let error = "none";
	try {
		new Derived();
	} catch (caught) {
		error = caught.name;
	}
	return [error, calls, fields, inner instanceof Derived];
}

function iteratorReentry() {
	let again;
	let inner;
	let calls = 0;
	let fields = 0;
	class Base {
		constructor() {
			calls++;
		}
	}
	class Derived extends Base {
		field = ++fields;
		constructor() {
			again = () => super();
			const values = {
				[Symbol.iterator]() {
					return {
						next() {
							inner = again();
							return { done: true };
						},
					};
				},
			};
			super(...values);
		}
	}
	let error = "none";
	try {
		new Derived();
	} catch (caught) {
		error = caught.name;
	}
	return [error, calls, fields, inner instanceof Derived];
}

function abruptParentReentry() {
	let again;
	let inner;
	let calls = 0;
	let caughtMarker = false;
	const marker = {};
	class Base {
		constructor() {
			if (++calls === 1) {
				inner = again();
				throw marker;
			}
		}
	}
	class Derived extends Base {
		constructor() {
			again = () => super();
			try {
				super();
			} catch (caught) {
				caughtMarker = caught === marker;
			}
		}
	}
	const result = new Derived();
	return [caughtMarker, calls, result === inner, result instanceof Derived];
}

console.log(
	JSON.stringify({
		parent: parentReentry(false),
		eval: parentReentry(true),
		iterator: iteratorReentry(),
		abrupt: abruptParentReentry(),
	}),
);
