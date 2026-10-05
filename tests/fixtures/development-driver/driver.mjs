import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";

const mode = process.argv[2];
if (mode === "exit") {
	process.stderr.write("EARLY_EXIT_SENTINEL\n", () => {
		process.exit(7);
	});
} else {
	const revisionPath = path.join(process.cwd(), "local.mts");
	let reportedRevision = 0;
	const server = createServer((_request, response) => {
		const revision = Number(
			readFileSync(revisionPath, "utf-8").match(/localRevision\s*=\s*(\d+)/)[1],
		);
		if (revision !== reportedRevision) {
			reportedRevision = revision;
			process.stderr.write("Compiled in 0ms · restarted\n");
		}
		if (mode === "body-hang") {
			response.writeHead(200);
			response.write("0");
		} else response.end(String(mode === "stale" ? 0 : revision));
	});
	process.on("SIGTERM", () => {
		if (mode === "ignore-term") {
			process.stderr.write("IGNORED_SIGTERM\n");
			return;
		}
		server.closeAllConnections();
		server.close(() => {
			process.stdout.write("FINAL_STDOUT\n", () => {
				process.stderr.write("FINAL_STDERR\n", () => {
					process.exit(0);
				});
			});
		});
	});
	server.listen(0, "127.0.0.1", () => {
		process.stdout.write(`DX_HTTP_PORT ${server.address().port}\n`);
	});
}
