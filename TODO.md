# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point once we compile and run most JS.

- [ ] Let's start with a clean slate.

The first areas of work are going to be:

- Intermediate:
- Rollup everything in an IR per function
  - Start building things like:
    - Debug location tables
    - Constant pools
  - Liveness analysis / register allocation
- Backend:
  - I kinda make decisions for here in the previous parts. So we'll have to build things hand in hand.
  - Lower in to instructions
  - Function metadata
  - Memory Layouts
  - The different tables/pools
  - Compile it.

### You never know ideas

- Erlang/OTP style message passing & cooperative scheduler.
- GUI work
- Deploying to AWS Lambda
- Compile to bare-metal maybe?
