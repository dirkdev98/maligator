// Installed by an entry that attaches no host reactor (the default harness main),
// as runtime-gap kernels are. Reading `process` must not require one.
const ok =
	Array.isArray(process.argv) &&
	process.argv.length >= 2 &&
	process.argv[process.argv.length - 1] === "hostless-argument" &&
	typeof process.env === "object" &&
	typeof process.exit === "function";
console.log(ok ? "PROCESS HOSTLESS PASS" : "PROCESS HOSTLESS FAIL");
