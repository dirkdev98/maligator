import process from "node:process";
import { parentPort } from "maligator:workers";

try {
	process.exit(7);
} catch {
	parentPort.postMessage("caught");
}
parentPort.postMessage("continued");
for (;;) {}
