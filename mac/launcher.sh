#!/bin/bash
# Midtown Strike for macOS.
#
# The game is one self-contained HTML file inside this app bundle. This
# launcher opens it in its own app-style window when a Chromium browser is
# installed (Chrome, Edge, Brave), and in the default browser otherwise.
HERE="$(cd "$(dirname "$0")" && pwd)"
GAME_DIR="$(cd "$HERE/../Resources/game" 2>/dev/null && pwd)"
GAME="$GAME_DIR/index.html"
if [ -z "$GAME_DIR" ] || [ ! -f "$GAME" ]; then
  osascript -e 'display alert "Midtown Strike" message "The game files are missing from the app. Download it again."' >/dev/null 2>&1
  exit 1
fi
# file:// URL with the characters that matter in a path percent-encoded
URL="file://$(printf '%s' "$GAME" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/#/%23/g' -e 's/?/%3F/g' -e 's/"/%22/g')"
for APP in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  for DIR in "/Applications" "$HOME/Applications"; do
    if [ -d "$DIR/$APP.app" ]; then
      open -na "$DIR/$APP.app" --args --app="$URL" --window-size=1440,900 && exit 0
    fi
  done
done
exec open "$GAME"
