import { primordialInventoryModes } from "../scripts/primordial-inventory-config.ts";
import { describePrimordialInventory } from "./helpers/primordial-inventory-suite.ts";

// Intl service modes run from primordial-inventory-intl.test.ts so CI can split the matrix.
describePrimordialInventory(
	primordialInventoryModes.filter((mode) => !mode.startsWith("intl-")),
);
