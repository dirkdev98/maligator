const originalNumber = Number;
const originalMath = Math;
const originalGlobal = globalThis;
let effects = 0;
function effect() {
	effects++;
	return 123;
}
for (const [name, attempt, expectedEffects] of [
	[
		"assignment",
		() => {
			Math = effect();
		},
		1,
	],
	[
		"compound assignment",
		() => {
			Math += effect();
		},
		1,
	],
	[
		"logical assignment",
		() => {
			Math &&= effect();
		},
		1,
	],
	[
		"postfix update",
		() => {
			Number++;
		},
		0,
	],
	[
		"prefix update",
		() => {
			++Number;
		},
		0,
	],
	[
		"destructuring",
		() => {
			[Number] = [effect()];
		},
		1,
	],
	[
		"globalThis assignment",
		() => {
			globalThis = effect();
		},
		1,
	],
]) {
	effects = 0;
	let caught;
	try {
		attempt();
	} catch (error) {
		caught = error;
	}
	if (!(caught instanceof TypeError)) throw new Error(name + " must throw TypeError");
	if (effects !== expectedEffects) throw new Error(name + " must retain RHS effects");
	if (Number !== originalNumber || Math !== originalMath || globalThis !== originalGlobal)
		throw new Error(name + " changed a locked global");
}
console.log("locked global bindings passed");
