# Contact photos

Avatars prefer the contact's real photo from the system address book —
GNOME Contacts / evolution-data-server, which syncs the user's GOA accounts —
and fall back to initial-based avatars when none is found.

## How it works

- **Bulk sync** (`syncPhotosFromEDS` in `src/contacts.ts`): at server start
  (background, non-fatal) and on demand via
  `POST /api/contacts/photos/sync`. It finds enabled contacts sources by
  scanning `~/.config/evolution/sources/*.source` (`ContactsEnabled=true`),
  exports each with `addressbook-export --format=vcard <uid>`, indexes every
  `EMAIL` → `PHOTO`, and upserts into the `contact_photos` table. The sync
  endpoint returns `{books, contacts, photos, errors[]}` — verbose on
  purpose, so a wrong CLI guess is diagnosable from the JSON alone.
  Override the binary with `CADENCE_ADDRESSBOOK_EXPORT`, the sources dir
  with `CADENCE_EDS_SOURCES` (tests).
- **Serving**: `GET /api/contacts/photo?email=` reads the cache only —
  fast, no D-Bus per avatar. 404 → the UI falls back to initials.
  404s are `no-store` (a freshly uploaded photo shows immediately);
  hits browser-cached 24h; server cache 30 days.
- **Manual avatars**: `POST /api/contacts/photo` `{email, data}` where data
  is a `data:image/…;base64,…` URI or raw base64 (JPEG/PNG/GIF/WebP, ≤2 MB,
  magic-byte verified). Stored with `source='manual'` in `contact_photos`:
  manual photos win — the bulk sync's upsert skips them — and never expire.
  `DELETE /api/contacts/photo?email=` removes a stored avatar. People-tab UI:
  hover an avatar → ✎ → file picker → upload; "Remove photo" in the expanded
  person detail.
- **Frontend**: avatars render `<img src="…" loading="lazy"
  onerror="this.remove()">` layered over the initials — a 404 reveals the
  initials with zero JS.
- `parseVCardPhoto` — extracts `PHOTO` from vCards: vCard 3.0 inline base64
  (`PHOTO;ENCODING=b;TYPE=JPEG:…`, folded lines unfolded) and vCard 4.0
  data URIs.

## D-Bus alternative (not implemented)

The factory also offers `OpenAddressBook(s)→(ss)` at
`org.gnome.evolution.dataserver.AddressBook10`
`/org/gnome/evolution/dataserver/AddressBookFactory` for a per-email live
lookup. The bulk export covers the need with fewer moving parts, so D-Bus
stays a fallback option.
