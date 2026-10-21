// Class-member sites guard on shared per-class layouts. Every way an instance or its
// prototype chain can stop matching the admitted layout must reach the ordinary path.
class Shape {
	#id;
	kind = "shape";
	constructor(id, size) {
		this.#id = id;
		this.size = size;
	}
	id() {
		return this.#id;
	}
	area() {
		return this.size * this.size;
	}
	grow(by) {
		this.size += by;
		return this;
	}
	describe() {
		return `${this.kind}#${this.#id}:${this.area()}`;
	}
}

class Circle extends Shape {
	#radius;
	constructor(id, radius) {
		super(id, radius * 2);
		this.#radius = radius;
		this.kind = "circle";
	}
	area() {
		return Math.round(Math.PI * this.#radius * this.#radius);
	}
	radius() {
		return this.#radius;
	}
}

function measure(shapes) {
	let total = 0;
	for (const shape of shapes) total += shape.area() + shape.id() + shape.size;
	return total;
}

function describeAll(shapes) {
	return shapes.map((shape) => shape.describe()).join(",");
}

const results = [];
const shapes = [];
for (let index = 0; index < 64; index++)
	shapes.push(
		index % 3 === 0 ? new Circle(index, index % 5) : new Shape(index, index % 7),
	);
for (let round = 0; round < 50; round++) measure(shapes);
results.push(["warm", measure(shapes), describeAll(shapes.slice(0, 4))]);

// An own method shadows the prototype's.
const shadowed = new Shape(1000, 3);
shadowed.area = () => -1;
results.push(["own-method", measure([shadowed, ...shapes.slice(0, 3)])]);

// A dictionary-mode instance keeps its leading slots but may own any name.
const wide = new Shape(1001, 4);
for (let index = 0; index < 200; index++) wide[`extra${index}`] = index;
wide.describe = () => "wide";
results.push(["overflow", measure([wide]), describeAll([wide])]);

// Another prototype under an identical instance shape.
const foreign = new Shape(1002, 5);
Object.setPrototypeOf(foreign, {
	area() {
		return 7;
	},
	id() {
		return 8;
	},
	describe() {
		return "foreign";
	},
});
results.push(["set-prototype", measure([foreign]), describeAll([foreign])]);

// Frozen and non-writable fields change the shape that stores guard on.
const frozen = Object.freeze(new Shape(1003, 6));
try {
	frozen.grow(1);
	results.push(["frozen", "no throw"]);
} catch (error) {
	results.push(["frozen", error.constructor.name, frozen.size]);
}
const pinned = new Shape(1004, 2);
Object.defineProperty(pinned, "size", { writable: false });
try {
	pinned.grow(1);
	results.push(["read-only", "no throw"]);
} catch (error) {
	results.push(["read-only", error.constructor.name, pinned.size]);
}

// Replacing a prototype method after admission.
const original = Shape.prototype.area;
Shape.prototype.area = function () {
	return 1;
};
results.push(["prototype-method", measure(shapes)]);
Shape.prototype.area = original;
results.push(["restored", measure(shapes)]);

// A method inserted between an instance and the class prototype.
Object.defineProperty(Circle.prototype, "id", {
	value() {
		return -2;
	},
	configurable: true,
	writable: true,
});
results.push(["intermediate", measure(shapes)]);
delete Circle.prototype.id;
results.push(["intermediate-removed", measure(shapes)]);

// Re-evaluated classes carry fresh private names and prototypes.
function makeCounter() {
	return class Counter {
		#count = 0;
		step() {
			this.#count++;
			return this.#count;
		}
	};
}
const First = makeCounter();
const Second = makeCounter();
const first = new First();
const second = new Second();
let counted = 0;
for (let index = 0; index < 20; index++) counted += first.step() + second.step();
try {
	First.prototype.step.call(second);
	results.push(["brand", "no throw"]);
} catch (error) {
	results.push(["brand", error.constructor.name, counted]);
}

// Same keys from an object literal with an unrelated prototype.
const literal = { kind: "literal", size: 9 };
results.push(["literal", literal.kind, literal.size, "area" in literal]);

console.log(JSON.stringify(results));
