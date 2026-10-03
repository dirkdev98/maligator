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
	writeFileSync(
		driver,
		readFileSync("runtime/primordial_inventory_test_main.c", "utf8").replace(
			"    MAL_INVENTORY_ROOTS",
			roots.join("\n"),
		),
	);
	return driver;
}
