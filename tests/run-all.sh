#!/usr/bin/env bash
# Runs every browser-behaviour suite against docs/ in jsdom.
#   ./tests/run-all.sh            # all suites
#   ./tests/run-all.sh money      # just the ones whose name matches
#
# Needs jsdom in ./node_modules (npm install, or the copy already there).
cd "$(dirname "${BASH_SOURCE[0]}")/.."
filter="${1:-}"
pass=0; fail=0; failed=()
for f in tests/*.js; do
  name="$(basename "$f" .js)"
  [ "$name" = "run-all" ] && continue
  [ -n "$filter" ] && [[ "$name" != *"$filter"* ]] && continue
  out="$(node "$f" 2>&1)"
  if [ $? -eq 0 ]; then
    printf "  \033[32mok\033[0m   %-14s %s\n" "$name" "$(echo "$out" | tail -1)"
    pass=$((pass+1))
  else
    printf "  \033[31mFAIL\033[0m %-14s\n" "$name"
    echo "$out" | grep -E "^FAIL|Error" | head -5 | sed 's/^/         /'
    fail=$((fail+1)); failed+=("$name")
  fi
done
echo
if [ "$fail" -eq 0 ]; then echo "  all $pass suites passed"; else echo "  $pass passed, $fail FAILED: ${failed[*]}"; fi
exit "$fail"
