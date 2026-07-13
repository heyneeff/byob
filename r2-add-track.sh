#!/bin/bash
# Upload a local audio file to Cloudflare R2 (zero egress fees) and register
# it as a BYOB track row in Supabase, so it shows up in artist.html's library.
#
# One-time setup (all free tier):
#   1. npx wrangler login                    # opens browser, Cloudflare auth
#   2. npx wrangler r2 bucket create byob-audio
#   3. npx wrangler r2 bucket dev-url enable byob-audio
#      -> note the https://pub-XXXX.r2.dev URL it prints
#   4. export R2_PUBLIC_BASE='https://pub-XXXX.r2.dev'
#      export SUPABASE_URL='https://NEWREF.supabase.co'
#      export SUPABASE_KEY='eyJ...'          # anon key is fine (tracks RLS
#                                            # requires auth for insert — use
#                                            # service_role key here instead)
#
# Usage:
#   ./r2-add-track.sh path/to/track.mp3 "Track Title"
set -euo pipefail

FILE="${1:?usage: r2-add-track.sh <audio-file> [title]}"
TITLE="${2:-$(basename "${FILE%.*}")}"
BUCKET="${R2_BUCKET:-byob-audio}"
BASE="${R2_PUBLIC_BASE:?set R2_PUBLIC_BASE to your https://pub-....r2.dev URL}"
SB_URL="${SUPABASE_URL:?set SUPABASE_URL}"
SB_KEY="${SUPABASE_KEY:?set SUPABASE_KEY (service_role for insert)}"

EXT="${FILE##*.}"
case "$EXT" in
  mp3) MIME=audio/mpeg ;; m4a) MIME=audio/mp4 ;; wav) MIME=audio/wav ;;
  ogg) MIME=audio/ogg ;; *) MIME=application/octet-stream ;;
esac

# Safe object key: keep it stable so phones cache it (no cache-busting).
KEY="tracks/$(basename "$FILE" | tr ' ' '_' | tr -cd 'A-Za-z0-9._-')"

echo "Uploading $FILE -> r2://$BUCKET/$KEY ($MIME)"
npx wrangler r2 object put "$BUCKET/$KEY" --file "$FILE" --content-type "$MIME" --remote

URL="$BASE/$KEY"
echo "Public URL: $URL"

echo "Registering track row in Supabase..."
curl -sf -X POST "$SB_URL/rest/v1/tracks" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"title\": \"$TITLE\", \"file_path\": \"$KEY\", \"public_url\": \"$URL\"}" \
  && echo && echo "DONE — '$TITLE' is in the library, served from R2."
