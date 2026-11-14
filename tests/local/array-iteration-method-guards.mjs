import vm from "node:vm";
function forEachSite(values) {
	const visits = [];
	const result = values.forEach((value, index, array) => {
		visits.push([value, index, array === values]);
		return value > 2;
	});
	return { result, visits };
}
function mapSite(values) {
	const visits = [];
	const result = values.map((value, index, array) => {
		visits.push([value, index, array === values]);
		return value + index;
	});
	return { result, visits };
}
function filterSite(values) {
	const visits = [];
	const result = values.filter((value, index, array) => {
		visits.push([value, index, array === values]);
		return value > 2;
	});
	return { result, visits };
}
function someSite(values) {
	const visits = [];
	const result = values.some((value, index, array) => {
		visits.push([value, index, array === values]);
		return value > 2;
	});
	return { result, visits };
}
function everySite(values) {
	const visits = [];
	const result = values.every((value, index, array) => {
		visits.push([value, index, array === values]);
		return value > 2;
	});
	return { result, visits };
}
function findSite(values) {
	const visits = [];
	const result = values.find((value, index, array) => {
		visits.push([value, index, array === values]);
		return value > 2;
	});
	return { result, visits };
}
function findIndexSite(values) {
	const visits = [];
	const result = values.findIndex((value, index, array) => {
		visits.push([value, index, array === values]);
		return value > 2;
	});
	return { result, visits };
}
function reduceSite(values) {
	const visits = [];
	const result = values.reduce((accumulator, value, index, array) => {
		visits.push([value, index, array === values]);
		return accumulator + value;
	}, 0);
	return { result, visits };
}
const sites = {
	forEach: forEachSite,
	map: mapSite,
	filter: filterSite,
	some: someSite,
	every: everySite,
	find: findSite,
	findIndex: findIndexSite,
	reduce: reduceSite,
};
const scenarios = {};
for (const name of Object.keys(sites)) {
	for (const timing of ["before", "after"]) {
		scenarios[`${name}-${timing}`] = () => {
			const output = [];
			if (timing === "after") output.push(sites[name]([1, 2, 3]));
			Array.prototype[name] = function (callback) {
				if (name === "reduce") callback(7, 9, 0, this);
				else callback(9, 0, this);
				return "replaced";
			};
			output.push(sites[name]([1, 2, 3]));
			return output;
		};
	}
}
scenarios.intact = () => Object.keys(sites).map((name) => sites[name]([1, , 3]));
scenarios.species = () => {
	const effects = [];
	for (const name of ["map", "filter"]) {
		const values = [1, 2, 3];
		values.constructor = {
			get [Symbol.species]() {
				effects.push(`species:${name}`);
				return function Result(length) {
					effects.push(`construct:${length}`);
					this.length = length;
				};
			},
		};
		effects.push(sites[name](values));
	}
	return effects;
};
for (const timing of ["before", "after"]) {
	scenarios[`global-species-${timing}`] = () => {
		const effects = [];
		if (timing === "after") effects.push(mapSite([1, 2, 3]));
		Object.defineProperty(Array, Symbol.species, {
			configurable: true,
			get() {
				effects.push("species");
				return function Result(length) {
					effects.push(`construct:${length}`);
					this.length = length;
				};
			},
		});
		return [mapSite([1, 2, 3]), filterSite([1, 2, 3]), effects];
	};
}
scenarios["foreign-array"] = () => {
	const values = vm.runInNewContext("[1,,3]");
	return Object.keys(sites).map((name) => sites[name](values));
};
scenarios["foreign-method"] = () => {
	const foreign = vm.runInNewContext("Array.prototype");
	const values = [1, 2, 3];
	values.map = foreign.map;
	return mapSite(values);
};
scenarios["foreign-callback"] = () => {
	const callback = vm.runInNewContext("(value,index)=>value+index");
	return [1, 2, 3].map(callback);
};
scenarios.proxy = () => {
	const effects = [];
	const values = new Proxy([1, , 3], {
		get(target, key, receiver) {
			effects.push(`get:${String(key)}`);
			return Reflect.get(target, key, receiver);
		},
		has(target, key) {
			effects.push(`has:${String(key)}`);
			return Reflect.has(target, key);
		},
	});
	const result = Object.keys(sites).map((name) => sites[name](values));
	return [result, effects];
};
scenarios["revoked-proxy"] = () => {
	const { proxy, revoke } = Proxy.revocable([1, 2, 3], {});
	revoke();
	try {
		return mapSite(proxy);
	} catch (error) {
		return error.name;
	}
};
const scenario = process.env.ITERATION_GUARD_CASE ?? "intact";
if (scenario === "list") console.log(Object.keys(scenarios).join("\n"));
else console.log(JSON.stringify(scenarios[scenario]()));
