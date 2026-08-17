#!/bin/bash
# Exercises links, the bin, and the upload webhook against a running install.
#
# What matters here is what a link must refuse: a share link may not write, a drop
# link may not read, and neither may leave the path it was made for. Traversal is
# neutralised rather than rejected — the assertions below check where the bytes
# actually landed, not just the status code.
#
#   BASE=http://127.0.0.1:8099 ADMIN=me ADMIN_PW=... DATA=/srv/depot/upload \
#     ./scripts/test-links.sh
#
# It writes and deletes files under DATA. Point it at a throwaway install.
set -uo pipefail

BASE="${BASE:?set BASE to the service URL}"
ADMIN="${ADMIN:?set ADMIN to an administrator account}"
ADMIN_PW="${ADMIN_PW:?set ADMIN_PW}"
DATA="${DATA:?set DATA to the served folder on disk}"
JAR=$(mktemp -d)
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
ko() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s (expected %s, got %s)\n' "$1" "$3" "$2"; }
is() { [ "$2" = "$3" ] && ok "$1" || ko "$1" "$2" "$3"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
trap 'rm -rf "$JAR"' EXIT

curl -s -c "$JAR/j" -X POST -H 'Content-Type: application/json' \
  -d "{\"user\":\"$ADMIN\",\"password\":\"$ADMIN_PW\"}" "$BASE/api/login" >/dev/null
echo probe > "$JAR/f.txt"

echo "== bin =="
curl -s -o /dev/null -b "$JAR/j" -H 'X-Depot: 1' -T "$JAR/f.txt" "$BASE/api/fs/jetable.txt"
is "delete accepted" "$(code -b "$JAR/j" -H 'X-Depot: 1' -X DELETE "$BASE/api/fs/jetable.txt")" 204
sleep 1
[ -z "$(ls "$DATA"/jetable.txt 2>/dev/null)" ] && ok "file left its place" || ko "fichier retire" present absent
TR=$(ls "$DATA"/.trash/ 2>/dev/null | head -1)
[ -n "$TR" ] && ok "file found in the bin ($TR)" || ko "bin" empty "1 fichier"
is "deleting from inside the bin really removes" \
  "$(code -b "$JAR/j" -H 'X-Depot: 1' -X DELETE "$BASE/api/fs/.trash/$TR")" 204
sleep 1
[ -z "$(ls "$DATA"/.trash/ 2>/dev/null)" ] && ok "bin emptied" || ko "bin emptied" "reste" empty

echo
echo "== share link (read only) =="
curl -s -o /dev/null -b "$JAR/j" -H 'X-Depot: 1' -T "$JAR/f.txt" "$BASE/api/fs/public.txt"
S=$(curl -s -b "$JAR/j" -H 'X-Depot: 1' -H 'Content-Type: application/json' \
  -d '{"kind":"share","path":"/public.txt","days":7}' $BASE/api/links | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$S" ] && ok "share link created" || ko "lien cree" empty token
is "reads without an account"        "$(code "$BASE/api/linkfs/$S/fs/")" 200
is "writes refused"           "$(code -H 'X-Depot: 1' -T "$JAR/f.txt" "$BASE/api/linkfs/$S/fs/intrus.txt")" 403
is "deletes refused"        "$(code -H 'X-Depot: 1' -X DELETE "$BASE/api/linkfs/$S/fs/")" 403
# Les ".." sont neutralises, pas refuses: le chemin est ramene dans le partage,
# donc on tombe sur un fichier inexistant plutot que sur une evasion.
is "traversal neutralised (share)" "$(code --path-as-is "$BASE/api/linkfs/$S/fs/%2e%2e/%2e%2e/secret.txt")" 404
is "unknown token refused"       "$(code "$BASE/api/link/nexistepas")" 404

echo
echo "== drop link (write only) =="
DR=$(curl -s -b "$JAR/j" -H 'X-Depot: 1' -H 'Content-Type: application/json' \
  -d '{"kind":"drop","path":"/boite","days":0}' $BASE/api/links | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$DR" ] && ok "drop link created" || ko "lien cree" empty token
[ -d "$DATA"/boite ] && ok "target folder created" || ko "dossier cible" absent present
is "uploads without an account"          "$(code -H 'X-Depot: 1' -T "$JAR/f.txt" "$BASE/api/linkfs/$DR/fs/envoi.txt")" 201
[ -f "$DATA"/boite/envoi.txt ] && ok "file landed in the right place" || ko "fichier arrive" absent present
is "listing refused"             "$(code "$BASE/api/linkfs/$DR/fs/?json")" 403
is "reading a file refused" "$(code "$BASE/api/linkfs/$DR/fs/envoi.txt")" 403
is "deletes refused"        "$(code -H 'X-Depot: 1' -X DELETE "$BASE/api/linkfs/$DR/fs/envoi.txt")" 403
code --path-as-is -H 'X-Depot: 1' -T "$JAR/f.txt" "$BASE/api/linkfs/$DR/fs/%2e%2e/dehors.txt" >/dev/null
[ -f "$DATA"/boite/dehors.txt ] && ok "traversal folded back into the box" || ko "traversee" "hors boite" "dans la boite"
is "door outside /fs refused"     "$(code "$BASE/api/linkfs/$DR/autre-chose.txt")" 404
[ ! -f "$DATA"/dehors.txt ] && ok "nothing escaped the box" || ko "evasion" "fichier ecrit" rien

echo
echo "== revoked =="
is "revoked"                 "$(code -b "$JAR/j" -H 'X-Depot: 1' -X DELETE "$BASE/api/links/$S")" 200
is "revoked link is unusable"  "$(code "$BASE/api/linkfs/$S/fs/")" 404

echo
echo "== upload webhook =="
# c'est le client qui annonce la fin d'un fichier: le service ne voit que des tranches
curl -s -o /dev/null -H 'Content-Type: application/json' -d '{"path":"envoi.txt"}' \
  "$BASE/api/linknotify/$DR"
curl -s -o /dev/null -b "$JAR/j" -H 'X-Depot: 1' -H 'Content-Type: application/json' \
  -d '{"path":"/public.txt"}' "$BASE/api/notify"
sleep 3
if [ -f /tmp/webhook.log ]; then
  N=$(grep -c '"event"' /tmp/webhook.log 2>/dev/null || echo 0)
  [ "$N" -ge 1 ] && ok "webhook fired ($N evenement(s))" || ko "webhook" 0 "au moins 1"
  grep -o '"name":"[^"]*"' /tmp/webhook.log | tail -2 | sed 's/^/      /'
else
  ko "webhook" "no log" "log"
fi

echo
printf '  ── %d passed, %d failed ──\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
