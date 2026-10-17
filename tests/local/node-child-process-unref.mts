import { spawn } from "node:child_process";
import { statfsSync } from "node:fs";

const [marker, delayMs] = process.argv.slice(2);
const child = spawn(
	"node",
	[
		"-e",
		`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), ${delayMs})`,
	],
	{ detached: true, stdio: "ignore" },
);
child.unref();
const volume = statfsSync(process.cwd());
console.log(
	JSON.stringify({
		pid: child.pid,
		bsize: volume.bsize,
		blocks: volume.blocks,
		files: volume.files,
	}),
);
