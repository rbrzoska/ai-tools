#!/usr/bin/env python3
"""
factory — run bookkeeping and deterministic gates for the agent software factory.

Works on any git repository. What to run (install, lint, typecheck, tests) comes from the
repository's project config: <repo>/.factory.json, else $FACTORY_HOME/projects/<repo-name>.json.
`factory init` writes a guessed config there when none exists; check it before the first run.

  factory where                                       print the install and data paths
  factory config [--repo <path>] [--detect]           print the project config (--detect: guess and save one)
  factory init <slug> [--repo <path>] [--base <ref>] [--no-install]
                                                      create run dir + worktree, print run.json
  factory gates <runDir>                              run deterministic gates, write gates.json, exit 1 on fail
  factory test <runDir> <spec>...                     run the project's test command for the given specs
  factory probe-run <runDir> [--keep]                 run adversary probe specs; without --keep archive and delete them
  factory canary-init <runDir>                        detached copy of the run's HEAD for seeded bugs
  factory canary-run <runDir>                         per seeded bug: do the tests kill it; then commit all bugs in the copy
  factory calibrate-init <pr> [--repo <path>]         detached worktree of a control-set PR as the reviewer saw it
  factory drop-worktree <path>                        remove a canary or calibration worktree
  factory gc [--repo <path>]                          remove every leftover canary or calibration worktree
  factory log <runId|runDir> '<json>'                 append an event to the ledger

Paths printed by this script use forward slashes, so they work in bash on every OS.
"""
import argparse
import datetime
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

FACTORY_ROOT = Path(__file__).resolve().parent.parent
FACTORY_HOME = Path(os.environ.get("FACTORY_HOME", Path.home() / ".factory"))
TASKS = Path(os.environ.get("FACTORY_TASKS", Path.home() / "factory-tasks"))
OUTPUT_TAIL_CHARS = 6000
TEST_RUNS = 3
PROBE_RUNS = 2
LEDGER_EVENTS = {"init", "gates", "probes", "canary-tests", "canary", "calibration", "result",
                 "incident", "human-correction", "retro"}
FULL_PANEL = {"spec", "robustness", "tests", "standards"}

# Defaults for a JavaScript / TypeScript project. A project config overrides any key.
DEFAULTS = {
    "name": None,
    "root": "",
    "install": None,
    "lint": None,
    "lintExtensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".html"],
    "typecheck": [],
    "test": None,
    "testSpecArg": ["{spec}"],
    "testCwdMarker": None,
    "specPattern": r"\.(spec|test)\.[cm]?[jt]sx?$",
    "sourceExtensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".html"],
    "siblingSpecs": ["{stem}.spec{ext}", "{stem}.test{ext}"],
    "probeName": "{topic}.factory-probe.spec.ts",
    "probeGlob": "*.factory-probe.spec.*",
    "focusOrSkipPattern": r"\b(fdescribe|fit|xdescribe|xit)\s*\(|\.(only|skip)\s*\(",
    "assertionPattern": r"\bexpect\(|\bassert\b",
    "testFailedPattern": r"Executed \d+ of \d+.*FAILED|Tests?\s+\d+ failed|Tests:.*\d+ failed|\bFAIL\b|\d+ failed",
    "branchPrefix": "factory/",
    "standardsDocs": [],
    "controlSet": None,
}

PYTHON_DEFAULTS = {
    "lintExtensions": [".py"],
    "sourceExtensions": [".py"],
    "specPattern": r"(^|/)test_[^/]*\.py$|_test\.py$",
    "siblingSpecs": ["test_{stem}{ext}", "tests/test_{stem}{ext}"],
    "probeName": "test_factory_probe_{topic}.py",
    "probeGlob": "test_factory_probe_*.py",
    "focusOrSkipPattern": r"@pytest\.mark\.(skip|xfail)|pytest\.skip\(",
    "assertionPattern": r"\bassert\b",
    "testFailedPattern": r"\d+ failed|\bFAILED\b|\bERROR\b",
}


def posix(path):
    return Path(path).as_posix()


def sh(cmd, cwd, timeout=1800):
    started = time.time()
    exe = shutil.which(cmd[0]) or cmd[0]
    try:
        proc = subprocess.run([exe, *cmd[1:]], cwd=cwd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
        code, output = proc.returncode, proc.stdout + proc.stderr
    except subprocess.TimeoutExpired as expired:
        code, output = 124, f"timeout after {timeout}s\n{expired.stdout or ''}"
    except FileNotFoundError as missing:
        code, output = 127, f"command not found: {missing}"
    return code, output[-OUTPUT_TAIL_CHARS:], round(time.time() - started, 1)


def git(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=True).stdout


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def append_ledger(run_id, event):
    FACTORY_HOME.mkdir(parents=True, exist_ok=True)
    with open(FACTORY_HOME / "ledger.jsonl", "a", encoding="utf-8") as ledger:
        ledger.write(json.dumps({"ts": now(), "runId": run_id, **event}, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- repository and project config

def repo_root(path):
    start = Path(path or os.getcwd()).resolve()
    try:
        common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], start).strip()
    except subprocess.CalledProcessError:
        sys.exit(f"not a git repository: {start}")
    common = Path(common)
    # The main checkout of a repository, also when called from one of its worktrees.
    return common.parent if common.name == ".git" else Path(git(["rev-parse", "--show-toplevel"], start).strip())


def repo_name(repo):
    return Path(repo).name


def config_paths(repo):
    return [Path(repo) / ".factory.json", FACTORY_HOME / "projects" / f"{repo_name(repo)}.json"]


def load_project(repo):
    for path in config_paths(repo):
        if path.exists():
            config = json.loads(read(path))
            base = {**DEFAULTS, **(PYTHON_DEFAULTS if config.get("language") == "python" else {})}
            return {**base, **config, "name": config.get("name") or repo_name(repo), "configPath": posix(path)}
    return None


def package_manager(repo):
    for lock, manager in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"),
                          ("package-lock.json", "npm")):
        if (repo / lock).exists():
            return manager
    return "npm"


def detect_project(repo):
    repo = Path(repo)
    config = {"name": repo_name(repo)}
    if (repo / "package.json").exists():
        pkg = json.loads(read(repo / "package.json"))
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        manager = package_manager(repo)
        config["install"] = [manager, "install"] + (["--frozen-lockfile"] if manager in ("pnpm", "yarn") else [])
        if manager == "npm" and (repo / "package-lock.json").exists():
            config["install"] = ["npm", "ci"]
        if "eslint" in deps:
            config["lint"] = ["npx", "eslint", "{files}"]
        if "typescript" in deps:
            if (repo / "nx.json").exists():
                config["typecheck"] = [["npx", "nx", "affected", "-t", "typecheck", "--base={base}", "--head=HEAD"]]
            elif (repo / "tsconfig.json").exists():
                config["typecheck"] = [["npx", "tsc", "--noEmit", "-p", "tsconfig.json"]]
        if "vitest" in deps:
            config["test"] = ["npx", "vitest", "run", "{specs}"]
            tracked = git(["ls-files", "*vitest.config.*"], repo).splitlines()
            if len(tracked) > 1:
                config["testCwdMarker"] = "vitest.config.*"
        elif "jest" in deps:
            config["test"] = ["npx", "jest", "{specs}"]
        elif (repo / "angular.json").exists() and "karma" in deps:
            config["test"] = ["npx", "ng", "test", "--no-watch", "--no-progress", "--browsers", "ChromeHeadless", "{specs}"]
            config["testSpecArg"] = ["--include", "{spec}"]
        if (repo / "CODING_STANDARDS.md").exists():
            config["standardsDocs"] = ["CODING_STANDARDS.md"]
    elif any((repo / name).exists() for name in ("pyproject.toml", "setup.py", "requirements.txt")):
        config["language"] = "python"
        config["install"] = ["pip", "install", "-e", "."] if (repo / "pyproject.toml").exists() else None
        config["lint"] = ["ruff", "check", "{files}"] if shutil.which("ruff") else None
        config["test"] = ["python", "-m", "pytest", "-q", "{specs}"]
    config["detected"] = now()
    return config


def project_for(repo, detect=False):
    project = load_project(repo)
    if project or not detect:
        return project, False
    guessed = detect_project(repo)
    target = FACTORY_HOME / "projects" / f"{repo_name(repo)}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    write(target, json.dumps(guessed, indent=2) + "\n")
    return load_project(repo), True


def expand(template, files=(), base="", spec_arg=("{spec}",)):
    out = []
    for part in template:
        if part == "{files}":
            out.extend(files)
        elif part == "{specs}":
            for spec in files:
                out.extend(arg.replace("{spec}", spec) for arg in spec_arg)
        else:
            out.append(part.replace("{base}", base))
    return out


def load_run(run_dir):
    run = json.loads(read(Path(run_dir) / "run.json"))
    project = load_project(run["repo"]) or run.get("project")
    return run, project


# ---------------------------------------------------------------- init

def untracked(worktree):
    return sorted(line[3:] for line in git(["status", "--porcelain"], worktree).splitlines() if line.startswith("??"))


def exclude_fingerprint(repo):
    exclude = Path(repo) / ".git" / "info" / "exclude"
    return read(exclude) if exclude.exists() else ""


def cmd_init(args):
    repo = repo_root(args.repo)
    project, guessed = project_for(repo, detect=True)
    slug = re.sub(r"[^a-zA-Z0-9-]+", "-", args.slug).strip("-")
    run_id = f"{datetime.date.today().isoformat()}-{repo_name(repo)}-{slug}"
    run_dir = FACTORY_HOME / "runs" / run_id
    worktree = TASKS / repo_name(repo) / slug
    if run_dir.exists() or worktree.exists():
        sys.exit(f"run or worktree already exists: {posix(run_dir)} / {posix(worktree)}")
    base_sha = git(["rev-parse", args.base or "HEAD"], repo).strip()
    branch = f"{project['branchPrefix']}{slug}"
    worktree.parent.mkdir(parents=True, exist_ok=True)
    git(["worktree", "add", "-b", branch, str(worktree), base_sha], repo)
    if project.get("install") and not args.no_install:
        code, output, _ = sh(expand(project["install"]), worktree, timeout=3600)
        if code != 0:
            sys.exit(f"install failed ({' '.join(project['install'])}):\n{output}")
    run_dir.mkdir(parents=True)
    run = {
        "untrackedAtInit": untracked(worktree),
        "mainExcludeAtInit": exclude_fingerprint(repo),
        "runId": run_id,
        "runDir": posix(run_dir),
        "repo": posix(repo),
        "worktree": posix(worktree),
        "branch": branch,
        "baseSha": base_sha,
        "startedAt": now(),
        "project": project,
    }
    write(run_dir / "run.json", json.dumps(run, indent=2) + "\n")
    append_ledger(run_id, {"event": "init", "repo": repo_name(repo), "baseSha": base_sha})
    if guessed:
        run["configGuessed"] = True
    print(json.dumps(run, indent=2))


# ---------------------------------------------------------------- change selection

def changed_files(worktree, base):
    entries = []
    for line in git(["diff", "--name-status", "--no-renames", base, "HEAD"], worktree).splitlines():
        status, path = line.split("\t", 1)
        entries.append((status, path))
    return entries


def in_root(project, path):
    root = project["root"].strip("/")
    return not root or path.startswith(root + "/")


def relative(project, path):
    root = project["root"].strip("/")
    return path[len(root) + 1:] if root else path


def is_spec(project, path):
    return re.search(project["specPattern"], path) is not None


def sibling_specs(project, path):
    stem_path = Path(path)
    out = []
    for template in project["siblingSpecs"]:
        name = template.format(stem=stem_path.stem, ext=stem_path.suffix)
        out.append(posix(stem_path.parent / name) if str(stem_path.parent) != "." else name)
    return out


def selection(project, worktree, changes):
    root_dir = Path(worktree) / project["root"]
    scoped = [(status, path) for status, path in changes if in_root(project, path)]
    present = [(status, path) for status, path in scoped if status != "D"]
    changed_specs = [relative(project, path) for _, path in present if is_spec(project, path)]
    changed_sources = [(status, path) for status, path in scoped
                       if not is_spec(project, path) and path.endswith(tuple(project["sourceExtensions"]))]
    siblings = {spec for _, path in present
                if not is_spec(project, path) and path.endswith(tuple(project["sourceExtensions"]))
                for spec in sibling_specs(project, relative(project, path))}
    specs = sorted(set(changed_specs) | {spec for spec in siblings if (root_dir / spec).exists()})
    lintable = [relative(project, path) for _, path in present if path.endswith(tuple(project["lintExtensions"]))]
    return changed_specs, changed_sources, specs, lintable


# ---------------------------------------------------------------- gates

def gate_tamper(project, worktree, base, changes):
    focus = re.compile(project["focusOrSkipPattern"])
    assertion = re.compile(project["assertionPattern"])
    problems = [f"spec deleted: {path}" for status, path in changes if status == "D" and is_spec(project, path)]
    for status, path in changes:
        if status != "M" or not is_spec(project, path):
            continue
        added = removed = 0
        for line in git(["diff", "-U0", base, "HEAD", "--", path], worktree).splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                added += len(assertion.findall(line))
                if focus.search(line):
                    problems.append(f"focused or skipped test added: {path}: {line[1:].strip()}")
            elif line.startswith("-") and not line.startswith("---"):
                removed += len(assertion.findall(line))
        if removed > added:
            problems.append(f"assertions removed: {path} (-{removed} +{added})")
    for status, path in changes:
        if status == "A" and is_spec(project, path):
            for number, line in enumerate(read(Path(worktree) / path).splitlines(), 1):
                if focus.search(line):
                    problems.append(f"focused or skipped test added: {path}:{number}")
    return ("fail" if problems else "pass"), "\n".join(problems), 0


def test_groups(project, root_dir, specs):
    """Group specs by the directory the test command must run in (nearest testCwdMarker)."""
    marker = project.get("testCwdMarker")
    if not marker:
        return [(root_dir, list(specs))]
    groups = {}
    for spec in specs:
        cwd = root_dir
        for parent in (root_dir / spec).parents:
            if root_dir not in (parent, *parent.parents):
                break
            if any(fnmatch.fnmatch(child.name, marker) for child in parent.iterdir() if child.is_file()):
                cwd = parent
                break
        groups.setdefault(cwd, []).append(posix((root_dir / spec).relative_to(cwd)))
    return list(groups.items())


def run_tests(project, worktree, specs):
    if not project.get("test"):
        return 127, "no test command in the project config", 0
    root_dir = Path(worktree) / project["root"]
    code, output, seconds = 0, "", 0.0
    for cwd, group in test_groups(project, root_dir, specs):
        group_code, group_output, group_seconds = sh(expand(project["test"], group, spec_arg=project["testSpecArg"]), cwd)
        seconds += group_seconds
        if group_code != 0 and code == 0:
            code, output = group_code, group_output
        elif code == 0:
            output = group_output
    return code, output, round(seconds, 1)


def gate_tests_repeated(project, worktree, specs):
    runs = [run_tests(project, worktree, specs) for _ in range(TEST_RUNS)]
    codes = [code for code, _, _ in runs]
    seconds = round(sum(elapsed for _, _, elapsed in runs), 1)
    failing_output = next((output for code, output, _ in runs if code != 0), "")
    if all(code == 0 for code in codes):
        return "pass", f"{TEST_RUNS}/{TEST_RUNS} runs green", seconds
    if all(code != 0 for code in codes):
        return "fail", failing_output, seconds
    green = sum(code == 0 for code in codes)
    return "flaky", f"{green}/{TEST_RUNS} runs green; output of a failing run:\n{failing_output}", seconds


def restore_head(worktree, paths):
    in_head = set(git(["ls-tree", "-r", "--name-only", "HEAD", "--", *paths], worktree).splitlines())
    for path in paths:
        if path in in_head:
            git(["checkout", "HEAD", "--", path], worktree)
        else:
            git(["rm", "-q", "--cached", "--ignore-unmatch", "--", path], worktree)
            (Path(worktree) / path).unlink(missing_ok=True)


def gate_red_green(project, worktree, base, changed_specs, changed_sources):
    if not changed_specs:
        return "skipped", "no spec files added or modified", 0
    if not changed_sources:
        return "skipped", "no non-spec source changes to revert", 0
    paths = [path for _, path in changed_sources]
    try:
        for status, path in changed_sources:
            if status == "A":
                (Path(worktree) / path).unlink()
            else:
                git(["checkout", base, "--", path], worktree)
        code, output, seconds = run_tests(project, worktree, changed_specs)
    finally:
        restore_head(worktree, paths)
    if code == 0:
        return "fail", "changed specs pass against the base implementation, so they do not prove the change", seconds
    return "pass", "changed specs fail against the base implementation", seconds


def cmd_gates(args):
    run_dir = Path(args.run_dir)
    run, project = load_run(run_dir)
    worktree, base, repo = Path(run["worktree"]), run["baseSha"], run["repo"]
    root_dir = worktree / project["root"]
    results = []

    def record(gate, status, detail, seconds):
        results.append({"gate": gate, "status": status, "detail": detail, "seconds": seconds})

    expected = set(run.get("untrackedAtInit", []))
    is_expected = lambda line: line.startswith("??") and line[3:] in expected
    dirty = "\n".join(line for line in git(["status", "--porcelain"], worktree).splitlines() if not is_expected(line))
    record("committed", "fail" if dirty else "pass", dirty, 0)
    changed = exclude_fingerprint(repo) != run.get("mainExcludeAtInit", "")
    record("isolation", "fail" if changed else "pass",
           "main repository .git/info/exclude changed since init" if changed else "", 0)
    changes = changed_files(worktree, base)
    if not changes:
        record("has-changes", "fail", "no commits on top of base", 0)

    if not dirty and changes:
        outside = [path for _, path in changes if not in_root(project, path)]
        record("scope", "skipped" if outside else "pass",
               "not covered by gates: " + ", ".join(outside) if outside else "", 0)
        changed_specs, changed_sources, specs, lintable = selection(project, worktree, changes)

        record("tamper", *gate_tamper(project, worktree, base, changes))

        if not project.get("lint"):
            record("lint", "skipped", "no lint command in the project config", 0)
        elif lintable:
            code, output, seconds = sh(expand(project["lint"], lintable, base), root_dir)
            record("lint", "pass" if code == 0 else "fail", "" if code == 0 else output, seconds)
        else:
            record("lint", "skipped", "no lintable files changed", 0)

        if not project.get("typecheck"):
            record("typecheck", "skipped", "no typecheck command in the project config", 0)
        for command in project.get("typecheck") or []:
            code, output, seconds = sh(expand(command, base=base), root_dir)
            name = "typecheck:" + " ".join(command[1:4])
            record(name, "pass" if code == 0 else "fail", "" if code == 0 else output, seconds)

        if not project.get("test"):
            record("tests", "skipped", "no test command in the project config", 0)
        elif specs:
            record("tests", *gate_tests_repeated(project, worktree, specs))
        else:
            record("tests", "skipped", "no spec files for the changed sources", 0)

        if project.get("test"):
            record("red-green", *gate_red_green(project, worktree, base, changed_specs, changed_sources))
        else:
            record("red-green", "skipped", "no test command in the project config", 0)

    passed = all(result["status"] not in ("fail", "flaky") for result in results)
    report = {
        "passed": passed,
        "headSha": git(["rev-parse", "HEAD"], worktree).strip(),
        "baseSha": base,
        "ranAt": now(),
        "results": results,
    }
    write(run_dir / "gates.json", json.dumps(report, indent=2) + "\n")
    append_ledger(run["runId"], {
        "event": "gates",
        "passed": passed,
        "headSha": report["headSha"],
        "gates": {result["gate"]: result["status"] for result in results},
    })
    print(json.dumps({"passed": passed, "gates": {r["gate"]: r["status"] for r in results}}, indent=2))
    sys.exit(0 if passed else 1)


def cmd_test(args):
    run, project = load_run(args.run_dir)
    code, output, seconds = run_tests(project, run["worktree"], args.specs)
    print(output)
    print(json.dumps({"exitCode": code, "seconds": seconds}))
    sys.exit(code)


# ---------------------------------------------------------------- probes

def classify_probe(project, code, output):
    if code == 0:
        return "pass"
    if re.search(project["testFailedPattern"], output):
        return "fail"
    return "broken"


def probe_files(project, worktree):
    root_dir = Path(worktree) / project["root"]
    return sorted(path for path in root_dir.rglob(project["probeGlob"])
                  if "node_modules" not in path.parts and ".git" not in path.parts)


def cmd_probe_run(args):
    run_dir = Path(args.run_dir)
    run, project = load_run(run_dir)
    worktree = Path(run["worktree"])
    root_dir = worktree / project["root"]
    files = probe_files(project, worktree)
    runs = 1 if args.keep else PROBE_RUNS
    probes = []
    for probe in files:
        rel = posix(probe.relative_to(root_dir))
        outcomes = []
        last_output = ""
        for _ in range(runs):
            code, output, _ = run_tests(project, worktree, [rel])
            outcomes.append(classify_probe(project, code, output))
            if code != 0:
                last_output = output
        status = "flaky" if len(set(outcomes)) > 1 else outcomes[0]
        probes.append({"file": rel, "status": status, "runs": outcomes, "output": last_output})
    result = {"runs": runs, "probes": probes}
    if not args.keep:
        archive = run_dir / "probes"
        archive.mkdir(exist_ok=True)
        for probe in files:
            write(archive / probe.name, read(probe))
            probe.unlink()
        expected = set(run.get("untrackedAtInit", []))
        leftover = "\n".join(line for line in git(["status", "--porcelain"], worktree).splitlines()
                             if not (line.startswith("??") and line[3:] in expected))
        result["worktreeClean"] = not leftover
        result["leftover"] = leftover
        write(archive / "probes.json", json.dumps(result, indent=2) + "\n")
        append_ledger(run["runId"], {
            "event": "probes",
            "counts": {status: sum(probe["status"] == status for probe in probes)
                       for status in ("pass", "fail", "flaky", "broken")},
            "worktreeClean": result["worktreeClean"],
        })
    print(json.dumps(result, indent=2))


# ---------------------------------------------------------------- canaries

def canary_paths(run):
    canary_dir = Path(run["runDir"]) / "canary"
    return canary_dir / "wt", canary_dir / "view", FACTORY_HOME / "canary-keys" / run["runId"]


def cmd_canary_init(args):
    run, _ = load_run(args.run_dir)
    worktree, repo = Path(run["worktree"]), run["repo"]
    canary_worktree, view_dir, key_dir = canary_paths(run)
    head_sha = git(["rev-parse", "HEAD"], worktree).strip()
    if canary_worktree.exists():
        git(["worktree", "remove", "--force", str(canary_worktree)], repo)
    git(["worktree", "add", "--detach", str(canary_worktree), head_sha], repo)
    view_dir.mkdir(parents=True, exist_ok=True)
    key_dir.mkdir(parents=True, exist_ok=True)
    write(view_dir / "spec.md", read(Path(run["runDir"]) / "spec.md"))
    print(json.dumps({
        "canaryWorktree": posix(canary_worktree),
        "viewDir": posix(view_dir),
        "keyDir": posix(key_dir),
        "baseSha": run["baseSha"],
        "headSha": head_sha,
    }, indent=2))


def cmd_canary_run(args):
    run, project = load_run(args.run_dir)
    worktree = Path(run["worktree"])
    canary_worktree, _, key_dir = canary_paths(run)
    seeded = json.loads(read(key_dir / "seeded.json"))
    _, _, specs, _ = selection(project, worktree, changed_files(worktree, run["baseSha"]))
    bugs = []
    for bug in seeded["bugs"]:
        patch = key_dir / f"{bug['id']}.patch"
        outcome = {"id": bug["id"], "killedByTests": None}
        if specs and project.get("test"):
            git(["apply", str(patch)], worktree)
            try:
                code, _, seconds = run_tests(project, worktree, specs)
            finally:
                git(["apply", "-R", str(patch)], worktree)
            outcome.update({"killedByTests": code != 0, "seconds": seconds})
        try:
            git(["apply", "--3way", str(patch)], canary_worktree)
            outcome["inCombinedCopy"] = True
        except subprocess.CalledProcessError:
            outcome["inCombinedCopy"] = False
        bugs.append(outcome)
    if git(["status", "--porcelain", "--untracked-files=no"], canary_worktree).strip():
        git(["commit", "-qam", "canary"], canary_worktree)
    result = {"bugs": bugs, "specs": specs}
    write(key_dir / "tests.json", json.dumps(result, indent=2) + "\n")
    append_ledger(run["runId"], {"event": "canary-tests", "bugs": bugs})
    print(json.dumps(result, indent=2))


# ---------------------------------------------------------------- calibration

def control_set_path(repo, project):
    candidates = []
    if project and project.get("controlSet"):
        candidates.append(Path(repo) / project["controlSet"])
        candidates.append(Path(project["controlSet"]).expanduser())
    candidates += [Path(repo) / ".factory-control-set.json",
                   FACTORY_HOME / "projects" / f"{repo_name(repo)}.control-set.json"]
    return next((path for path in candidates if path.exists()), None)


def cmd_calibrate_init(args):
    repo = repo_root(args.repo)
    project = load_project(repo)
    control_set = control_set_path(repo, project)
    if not control_set:
        sys.exit(f"no control set for {repo_name(repo)}: put one at "
                 f"{posix(FACTORY_HOME / 'projects' / (repo_name(repo) + '.control-set.json'))}")
    entry = next((item for item in json.loads(read(control_set)) if item["pr"] == args.pr), None)
    if not entry:
        sys.exit(f"PR {args.pr} is not in {posix(control_set)}")
    review_sha = entry["reviewSha"]
    base_sha = git(["merge-base", review_sha, entry["mergeSha"] + "^1"], repo).strip()
    calibration_dir = FACTORY_HOME / "calibration" / repo_name(repo) / str(args.pr)
    worktree, view_dir = calibration_dir / "wt", calibration_dir / "view"
    if not worktree.exists():
        git(["worktree", "add", "--detach", str(worktree), review_sha], repo)
        view_dir.mkdir(parents=True, exist_ok=True)
        write(view_dir / "spec.md",
              f"# Task\n\n{entry['taskStatement']}\n\n"
              "There are no numbered acceptance criteria for this change. Judge it against the task statement above.\n")
    print(json.dumps({"pr": args.pr, "worktree": posix(worktree), "viewDir": posix(view_dir),
                      "baseSha": base_sha, "controlSet": posix(control_set)}, indent=2))


# ---------------------------------------------------------------- cleanup

def owning_repo(path):
    return repo_root(path)


def cmd_drop_worktree(args):
    path = Path(args.path).resolve()
    if FACTORY_HOME.resolve() not in path.parents:
        sys.exit(f"refusing to drop a worktree outside {posix(FACTORY_HOME)}: {posix(path)}")
    repo = owning_repo(path) if path.exists() else None
    if repo:
        git(["worktree", "remove", "--force", str(path)], repo)
    print(json.dumps({"dropped": posix(path)}))


def cmd_gc(args):
    repo = repo_root(args.repo)
    listing = git(["worktree", "list", "--porcelain"], repo)
    paths = [Path(line[len("worktree "):]) for line in listing.splitlines() if line.startswith("worktree ")]
    home = FACTORY_HOME.resolve()
    dropped = []
    for path in paths:
        if home in path.resolve().parents:
            git(["worktree", "remove", "--force", str(path)], repo)
            dropped.append(posix(path))
    git(["worktree", "prune"], repo)
    print(json.dumps({"dropped": dropped}, indent=2))


# ---------------------------------------------------------------- misc

def cmd_log(args):
    run_json = Path(args.run_dir) / "run.json"
    run_id = json.loads(read(run_json))["runId"] if run_json.exists() else args.run_dir
    event = json.loads(args.event)
    if event.get("event") not in LEDGER_EVENTS:
        sys.exit(f"unknown event {event.get('event')!r}; expected one of {sorted(LEDGER_EVENTS)}")
    if event["event"] in ("calibration", "canary") and not FULL_PANEL <= set(event.get("judges", [])):
        sys.exit(f"{event['event']} event needs \"judges\" with all of {sorted(FULL_PANEL)}; "
                 "a result from an incomplete panel is not recorded")
    append_ledger(run_id, event)


def cmd_where(_args):
    print(json.dumps({
        "factory": posix(FACTORY_ROOT),
        "cli": posix(FACTORY_ROOT / "bin" / "factory"),
        "workflows": posix(FACTORY_ROOT / "workflows"),
        "home": posix(FACTORY_HOME),
        "ledger": posix(FACTORY_HOME / "ledger.jsonl"),
        "runs": posix(FACTORY_HOME / "runs"),
        "projects": posix(FACTORY_HOME / "projects"),
        "tasks": posix(TASKS),
    }, indent=2))


def cmd_config(args):
    repo = repo_root(args.repo)
    project, guessed = project_for(repo, detect=args.detect)
    if not project:
        print(json.dumps({"repo": posix(repo), "config": None,
                          "lookedAt": [posix(path) for path in config_paths(repo)]}, indent=2))
        return
    print(json.dumps({"repo": posix(repo), "guessed": guessed, "config": project}, indent=2))


def main():
    parser = argparse.ArgumentParser(prog="factory")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("where").set_defaults(handler=cmd_where)
    config = commands.add_parser("config")
    config.add_argument("--repo")
    config.add_argument("--detect", action="store_true")
    config.set_defaults(handler=cmd_config)
    init = commands.add_parser("init")
    init.add_argument("slug")
    init.add_argument("--repo")
    init.add_argument("--base")
    init.add_argument("--no-install", action="store_true")
    init.set_defaults(handler=cmd_init)
    gates = commands.add_parser("gates")
    gates.add_argument("run_dir")
    gates.set_defaults(handler=cmd_gates)
    test = commands.add_parser("test")
    test.add_argument("run_dir")
    test.add_argument("specs", nargs="+")
    test.set_defaults(handler=cmd_test)
    for name, handler in (("canary-init", cmd_canary_init), ("canary-run", cmd_canary_run)):
        canary = commands.add_parser(name)
        canary.add_argument("run_dir")
        canary.set_defaults(handler=handler)
    calibrate = commands.add_parser("calibrate-init")
    calibrate.add_argument("pr", type=int)
    calibrate.add_argument("--repo")
    calibrate.set_defaults(handler=cmd_calibrate_init)
    drop = commands.add_parser("drop-worktree")
    drop.add_argument("path")
    drop.set_defaults(handler=cmd_drop_worktree)
    gc = commands.add_parser("gc")
    gc.add_argument("--repo")
    gc.set_defaults(handler=cmd_gc)
    probe = commands.add_parser("probe-run")
    probe.add_argument("run_dir")
    probe.add_argument("--keep", action="store_true")
    probe.set_defaults(handler=cmd_probe_run)
    log = commands.add_parser("log")
    log.add_argument("run_dir")
    log.add_argument("event")
    log.set_defaults(handler=cmd_log)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
