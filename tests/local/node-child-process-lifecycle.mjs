import { spawn } from "node:child_process";

const earlyEof = process.env.MAL_CHILD_STDIO_CASE === "early-eof";
const child = spawn("sh", [
	"-c",
	earlyEof
		? "exec 1>&- 2>&-; sleep 0.03; exit 7"
		: "(sleep 0.03; printf payload) & exit 7",
]);
const events = [];
await new Promise((resolve, reject) => {
	child.on("error", reject);
	child.on("spawn", () => events.push("spawn"));
	child.on("exit", (code) => {
		events.push(`exit ${code}`);
		if (!earlyEof)
			child.stdout.on("data", () => {
				events.push("data");
				child.stdout.destroy();
				child.stderr.destroy();
			});
	});
	child.on("close", (code) => {
		events.push(`close ${code}`);
		resolve();
	});
	if (earlyEof) {
		child.stdout.resume();
		child.stderr.resume();
	}
});
console.log(JSON.stringify(events));
