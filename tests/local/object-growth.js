const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;

function grow(object, start, end) {
	for (let i = start; i < end; i++) object["field" + i] = { value: i };
}

switch (process.env.OBJECT_GROWTH_CASE) {
	case "fields": {
		const proto = { inherited: 11 };
		const small = { seed: { value: 13 } };
		const wide = { a: 1, b: 2, c: 3, d: 4, seed: { value: 17 } };
		collect();
		for (const object of [small, wide]) {
			grow(object, 0, 10);
			Object.setPrototypeOf(object, proto);
			const key = Symbol("extra");
			Object.defineProperty(object, key, { value: { value: 19 } });
			collect();
			console.log(
				JSON.stringify([
					Object.keys(object),
					object.seed.value,
					object.field0.value,
					object.field9.value,
					object[key].value,
					object.inherited,
				]),
			);
		}
		break;
	}
	case "dictionary": {
		const object = { seed: { value: 13 }, removed: 17 };
		grow(object, 0, 12);
		delete object.removed;
		delete object.field3;
		object.field3 = { value: 23 };
		grow(object, 12, 80);
		delete object.field30;
		Object.defineProperty(object, "computed", {
			enumerable: true,
			get() {
				return this.seed.value + this.field79.value;
			},
		});
		object.field30 = { value: 29 };
		collect();
		console.log(
			JSON.stringify([
				Object.keys(object),
				object.field3.value,
				object.field30.value,
				object.field79.value,
				Object.getOwnPropertyDescriptor(object, "field79"),
				object.computed,
			]),
		);
		break;
	}
	case "churn": {
		const survivors = [];
		let total = 0;
		for (let i = 0; i < 192; i++) {
			const object = { index: i };
			grow(object, 0, 9);
			total += object.field8.value + object.index;
			if (i % 16 === 0) survivors.push(object);
		}
		collect();
		console.log(
			JSON.stringify([
				total,
				survivors.map((record) => [record.index, record.field0.value]),
			]),
		);
		break;
	}
	case "freeze": {
		const object = {};
		grow(object, 0, 9);
		Object.freeze(object);
		collect();
		console.log(
			JSON.stringify([
				Object.isFrozen(object),
				Reflect.set(object, "extra", 17),
				Reflect.set(object, "field8", 19),
				Reflect.deleteProperty(object, "field0"),
				Object.getOwnPropertyDescriptor(object, "field8"),
			]),
		);
		break;
	}
	default:
		throw new Error("Unknown object growth case");
}
