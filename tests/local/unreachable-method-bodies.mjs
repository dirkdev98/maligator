class Catalog {
	active() {
		return "available";
	}

	dormant(first, second) {
		return function dormantClosure() {
			return [first, second, "dormant body literal"];
		};
	}

	*dormantGenerator() {
		yield "dormant generator literal";
	}

	async dormantAsync() {
		return "dormant async literal";
	}
}

console.log(Object.getOwnPropertyNames(Catalog.prototype).join(","));
console.log(new Catalog().active());
