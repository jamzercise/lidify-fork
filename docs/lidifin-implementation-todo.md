# Lidifin implementation to-do (pre-planning)

This document is a **to-do list for implementing Jellyfin as the music library backend** (Lidifin). It assumes the design in [jellyfin-music-client-feasibility.md](./jellyfin-music-client-feasibility.md): proxy-only (no library copy in Lidify), metadata from Jellyfin only, playlists created in Lidifin then pushed to Jellyfin (Option B), vibe via AudioMuse-AI when configured. **See also** the feasibility doc’s **“Additional hurdles and clarifications (to align on)”** section for migration, failure modes, deployment, performance, and security topics to align on before or during implementation.

**Implementation plan:** For a file-level plan (what to change where, in what order, and how to avoid conflicts), see [lidifin-implementation-plan.md](./lidifin-implementation-plan.md).

**Post-implementation checklist:** After building, use [lidifin-post-implementation-checklist.md](./lidifin-post-implementation-checklist.md) to verify all updates, cross-check integration, and ensure Docker/env/docs are updated.

**Decisions (from feasibility doc):** Lidifin is **new installs only**—no migration of existing Lidify users or native library/playlists.

**Phases (from feasibility doc):**  
Phase 1 = **Jellyfin as default music library** (not optional) → Phase 2 = Vibe/AudioMuse-AI → Phase 3 (optional) = Offline play (cache Jellyfin streams for when Jellyfin/network unavailable) + multi-user Jellyfin (one Jellyfin user linked per Lidify user; on login load that user’s library and cache—Jellyfin API is user-scoped, so this is supported).

---

## 1. Backend – configuration

- [ ] **Jellyfin config in backend**
  - Add Jellyfin settings (e.g. in `SystemSettings` or env): `jellyfinEnabled`, `jellyfinUrl`, `jellyfinApiKey` (or user-specific token). Jellyfin is the **default music source** for Lidifin—when configured, the main Library and streaming are from Jellyfin.
  - **Credentials: Option D (hybrid).** Resolve API key as: `process.env.JELLYFIN_API_KEY` if set, else decrypted value from DB. Store API key in DB encrypted at rest (e.g. key from SESSION_SECRET or ENCRYPTION_KEY) when user saves via Settings. Document that env overrides DB.
  - Load and validate config at startup (or on first use). App can still run without Jellyfin for non-music features (audiobooks, podcasts, etc.); music tab then shows empty or “Connect Jellyfin” until configured.
- [ ] **Optional: AudioMuse-AI config**
  - Add optional settings: `audioMuseEnabled`, `audioMuseBaseUrl` for Phase 2 (vibe/radio).

**Relevant files (current):** `backend/src/config.ts`, `backend/prisma/schema.prisma` (SystemSettings), `backend/src/utils/systemSettings.ts`, `backend/src/utils/configValidator.ts` (when Jellyfin is music source, MUSIC_PATH may be optional or only for download destination).

---

## 2. Backend – Jellyfin client / adapter

- [ ] **Jellyfin API client**
  - New service (e.g. `backend/src/services/jellyfin.ts`): authenticate with Jellyfin (API key or user token), call Items API (`GET /Items`, `GET /Items/{id}` with `IncludeItemTypes=MusicArtist,MusicAlbum,Audio`), handle errors and rate limits.
- [ ] **Map Jellyfin → Lidify DTOs**
  - Map Jellyfin item responses to the **same JSON shapes** the frontend already uses for artist, album, track (id, name/title, cover art, duration, etc.). Use **id format `jellyfin:{jellyfinItemId}`** (or agreed prefix) so the rest of the app can treat “track id” as an opaque string.
- [ ] **Cover art**
  - Resolve cover art via Jellyfin image API (e.g. `GET /Items/{id}/Images/Primary`) and expose in mapped DTOs as URL (Lidify proxy or direct Jellyfin URL with auth). See feasibility doc “Cover art” hurdle.
- [ ] **Optional short-TTL cache**
  - Optional in-memory or Redis cache for hot paths (e.g. “current album,” “artist by id”) to reduce latency and load on Jellyfin; document TTL and invalidation.

**Relevant files (current):** New `backend/src/services/jellyfin.ts`; frontend expects artist/album/track shape from `backend/src/routes/library.ts` (artists, albums, tracks endpoints).

---

## 3. Backend – library routes (proxy Jellyfin)

- [ ] **Unified library API**
  - When Jellyfin is configured as the music source, **GET /library/artists**, **GET /library/albums**, **GET /library/tracks** (and by-id) are served by the **Jellyfin adapter** (proxy + map) instead of Prisma queries on Artist/Album/Track. Optionally support “Jellyfin + native” later if dual source is desired.
- [ ] **Query params and pagination**
  - Support existing query params (query, limit, offset, filter, sortBy) where applicable by translating them to Jellyfin API filters/params or by filtering in the adapter layer.
- [ ] **Filter “owned” / “discovery”**
  - Today library uses “owned” (library albums) vs “discovery.” For Jellyfin-only, “library” is “whatever Jellyfin returns”; discovery may still be a Lidify concept (e.g. discovery albums that point to Jellyfin after download). Define how filter maps when music is from Jellyfin.
- [ ] **GET /library/tracks/:id**
  - For `id` of form `jellyfin:xxx`, fetch track details from Jellyfin (Items API) and return mapped DTO; do not query Prisma Track.

**Relevant files (current):** `backend/src/routes/library.ts` (GET /artists, /albums, /tracks, /tracks/:id, /artists/:id, /albums/:id).

---

## 4. Backend – stream route (Jellyfin proxy or redirect)

- [ ] **Stream endpoint for Jellyfin items**
  - **GET /library/tracks/:id/stream**: when `id` is `jellyfin:{itemId}`, do **not** look up Prisma Track. Instead, get Jellyfin stream URL (e.g. Jellyfin’s `/Audio/{id}/stream` or PlaybackInfo), then either **redirect** the client to that URL (with auth token) or **proxy** the stream. Support range requests if Jellyfin supports them.
- [ ] **Play logging**
  - When streaming a Jellyfin track, log play in Lidify (e.g. `Play` table or equivalent) using `trackId = jellyfin:itemId` so play history and stats remain in Lidify. Ensure Play/listening state can reference non-Prisma “track” ids (see schema section below).
- [ ] **Quality / transcode**
  - Jellyfin may expose quality/transcode options via query params; pass through or respect user quality preference if supported by Jellyfin API.

**Relevant files (current):** `backend/src/routes/library.ts` (GET /library/tracks/:id/stream), `backend/src/services/audioStreaming.ts` (native only today).

---

## 5. Backend – playlists (store `jellyfin:itemId`, push to Jellyfin)

- [ ] **Playlist items support Jellyfin ids**
  - PlaylistItem today has `trackId` → Track (FK). To support Jellyfin, either:
    - **Option A:** Add optional `externalTrackId` (e.g. `jellyfin:xxx`) and keep `trackId` nullable for “external” items; or  
    - **Option B:** Store a **string** “track reference” (e.g. `jellyfin:xxx` or native `cuid`) in one field and resolve to Track only when it’s a native id.  
  - When returning playlist items to the frontend, **resolve** `jellyfin:itemId` to track-like metadata (and stream URL) via Jellyfin adapter so the UI shows title, artist, album, cover.
- [ ] **Create/update/delete playlist → push to Jellyfin**
  - When user creates/updates/deletes a playlist in Lidifin that contains music (Jellyfin) items, call Jellyfin API: create playlist, add/remove items by Jellyfin item ID. Store Jellyfin playlist ID on the Lidify playlist (e.g. `jellyfinPlaylistId` on `Playlist`) for updates. Handle errors and retries; document “Lidifin is source of truth, v1 ignores edits made in Jellyfin.”
- [ ] **Playlist list/detail**
  - GET /playlists and GET /playlists/:id: when including items, resolve `jellyfin:xxx` items through Jellyfin adapter for metadata (and optionally stream URL) so the frontend does not need to know the source.

**Relevant files (current):** `backend/src/routes/playlists.ts`, `backend/prisma/schema.prisma` (Playlist, PlaylistItem with trackId → Track).

---

## 5b. Backend – Jellyfin Favorites (heart icon + Favorites list)

- [ ] **Toggle favorite in Jellyfin**
  - New endpoint (e.g. POST/DELETE or POST with body) to add/remove a track from Jellyfin favorites. Backend calls Jellyfin `POST /Users/{UserId}/FavoriteItems/{ItemId}` to add, and the appropriate remove-favorite call to unfavorite. Accept `jellyfin:itemId` (or raw Jellyfin id). Return success so the frontend can update the heart state.
- [ ] **GET Favorites list (live view)**
  - New endpoint (e.g. GET /library/favorites or GET /jellyfin/favorites) that calls Jellyfin `GET /Items` with `isFavorite=true`, `includeItemTypes=Audio`, and `userId`. Map response to the same track shape the frontend uses (ids as `jellyfin:xxx`). No stored playlist—always fetch from Jellyfin so the list auto-updates.
- [ ] **Optional: favorite state when resolving tracks**
  - When returning track-like objects (library, queue, playlist), optionally include `isFavorite` from Jellyfin (e.g. from item's UserData or a small batch call) so the heart icon can show filled/unfilled without an extra request per track. Can be Phase 2 if needed.

**Relevant files (current):** New route (e.g. `backend/src/routes/jellyfin.ts` or under library); Jellyfin adapter.

---

## 6. Backend – playback state and queue

- [ ] **PlaybackState and queue**
  - PlaybackState already stores `trackId` (string) and `queue` (JSON). Ensure queue items can carry `id: "jellyfin:xxx"` and that when the frontend requests “current track” or “queue,” the backend **resolves** those ids to full track-like objects (metadata + stream URL) via Jellyfin adapter when applicable.
- [ ] **GET playback state**
  - When returning playback state to the client, resolve `trackId` and each queue item’s `id` to the same shape the frontend expects (including stream URL); for `jellyfin:xxx` use Jellyfin adapter, for native use existing Prisma + stream URL builder.

**Relevant files (current):** `backend/src/routes/playbackState.ts`, `backend/prisma/schema.prisma` (PlaybackState), frontend expects `getStreamUrl(trackId)` and track objects with `id`, `title`, `album`, `artist`, etc.

---

## 7. Backend – discovery, downloads, playlist import

- [ ] **Download path = Jellyfin library path**
  - When Jellyfin is the music source, Lidarr (and Soulseek) download destination should be the **Jellyfin music library path** (configurable), so new files are indexed by Jellyfin. Lidify does not scan that path for music; it only reads from Jellyfin.
- [ ] **Trigger Jellyfin scan (optional)**
  - After a download completes, optionally call Jellyfin “refresh library” (or scan) API so the new album appears in Jellyfin (and thus in Lidifin) without manual refresh.
- [ ] **Playlist import**
  - Spotify/Deezer/YT Music import still triggers Lidarr/Soulseek and adds to the same download path (Jellyfin library). After Jellyfin indexes the new album, “match” the imported playlist entries to **Jellyfin item ids** (e.g. by metadata or polling) and create Lidifin playlist items with `jellyfin:itemId`. No Lidify music scan.

**Relevant files (current):** `backend/src/routes/downloads.ts`, `backend/src/services/acquisitionService.ts`, `backend/src/services/simpleDownloadManager.ts`, `backend/src/services/spotifyImport.ts`, `backend/src/utils/configValidator.ts`, system settings `musicPath` / `downloadPath`.

---

## 8. Backend – scan and native library

- [ ] **No native music scan when Jellyfin is music source**
  - With Jellyfin as the default music source, do not run Lidify music scan for the main library (or hide “Scan library” for music). Main “music” view is from Jellyfin only. Optionally support a separate “native” library later (dual source).
- [ ] **MUSIC_PATH / config**
  - When music is from Jellyfin, MUSIC_PATH is only needed as download destination (Jellyfin library path). Adjust config validation so app can start without a valid MUSIC_PATH when Jellyfin is the music source and path is used only for downloads.

**Relevant files (current):** `backend/src/routes/library.ts` (POST /scan), `backend/src/workers/processors/scanProcessor.ts`, `backend/src/utils/configValidator.ts`, `backend/src/config.ts`.

---

## 9. Backend – vibe, mixes, recommendations (Phase 2)

- [ ] **AudioMuse-AI integration**
  - When “vibe” or “similar tracks” or “radio” is requested for a track with id `jellyfin:xxx`, call **AudioMuse-AI** API (similar songs, text search, alchemy, etc.) with the Jellyfin item ID; get back a list of Jellyfin item IDs; build queue with those ids and stream from Jellyfin. No analysis or embedding storage in Lidify for Jellyfin music.
- [ ] **Mixes / programmatic playlists**
  - Today mixes return native `trackIds` from Prisma. When music is from Jellyfin, mixes may need to be based on Jellyfin data (e.g. from AudioMuse-AI or from Jellyfin library queries). Adapt `mixes` routes and `programmaticPlaylistService` so that when Jellyfin is the source, mix track lists are Jellyfin item ids and are resolved the same way as queue/playlist items.
- [ ] **Recommendations / Made For You**
  - Recommendations that today use Artist/Album/Track from Prisma should instead use “library” data from the Jellyfin adapter (and optionally native) so the same features work with a unified “library” view.

**Relevant files (current):** `backend/src/routes/mixes.ts`, `backend/src/services/programmaticPlaylists.ts`, `backend/src/services/moodBucketService.ts`, `backend/src/routes/recommendations.ts`, `backend/src/routes/analysis.ts` (if used for vibe).

---

## 10. Backend – schema and data model

- [ ] **Track reference as string**
  - Ensure everywhere that today expects a Prisma `Track` FK can accept a “track reference” that is either a native Track id or `jellyfin:itemId`. Key places: `PlaylistItem.trackId`, `PlaybackState.trackId` and queue JSON, `Play.trackId`, `LikedTrack.trackId`, `CachedTrack.trackId`, `ListeningState.trackId`.  
  - **Option A:** Keep FKs and add a separate path for “external” items (e.g. `PlaylistItem.externalTrackId` + nullable `trackId`).  
  - **Option B:** Change to a single string “track reference” and resolve at read time (no FK to Track for Jellyfin items).  
  - Decision: document chosen approach; feasibility doc recommends “store only track identifier (`jellyfin:itemId` or native id), resolve at read time.”
- [ ] **Play table**
  - If Play is to record plays for Jellyfin tracks, `Play.trackId` must allow values that are not in Track table (e.g. string id `jellyfin:xxx`). That may require making the FK optional or using a generic “trackReference” string and dropping FK for that column.
- [ ] **Playlist.jellyfinPlaylistId**
  - Add field to store Jellyfin playlist ID when “push to Jellyfin” is implemented, for updates and deletes.
- [ ] **LikedTrack / CachedTrack / others**
  - Define how “liked” and “cached” work for Jellyfin items: e.g. LikedTrack stores `trackId = jellyfin:xxx` (no FK), and CachedTrack either skipped for Jellyfin or implemented as “cache Jellyfin stream file” in a later phase.

**Relevant files (current):** `backend/prisma/schema.prisma` (Track, PlaylistItem, PlaybackState, Play, LikedTrack, CachedTrack, ListeningState, etc.).

---

## 11. Frontend – configuration and settings UI

- [ ] **Jellyfin settings**
  - Add UI (e.g. in Settings / Integrations) to set Jellyfin URL, API key (or auth), enable/disable “Use Jellyfin for music.” Optionally: “Jellyfin library path” (for display or for download destination hint).
  - When API key is provided via env, show hint in Settings (e.g. "Using API key from environment") so users know the field is not in use; backend can expose a flag or omit the stored value when env is set.
- [ ] **AudioMuse-AI settings (Phase 3)**
  - Optional section for AudioMuse-AI base URL and enable/disable for vibe features.
- [ ] **Onboarding**
  - If onboarding currently asks for music path / scan, add path for “Jellyfin” mode: e.g. connect Jellyfin, then optionally set download path. Do not require local music path when Jellyfin is the only music source.

**Relevant files (current):** `frontend/features/settings/`, `frontend/app/onboarding/page.tsx`, system settings API.

---

## 12. Frontend – library (artists, albums, tracks)

- [ ] **Use existing library UI**
  - Library page and tabs (artists, albums, tracks) can stay as-is if the API returns the same DTOs. Ensure backend returns `id` as `jellyfin:xxx` or native id and that all list/detail endpoints work when data comes from Jellyfin adapter.
- [ ] **Stream URL**
  - Frontend uses `api.getStreamUrl(trackId)`. Ensure `getStreamUrl` works for `trackId` of form `jellyfin:xxx` (backend must accept that in GET /library/tracks/:id/stream). No frontend change if backend handles it.
- [ ] **Cover art**
  - If cover art is a URL (Jellyfin or Lidify proxy), ensure frontend uses it as-is (e.g. `<img src={...} />` or existing cover component). If backend returns a different shape (e.g. `coverArt` URL), align with existing artist/album/track card components.
- [ ] **Empty / loading states**
  - When Jellyfin is enabled but not configured or fails, show appropriate message (e.g. “Connect Jellyfin in Settings” or “Jellyfin unavailable”).

**Relevant files (current):** `frontend/app/library/page.tsx`, `frontend/features/library/`, `frontend/lib/api.ts` (getStreamUrl, getArtists, getAlbums, getTracks).

---

## 13. Frontend – player and queue

- [ ] **Track id format**
  - Player and queue already use `track.id` and pass it to `getStreamUrl(track.id)`. As long as `track.id` can be `jellyfin:xxx`, no change needed if backend stream route supports it. Ensure queue items from playlists and playback state have `id` set correctly when resolved by backend.
- [ ] **Now playing / queue panel**
  - NowPlayingQueuePanel and similar components expect track objects with `id`, `title`, `artist`, `album`, etc. Backend must resolve Jellyfin ids to that shape when sending playback state and queue; then frontend “just works.”
- [ ] **Playback state persistence**
  - When user plays a Jellyfin track, playback state and queue may contain `jellyfin:xxx` ids; ensure frontend does not assume numeric or cuid-only ids (e.g. no parsing that breaks on `jellyfin:` prefix).

**Relevant files (current):** `frontend/components/player/HowlerAudioElement.tsx`, `frontend/lib/api.ts` (getStreamUrl), `frontend/lib/audio-controls-context.tsx`, `frontend/lib/audio-state-context.tsx`, `frontend/components/player/NowPlayingQueuePanel.tsx`.

---

## 14. Frontend – playlists

- [ ] **Add to playlist**
  - “Add to playlist” can add a track with `id: jellyfin:xxx`. Backend playlist APIs must accept that as `trackId` and store it (and push to Jellyfin when Option B is implemented).
- [ ] **Playlist detail**
  - When opening a playlist, items that are Jellyfin tracks should show title, artist, album, cover (from backend-resolved metadata). Play and stream URL should work via `getStreamUrl(jellyfin:xxx)`.
- [ ] **Create playlist**
  - No change needed if backend creates the playlist and pushes to Jellyfin; frontend just shows success. Optionally show “Also visible in Jellyfin” if we add that hint.

**Relevant files (current):** `frontend/features/library/hooks/useLibraryActions.ts` (add to playlist), playlist detail page, `frontend/lib/api.ts` (playlist endpoints).

---

## 14b. Frontend – Jellyfin Favorites (heart icon + Favorites list)

- [ ] **Heart icon**
  - Show a heart (or like) icon next to each track in library lists, queue, and in the music player. On click, call backend to toggle favorite in Jellyfin; update icon state (filled/unfilled). Works for `jellyfin:xxx` tracks; backend uses Jellyfin Favorites API.
- [ ] **Favorites view (auto-updating list)**
  - Add a **Favorites** section or entry point (e.g. in Library sidebar or a dedicated "Favorites" playlist-like view). When opened, fetch the list from the new backend endpoint (GET favorites from Jellyfin). Display as a track list; play and stream work via existing `getStreamUrl(jellyfin:xxx)`. List is a live view—no stored playlist—so it auto-updates when the user (or Jellyfin) adds/removes favorites. Optionally refresh when returning to the tab or after toggling a heart.

**Relevant files (current):** Library track rows, player (FullPlayer / NowPlayingQueuePanel), `frontend/lib/api.ts` (new methods for favorite toggle and get favorites).

---

## 15. Frontend – search, discovery, downloads

- [ ] **Search**
  - Library search (artists, albums, tracks) should hit the same library API that is backed by Jellyfin when enabled; backend search must query Jellyfin (or Jellyfin + native) and return unified results.
- [ ] **Discovery and “add to library”**
  - Discovery UI and “add to library” flows stay; only the “library” that receives new music is Jellyfin (download path = Jellyfin library path). Frontend may need no change if backend handles destination and “library” is just “what Jellyfin returns.”
- [ ] **Playlist import**
  - Import flows (Spotify, etc.) unchanged from user perspective; backend resolves new albums to Jellyfin after they are downloaded and indexed.

**Relevant files (current):** `frontend/features/search/`, discovery-related pages, download/add-to-library buttons.

---

## 16. Testing and documentation

- [ ] **E2E / integration**
  - Add or extend tests for: library endpoints when Jellyfin is enabled (mock Jellyfin API); stream route for `jellyfin:itemId`; playlist create/update with Jellyfin push; playback state with Jellyfin track in queue.
- [ ] **Docs**
  - Update README or docs with: Jellyfin as default music source for Lidifin, required env/settings, that metadata comes from Jellyfin and playlists are pushed to Jellyfin (Option B), optional AudioMuse-AI for vibe.

---

## Summary checklist (high level)

| Area | Backend | Frontend |
|------|---------|----------|
| **Config** | Jellyfin ( + optional AudioMuse) settings | Settings UI, onboarding path for Jellyfin |
| **Library** | Jellyfin adapter (proxy + map), library routes serve from adapter when enabled | Reuse existing UI; ensure stream URL and ids work |
| **Stream** | GET /tracks/:id/stream handles `jellyfin:xxx` (redirect or proxy) | getStreamUrl(trackId) unchanged if id format supported |
| **Playlists** | Store `jellyfin:itemId`, resolve for GET; push create/update/delete to Jellyfin | Add-to-playlist and playlist detail work with resolved items |
| **Playback / queue** | Resolve `jellyfin:xxx` in playback state and queue to full track + stream URL | No change if backend resolves |
| **Discovery / downloads** | Download path = Jellyfin library; optional Jellyfin scan trigger; import → Jellyfin ids | No major change |
| **Scan** | Disable or gate native scan when Jellyfin is music source | Optional: hide scan when Jellyfin only |
| **Vibe / mixes** | AudioMuse-AI for Jellyfin items; mixes use Jellyfin-backed “library” | No change if API shape unchanged |
| **Schema** | Track reference as string or optional FK; Playlist.jellyfinPlaylistId; Play/LikedTrack for Jellyfin ids | — |

This to-do can be used as the implementation checklist when starting Lidifin work; tick items as they are done and adjust order per phase (1 → 2 → 3).
