# ai-tools

Personal Claude Code skills (and the agent factory), synced between machines.

## Setup on a new machine

```bash
# move any existing local skills out of the way first
mv ~/.claude/skills ~/.claude/skills.old 2>/dev/null
git clone https://github.com/rbrzoska/ai-tools ~/.claude/skills
bash ~/.claude/skills/.setup.sh   # links the factory's agents into ~/.claude/agents
```

Then add these hooks to `~/.claude/settings.json` (merge with what is already there):

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "shell": "bash",
    "command": "bash \"$HOME/.claude/skills/.sync.sh\" pull", "timeout": 20 }] }],
  "Stop": [{ "hooks": [{ "type": "command", "shell": "bash",
    "command": "bash \"$HOME/.claude/skills/.sync.sh\" push", "timeout": 30, "async": true }] }]
}
```

`SessionStart` pulls the latest skills; `Stop` commits local changes (e.g. new
entries in `slonsko-godka/slowniczek.md`) and pushes them.

## Factory

`factory/` is a skill with its own agents, workflows and CLI — see `factory/README.md`.
