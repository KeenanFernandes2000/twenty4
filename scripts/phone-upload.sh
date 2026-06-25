#!/usr/bin/env bash
# twenty4 — device upload test (curl + jq, NO bun needed)
# Usage: ./phone-upload.sh <API_URL> <PHOTO_PATH> [PHONE]
set -e
API="${1:?usage: phone-upload.sh <API_URL> <PHOTO_PATH> [PHONE]}"
PHOTO="${2:?need a photo path, e.g. /sdcard/DCIM/Camera/IMG.jpg}"
PHONE="${3:-+15557654321}"
ENC_PHONE=$(printf '%s' "$PHONE" | sed 's/+/%2B/')
TZ_NAME="UTC"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
SIZE=$(wc -c < "$PHOTO")

echo "1) login ($PHONE) ..."
curl -s -X POST "$API/auth/start" -H 'content-type: application/json' \
  -d "{\"identifier\":\"$PHONE\",\"channel\":\"phone\"}" >/dev/null
CODE=$(curl -s "$API/auth/dev/last-otp?identifier=$ENC_PHONE" | jq -r '.code')
TOKEN=$(curl -s -X POST "$API/auth/verify" -H 'content-type: application/json' \
  -d "{\"identifier\":\"$PHONE\",\"channel\":\"phone\",\"code\":\"$CODE\"}" | jq -r '.token')
[ "$TOKEN" != "null" ] && echo "   token ok" || { echo "   LOGIN FAILED"; exit 1; }

echo "2) init ($SIZE bytes) ..."
INIT=$(curl -s -X POST "$API/media" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"mediaType\":\"photo\",\"contentType\":\"image/jpeg\",\"byteSize\":$SIZE,\"deviceTimezone\":\"$TZ_NAME\",\"deviceCapturedAt\":\"$NOW\"}")
ID=$(echo "$INIT" | jq -r '.id'); URL=$(echo "$INIT" | jq -r '.uploadUrl')
echo "   id=$ID  uploadUrl host=$(echo "$URL" | sed -E 's#^https?://([^/]+)/.*#\1#')"

echo "3) presigned PUT ..."
PUT=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$URL" -H 'content-type: image/jpeg' --upload-file "$PHOTO")
echo "   PUT -> $PUT"

echo "4) complete ..."
curl -s -X POST "$API/media/$ID/complete" -H "authorization: Bearer $TOKEN" | jq -c '{processingStatus,validationStatus}'

echo "5) poll validation ..."
for i in $(seq 1 15); do
  V=$(curl -s "$API/media/today" -H "authorization: Bearer $TOKEN" | jq -r ".items[] | select(.id==\"$ID\") | .validationStatus")
  echo "   [$i] $V"; [ "$V" = "valid" ] && break; [ "$V" = "invalid" ] && break; sleep 1
done

echo "6) download + byte-compare ..."
DURL=$(curl -s "$API/media/$ID/download-url" -H "authorization: Bearer $TOKEN" | jq -r '.downloadUrl')
curl -s "$DURL" -o /tmp/dl.$$ 
if cmp -s "$PHOTO" /tmp/dl.$$; then echo "   ✅ byte-match: downloaded == uploaded"; else echo "   ❌ byte MISMATCH"; fi
rm -f /tmp/dl.$$

echo "7) cleanup ..."
curl -s -o /dev/null -w '   DELETE -> %{http_code}\n' -X DELETE "$API/media/$ID" -H "authorization: Bearer $TOKEN"
echo "DONE"
