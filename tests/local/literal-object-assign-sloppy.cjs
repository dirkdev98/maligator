const target = {};
Object.defineProperty(target, "revision", { value: 3, writable: false });
let error;
try {
	Object.assign(target, { revision: 7 });
} catch (value) {
	error = value.name;
}
console.log(JSON.stringify([error, target.revision]));
