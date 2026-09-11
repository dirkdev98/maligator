import { workerEnvironment } from "../src/worker-budget.ts";

// Each test worker owns one slot; globalSetup retains the parent's preparation allocation.
Object.assign(process.env, workerEnvironment(1));
