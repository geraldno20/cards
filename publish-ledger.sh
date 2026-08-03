#!/usr/bin/env bash
# Publish a ledger CSV exported from the Transactions tab to the database file
# that GitHub Pages serves.
#
#   ./publish-ledger.sh                     # newest cards-transactions.csv in ~/Downloads
#   ./publish-ledger.sh path/to/file.csv    # a specific export
#   ./publish-ledger.sh -y                  # skip the confirmation prompt
#
# The browser's "Save to GitHub" button does the same thing without a terminal.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$REPO_ROOT/docs/data/transactions.csv"
ASSUME_YES=0
SRC=""

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) SRC="$arg" ;;
  esac
done

if [[ -z "$SRC" ]]; then
  # Newest matching export in ~/Downloads.
  SRC="$(find "$HOME/Downloads" -maxdepth 1 -name 'cards-transactions*.csv' -print0 2>/dev/null \
        | xargs -0 ls -t 2>/dev/null | head -1 || true)"
  if [[ -z "$SRC" ]]; then
    echo "No cards-transactions*.csv found in ~/Downloads." >&2
    echo "Export one from the Transactions tab, or pass a path: ./publish-ledger.sh path/to/file.csv" >&2
    exit 1
  fi
  echo "Using newest export: $SRC"
fi

[[ -f "$SRC" ]] || { echo "Not a file: $SRC" >&2; exit 1; }

# Refuse anything that isn't a ledger export — a wrong file here would overwrite
# the published database.
header="$(head -1 "$SRC")"
for col in "Sport" "Purchase Price" "Sold Price" "Profit"; do
  case "$header" in
    *"$col"*) ;;
    *) echo "Refusing: '$SRC' has no '$col' column. Is it a ledger export?" >&2; exit 1 ;;
  esac
done

new_rows=$(( $(wc -l < "$SRC") - 1 ))
old_rows=0
[[ -f "$TARGET" ]] && old_rows=$(( $(wc -l < "$TARGET") - 1 ))

echo
echo "  from : $SRC  ($new_rows rows)"
echo "  to   : docs/data/transactions.csv  ($old_rows rows currently)"
echo "  delta: $(( new_rows - old_rows )) rows"
echo

if [[ -f "$TARGET" ]] && cmp -s "$SRC" "$TARGET"; then
  echo "Identical to the published file — nothing to do."
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf "Commit and push this to the public repo? [y/N] "
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

cp "$SRC" "$TARGET"
cd "$REPO_ROOT"
git add docs/data/transactions.csv
if git diff --cached --quiet; then
  echo "No change staged — nothing to commit."
  exit 0
fi
git commit -q -m "Update card ledger ($new_rows rows)"
git push -q
echo "Pushed. GitHub Pages redeploys in a minute or two:"
echo "  https://$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+)/([^/.]+)(\.git)?#\1.github.io/\2#')/#transactions"
