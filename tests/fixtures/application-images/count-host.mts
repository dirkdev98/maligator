import { readFileSync } from "node:fs";
import process from "node:process";
import type { ApplicationImageDescriptor } from "../../../src/application-images.ts";
import type { FixtureBridge } from "./types.ts";
const bridge = mal as unknown as FixtureBridge;
const descriptor = JSON.parse(
	readFileSync(process.argv[2]!, "utf8"),
) as ApplicationImageDescriptor;
const image = bridge._loadApplicationImage(descriptor);
const application = bridge._launchApplicationImage(image, {
	argv: ["application-host", descriptor.entryPath],
	exitOnResult: true,
});
const exit = await application.closed;
bridge._releaseApplicationImage(image);
if (exit.reason !== "completed" || exit.result !== Number(process.argv[3]))
	throw new Error(`fragment execution failed: ${JSON.stringify(exit)}`);
process.stdout.write("application fragments PASS\n");
