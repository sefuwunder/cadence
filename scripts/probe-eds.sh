#!/bin/sh
# probe-eds.sh — run on your machine, paste the whole output back to Muse.
# Discovers how evolution-data-server (GOA-synced contacts) exposes address
# books on your session bus, so Cadence can wire contact photos into avatars.
set -u

echo "=== 1. EDS names on the session bus ==="
busctl --user list --no-legend 2>/dev/null | grep -i -E "evolution|addressbook|folks" || echo "(none found)"

echo ""
echo "=== 2. AddressBook factory object tree ==="
busctl --user tree org.gnome.evolution.dataserver.AddressBook10 2>&1 | head -30 || true

echo ""
echo "=== 3. SourceManager (lists configured address books) ==="
busctl --user tree org.gnome.evolution.dataserver.SourceManager 2>&1 | head -20 || true

echo ""
echo "=== 4. addressbook-export helper ==="
ls /usr/libexec/evolution-data-server/ 2>/dev/null | grep -i address || echo "(not present)"

echo ""
echo "=== 5. EDS source files (GOA-backed address books show here) ==="
ls ~/.config/evolution/sources/ 2>/dev/null | head -20 || echo "(no sources dir)"
for f in ~/.config/evolution/sources/*; do
  [ -f "$f" ] || continue
  if grep -qi -E "addressbook|contacts" "$f" 2>/dev/null; then
    echo "--- $f"
    grep -E "DisplayName|BackendName|Enabled|Uid" "$f" 2>/dev/null | head -8
  fi
done

echo ""
echo "=== 6. GOA accounts (for reference) ==="
busctl --user list --no-legend 2>/dev/null | grep -i "Goa" || echo "(no Goa names)"
