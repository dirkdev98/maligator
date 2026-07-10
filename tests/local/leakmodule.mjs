// Module-namespace leak fixture (the one owned-allocation kind leakaudit.js cannot
// reach — a MalModuleNamespaceObject's malloc'd `exports` array, freed by the
// namespace finalizer at gc.c). Run through the leak lane under MAL_GC_AT_EXIT: the
// teardown forces a final full GC + finalize-all, so a dropped `free(ns->exports)`
// would surface as a leak named MalModuleNamespaceExport / malloc in the grouped
// `leaks` backtrace. `import * as` builds a namespace object per imported module.

import * as ns1 from "./leakmodule_dep.js";
import * as ns2 from "./leakmodule_dep2.js";

// Touch the exports so the namespaces are materialized and their exports arrays are
// live during the run (and so the compiler cannot prove them dead and elide them).
let acc = 0;
for (let i = 0; i < 500; i++) {
	acc += ns1.alpha + ns1.bump() + ns2.sum();
	acc += ns1.table.a + ns2.x;
}

// Reflect over the namespaces' own keys too — the exotic own-key path also reads
// the exports array.
let keys = 0;
for (const k of Object.keys(ns1)) keys += k.length;
for (const k of Object.keys(ns2)) keys += k.length;

console.log("leakmodule-ok acc=" + acc + " keys=" + keys);
