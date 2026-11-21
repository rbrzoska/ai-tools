#!/usr/bin/env bash
# Makes the factory's subagents visible to Claude Code: ~/.claude/agents -> ~/.claude/skills/factory/agents.
# A directory junction on Windows (no admin rights needed), a symlink elsewhere. Idempotent.
set -u
src="$HOME/.claude/skills/factory/agents"
dst="$HOME/.claude/agents"
if command -v cygpath >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "
    \$dst = '$(cygpath -w "$dst")'; \$src = '$(cygpath -w "$src")'
    \$item = Get-Item -LiteralPath \$dst -Force -ErrorAction SilentlyContinue
    if (\$item -and -not (\$item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Write-Output \"! \$dst is a real directory; move its files into \$src first\"; exit 1 }
    if (\$item) { \$item.Delete() }
    New-Item -ItemType Junction -Path \$dst -Target \$src | Out-Null
    Write-Output \"ok \$dst -> \$src (junction)\""
else
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then echo "! $dst is a real directory; move its files into $src first"; exit 1; fi
  ln -sfn "$src" "$dst" && echo "ok $dst -> $src"
fi
