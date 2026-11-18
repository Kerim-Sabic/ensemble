# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Build and run

You need Windows 10 or 11, [Node.js](https://nodejs.org) 22 and [pnpm](https://pnpm.io) 10.

```bash
git clone https://github.com/Kerim-Sabic/ensemble.git
cd ensemble
pnpm install
pnpm dev
```

To work without touching any account, run the app with its scripted demo team. In PowerShell:

```powershell
$env:ENSEMBLE_DEMO = '1'; pnpm dev
```

The demo team answers, starts agents, runs goals, loops, Ultra and Go crazy the same way every time, so it is also what the tests use.

## Check a change

```bash
pnpm typecheck   # both TypeScript projects
pnpm auto-test   # the engine against the demo team, no account used
```

Both must pass. For a change to the window, look at it in demo mode in light and dark, and add screenshots to the pull request.

`pnpm engine <scenario>` runs the real engine on your real accounts from a terminal. It spends your allowance, so it is never required for a pull request.

## Where things are

```
src/
  main/        the engine: hub (routing, models, tools), sessions, providers, goals and loops, prompts
  preload/     the bridge to the window
  renderer/    the interface (React, Tailwind, zustand)
  shared/      types and pure helpers used by both sides
scripts/       tests, the demo checks and build helpers
```

## House style

- **Plain words in the interface.** Sentence case, short labels, no jargon: "Goal", "Round 2 of 12", "Next run in 4:12".
- **Match what is there.** The components in `src/renderer/src/components/ui.tsx`, lucide icons, the colour tokens in `styles/index.css`, light and dark both.
- **Say only what was checked.** In code comments, in the interface and in pull requests.
- **Keep it small.** One change per pull request is easiest to review.

Security problems: please report them privately, as [docs/SECURITY.md](docs/SECURITY.md) describes.

By contributing you agree that your work is released under the [MIT license](LICENSE).
