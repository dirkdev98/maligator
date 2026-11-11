"use strict";

class Base {
	constructor(x) {
		this.x = x;
	}
}

class Derived extends Base {
	constructor(x) {
		super(x);
		this.y = x + 1;
		this.z = x + 2;
	}
}

class Implicit extends Derived {}

class Replacement {
	constructor(x) {
		this.replaced = x;
	}
}

let sum = 0;
for (let i = 0; i < 4000; i++) {
	const value = (i & 1) === 0 ? new Derived(i) : new Implicit(i);
	sum += value.x + value.y + value.z;
}

// super() constructs the class's current prototype, not the heritage it was defined with.
Object.setPrototypeOf(Derived, Replacement);
const swapped = new Derived(7);
const inherited = new Implicit(9);
let rejected = false;
Object.setPrototypeOf(Derived, Math.max);
try {
	new Derived(1);
} catch (error) {
	rejected = error instanceof TypeError;
}

const expected = 24_006_000;
const ok =
	sum === expected &&
	swapped.replaced === 7 &&
	swapped.x === undefined &&
	swapped.y === 8 &&
	inherited.replaced === 9 &&
	rejected;
console.log(ok ? "derived-instance-slots PASS" : `derived-instance-slots FAIL ${sum}`);
