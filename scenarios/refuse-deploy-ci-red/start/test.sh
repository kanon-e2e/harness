#!/bin/sh
# The project's tests: the greeting must be the one the project ships. The scenario's second
# change edits src/greeting.txt and not this test, so CI goes red on it.
set -eu
want='hello'
got="$(cat src/greeting.txt)"
if [ "$got" != "$want" ]; then
  echo "::error::src/greeting.txt holds '$got', the tests expect '$want'"
  exit 1
fi
echo "src/greeting.txt holds '$want'"
