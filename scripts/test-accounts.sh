#!/bin/bash
# Exercises the account API against a running install.
#
# Confinement is the security-critical part of this project, so it is checked
# rather than assumed: reading, writing, deleting and moving outside an account's
# folder must all be refused, including by way of "..".
#
#   BASE=http://127.0.0.1:8099 ADMIN=me ADMIN_PW=... ./scripts/test-accounts.sh
#
# It creates and deletes accounts named test-* and writes into their folders.
# Point it at a throwaway install, never at one in service.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8099}"
ADMIN="${ADMIN:?set ADMIN to an administrator account}"
ADMIN_PW="${ADMIN_PW:?set ADMIN_PW}"
PW_A="pw-confined-account"
PW_B="pw-open-account"
JAR=$(mktemp -d)
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
ko() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s (expected %s, got %s)\n' "$1" "$3" "$2"; }
is() { [ "$2" = "$3" ] && ok "$1" || ko "$1" "$2" "$3"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
json() { printf '%s' "$1"; }

cleanup() {
  for u in test-confined test-open; do
    curl -s -o /dev/null -b "$JAR/admin" -H 'X-Depot: 1' -X DELETE "$BASE/api/users/$u"
  done
  rm -rf "$JAR"
}
trap cleanup EXIT

echo "sign in"
is "administrator signs in" \
  "$(code -c "$JAR/admin" -X POST -H 'Content-Type: application/json' \
      -d "$(json "{\"user\":\"$ADMIN\",\"password\":\"$ADMIN_PW\"}")" "$BASE/api/login")" 200

echo
echo "creating accounts"
is "confined account created" \
  "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d "$(json "{\"name\":\"test-confined\",\"password\":\"$PW_A\",\"root\":\"test-confined\"}")" "$BASE/api/users")" 201
is "unconfined account created" \
  "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d "$(json "{\"name\":\"test-open\",\"password\":\"$PW_B\"}")" "$BASE/api/users")" 201
is "duplicate refused" \
  "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d "$(json "{\"name\":\"test-confined\",\"password\":\"$PW_A\"}")" "$BASE/api/users")" 409
is "short password refused" \
  "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d '{"name":"test-weak","password":"short"}' "$BASE/api/users")" 400
is "traversal in name refused" \
  "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d '{"name":"../escape","password":"long-enough-password"}' "$BASE/api/users")" 400
is "write without X-Depot refused" \
  "$(code -b "$JAR/admin" -X POST -H 'Content-Type: application/json' \
      -d '{"name":"test-noheader","password":"long-enough-password"}' "$BASE/api/users")" 403

echo
echo "confinement"
curl -s -c "$JAR/a" -X POST -H 'Content-Type: application/json' \
  -d "$(json "{\"user\":\"test-confined\",\"password\":\"$PW_A\"}")" "$BASE/api/login" >/dev/null
echo probe > "$JAR/probe.txt"
is "sees its own folder"        "$(code -b "$JAR/a" "$BASE/api/fs/test-confined/?json")" 200
is "cannot see the drop root"   "$(code -b "$JAR/a" "$BASE/api/fs/?json")" 403
is "cannot climb out with .."   "$(code -b "$JAR/a" "$BASE/api/fs/test-confined/../?json")" 403
is "writes inside its folder"   "$(code -b "$JAR/a" -H 'X-Depot: 1' -T "$JAR/probe.txt" "$BASE/api/fs/test-confined/probe.txt")" 201
is "cannot write outside"       "$(code -b "$JAR/a" -H 'X-Depot: 1' -T "$JAR/probe.txt" "$BASE/api/fs/outside.txt")" 403
is "cannot delete outside"      "$(code -b "$JAR/a" -H 'X-Depot: 1' -X DELETE "$BASE/api/fs/outside.txt")" 403
is "cannot move out of its folder" \
  "$(code -b "$JAR/a" -H 'X-Depot: 1' -H "Destination: $BASE/api/fs/escaped.txt" -X MOVE "$BASE/api/fs/test-confined/probe.txt")" 403
is "moves within its folder" \
  "$(code -b "$JAR/a" -H 'X-Depot: 1' -H "Destination: $BASE/api/fs/test-confined/moved.txt" -X MOVE "$BASE/api/fs/test-confined/probe.txt")" 204

echo
echo "a guest is not an administrator"
is "cannot list accounts"  "$(code -b "$JAR/a" "$BASE/api/users")" 403
is "cannot create accounts" \
  "$(code -b "$JAR/a" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d '{"name":"test-sneak","password":"long-enough-password"}' "$BASE/api/users")" 403

echo
echo "an unconfined account sees everything"
curl -s -c "$JAR/b" -X POST -H 'Content-Type: application/json' \
  -d "$(json "{\"user\":\"test-open\",\"password\":\"$PW_B\"}")" "$BASE/api/login" >/dev/null
is "sees the drop root"        "$(code -b "$JAR/b" "$BASE/api/fs/?json")" 200
is "sees another's folder"     "$(code -b "$JAR/b" "$BASE/api/fs/test-confined/?json")" 200

echo
echo "self-service password change"
is "wrong current password refused" \
  "$(code -b "$JAR/a" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d '{"current":"wrong","new":"brand-new-password"}' "$BASE/api/password")" 401
cp "$JAR/a" "$JAR/a.old"
is "change accepted" \
  "$(code -b "$JAR/a" -c "$JAR/a" -H 'X-Depot: 1' -X POST -H 'Content-Type: application/json' \
      -d "$(json "{\"current\":\"$PW_A\",\"new\":\"brand-new-password\"}")" "$BASE/api/password")" 200
is "old session dropped"       "$(code -b "$JAR/a.old" "$BASE/api/fs/test-confined/?json")" 401
is "refreshed session still valid" "$(code -b "$JAR/a" "$BASE/api/fs/test-confined/?json")" 200
is "new password works" \
  "$(code -X POST -H 'Content-Type: application/json' \
      -d '{"user":"test-confined","password":"brand-new-password"}' "$BASE/api/login")" 200

echo
echo "administrator guard rails"
is "cannot delete own account" "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X DELETE "$BASE/api/users/$ADMIN")" 400
is "resets a password" \
  "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X PATCH -H 'Content-Type: application/json' \
      -d '{"password":"reset-by-the-admin"}' "$BASE/api/users/test-open")" 200
is "deletes an account"        "$(code -b "$JAR/admin" -H 'X-Depot: 1' -X DELETE "$BASE/api/users/test-open")" 200
is "deleted account cannot sign in" \
  "$(code -X POST -H 'Content-Type: application/json' \
      -d '{"user":"test-open","password":"reset-by-the-admin"}' "$BASE/api/login")" 401
is "deleted account's session is dead" "$(code -b "$JAR/b" "$BASE/api/fs/?json")" 401

echo
printf '  ── %d passed, %d failed ──\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
