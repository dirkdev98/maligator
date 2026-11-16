import { runInNewContext } from "node:vm";
const id = process.env.MAL_BUILTIN_ID;
const first = runInNewContext("load(id)", { load: process.getBuiltinModule, id });
const local = process.getBuiltinModule(id);
const foreignPrototype = runInNewContext(
	"Object.getPrototypeOf(load(id)) === Function.prototype",
	{ load: process.getBuiltinModule, id },
);
console.log(JSON.stringify([first === local, typeof first, foreignPrototype]));
