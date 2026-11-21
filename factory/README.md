# factory

An agent software factory on Claude Code: one task goes from the request to a local branch with an evidence report. Works on any git repository; the project config says what to run.

Entry point: the skill (`SKILL.md`, `/factory <task>`). Everything else lives next to it:

- `agents/` — subagent definitions (grill, spec, planner, implementer, gates, four judges, refuter, adversary, canary seeder, retro)
- `workflows/` — `factory-spec.js`, `factory-build.js`, `factory-canary.js`, `factory-calibrate.js`, `factory-retro.js`
- `bin/factory` — CLI (`where`, `config`, `init`, `gates`, `test`, `probe-run`, `canary-*`, `calibrate-init`, `gc`, `log`); needs git and Python 3.9+

## Flow

1. `factory init <slug> --repo <repo>` — run directory in `~/.factory/runs/<runId>/`, worktree `~/factory-tasks/<repo>/<slug>`.
2. Workflow `factory-spec` — grilling (the agent finds the facts, only high-risk decisions go to the human), `spec.md`, `plan.md`.
3. The human approves the spec.
4. Workflow `factory-build` — TDD per ticket, deterministic gates (`factory gates`), four independent judges, an adversary with probe tests, a refuter on every finding, at most two fix rounds.
5. `report.md` — hard evidence apart from opinions, plus what nobody checked.

Nothing is pushed or published.

## Project config

`<repo>/.factory.json` or `~/.factory/projects/<repo-name>.json`; `factory config --detect` guesses one (npm / pnpm / yarn, ESLint, TypeScript, Nx, Vitest, Jest, Karma, pytest). Example for an Nx monorepo with one Vitest config per package:

```json
{
  "install": ["pnpm", "install", "--frozen-lockfile"],
  "lint": ["npx", "eslint", "{files}"],
  "typecheck": [["npx", "nx", "affected", "-t", "typecheck", "--base={base}", "--head=HEAD"]],
  "test": ["npx", "vitest", "run", "{specs}"],
  "testCwdMarker": "vitest.config.*",
  "standardsDocs": ["AGENTS.md"]
}
```

## Deterministic gates

`committed`, `isolation`, `scope`, `tamper` (deleted specs, focused / skipped tests, fewer assertions), `lint`, `typecheck`, `tests` (changed specs and specs next to changed sources, 3 runs, flaky = fail), `red-green` (changed specs must fail on the base implementation). A gate with no command in the config is `skipped`. Result in `gates.json`, events in `~/.factory/ledger.jsonl`.

## Checking the checkers

- `factory-canary` — plants known bugs in a copy of a finished change: do the tests kill them, do the judges report them.
- `factory-calibrate` — judges and refuter on historical PRs of the same repository, as the reviewer saw them (`reviewSha` in the control set), matched against the human review. Control set: `~/.factory/projects/<repo-name>.control-set.json`, entries `{ pr, reviewSha, mergeSha, taskStatement, reviewFindings: [{ path, summary }] }`.

## Environment variables

`FACTORY_HOME` (default `~/.factory`), `FACTORY_TASKS` (default `~/factory-tasks`).
