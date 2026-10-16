import { primordialInventoryModes } from "../scripts/primordial-inventory-config.ts";
import { describePrimordialInventory } from "./helpers/primordial-inventory-suite.ts";

describePrimordialInventory(
	primordialInventoryModes.filter((mode) => mode.startsWith("intl-")),
);
