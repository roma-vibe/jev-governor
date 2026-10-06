#!/bin/sh
# Points .git/hooks/pre-commit at scripts/pre-commit of whichever checkout
# (or worktree) commits.
set -e
hooks=$(git rev-parse --git-common-dir)/hooks
cat > "$hooks/pre-commit" <<'HOOK'
#!/bin/sh
top=$(git rev-parse --show-toplevel)
if [ -f "$top/scripts/pre-commit" ]; then exec sh "$top/scripts/pre-commit"; fi
# A checkout from before scripts/pre-commit: validate the mod only.
if git diff --cached --name-only | grep -q '^hooks/\|^\.claude-plugin/'; then
  sh "$top/scripts/validate.sh" || { echo "pre-commit: plugin validate failed" >&2; exit 1; }
fi
HOOK
chmod +x "$hooks/pre-commit"
echo "pre-commit hook installed in $hooks"
