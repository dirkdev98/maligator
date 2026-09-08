import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export function writePrimordialInventoryDriver(outDir: string): string {
	const header = readFileSync("runtime/src/intrinsics.h", "utf8");
	const enumeration = header
		.split("typedef enum MalIntrinsic {")[1]
		?.split("} MalIntrinsic;")[0];
	if (enumeration === undefined) throw new Error("Missing intrinsic enum");
	const roots = enumeration.split("\n").flatMap((line) => {
		if (/^#(?:if|elif|else|endif)/.test(line)) return [line];
		const name = /^\s*(MAL_INTRINSIC_\w+)(?:\s*=\s*[^,]+)?,/.exec(line)?.[1];
		return name === undefined || name === "MAL_INTRINSIC_COUNT"
			? []
			: [`{ "${name}", ${name} },`];
	});
	const driver = path.join(outDir, "primordial-inventory.c");
	const hostMain = readFileSync("runtime/host_main.c", "utf8");
	const start = hostMain.indexOf("    mal_host_attach(&vm);");
	const end = hostMain.indexOf("    mal_vm_run_host_installs(&vm, &launch);");
	if (start < 0 || end < start) throw new Error("Missing host initialization boundary");
	const hostInstalls = hostMain.slice(
		start,
		end + "    mal_vm_run_host_installs(&vm, &launch);".length,
	);
	writeFileSync(
		driver,
		readFileSync("runtime/primordial_inventory_test_main.c", "utf8")
			.replace("    MAL_INVENTORY_ROOTS", roots.join("\n"))
			.replace("    MAL_INVENTORY_HOST_INSTALLS", hostInstalls),
	);
	return driver;
}
