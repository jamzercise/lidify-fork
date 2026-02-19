# Lidifin Implementation Plan

This document is a **comprehensive, file-level implementation plan** for using Jellyfin as the default music library and streaming source (Lidifin). It complements:

- [jellyfin-music-client-feasibility.md](./jellyfin-music-client-feasibility.md) – design decisions and hurdles
- [lidifin-implementation-todo.md](./lidifin-implementation-todo.md) – checklist of features

**Goals of this plan:**

1. **Specificity** – Which files and functions to change, and how.
2. **Order** – Implementation order so each step builds on the previous without rework.
3. **Integration** – How backend, frontend, and schema changes interact so there are no conflicts or duplicate code paths.
4. **Single mental model** – One place to see “what we’re going to do and how it affects everything” before coding.

**Scope:** Phase 1 (Jellyfin as default music library) is the primary focus. Phase 2 (vibe/AudioMuse-AI) and Phase 3 (offline, multi-user) are called out where they touch the same code. **Lidifin is new-installs-only** – no migration of existing Lidify users or native library.

---

## 1. Implementation order (dependency graph)

Implement in this order so that:

- Schema and config are in place before any code assumes Jellyfin.
- The Jellyfin client and DTO mapping exist before library/stream/playlists use them.
- Backend resolution of `jellyfin:xxx` is consistent everywhere (library, stream, playlists, playback state, favorites).

```
1. Schema + config (Jellyfin settings, track reference as string, Playlist.jellyfinPlaylistId)
2. Jellyfin client + adapter (new service, DTO mapping, cover art, optional cache)
3. Library routes (proxy Jellyfin when enabled; GET artists/albums/tracks, GET by id)
4. Stream route (handle jellyfin:xxx → redirect to Jellyfin; play logging)
5. Playlists (store jellyfin:itemId; resolve on GET; push to Jellyfin on create/update/delete)
6. Favorites (toggle endpoint, GET favorites list)
7. Playback state + queue (resolve jellyfin:xxx when returning state/queue)
8. Plays, ListeningState, LikedTrack (schema + any code that assumes Track FK)
9. Discovery, downloads, playlist import (download path, Jellyfin scan trigger, match to Jellyfin ids)
10. Scan and config validation (no native music scan when Jellyfin; MUSIC_PATH optional for Lidifin)
11. Frontend: settings + onboarding (Jellyfin URL, API key, test connection)
12. Frontend: library, player, queue (ensure id format and stream URL work)
13. Frontend: playlists (add to playlist with jellyfin:xxx; playlist detail with resolved items)
14. Frontend: favorites (heart icon, Favorites view)
15. Search, recommendations, mixes (Phase 2: AudioMuse-AI; library from Jellyfin adapter)
16. Tests and docs
```

Sections below follow this order and list **concrete files and changes**.

---

## 2. Schema and data model

**Decision (from feasibility):** Single string “track reference” – no FK to `Track`. Values: native Lidify `cuid` or `jellyfin:{jellyfinItemId}`. Resolve at read time.

### 2.1 Files to change

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | See table below. |
| New migration | After editing schema, run `npx prisma migrate dev --name lidifin_track_reference`. |

### 2.2 Schema changes (detailed)

**SystemSettings**

- Add:
  - `jellyfinEnabled Boolean @default(false)`
  - `jellyfinUrl String?`
  - `jellyfinApiKey String?` (store encrypted; decrypt in `systemSettings.ts` like other secrets)
- Optional for Phase 2: `audioMuseEnabled`, `audioMuseBaseUrl`.

**Playlist**

- Add: `jellyfinPlaylistId String?` (store Jellyfin playlist id after push for updates/deletes).

**PlaylistItem**

- Change: `trackId` from FK to `Track` → **String only** (no `@relation` to Track).
- Keep: `playlistId`, `sort`, relation to `Playlist`.
- Remove: `track` relation. Unique constraint `@@unique([playlistId, trackId])` stays (both are strings).

**PlaybackState**

- Already has `trackId String?` and `queue Json?`. No FK to Track in schema – **no schema change**.
- Application: when returning playback state, resolve `trackId` and each queue item `id` via “resolve track reference” helper (Jellyfin adapter if `jellyfin:`, else Prisma Track).

**Play**

- Change: `trackId` to String, **remove** `track` relation to Track.
- Add `@@index([trackId])` if not present (for play history by track).
- Application: when recording a play for `jellyfin:xxx`, store the string; no Prisma lookup.

**LikedTrack**

- Change: `trackId` to String, **remove** `track` relation.
- Keep `@@id([userId, trackId])` and indexes.
- Application: allow `trackId = jellyfin:xxx`; for “liked” list resolution use same resolver as playlists.

**CachedTrack**

- Option A: Change `trackId` to String, remove Track relation (consistent with others). For Lidifin Phase 1 we don’t cache Jellyfin streams; this avoids FK errors if anything still references CachedTrack by a jellyfin id.
- Option B: Keep FK and restrict CachedTrack to native tracks only (application logic: only cache when track is native). For Phase 1, **Option A** is simpler so all “track reference” columns are string-only.

**ListeningState**

- Currently `trackId String?` with no Track relation – **no schema change**. Application: when returning or using `trackId`, resolve via same “track reference” helper.

**Other models that reference Track**

- Any other table with `trackId` → Track FK (e.g. `MoodBucket`, `TrackEmbedding`) is for **native** analysis/vibe. For Lidifin Phase 1 we don’t store Jellyfin tracks in Track table, so those stay as-is. If a future feature needs “favorite Jellyfin track” in a mood bucket, that would be a separate design (e.g. store `jellyfin:xxx` in a new or extended table without Track FK).

### 2.3 Migration and backwards compatibility

- Migration: alter columns to `TEXT` (or keep `String` in Prisma), drop FK constraints. Existing rows have cuid strings – they remain valid.
- **No backfill.** Application code must treat any `trackId` that does not start with `jellyfin:` as native and resolve via Prisma Track (or skip resolution for play history if not needed for display).

### 2.4 Central “track reference” resolver (application layer)

- Introduce a **single** resolver used everywhere: input = `trackId: string`, output = `Promise<ResolvedTrack | null>` where `ResolvedTrack` is the same shape the frontend expects (id, title, duration, artist, album, coverArt, streamUrl if needed).
- **Location:** e.g. `backend/src/services/trackResolver.ts` or inside `backend/src/services/jellyfin.ts` (e.g. `resolveTrackReference(trackId)`). If `trackId.startsWith('jellyfin:')`, call Jellyfin adapter; else `prisma.track.findUnique` + build stream URL from existing audio streaming service.
- **Usage:** Library (GET track by id), stream route (after resolving to get stream URL for Jellyfin), playlists (resolve each item), playback state (resolve current + queue), favorites (list is already from Jellyfin), plays (no resolution needed for write; optional for read).

---

## 3. Backend configuration

### 3.1 Config and env

| File | Change |
|------|--------|
| `backend/src/config.ts` | Do **not** require `MUSIC_PATH` when Jellyfin is the music source. Either: (a) make `MUSIC_PATH` optional in env schema when a “Lidifin mode” flag is set, or (b) defer music-path validation to `validateMusicConfig()` and there skip path-exists check when Jellyfin is enabled and music path is only used as download destination. Prefer (b) so one codebase works for both Lidify and Lidifin. |
| `backend/src/utils/configValidator.ts` | In `validateMusicConfig()`: if system settings (or env) indicate Jellyfin is the music source, treat `musicPath` as optional for **library** (only validate that it exists if we use it for downloads). So: when Jellyfin is enabled, allow startup even if `musicPath` is missing, and use `downloadPath` (or same path) for download destination only. |

### 3.2 System settings (DB + API)

| File | Change |
|------|--------|
| `backend/src/utils/systemSettings.ts` | In `getSystemSettings()`, decrypt and expose `jellyfinApiKey` (same pattern as `audiobookshelfApiKey`). Add logic: if `process.env.JELLYFIN_API_KEY` is set, return that as the effective API key (env overrides DB). Do not store env value in DB. |
| `backend/src/routes/systemSettings.ts` | Extend `systemSettingsSchema` with `jellyfinEnabled`, `jellyfinUrl`, `jellyfinApiKey` (nullable). On GET, never return raw API key; optionally return a flag `jellyfinApiKeyFromEnv: true` when env is set. On PUT, encrypt `jellyfinApiKey` before save (same as other secrets). |
| `backend/prisma/schema.prisma` | Already covered in §2. |

### 3.3 Conflict prevention

- **Single source of “is Jellyfin enabled”:** Read from `getSystemSettings()` (and optionally cache). Use the same helper everywhere (e.g. `isJellyfinMusicSource(): Promise<boolean>`) so library, stream, playlists, and playback state all branch consistently.

---

## 4. Jellyfin client and adapter

### 4.1 New files

| File | Purpose |
|------|--------|
| `backend/src/services/jellyfin.ts` | Jellyfin API client: auth (API key header), GET Items (artists, albums, audio), GET Item by id, get stream URL (for redirect), image URL for cover art. Map Jellyfin responses to DTOs that match existing frontend shapes (id = `jellyfin:{id}`, title, artist, album, duration, coverArt). Optional: short-TTL in-memory cache for “get item by id” and “get stream URL.” |
| Optional: `backend/src/utils/jellyfinDto.ts` | Pure mapping functions: Jellyfin item → artist/album/track DTO (so `jellyfin.ts` stays thin and testable). |

### 4.2 DTO shape (align with frontend)

- Frontend already expects: `id`, `title`, `duration`, `artist: { id, name }`, `album: { id, title, coverArt }`, etc. Jellyfin adapter must output the **same** shape so library and playlist detail pages need no frontend changes.
- Use **consistent id format:** `jellyfin:{jellyfinItemId}` for every type (artist, album, track) so the app can treat ids as opaque strings.

### 4.3 Cover art

- Jellyfin image API: e.g. `GET /Items/{id}/Images/Primary`. Either return a full URL (with Jellyfin auth token if required) or proxy via Lidify (e.g. `GET /api/library/cover-art/jellyfin/:id`). If proxy: add a route that calls Jellyfin image API and streams the response; frontend keeps using “cover art URL” the same way.

### 4.4 Track resolver (reuse)

- The “track reference” resolver (§2.4) will call this Jellyfin service when `trackId.startsWith('jellyfin:')`. Implement `getTrackById(jellyfinId: string)` and `getStreamUrl(jellyfinId: string)` (and optionally batch `getTracksByIds`) in `jellyfin.ts` so the resolver and stream route can use them.

### 4.5 Batch resolution (performance)

- When resolving many ids (playlist, queue), use Jellyfin’s `ids` parameter (e.g. `GET /Items?ids=id1,id2,...`) in one or a few calls, then map results back to the requested order. Implement in `jellyfin.ts` and use from playlist and playback-state handlers.

---

## 5. Library routes (proxy Jellyfin)

### 5.1 Files to change

| File | Change |
|------|--------|
| `backend/src/routes/library.ts` | **Branch by music source:** if Jellyfin is the music source, GET /library/artists, /albums, /tracks (and by-id) should be served by the Jellyfin adapter instead of Prisma. Keep the same route paths and response shapes. Translate query params (query, limit, offset, sortBy, filter) to Jellyfin API params or filter in adapter. For GET /library/tracks/:id, if id is `jellyfin:xxx`, use adapter; otherwise existing Prisma + format. |

### 5.2 Specific route behavior

- **GET /library/artists** – If Jellyfin: call Jellyfin Items with `IncludeItemTypes=MusicArtist`, map to existing artist list shape. Pagination/sort via Jellyfin params or in-memory slice.
- **GET /library/albums** – Same idea with `MusicAlbum`; optional `artistId` filter if supported.
- **GET /library/tracks** – Same with `Audio`; support filters (e.g. album, artist) if Jellyfin supports them.
- **GET /library/tracks/:id** – If id starts with `jellyfin:`, fetch from Jellyfin adapter and return mapped DTO; else current Prisma + format.
- **POST /library/scan** – When Jellyfin is music source, return 400 or a message that scan is not used (or hide in frontend). See §10.

### 5.3 Empty / error handling

- If Jellyfin is not configured or returns an error: return 503 or 200 with empty list and a message like “Jellyfin is slow or unreachable. Check your Jellyfin instance.” (per feasibility doc). Frontend can show Retry.

### 5.4 Conflict prevention

- All library read paths for music go through the same “source” check: if Jellyfin enabled → adapter; else Prisma. No mixed responses for the same endpoint.

---

## 6. Stream route

### 6.1 Files to change

| File | Change |
|------|--------|
| `backend/src/routes/library.ts` | In **GET /library/tracks/:id/stream**: before looking up Prisma Track, check if `id.startsWith('jellyfin:')`. If yes: (1) get Jellyfin stream URL (with auth) from Jellyfin service, (2) log play in Play table with `trackId = id` (string), (3) respond with **redirect** (302) to that URL. If no: keep existing behavior (Prisma Track → AudioStreamingService). |
| `backend/src/services/audioStreaming.ts` | No change for Jellyfin path; stream route never calls it for `jellyfin:xxx`. Optional: add a guard at the top of `getStreamFilePath` that returns an error if trackId looks like `jellyfin:`, so no one accidentally passes it through. |

### 6.2 Play logging

- When streaming a Jellyfin track, insert into `Play` with `trackId = req.params.id` (the `jellyfin:xxx` string). Schema already allows string; no FK. No need to resolve the track for the insert.

### 6.3 Failure handling

- If Jellyfin stream URL fails: return 503 with message “Jellyfin is slow or unreachable…”; frontend can skip to next track (feasibility doc).

---

## 7. Playlists (store jellyfin:itemId, resolve, push to Jellyfin)

### 7.1 Files to change

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | PlaylistItem.trackId as string (no FK); Playlist.jellyfinPlaylistId (see §2). |
| `backend/src/routes/playlists.ts` | **POST /playlists/:id/items:** Accept any string `trackId` (including `jellyfin:xxx`). Do **not** call `prisma.track.findUnique` for existence; optionally validate by resolving (Jellyfin or Track) and reject if not found. Insert PlaylistItem with `trackId` string. **GET /playlists** and **GET /playlists/:id:** Do not use `include: { track: { ... } }` because there is no Track relation. Instead: load items with `trackId` and `sort`; collect all `trackId`s; call batch resolver (§2.4, §4.5); build response with resolved track objects in same order. **POST /playlists** (create): After creating in DB, if Jellyfin is enabled, call Jellyfin “create playlist” and “add items” by Jellyfin id; store returned Jellyfin playlist id in `Playlist.jellyfinPlaylistId`. **PUT /playlists/:id** (update name/visibility) and **DELETE/ reorder/ add/remove items:** Push changes to Jellyfin using `jellyfinPlaylistId`; on failure, save in Lidify anyway and optionally retry in background (feasibility doc). **DELETE /playlists/:id/items/:trackId:** Use `trackId` as string (route param) in `playlistId_trackId` unique key. |
| New or existing | Jellyfin playlist API: create playlist, add/remove items by item id. Implement in `jellyfin.ts` and call from playlists route. |

### 7.2 Playlist list/detail response shape

- Items array: each element has the same track shape as elsewhere (id, title, artist, album, duration, coverArt). So frontend does not need to know whether it was native or Jellyfin.

### 7.3 Conflict prevention

- Playlist item uniqueness is `(playlistId, trackId)`; both are strings, so `jellyfin:xxx` and native cuid are both valid. Reorder and delete by `trackId` string; no Prisma Track relation.

---

## 8. Jellyfin Favorites (backend)

### 8.1 New endpoints (and files)

| Location | Endpoint | Behavior |
|----------|----------|----------|
| `backend/src/routes/library.ts` or `backend/src/routes/jellyfin.ts` | **POST /api/library/favorites/:trackId** or **POST /api/jellyfin/favorites** (body: `{ trackId }`) | If trackId is `jellyfin:xxx`, call Jellyfin `POST /Users/{UserId}/FavoriteItems/{ItemId}`. Return success so frontend can set heart filled. |
| Same | **DELETE /api/library/favorites/:trackId** (or POST with action=remove) | Call Jellyfin remove-favorite; return success. |
| Same | **GET /api/library/favorites** or **GET /api/jellyfin/favorites** | Call Jellyfin `GET /Items?isFavorite=true&IncludeItemTypes=Audio&UserId=...`. Map to track list (same DTO as library tracks). Return list (live view; no stored playlist). |

### 8.2 Files to change

| File | Change |
|------|--------|
| `backend/src/services/jellyfin.ts` | Add: addFavorite(itemId), removeFavorite(itemId), getFavorites(). |
| `backend/src/index.ts` | If new router `jellyfin.ts`, mount it (e.g. `/api/jellyfin` or under `/api/library`). |
| `backend/src/routes/library.ts` | Alternatively, add GET/POST/DELETE favorites under library (e.g. `/library/favorites`) so one place for “library” concerns. |

### 8.3 Optional: isFavorite in track objects

- When resolving tracks (playlist, queue, library), optionally include `isFavorite` from Jellyfin UserData so the heart icon can show state without an extra request per track. Can be Phase 2.

---

## 9. Playback state and queue

### 9.1 Files to change

| File | Change |
|------|--------|
| `backend/src/routes/playbackState.ts` | **GET /:** When returning playback state, do not return raw `trackId` and `queue` only. Resolve `trackId` via track resolver to full track object (with stream URL if needed). Resolve each queue item’s `id` via batch resolver; replace queue with array of resolved track objects (same shape as frontend expects). So frontend continues to receive `{ playbackType, trackId, queue: [{ id, title, artist, album, ... }], currentIndex, ... }` and can call `getStreamUrl(item.id)` for any item. |
| `backend/src/routes/playbackState.ts` | **POST /:** Accept `trackId` and `queue` as today. Queue items can have `id: "jellyfin:xxx"`. No validation against Track table; allow any string id. Sanitization already keeps `item.id` as string; ensure no code assumes numeric or cuid-only. |

### 9.2 Conflict prevention

- Single resolver for both current track and queue items. Use batch resolution when queue has many Jellyfin ids.

---

## 10. Plays, ListeningState, LikedTrack, CachedTrack

### 10.1 Plays

- **Write:** Already covered – stream route and any other “play” recording use `trackId` string. No FK.
- **Read:** Any endpoint that lists plays with track details must resolve `trackId` through the track resolver (so Jellyfin tracks show title, artist, etc.). Files: `backend/src/routes/plays.ts` – if there is a “recent plays” or similar that joins to Track, switch to resolver for each play’s trackId.

### 10.2 ListeningState

- Schema: no change. When returning listening state that includes track info, resolve `trackId` via resolver.

### 10.3 LikedTrack

- Allow inserting/deleting with `trackId = jellyfin:xxx`. Any “liked tracks” list API should resolve ids through the same resolver.

### 10.4 CachedTrack

- If schema is changed to string (no FK), any code that writes CachedTrack must only do so for native tracks (or we don’t cache Jellyfin in Phase 1). Reads that join to Track must be updated to use resolver for non-native ids if we ever mix cached Jellyfin later.

---

## 11. Discovery, downloads, playlist import

### 11.1 Download path = Jellyfin library path

| File | Change |
|------|--------|
| `backend/src/routes/downloads.ts` | Use download path from settings (e.g. `downloadPath` or `musicPath` when Jellyfin is music source). Ensure Lidarr/Soulseek write to this path so Jellyfin can index it. |
| `backend/src/services/acquisitionService.ts` | Same: destination for downloads should be the configured path that Jellyfin scans. |
| `backend/src/services/simpleDownloadManager.ts` | Same. |
| `backend/src/utils/configValidator.ts` | When Jellyfin is music source, the “music” path is only for downloads; validate it exists when downloads are used, or document that user must set it to a path Jellyfin can read. |

### 11.2 Trigger Jellyfin scan (optional)

- After a download completes, call Jellyfin “refresh library” or “scan” API so new album appears. Implement in `jellyfin.ts`; call from download completion hook (e.g. in acquisitionService or webhook handler).

### 11.3 Playlist import (Spotify/Deezer/YT Music)

| File | Change |
|------|--------|
| `backend/src/services/spotifyImport.ts` | After download and (optional) Jellyfin scan, resolve imported rows to Jellyfin item ids (match by metadata: artist, album, track title; optional MBID if Jellyfin exposes it). Create playlist items with `trackId = jellyfin:xxx`. Handle “not found”: skip or mark pending. Do this in Phase 1 (feasibility doc). |

### 11.4 Conflict prevention

- Single “download destination” from settings. No Lidify music scan when Jellyfin is source (§12).

---

## 12. Scan and native library

### 12.1 Files to change

| File | Change |
|------|--------|
| `backend/src/routes/library.ts` | **POST /library/scan:** When Jellyfin is the music source, return 400 with a clear message (e.g. “Library scan is not used when Jellyfin is the music source”) or 200 with message “No scan needed.” |
| `backend/src/workers/processors/scanProcessor.ts` | When Jellyfin is music source, skip music scan (or never enqueue music scan job). Optional: keep job for “reconcile pending playlist tracks” only if that path still makes sense (e.g. after Jellyfin indexes new files, we match pending rows to Jellyfin ids). |
| `backend/src/utils/configValidator.ts` | When Jellyfin is enabled, do not require MUSIC_PATH for library; only for download path if used. |
| `backend/src/config.ts` | Env validation: allow app to start without MUSIC_PATH when Jellyfin is set (e.g. read Jellyfin flag from DB in async init, or use env flag like LIDIFIN=1). Prefer “validate in validateMusicConfig and don’t throw if Jellyfin and path missing.” |

---

## 13. Frontend – configuration and onboarding

### 13.1 Settings UI

| File | Change |
|------|--------|
| `frontend/features/settings/` | Add a section “Jellyfin” (or under Integrations): Jellyfin URL, API key (password field), enable “Use Jellyfin for music.” When API key is from env, show “Using API key from environment” and disable/key field. “Test connection” button: call new backend endpoint that runs GET Jellyfin System/Info or Users/Me; show success or error message. |
| `frontend/lib/api.ts` | Add: `getSystemSettings()` / `updateSystemSettings()` if not already; ensure Jellyfin fields are in types. Add: `testJellyfinConnection(url?, apiKey?)` or `testJellyfinConnection()` that uses saved settings. |
| Backend | New route: **POST /api/system-settings/jellyfin/test** or **GET /api/jellyfin/test** that uses current saved (or body) URL + API key and calls Jellyfin; returns { ok } or { error }. |

### 13.2 Onboarding

| File | Change |
|------|--------|
| `frontend/app/onboarding/page.tsx` | Add path for “Jellyfin” mode: connect Jellyfin (URL + API key), test connection, then optionally set download folder. Do not require local music path when Jellyfin is the only music source. |

### 13.3 Conflict prevention

- Backend is source of truth for “Jellyfin enabled.” Frontend can read it from system settings or a dedicated “music source” API so library/empty states show correctly.

---

## 14. Frontend – library, player, queue

### 14.1 Library

| File | Change |
|------|--------|
| `frontend/app/library/page.tsx` | No change if API returns same DTOs. Ensure loading/error state shows “Jellyfin is slow or unreachable” and Retry when API returns error or empty with message. |
| `frontend/features/library/` | Same: use existing components; ids can be `jellyfin:xxx`. |
| `frontend/lib/api.ts` | `getStreamUrl(trackId)` already builds URL as `/api/library/tracks/${trackId}/stream` – no change. Backend must accept `jellyfin:xxx` in stream route. |

### 14.2 Player and queue

| File | Change |
|------|--------|
| `frontend/components/player/HowlerAudioElement.tsx` | Uses `api.getStreamUrl(currentTrack.id)` – works if `currentTrack.id` is `jellyfin:xxx`. Ensure no code parses `id` as number or assumes cuid format. |
| `frontend/lib/audio-controls-context.tsx`, `frontend/lib/audio-state-context.tsx` | When setting queue or current track, ids can be strings; no change if backend returns resolved track objects with `id` set. |
| `frontend/components/player/NowPlayingQueuePanel.tsx` | Expects track objects with `id`, `title`, `artist`, `album`; backend resolves so no change. |

### 14.3 Conflict prevention

- Frontend never “branches” on id format; it always uses `track.id` and `getStreamUrl(track.id)`. Backend is responsible for resolution and stream URL.

---

## 15. Frontend – playlists

| File | Change |
|------|--------|
| `frontend/features/library/hooks/useLibraryActions.ts` | “Add to playlist” sends `trackId` – can be `jellyfin:xxx`. No change if backend accepts it. |
| Playlist detail page | Shows items from API; backend returns resolved track objects, so play and stream work via `getStreamUrl(item.id)`. Optional: show “Also visible in Jellyfin” when backend adds that hint. |

---

## 16. Frontend – Jellyfin Favorites

| File | Change |
|------|--------|
| `frontend/lib/api.ts` | Add: `getFavorites()`, `addFavorite(trackId)`, `removeFavorite(trackId)` (or `toggleFavorite(trackId)`). |
| Library track rows, queue rows, player | Add heart icon; on click call toggle; update local state (filled/unfilled). Only show or enable for `track.id.startsWith('jellyfin:')` if we don’t support native favorites in the same way. |
| Favorites view | New entry in sidebar or Library: “Favorites.” On open, fetch from GET /api/library/favorites (or GET /api/jellyfin/favorites). Render as track list; play and stream via existing `getStreamUrl`. Refresh on return to tab or after toggle. |

---

## 17. Search, recommendations, mixes (Phase 2)

- **Search:** Backend search (e.g. `backend/src/routes/search.ts`, `backend/src/services/search.ts`) should query Jellyfin when Jellyfin is music source and return unified results with same DTO shape.
- **Recommendations / homepage:** Use “library” data from Jellyfin adapter so same features work.
- **Mixes / vibe:** When music is from Jellyfin, use AudioMuse-AI with Jellyfin item ids; mix endpoints return `jellyfin:xxx` ids; resolution already in place for queue and playback.

---

## 18. Testing and documentation

- **E2E / integration:** Mock Jellyfin API; test library endpoints, stream redirect for `jellyfin:xxx`, playlist create with push, playback state with Jellyfin track in queue, favorites toggle and list.
- **Docs:** Update README with Jellyfin as default music source, env/settings, failure message, optional AudioMuse-AI.

---

## 19. Cross-cutting summary: avoiding conflicts

1. **Single “track reference” type:** Everywhere we store or pass a track identifier, it is a string: either native cuid or `jellyfin:itemId`. One resolver turns it into the DTO the frontend expects.
2. **Single “music source” check:** One place (e.g. `getSystemSettings()` + `jellyfinEnabled`) determines whether library/stream/scan use Jellyfin. All routes use the same check.
3. **Batch resolution:** Playlists and playback state resolve many ids in one go (Jellyfin batch API + cache) so we don’t have N+1 and we don’t mix “per-item” logic with “list” logic.
4. **Stream route:** Only place that produces audio for a track. It branches once on `id.startsWith('jellyfin:')` and then either Jellyfin redirect or existing file stream. No second code path elsewhere that “also” streams.
5. **Playlists:** Write path accepts any string `trackId`; read path always resolves via same resolver. Push to Jellyfin is a separate step after DB write; failure does not block save.
6. **Schema:** No FK from PlaylistItem, Play, LikedTrack, etc. to Track. So no Prisma errors when storing `jellyfin:xxx`; no need to “fake” a Track row.

---

## 20. File change index (quick reference)

| Area | Backend files | Frontend files |
|------|----------------|----------------|
| Schema | `prisma/schema.prisma` + migration | — |
| Config | `config.ts`, `configValidator.ts`, `systemSettings.ts`, `routes/systemSettings.ts` | — |
| Jellyfin client | **New:** `services/jellyfin.ts`; **New (optional):** `utils/jellyfinDto.ts` | — |
| Track resolver | **New:** `services/trackResolver.ts` or inside `jellyfin.ts` | — |
| Library | `routes/library.ts` | `app/library/page.tsx`, `features/library/` (error/empty states) |
| Stream | `routes/library.ts` (GET .../stream) | — |
| Playlists | `routes/playlists.ts`, `services/jellyfin.ts` (playlist push) | `features/library/hooks/useLibraryActions.ts`, playlist detail |
| Favorites | `routes/library.ts` or `routes/jellyfin.ts`, `services/jellyfin.ts` | `lib/api.ts`, track rows, queue, player, Favorites view |
| Playback state | `routes/playbackState.ts` | — |
| Plays / LikedTrack | `routes/plays.ts` (if listing with track details) | — |
| Discovery / import | `acquisitionService.ts`, `simpleDownloadManager.ts`, `spotifyImport.ts`, `configValidator.ts` | — |
| Scan | `routes/library.ts`, `workers/processors/scanProcessor.ts`, `configValidator.ts`, `config.ts` | — |
| Settings / onboarding | `routes/systemSettings.ts`, new test-connection endpoint | `features/settings/`, `app/onboarding/page.tsx`, `lib/api.ts` |
| App mount | `index.ts` (if new jellyfin routes) | — |

This plan should give a full picture of what to change and how the pieces fit together before implementation starts.
