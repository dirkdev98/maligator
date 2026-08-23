"use strict";

function assert(value, message) {
	if (!value) throw new Error(message);
}

var setterCalls = 0;
class Base {
	get x() {
		return this._x;
	}
	set x(value) {
		setterCalls++;
		this._x = value;
	}
	get tag() {
		return function (strings) {
			return this.name + strings[0];
		};
	}
	method() {
		return this.name;
	}
}

class Derived extends Base {
	read() {
		return super.x;
	}
	call() {
		return super.method();
	}
	compound() {
		return (super.x += 2);
	}
	logical() {
		return (super.x ||= 7);
	}
	update() {
		return super.x++;
	}
	tagged() {
		return super.tag`!`;
	}
	optional() {
		return super.method?.();
	}
	destructure(value) {
		[super.x] = [value];
	}
}

var value = new Derived();
value.name = "derived";
value._x = 3;
assert(value.read() === 3, "getter receiver");
assert(value.call() === "derived", "call receiver");
assert(value.compound() === 5 && value._x === 5, "compound super");
assert(value.update() === 5 && value._x === 6, "update super");
value._x = 0;
assert(value.logical() === 7 && value._x === 7, "logical super");
assert(value.tagged() === "derived!", "tagged super");
assert(value.optional() === "derived", "optional super call");
value.destructure(11);
assert(value._x === 11 && setterCalls === 4, "destructuring super");

var coercions = 0;
var computedKey = {
	toString() {
		coercions++;
		return "x";
	},
};
class Computed extends Base {
	compound(key) {
		return (super[key] += 1);
	}
	logical(key) {
		return (super[key] ||= 8);
	}
	update(key) {
		return super[key]++;
	}
}
var computed = new Computed();
computed._x = 1;
computed.compound(computedKey);
computed.logical(computedKey);
computed.update(computedKey);
assert(coercions === 3 && computed._x === 3, "computed key converted once per RMW");

var nullCoercions = 0;
var nullHome = {
	read(key) {
		return super[key];
	},
};
Object.setPrototypeOf(nullHome, null);
try {
	nullHome.read({
		toString() {
			nullCoercions++;
			return "x";
		},
	});
} catch (error) {
	assert(error instanceof TypeError, "null super base");
}
assert(nullCoercions === 1, "key conversion precedes null super-base failure");

var keyCalls = 0;
class Ordered extends Base {
	constructor() {
		try {
			super[
				(() => {
					keyCalls++;
					return "x";
				})()
			];
		} catch (error) {
			assert(error instanceof ReferenceError, "this checked before computed key");
		}
		super();
	}
}
new Ordered();
assert(keyCalls === 0, "computed key ran before this check");

var directCaught;
class DirectBeforeSuper extends Base {
	constructor() {
		try {
			super.x;
		} catch (error) {
			directCaught = error;
		}
		super();
	}
}
new DirectBeforeSuper();
assert(
	directCaught instanceof ReferenceError,
	"direct super property read checks this inside try",
);

var replacement = {
	get x() {
		return this._x * 10;
	},
	method() {
		return "live:" + this.name;
	},
};
Object.setPrototypeOf(Derived.prototype, replacement);
value._x = 2;
assert(
	value.read() === 20 && value.call() === "live:derived",
	"live instance home object",
);

class StaticBase {
	static get x() {
		return this._x;
	}
}
class StaticDerived extends StaticBase {
	static read() {
		return super.x;
	}
}
StaticDerived._x = 4;
assert(StaticDerived.read() === 4, "static getter receiver");
Object.setPrototypeOf(StaticDerived, {
	get x() {
		return this._x + 1;
	},
});
assert(StaticDerived.read() === 5, "live static home object");

var objectBase = {
	get x() {
		return this._x;
	},
};
var object = {
	_x: 9,
	read() {
		return super.x;
	},
	plain() {},
};
Object.setPrototypeOf(object, objectBase);
assert(object.read() === 9, "object literal getter receiver");
var constructThrew = false;
try {
	new object.plain();
} catch (error) {
	constructThrew = error instanceof TypeError;
}
assert(constructThrew, "object method constructibility");

console.log("class-super PASS");
