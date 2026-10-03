import { execFileSync, spawn } from "node:child_process";

const selfTerminate = ["-c", "kill -TERM $$; exit 3"];

function syncSelfTerminate() {
	try {
		execFileSync("/bin/sh", selfTerminate, { stdio: "ignore" });
		return { status: 0, signal: null };
	} catch (error) {
		return { status: error.status, signal: error.signal };
	}
}

function exitOf(child) {
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (status, signal) => resolve({ status, signal }));
	});
}

// The SIGTERM can reach the child before it execs; it must still terminate it.
function killBeforeSpawnEvent() {
	const child = spawn("/bin/sh", ["-c", "exec sleep 5"], { stdio: "ignore" });
	const exited = exitOf(child);
	child.kill("SIGTERM");
	return exited;
}

function unreadInputSurvives() {
	try {
		execFileSync("/bin/sh", ["-c", "exit 0"], {
			input: "x".repeat(1 << 20),
			stdio: ["pipe", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

export async function childSignalOutcomes() {
	return {
		sync: syncSelfTerminate(),
		async: await exitOf(spawn("/bin/sh", selfTerminate, { stdio: "ignore" })),
		killed: await killBeforeSpawnEvent(),
		unreadInput: unreadInputSurvives(),
	};
}

export const expectedOutcomes = JSON.stringify({
	sync: { status: null, signal: "SIGTERM" },
	async: { status: null, signal: "SIGTERM" },
	killed: { status: null, signal: "SIGTERM" },
	unreadInput: true,
});
