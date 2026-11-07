#!/bin/sh
# Builds Nick-1.0.0.jar for the companion-survival Paper server (docs/MINECRAFT.md "Nick plugin").
# LIB: a folder with the server's paper-api, net/kyori, net/md-5 and jspecify jars (from /srv/companion-survival/libraries).
set -eu
here=$(cd "$(dirname "$0")" && pwd); LIB=${LIB:?set LIB to the folder of API jars}; JDK=${JDK:-$HOME/.jdks/openjdk-25.0.2}
out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
"$JDK/bin/javac" --release 25 -cp "$LIB/*" -d "$out" "$here"/src/dev/blackoutburst/nick/*.java
cp "$here/plugin.yml" "$out/"
(cd "$out" && "$JDK/bin/jar" cf "$here/Nick-1.0.0.jar" .)
echo "$here/Nick-1.0.0.jar"
