#!/usr/bin/env bash
# Keeps ~/.claude/skills in sync across machines.
#   .sync.sh pull  -> fetch the latest skills (SessionStart hook)
#   .sync.sh push  -> commit local changes and push them (Stop hook)
cd "$(dirname "$0")" || exit 0
case "$1" in
  pull)
    git pull --rebase --autostash -q 2>/dev/null
    ;;
  push)
    if [ -n "$(git status --porcelain)" ]; then
      git add -A
      git commit -q -m "sync from $(hostname) $(date '+%Y-%m-%d %H:%M')"
    fi
    if [ -n "$(git log '@{u}..' --oneline 2>/dev/null)" ]; then
      git pull --rebase --autostash -q 2>/dev/null
      git push -q 2>/dev/null
    fi
    ;;
esac
exit 0
