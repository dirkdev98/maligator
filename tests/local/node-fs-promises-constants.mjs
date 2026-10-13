import fs from "node:fs";
import promises, { constants } from "node:fs/promises";
const descriptor = Object.getOwnPropertyDescriptor(promises, "constants");
const rows = [
	["identity", constants === fs.constants, promises.constants === constants],
	["descriptor", descriptor.writable, descriptor.enumerable, descriptor.configurable],
];
for (const name of ["F_OK", "R_OK", "W_OK", "X_OK"]) {
	const d = Object.getOwnPropertyDescriptor(constants, name);
	rows.push([name, constants[name], d.writable, d.enumerable, d.configurable]);
}
promises.constants = { F_OK: 99 };
rows.push([
	"replacement",
	constants === fs.constants,
	promises.constants.F_OK,
	process.getBuiltinModule("fs/promises").constants === promises.constants,
]);
console.log(JSON.stringify(rows));
