#!/usr/bin/env bash
# Adds Jarvis to the app menu with its own icon, so it opens and pins like any other app.
# Everything goes in your home folder. Nothing needs sudo.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
MENU_DIR="$HOME/.local/share/applications"
LAUNCHER="$HOME/.Jarvis/launch.sh"

mkdir -p "$ICON_DIR" "$MENU_DIR" "$HOME/.Jarvis"
cp "$APP_DIR/assets/jarvis.svg" "$ICON_DIR/jarvis.svg"

# The launcher exists because this folder's name contains an apostrophe and a space,
# which .desktop files handle badly.
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
cd "$APP_DIR"
export CHROME_DESKTOP=jarvis.desktop
exec "$APP_DIR/node_modules/electron/dist/electron" . "\$@"
EOF
chmod +x "$LAUNCHER"

cat > "$MENU_DIR/jarvis.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Jarvis
Comment=Your personal voice assistant
Exec=$LAUNCHER
Icon=jarvis
Terminal=false
Categories=Utility;
StartupWMClass=jarvis
StartupNotify=true
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$MENU_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
echo "Jarvis is in your app menu."
