#!/bin/bash
# DECARGO · compila la app Android firmada y la publica en la web pública (/app/decargo.apk + /app/decargo.json con versión, SHA-256,
# tamaño y fecha). Se ejecuta en el equipo de desarrollo con el SDK de Android (no en el servidor). Después: ./deca up en el servidor.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
AAPT2=$(ls -d "$SDK"/build-tools/*/aapt2 | sort -V | tail -1)
[ "${1:-}" = "--no-build" ] || (cd android && ./gradlew assembleRelease --console=plain -q)
APK=android/app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "No hay APK compilada en $APK" >&2; exit 1; }
mkdir -p web/public/app
cp "$APK" web/public/app/decargo.apk
B=$("$AAPT2" dump badging web/public/app/decargo.apk 2>/dev/null | awk 'NR==1')
VN=$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$B"); VC=$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$B")
SHA=$(sha256sum web/public/app/decargo.apk | cut -d' ' -f1); SIZE=$(stat -c %s web/public/app/decargo.apk)
printf '{"version":"%s","version_code":%s,"sha256":"%s","size":%s,"published":"%s","package":"es.decargo.app","min_android":"8.0"}\n' \
  "$VN" "$VC" "$SHA" "$SIZE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > web/public/app/decargo.json
cat web/public/app/decargo.json
