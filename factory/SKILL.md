---
name: factory
description: Run one task through the agent software factory on any git repository - grilling, spec, plan, TDD implementation in an isolated worktree, deterministic gates (lint, typecheck, tests, red-green, tamper), independent judges with refutation, an adversary with probe tests, and an evidence report. Use when the user says "fabryka", "puść przez fabrykę", "factory <ticket>", "zleć fabryce", or asks for a task to be done end to end by the factory.
---

# Factory — one task, end to end

You are the foreman. The workflows do the fan-out; you do the bookkeeping, talk to the user at the human gates, and write the final report from evidence on disk. This skill is the user's opt-in to the Workflow tool.

`FACTORY=~/.claude/skills/factory/bin/factory` (a bash script; it finds Python 3 itself). `$FACTORY where` prints every path: the workflows directory, the data home (`~/.factory`: runs, ledger, project configs), and where task worktrees go (`~/factory-tasks/<repo>/<slug>`). Pass Workflow the absolute `scriptPath` it prints, never a `~` path.

## 0. Project config (first run in a repository)

The factory works on any git repository; what it runs comes from the project config: `<repo>/.factory.json`, else `~/.factory/projects/<repo-name>.json`.

```bash
$FACTORY config --repo <repo>            # show it
$FACTORY config --repo <repo> --detect   # none yet: guess one and save it to ~/.factory/projects/
```

Keys (all optional; defaults fit a JavaScript / TypeScript project, `"language": "python"` switches to pytest defaults):

| Key | Meaning |
|---|---|
| `root` | directory inside the repo the gates cover (`""` = whole repo); changes outside it are reported as not covered |
| `install` | command run once in a new worktree, e.g. `["pnpm","install","--frozen-lockfile"]` |
| `lint` | lint command; `{files}` = changed lintable files (relative to `root`) |
| `typecheck` | list of commands; `{base}` = base commit |
| `test` | test command; `{specs}` = the selected spec files, each expanded through `testSpecArg` (e.g. `["--include","{spec}"]` for Karma) |
| `testCwdMarker` | file name (glob) whose nearest directory a spec is run from, for monorepos with one test config per package (e.g. `vitest.config.*`) |
| `specPattern`, `siblingSpecs`, `sourceExtensions`, `lintExtensions` | how specs and sources are recognised and paired (`{stem}.spec{ext}` next to `{stem}{ext}`) |
| `probeName`, `probeGlob` | file name of the adversary's probe tests |
| `focusOrSkipPattern`, `assertionPattern`, `testFailedPattern` | regexes for the tamper gate and for telling a failing probe from a broken one |
| `branchPrefix` | run branch prefix (default `factory/`) |
| `standardsDocs` | extra standards files the implementer and the standards judge read (besides `CLAUDE.md` / `AGENTS.md`) |
| `controlSet` | historical PRs for `factory-calibrate` (default `~/.factory/projects/<repo-name>.control-set.json`) |

When the config was just guessed (`configGuessed: true` from `init`, or `guessed: true` from `config`), show it to the user and get it confirmed before the spec. A gate without a command is reported `skipped`, never `pass`.

## 1. Start the run

```bash
$FACTORY init <slug> --repo <repo> [--base <ref>]
```

`<repo>` defaults to the repository of the current directory. `<slug>` is the ticket key plus two or three words (`DEV-1234-fix-tier-label`, `gh-42-retry-upload`), or just a few words. `--base` only when the user names a base; the default is the main checkout's HEAD. The command creates the worktree `~/factory-tasks/<repo>/<slug>` on branch `<branchPrefix><slug>`, runs the project's `install`, and prints `run.json` (it carries the project config as `project`). Keep that object: it is `run` in every workflow call.

## 2. Spec (workflow `factory-spec`)

Call Workflow with `scriptPath: <workflows>/factory-spec.js` and `args: { run, task }`, where `task` is the user's text or the ticket key / link.

- `needs-answers`: show the user every returned question with its recommended answer (AskUserQuestion, recommendation first). Then call the workflow again with `resumeFromRunId` and `args: { run, task, answers: { <id>: <answer> } }`.
- `spec-ready`: **human gate.** Link `spec.md` and `plan.md` from the run directory, list the acceptance criteria and every decision taken by default, and wait for the user's approval. If they change something, edit `spec.md` to match and say what you changed before building.

## 3. Build (workflow `factory-build`)

After approval call Workflow with `scriptPath: <workflows>/factory-build.js` and `args: { run, tickets, size }` taken from the spec result. To review an existing branch without implementing, pass `reviewOnly: true`.

The build runs each judge `judgeRuns` times (default 2) and merges the passes: a finding seen in only one pass is `stable: false`. In parallel an adversary writes probe tests and runs them; probes that fail become findings with a rerunnable test as evidence, archived in `<runDir>/probes/`. Report unstable findings, spec-judge verdicts that differ between passes, and the probe results in their own lines.

## 4. Check the checkers (workflow `factory-canary`)

When the build returns `passed`, call Workflow with `scriptPath: <workflows>/factory-canary.js` and `args: { run, bugs: 3 }`. It plants known bugs in a throwaway copy and measures how many the tests kill and how many the judges report. Read `~/.factory/canary-keys/<runId>/tests.json` yourself for the test result.

Canaries are blatant spec violations, so a perfect canary score only shows the judges were awake. The honest ceiling on trust is the latest calibration against human reviews of the same repository (`event: calibration` in `~/.factory/ledger.jsonl`, produced by workflow `factory-calibrate` with `args: { prs, repo }` from that repository's control set). State both numbers in the report and derive the trust level from them:

- `low`: canary judge recall or test kill rate below 2/3, or a judge did not return.
- `medium`: both canary rates at least 2/3, and calibration recall after refuter below 2/3 or no calibration for this repository.
- `high`: both canary rates and calibration recall after refuter at least 2/3.

## 5. Report

Write `<runDir>/report.md`. Deterministic evidence comes from `<runDir>/gates.json`, which you read yourself; never from what an agent said about the gates.

```markdown
# Factory report — <runId>
Verdict: passed | review-open | gates-failed | judges-incomplete
Repository: <repo> · Branch: <branch> (<n> commits on <baseSha short>)

## Hard evidence (deterministic)
| Gate | Status | Detail |

## Opinions (non-deterministic)
### Acceptance criteria — judge verdict per criterion
### Findings — id, judge, severity, refuter verdict, claim
(confirmed / refuted / uncertain are listed separately; uncertain findings are not hidden)

## Trust in this verdict: low | medium | high
(canary: tests killed n/m, judges caught n/m; calibration: judges reproduce x% of human review findings, y% after the refuter — or "no calibration for this repository")

## Not verified
(skipped gates and why, paths outside gate coverage, judges that did not return, what no stage checked — e.g. the running UI)

## Cost
(agents run, fix rounds, review rounds)
```

Then append the outcome to the ledger:

```bash
$FACTORY log <runDir> '{"event":"result","status":"<status>","fixRounds":<n>,"reviewRounds":<n>,"confirmedBlocking":<n>,"refuted":<n>,"uncertain":<n>}'
```

## 6. Housekeeping after every workflow

- Every workflow returns `incidents`. Log each one: `$FACTORY log <runDir> '{"event":"incident","kind":"<kind>","detail":"<one line>"}'`. Log any problem of the factory you notice yourself the same way: a gate failing for a reason unrelated to the task, an agent acting outside its role, a manual fix you had to make.
- Run `$FACTORY gc --repo <repo>` at the end, so no canary or calibration worktree is left behind.
- After every few runs, or when the user asks for a retro, run workflow `factory-retro` and show the user only `recurring` problems as proposals. Nothing from the retro is applied without the user's approval.

## Rules

- The run ends at a local branch and a report. Never push, never open a pull request, never comment on the ticket tracker or the git host unless the user asks after reading the report.
- The repository's own rules (`CLAUDE.md`, `AGENTS.md`) bind every agent of the run; when they forbid something the factory would do (a command, a test runner invocation), follow the repository and log an incident.
- A skipped gate is reported as skipped, never as passed.
- If a workflow returns `failed`, `gates-failed` or `judges-incomplete`, report that state as it is; do not finish the work yourself to make the run look green.
- When the user corrects the spec, the plan or the result, log it: `$FACTORY log <runDir> '{"event":"human-correction","stage":"<stage>","what":"<one line>"}'`. These corrections are how the factory is measured.
