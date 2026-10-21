class Shape {
	area() {
		return 0;
	}
}
class Square extends Shape {
	constructor(side) {
		super();
		this.side = side;
	}
	area() {
		return this.side * this.side;
	}
}
class Strip extends Shape {
	constructor(length) {
		super();
		this.length = length;
	}
	area() {
		return this.length;
	}
}
class Plain extends Shape {}

function total(shapes) {
	let sum = 0;
	for (let index = 0; index < shapes.length; index++) sum += shapes[index].area();
	return sum;
}

const shapes = [new Square(3), new Strip(4), new Plain(), new Square(2)];
console.log(total(shapes));
const overridden = new Square(5);
overridden.area = () => 100;
shapes.push(overridden);
console.log(total(shapes));
Strip.prototype.area = function () {
	return -this.length;
};
console.log(total(shapes));

class Tree {
	constructor(left, right) {
		this.left = left;
		this.right = right;
	}
	size() {
		const left = this.left === null ? 0 : this.left.size();
		return 1 + left + (this.right === null ? 0 : this.right.size());
	}
}
class Counted extends Tree {
	size() {
		return 10 + super.size();
	}
}
const tree = new Tree(new Tree(null, null), new Counted(new Tree(null, null), null));
console.log(tree.size());
tree.left.size = () => 1000;
console.log(tree.size());

class Base {
	get kind() {
		return "base";
	}
}
class Derived extends Base {
	get kind() {
		return "derived";
	}
}
let kinds = "";
for (const value of [new Base(), new Derived(), new Base()]) kinds += value.kind + ",";
console.log(kinds);
