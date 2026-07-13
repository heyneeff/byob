#!/bin/bash
# Repoint every BYOB file from the old (quota-restricted) Supabase project
# to a new one. Usage:
#   ./swap-supabase.sh https://NEWREF.supabase.co 'eyJNEW_ANON_KEY...'
#
# Replaces the old project URL and the old anon key everywhere they are
# hardcoded (~17 html/js/mjs files). Idempotent; prints what changed.
set -euo pipefail

NEW_URL="${1:?usage: swap-supabase.sh <new-url> <new-anon-key>}"
NEW_KEY="${2:?usage: swap-supabase.sh <new-url> <new-anon-key>}"

OLD_URL='https://ohacvuwzvuifpyqckise.supabase.co'
# Old anon key prefix — matched as a whole eyJ... token below.
DIR="$(cd "$(dirname "$0")" && pwd)"

FILES=$(grep -rl "$OLD_URL" "$DIR" --include='*.html' --include='*.js' --include='*.mjs' || true)
if [ -z "$FILES" ]; then echo "Nothing references the old URL — already swapped?"; exit 0; fi

# Grab the old anon key from the first file that has both URL and a JWT.
OLD_KEY=$(grep -hoE 'eyJ[A-Za-z0-9_.-]{40,}' $FILES | sort -u | head -1)
echo "Old key: ${OLD_KEY:0:24}..."
echo "New URL: $NEW_URL"

for f in $FILES; do
  sed -i '' "s|$OLD_URL|$NEW_URL|g; s|$OLD_KEY|$NEW_KEY|g" "$f"
  echo "  swapped: $f"
done

LEFT=$(grep -rl "$OLD_URL\|$OLD_KEY" "$DIR" --include='*.html' --include='*.js' --include='*.mjs' || true)
[ -z "$LEFT" ] && echo "DONE — all references updated." || { echo "STILL REFERENCING OLD PROJECT:"; echo "$LEFT"; exit 1; }
