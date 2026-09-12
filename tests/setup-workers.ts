import { workerBudget, workerCount, workerEnvironment } from "../src/worker-budget.ts";

const budget = workerBudget(process.env.MALIGATOR_WORKERS);
const testWorkers = workerCount(
	process.env.MAL_TEST_WORKERS,
	"MAL_TEST_WORKERS",
	budget,
	budget,
);
Object.assign(
	process.env,
	workerEnvironment(Math.max(1, Math.floor(budget / testWorkers))),
);
