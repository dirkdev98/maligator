Run JavaScript and erasable TypeScript as a native application. Use the guides to complete a task, or look up a symbol and its defaults in the API reference.

Maligator is experimental. Check [Compatibility](/compatibility) before relying on a Web API, Node module, or language feature.

## Start an application

[Getting started](/guides/getting-started) takes you from installation to a running project. Already have an entry point? [Configure a build](/guides/build-configuration), then use [the development loop](/guides/development).

```shell
npm install --global @maligator/cli@alpha
maligator init
maligator run
```

## Work on your application

- [Use TypeScript](/guides/typescript) to load runtime declarations and check your code.
- [Write application tests](/guides/testing) and rerun a selected suite.
- [Run tasks in workers](/guides/workers) with a bounded pool and explicit cleanup.
- [Serve HTTP](/guides/http) or [embed files](/guides/assets).
- [Build for production](/guides/production) and [profile a workload](/guides/profiling).

## Look up a contract

The [API reference](/api) covers build configuration, runtime globals, public modules, and CLI commands. Each page includes callable signatures, member contracts, and links to the relevant guide.

Read [Troubleshooting](/guides/troubleshooting) when a command fails. To change the compiler itself, follow [Develop Maligator](/guides/contributing).

Every page has a Markdown copy. The [public symbol index](/reference.json) provides direct links, signatures, and availability; [llms.txt](/llms.txt) lists the main entry points.
