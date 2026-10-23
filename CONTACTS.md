# Contact photos

Avatars prefer the contact's real photo from the system address book —
GNOME Contacts / evolution-data-server, which syncs the user's GOA accounts —
and fall back to initial-based avatars when none is found.

## How it works

- `src/contacts.ts` — resolution chain: `contact_photos` SQLite cache
  (30-day TTL) → EDS over the session bus via `busctl` → `null`.
  Every external call is defensive; any failure returns null and the UI
  shows initials. The EDS availability verdict is memoized for 60s so
  avatar-heavy pages don't spawn a `busctl` per image on EDS-less machines.
- `GET /api/contacts/photo?email=` — serves `image/*` bytes (browser-cached
  24h) or 404. The frontend renders
  `<img src="…" onerror="this.remove()">` inside the avatar, so a 404
  reveals the initials underneath with zero JS.
- `parseVCardPhoto` — extracts `PHOTO` from vCards: vCard 3.0 inline
  base64 (`PHOTO;ENCODING=b;TYPE=JPEG:…`, folded lines unfolded) and
  vCard 4.0 data URIs.

## Wiring the EDS lookup (one step left)

The D-Bus surface of evolution-data-server can't be verified from the build
machine — it must be read from the machine Cadence runs on:

```sh
./scripts/probe-eds.sh   # paste the whole output back
```

Then implement `edsVCardsForEmail()` in `src/contacts.ts` with the exact
service / object-path / method the probe reveals, e.g. (shape TBD):

```ts
// per address book: call the list method with an email query,
// collect the returned vCards, parseVCardPhoto() each
```

Until then the endpoint 404s and avatars stay initial-based — nothing breaks.
