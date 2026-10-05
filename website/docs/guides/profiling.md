Run a representative application workload with `--profile` to identify expensive source locations. Profiling compiles a separate production-optimized image and requires the native toolchain.

## Capture one workload

```shell
maligator run src/index.ts --profile -- workload-argument
```

Choose an input that completes and represents the work you want to improve. The command prints capture quality, attribution coverage, CPU findings, charged allocations, and GC pauses. It retains the capture under `.maligator/profiles/<timestamp>-run-<build-id>/`. Set `MALIGATOR_PROFILE_DIRECTORY` when automation needs a fixed parent directory.

Read the quality indicators before ranking hot spots. Lost events, truncated data, and sparse attribution limit what a capture can establish. Charged allocation measures where allocation costs were attributed; it is not a live-heap ownership graph.

## Inspect exact compiler counters

```shell
maligator run src/index.ts --profile=compiler -- workload-argument
```

This mode adds exact source-site execution, fallback, allocation, boxing, and safepoint counts. `compiler.json` carries backend decisions and event counts; `metadata.json` supplies site identities. It is more intrusive than sampling. Do not use its wall time as a production performance measurement.

## Profile tests or a binary

```shell
maligator test sum.test.ts --profile --run "adds values"
maligator build --production --profile --artifact dist/profiled-app
```

Profiled tests retain test selection and reporting, but use an AOT diagnostic path. A profiled build produces a metadata sidecar (`profile.json` in an artifact). Directly launching that binary requires capture settings and matching identity; use the [profile formats and direct-launch instructions](https://github.com/dirkdev98/maligator/blob/main/docs/profiling.md) for that workflow.

Compare ordinary production executions with matched inputs and output checks after making a change. A hot site suggests where to investigate; one capture does not prove an improvement. The [CLI reference](/api/cli#profile) lists flag interactions.
