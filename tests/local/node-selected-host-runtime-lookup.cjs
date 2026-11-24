const { release } = require("node:os");
const path = require("node:path");
const load = process[process.env.MAL_HOST_LOADER_KEY];

console.log(
	typeof release(),
	typeof load("node:os"),
	typeof load("os"),
	load("node:path") === path,
);
