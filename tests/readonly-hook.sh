#!/bin/sh
# Tests the read-only hook (hooks/readonly.ts) the way agy calls it: a PreToolUse payload on stdin,
# a decision on stdout. Run: sh tests/readonly-hook.sh
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
perl -0777 -ne 'print $1 if /String\.raw`(.*)`/s' "$here/hooks/readonly.ts" > "$tmp/hook.pl"
perl -c "$tmp/hook.pl" 2>/dev/null || { echo "FAIL: the hook does not compile"; exit 1; }

fails=0
# expect <allow|deny|none> <tool> <json args>
expect() {
  want=$1 tool=$2 args=$3
  got=$(printf '{"toolCall":{"name":"%s","args":%s}}' "$tool" "$args" | HOME=/home/u AGY4CLAUDE_READONLY=${RO-1} perl "$tmp/hook.pl")
  case $got in
    *'"decision":"allow"'*) d=allow ;;
    *'"decision":"deny"'*) d=deny ;;
    '{}') d=none ;;
    *) d="?($got)" ;;
  esac
  if [ "$d" != "$want" ]; then echo "FAIL: $tool $args -> $d, want $want"; fails=$((fails + 1)); fi
}
cmd() { expect "$1" run_command "$(printf '%s' "$2" | perl -MJSON::PP -0777 -ne 'print JSON::PP->new->encode({CommandLine => $_})')"; }

cmd allow 'git diff main...collect-tally --stat'
cmd allow 'git diff main...collect-tally -- core/src/db.ts'
cmd allow 'git grep -n "localDate\|taiwanDayStart\|TZ" core/'
cmd allow 'git log --oneline -5 2>&1 | tail -3'
cmd allow 'git -C /repo status --short'
cmd allow 'git branch -a'
cmd allow 'cd core && grep -rn foo . | head -20'
cmd allow 'ls -la 2>/dev/null'
cmd allow "sed -n '1,20p' a.ts"
cmd allow 'find . -name "*.ts" -not -path "./node_modules/*"'
cmd allow 'rg -n "TODO" src | wc -l'
cmd allow 'cat a.txt; echo done'
cmd deny 'deno test core/src/tally*'
cmd deny 'deno test --no-check core/src/tally*'
cmd deny 'npm run build'
cmd deny 'npx tsc --noEmit'
cmd deny 'cargo build'
cmd deny 'make'
cmd deny 'rm -rf build'
cmd deny 'touch made.txt'
cmd deny 'git checkout main'
cmd deny 'git commit -am x'
cmd deny 'git branch -D old'
cmd deny 'git -c core.pager=evil log'
cmd deny 'git grep -O vim foo'
cmd deny 'git diff --output=/tmp/x.patch'
cmd deny 'git diff > /tmp/x.patch'
cmd deny 'cat a >> b'
cmd deny 'echo $(rm -rf /)'
cmd deny 'echo `id`'
cmd deny "sed -i '' s/a/b/ a.ts"
cmd deny 'find . -name "*.o" -delete'
cmd deny 'find . -exec rm {} \;'
cmd deny 'sort -o out.txt in.txt'
cmd deny 'rg --pre ./x foo'
cmd allow 'tree -L 2 src'
cmd deny 'tree -o listing.txt'
cmd deny 'FOO=1 ls'
cmd deny 'ls && deno task build'
cmd deny 'ls | xargs rm'
expect allow run_command '{"CommandLine":"\"ls\""}'
expect deny write_to_file '{"TargetFile":"/repo/src/a.ts","CodeContent":"x"}'
expect deny replace_file_content '{"TargetFile":"/home/u/.gemini/../repo/a.ts"}'
expect allow write_to_file '{"TargetFile":"/home/u/.gemini/antigravity-cli/brain/c1/plan.md"}'
expect none view_file '{"AbsolutePath":"/repo/a.ts"}'
RO=0 expect none run_command '{"CommandLine":"rm -rf build"}'

if [ "$fails" -eq 0 ]; then echo "readonly hook: all cases pass"; else echo "readonly hook: $fails failed"; exit 1; fi
