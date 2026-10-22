#!/bin/sh
# Run a heavy step on tenet (Arch x86_64, 16 threads, 15 GB) instead of on
# this 8 GB Mac, against this checkout as it stands: its commit plus any
# changes to tracked files (new files count once they are `git add`ed).
#
#   sh scripts/tenet.sh bun test
#   sh scripts/tenet.sh bun run typecheck
#   make tenet RUN="bun run lint"
#
# The snapshot goes over ssh as refs/heads/sync/<branch> into ~/work/ruri on
# tenet, never to GitHub, so unmerged branches stay off origin. Each branch
# runs in a worktree of its own there (~/work/ruri-wt/<branch>) with its own
# node_modules, installed again only when bun.lock changes; two runs of one
# branch wait for each other. Editing and git stay on the Mac.
#
# A scratch server there is reached through a forward from the Mac:
#   ssh -N -L 7777:127.0.0.1:7777 tenet
# Real-turn scripts need the coding CLI signed in on tenet (once, by hand).
set -eu
host=${TENET:-tenet}
[ $# -gt 0 ] || { echo "usage: sh scripts/tenet.sh <command…>" >&2; exit 2; }

branch=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
[ "$branch" = HEAD ] && branch=detached
snapshot=$(git stash create)
snapshot=${snapshot:-$(git rev-parse HEAD)}
git push -q -f "$host:work/ruri" "$snapshot:refs/heads/sync/$branch"

# the command, quoted for the remote shell
cmd=""
for arg in "$@"; do cmd="$cmd '$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"; done

ssh "$host" "sh -s -- '$branch' $cmd" <<'EOF'
set -eu
branch=$1
shift
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
repo=$HOME/work/ruri
wt=$HOME/work/ruri-wt/$branch
mkdir -p "$HOME/work/ruri-wt"
[ -d "$wt" ] || git -C "$repo" worktree add -q --detach "$wt" "sync/$branch"
cd "$wt"
exec 9> "$wt.lock"
flock 9
git checkout -q -f --detach "sync/$branch"
git clean -fdq
lock=$(sha256sum bun.lock | cut -c1-64)
if [ "$(cat node_modules/.ruri-lock 2>/dev/null)" != "$lock" ]; then
  bun install --frozen-lockfile >/dev/null
  echo "$lock" > node_modules/.ruri-lock
fi
echo "tenet: $(git rev-parse --short HEAD) in $wt"
"$@"
EOF
