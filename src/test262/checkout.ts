import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";

export function test262Checkout() {
	if (existsSync(path.join(TEST262_METADATA.path, ".git"))) {
		if (Math.random() < 0.1) {
			test262Log("Updating repository...");
			execSync(`git fetch origin`, {
				cwd: TEST262_METADATA.path,
				stdio: "ignore",
			});
		} else {
			test262Log("Assuming up to date repository...");
		}
	} else {
		test262Log("Cloning repository...");
		execSync(
			`git clone https://github.com/${TEST262_METADATA.repository} ${TEST262_METADATA.path}`,
			{ stdio: "ignore" },
		);
	}

	test262Log(`Checkout revision: ${TEST262_METADATA.sha}.`);
	execSync(`git checkout ${TEST262_METADATA.sha}`, {
		cwd: TEST262_METADATA.path,
		stdio: "ignore",
	});
}
