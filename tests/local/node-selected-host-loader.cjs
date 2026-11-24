const { release } = require("node:os");
const { getBuiltinModule: load } = process;
const os = load("node:os");

console.log(release === os.release, typeof os.cpus);
