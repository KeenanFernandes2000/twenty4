#!/usr/bin/env bash
# twenty4 — device upload test (curl + jq, NO bun needed). Termux-friendly.
# Usage: bash scripts/phone-upload.sh <API_URL> <PHOTO_PATH> [PHONE]
#   e.g. bash scripts/phone-upload.sh http://100.98.100.117:3000 /sdcard/DCIM/Camera/IMG.jpg
API="${1:?usage: phone-upload.sh <API_URL> <PHOTO_PATH> [PHONE]}"
PHOTO="${2:?need a photo path, e.g. /sdcard/DCIM/Camera/IMG.jpg}"
PHONE="${3:-+15557654321}"
C="curl -sS -m 20"   # -sS shows errors; -m 20 = fail instead of hanging forever

command -v jq   >/dev/null || { echo "ERROR: jq not installed -> run: pkg install jq";   exit 1; }
[ -f "$PHOTO" ]              || { echo "ERROR: photo not found: $PHOTO (run termux-setup-storage; check the path)"; exit 1; }

echo "0) reaching the API at $API ..."
HC=$($C -o /dev/null -w '%{http_code}' "$API/health" 2>&1) || { echo "   ❌ cannot reach $API/health  ($HC) — is the API running on the dev machine + are you on the same Tailscale/LAN?"; exit 1; }
[ "$HC" = "200" ] && echo "   ✅ API reachable (200)" || { echo "   ❌ /health returned $HC"; exit 1; }

ENC_PHONE=$(printf '%s' "$PHONE" | sed 's/+/%2B/')
NOW=$(date -u +%Y-%m-%dT%H:%M:%S+00:00); SIZE=$(wc -c < "$PHOTO")

echo "1) login ($PHONE) ..."
S=$($C -o /dev/null -w '%{http_code}' -X POST "$API/auth/start" -H 'content-type: application/json' -d "{\"identifier\":\"$PHONE\",\"channel\":\"phone\"}") || { echo "   ❌ /auth/start request failed/timed out"; exit 1; }
[ "$S" = "202" ] || { echo "   ❌ /auth/start -> $S (429 = OTP rate-limited; wait 15 min or flush otp keys on the dev machine)"; exit 1; }
CODE=$($C "$API/auth/dev/last-otp?identifier=$ENC_PHONE" | jq -r '.code // empty')
[ -n "$CODE" ] || { echo "   ❌ no dev OTP returned (is NODE_ENV != production?)"; exit 1; }
TOKEN=$($C -X POST "$API/auth/verify" -H 'content-type: application/json' -d "{\"identifier\":\"$PHONE\",\"channel\":\"phone\",\"code\":\"$CODE\"}" | jq -r '.token // empty')
[ -n "$TOKEN" ] && echo "   ✅ logged in" || { echo "   ❌ verify failed"; exit 1; }

echo "2) init ($SIZE bytes) ..."
INIT=$($C -X POST "$API/media" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"mediaType\":\"photo\",\"contentType\":\"image/jpeg\",\"byteSize\":$SIZE,\"deviceTimezone\":\"UTC\",\"deviceCapturedAt\":\"$NOW\"}")
ID=$(echo "$INIT" | jq -r '.id // empty'); URL=$(echo "$INIT" | jq -r '.uploadUrl // empty')
[ -n "$ID" ] && [ -n "$URL" ] || { echo "   ❌ init failed: $INIT"; exit 1; }
echo "   ✅ id=$ID  uploadUrl host=$(echo "$URL" | sed -E 's#^https?://([^/]+)/.*#\1#')"

echo "3) presigned PUT (upload the photo) ..."
PUT=$($C -o /dev/null -w '%{http_code}' -X PUT "$URL" -H 'content-type: image/jpeg' --upload-file "$PHOTO") || { echo "   ❌ PUT failed/timed out (can the phone reach the MinIO host:9000?)"; exit 1; }
[ "$PUT" = "200" ] && echo "   ✅ PUT 200" || { echo "   ❌ PUT -> $PUT"; exit 1; }

echo "4) complete ..."
$C -X POST "$API/media/$ID/complete" -H "authorization: Bearer $TOKEN" | jq -c '{processingStatus,validationStatus}'

echo "5) wait for validation ..."
for i in $(seq 1 20); do
  V=$($C "$API/media/today" -H "authorization: Bearer $TOKEN" | jq -r ".items[] | select(.id==\"$ID\") | .validationStatus")
  echo "   [$i] $V"; { [ "$V" = "valid" ] || [ "$V" = "invalid" ]; } && break; sleep 1
done

echo "6) download + byte-compare ..."
DURL=$($C "$API/media/$ID/download-url" -H "authorization: Bearer $TOKEN" | jq -r '.downloadUrl // empty')
if [ -n "$DURL" ]; then
  $C "$DURL" -o "/tmp/dl.$$" && (cmp -s "$PHOTO" "/tmp/dl.$$" && echo "   ✅ byte-match: downloaded == uploaded" || echo "   ❌ byte MISMATCH"); rm -f "/tmp/dl.$$"
else echo "   ❌ no download URL (verdict not valid?)"; fi

echo "7) cleanup ..."
$C -o /dev/null -w '   DELETE -> %{http_code}\n' -X DELETE "$API/media/$ID" -H "authorization: Bearer $TOKEN"
echo "DONE ✅"
