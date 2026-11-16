# Coal Garden

A pixel-art mine with autonomous Qwen agents on Cloudflare Workers and Durable Objects.

Each miner has a Pi Durable session, transcript, and durable work state. One Mine Durable Object owns the shared world.

## How it works

* Qwen chooses among four tools: `discover`, `walk_to`, `mine`, and `talk`.
* Miners share discoveries and coordinate through messages.
* Miners can share paths. Each extraction action holds an exclusive resource claim.
* The world contains coal and diamonds. Miners carry resources to a hopper.
* React controls and a Canvas renderer show the world, crew, public tool traces, and metrics.
* Durable alarms complete physical actions. Browser connections do not drive the simulation.
* Single-use inference grants enforce request limits, concurrency, and a fixed $5 inference allowance per run.

The selected model is `@cf/qwen/qwen3.8-27b`. Reasoning is disabled. Each request has a 1,024-token output cap. The live provider has no model fallback.

The inference allowance excludes Worker, Durable Object, storage, network, and other platform charges. It does not limit an account invoice.

## Source-only publication

This repository intentionally excludes configuration files, credentials, account identifiers, deployment addresses, operational records, screenshots, and recordings.

Build, TypeScript, test, and Wrangler configuration files are not included. Supply your own local configuration before you use the package scripts. The scripts retain their original command names; this snapshot is not a complete deployment package.

Use Node.js 22.19 or later and npm. `package.json` and `package-lock.json` preserve the dependency versions. `npm ci` installs these dependencies.

A complete local configuration needs:

* A React/Vite client with output at `dist/client` and an `/api` proxy with WebSocket support.
* A TypeScript configuration for React and Cloudflare Workers.
* A Vitest Workers pool that uses `src/testing/test-worker.ts`.
* A Worker entrypoint at `src/worker/index.ts`, an `ASSETS` binding, and a Workers AI binding named `AI`.
* SQLite Durable Object bindings named `MINES` and `MINERS`, with classes `Mine` and `Miner`.
* Your own deployment account, routes, authentication, and access policies.

Keep your local configuration outside Git. The ignore rules exclude common configuration and secret files.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/worker/` | HTTP routing, authoritative world, durable miners, tools, and guarded inference |
| `src/shared/` | Protocols and world rules |
| `src/client/` | Operator interface, world renderer, and state store |
| `src/testing/` | Local synthetic provider and Workers test entrypoint |
| `test/` | Domain, admission, durability, HTTP, and viewer regressions |
| `scripts/` | Finite smoke and scale runners |
| `public/` | Original sprite atlases and bundled fonts |

The synthetic provider is for local tests and benchmarks only. It makes no model requests. Do not deploy that entrypoint as the live application.

No benchmark records are published here. Source code and synthetic tests do not establish production scale.

## References

* [PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/)
* [Cloudflare Pi AI provider](https://developers.cloudflare.com/agents/models/pi-ai/)
* [Qwen 3.8 27B](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)
* [Durable Objects](https://developers.cloudflare.com/durable-objects/)

The bundled IBM Plex fonts include their upstream license in `public/fonts/OFL.txt`.
