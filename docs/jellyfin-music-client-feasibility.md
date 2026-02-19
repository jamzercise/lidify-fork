# Jellyfin as Music Library Backend (Lidifin) – Feasibility

**Goal:** Use Jellyfin as the **music library** source in Lidify (browse, stream, playlists for music) while keeping **all other Lidify features** working: audiobooks (Audiobookshelf), podcasts, discovery, playlist import, downloads (Lidarr/Soulseek), vibe, etc.

---

## TL;DR – Feasibility

**Feasible, with significant but bounded work.** The cleanest approach is:

- **Music:** Sourced from Jellyfin only (artists, albums, tracks, stream URLs). Lidify becomes a “Jellyfin music client” for the music tab and playback.
- **Everything else:** Unchanged. Audiobooks (Audiobookshelf), podcasts (RSS), discovery, imports, downloads, and playback state stay in Lidify; only the *music* data and *music* stream URLs come from Jellyfin.

**Vibe / audio analysis:** Can be **offloaded to [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI)**—a separate Dockerized service that already integrates with Jellyfin, runs local sonic analysis (Librosa, ONNX, CLAP), and exposes similar-songs, text search, and mood-based playlists. Lidify would call AudioMuse-AI’s API with Jellyfin item IDs and use the returned IDs for “vibe” and radio features instead of running its own analysis pipeline.

---

## Current vs Target Architecture

### Current (Lidify today)

| Concern | How it works |
|--------|----------------|
| **Music library** | Filesystem scan (`MUSIC_PATH`) → `MusicScanner` → PostgreSQL (Artist, Album, Track). Each track has `filePath`, `fileModified`, etc. |
| **Music streaming** | `GET /api/library/tracks/:id/stream` → `AudioStreamingService` reads file from `musicPath + track.filePath`, optional transcode, range support. |
| **Music metadata** | Enrichment from MusicBrainz, Last.fm; CLAP/Essentia for vibe (BPM, energy, mood, embeddings). |
| **Discovery / downloads** | Lidarr (add album → download → webhook) or Soulseek → files land in `MUSIC_PATH` → Lidify scan picks them up. |
| **Playlist import** | Spotify/Deezer/YT Music → match tracks → Lidarr/Soulseek download → scan → playlist. |
| **Audiobooks** | Audiobookshelf API + proxy stream. |
| **Podcasts** | RSS + Lidify DB (subscriptions, progress); stream from episode URL or proxy. |
| **Playback state** | Lidify DB (PlaybackState, Play, queue); frontend uses Lidify `trackId` and Lidify stream URL. |

### Target (Lidifin – Jellyfin for music)

| Concern | How it would work |
|--------|---------------------|
| **Music library** | **Jellyfin** as single source of truth. Lidify **proxies** Jellyfin API and maps responses to the same JSON shape the frontend uses; no copy of library data stored in Lidify. Optional short-TTL cache for hot paths. |
| **Music streaming** | Stream from **Jellyfin** (e.g. Jellyfin’s `/Audio/{id}/stream` or PlaybackInfo). Lidify can proxy with auth or return Jellyfin stream URL + token so the frontend hits Jellyfin. |
| **Music metadata** | From Jellyfin (and optionally Last.fm/MusicBrainz for display). Vibe/analysis: see hurdles below. |
| **Discovery / downloads** | Unchanged in flow: Lidarr/Soulseek still download to a path. That path is configured as a **Jellyfin library** so Jellyfin indexes new music; Lidify does *not* scan that path for music—it only reads from Jellyfin. |
| **Playlist import** | Unchanged: import → download to Jellyfin library path → Jellyfin rescans (or we trigger a Jellyfin scan). No Lidify music scan. |
| **Audiobooks / Podcasts / Playback state / rest** | Unchanged; only “music” is switched to Jellyfin. |

So: **music** = Jellyfin client; **non-music** = current Lidify behavior.

---

## Music metadata: pull from Jellyfin only (no Lidifin enrichment)

**Decision:** Lidifin does **not** add, store, or track music metadata itself. It **pulls metadata straight from Jellyfin** and lets Jellyfin handle all metadata enrichment (tags, artwork, artist/album info, etc.).

| Approach | Rationale |
|----------|-----------|
| **Pull from Jellyfin only** ✓ | **Chosen.** Jellyfin is already the source of truth for the music library; it has its own metadata (embedded tags, plugins, and optional MusicBrainz/other metadata). Lidifin proxies or maps Jellyfin item responses to the shape the frontend needs—no copy, no sync, no duplicate enrichment. Simpler and consistent with "no library storage in Lidify" (Option B in the data model). |
| Lidifin adds/tracks metadata | Would require storing a copy of library or per-track metadata in Lidify, sync when Jellyfin changes, and duplicate enrichment pipelines. Only consider if you need Lidify-only metadata (e.g. custom tags) that Jellyfin cannot hold; not in scope for the initial build. |

**In practice:** Artist/album/track names, cover art, release year, etc. all come from Jellyfin API responses. Lidifin does not run MusicBrainz/Last.fm (or similar) for Jellyfin music; Jellyfin (and its plugins) do that. Vibe/analysis (BPM, mood, similar tracks) is handled by **AudioMuse-AI** when used, not by Lidifin storing or enriching metadata.

---

## Jellyfin API (what we’d use)

- **Items:** `GET /Items` with `IncludeItemTypes=MusicArtist,MusicAlbum,Audio` (and filters) for library browse; `GET /Items/{id}` for details.
- **Playback / streaming:** `GET /Audio/{id}/stream` (or universal audio endpoint) with query params for codec/bitrate; or `GET /Items/{id}/PlaybackInfo` then stream the chosen URL. Supports transcoding and range requests.
- **Auth:** API key or user auth (e.g. `MediaBrowser` header). Lidify would store Jellyfin server URL + credentials and use them for all music requests.
- **Favorites:** `POST /Users/{UserId}/FavoriteItems/{Id}` to add favorite; remove endpoint to unfavorite. `GET /Items` with `isFavorite=true` and `userId` to list the user's favorite items (e.g. for the Favorites view).

Lidify's frontend today expects: list of artists/albums/tracks (with ids, titles, cover, etc.) and a **stream URL per track**. With an adapter that maps Jellyfin items to the same shapes and provides a stream URL (Lidify proxy or Jellyfin direct), the current UI can be reused with minimal changes.

---

## Jellyfin Favorites (heart icon + auto-updating Favorites list)

**Goal:** Use Jellyfin's Favorites so that (1) users can tap a **heart icon** (e.g. next to each track and in the music player) to favorite/unfavorite in Jellyfin, and (2) a **Favorites** list in Lidifin that behaves like an auto-updating playlist—always showing the current favorited tracks, with no separate stored playlist to maintain.

**How it works:**

- **Heart icon:** When the user taps the heart on a track (library, queue, or player), the backend calls Jellyfin: `POST /Users/{UserId}/FavoriteItems/{ItemId}` to add, or the appropriate remove-favorite call to unfavorite. The track is then favorited (or not) in Jellyfin; the same state is visible in Jellyfin's own UI and other clients.
- **Favorites list (auto-updating "playlist"):** Expose a **Favorites** section or playlist-like view in Lidifin. When opened, the backend calls Jellyfin `GET /Items` with `isFavorite=true` and `includeItemTypes=Audio` (and `userId`) to get the user's favorite tracks. Map the response to the same track shape the frontend uses and return as a list. This list is **not** a stored playlist in Lidifin—it is a **live view** of Jellyfin favorites, so it auto-updates whenever the user (or another client) adds/removes favorites. Optionally, we could also push this list to a Jellyfin playlist (e.g. "Lidifin Favorites") so it appears as a playlist in Jellyfin's sidebar and stays in sync; that would be an extra sync step when favorites change.

**Recommendation:** Implement heart icon + Favorites view as above (live view from Jellyfin, no stored playlist). Optional later: sync Favorites to a Jellyfin playlist for visibility in Jellyfin's UI.

---

## Using AudioMuse-AI for vibe / analysis (recommended)

[AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI) is an open-source, Dockerized service that:

- Connects to **Jellyfin** (and Navidrome, LMS, Lyrion, Emby) via API and performs **local sonic analysis** on the media server’s library (Librosa, ONNX, CLAP).
- Exposes a **Flask REST API** (with Swagger) for:
  - **Similar songs** (e.g. “playlist from similar songs” given a track).
  - **Text search** (e.g. “calm piano songs”, “high-tempo low-energy”) via CLAP.
  - **Clustering**, **Music Map**, **Song paths** (bridge between two tracks), **Sonic fingerprint**, **Song Alchemy** (vibe sliders, ADD/SUBTRACT).
- Stores results keyed by the **media server’s item IDs** (e.g. Jellyfin item IDs), so responses are directly usable by a Jellyfin client.
- Offers an **[AudioMuse-AI Plugin for Jellyfin](https://github.com/NeptuneHub/AudioMuse-AI)** so users can use these features inside Jellyfin’s UI as well.

**How Lidifin would use it:**

1. **Deploy:** User runs Jellyfin (music library) + AudioMuse-AI (configured with `MEDIASERVER_TYPE=jellyfin`, `JELLYFIN_URL`, `JELLYFIN_USER_ID`, `JELLYFIN_TOKEN`). AudioMuse-AI runs its “Analysis and Clustering” on Jellyfin’s library once (or on a schedule).
2. **Lidify config:** Add optional settings for AudioMuse-AI base URL (e.g. `http://audiomuse:8000`) so Lidify backend can call it.
3. **“Vibe” / “Similar tracks” in Lidify:** When the user taps “vibe” or “find similar” for a track, Lidify backend:
   - Sends the **Jellyfin item ID** of that track to AudioMuse-AI’s similar-songs (or equivalent) endpoint.
   - Receives a list of **Jellyfin item IDs** (similar tracks).
   - Builds the queue in Lidify with those ids (as `jellyfin:itemId`) and streams from Jellyfin as usual.
4. **Radio / mood mixes:** For “mood mixer” or “workout” style radio, Lidify could call AudioMuse-AI’s text search or alchemy endpoints with a text query or vibe params and get back Jellyfin item IDs, then build the queue and stream from Jellyfin.
5. **No analysis in Lidify:** Lidify does not run CLAP/Essentia or store embeddings for Jellyfin music; AudioMuse-AI is the single place that does analysis for the Jellyfin library.

**Benefits:**

- **No duplicate pipeline:** One analysis stack (AudioMuse-AI) for Jellyfin music; Lidify stays a thin client.
- **Same ecosystem:** Users who already use Jellyfin + AudioMuse-AI plugin get the same “vibe” data when using Lidify as their client.
- **Proven stack:** AudioMuse-AI is already used with Jellyfin (and others); we only consume its API.

**Caveats:**

- AudioMuse-AI must be deployed and configured by the user (or documented as an optional Lidifin companion).
- Lidify needs to map its “vibe” and “radio” UI to AudioMuse-AI’s endpoints (similar, text search, alchemy); some UX tuning may be needed.
- If AudioMuse-AI is not configured, Lidify can fall back to “no vibe for music” (Option A in the hurdle list).

---

## Hurdles, Difficulty, and Workarounds

### 1. Data model and ID mismatch

- **Issue:** Lidify uses internal IDs (cuid) for Artist, Album, Track and expects `trackId` in playback state, playlists, and stream URL. Jellyfin uses its own item IDs (e.g. UUIDs) and types (MusicArtist, MusicAlbum, Audio).
- **Difficulty:** Medium.
- **Recommended approach: proxy + map, no library storage in Lidify (Option B below).** Keep Jellyfin as the single source of truth for music library data; Lidify does not store a copy of artists/albums/tracks. That avoids sync logic, duplicate storage, and cache invalidation, and keeps Lidifin simpler long-term.
- **Workarounds:**
  - **Option A (mirror/cache in Lidify):** Store a “virtual” or cached representation in Lidify (e.g. `JellyfinTrack` / `JellyfinAlbum` with `jellyfinItemId`), use composite id `jellyfin:${itemId}` in the API. **Downsides:** sync logic when Jellyfin library changes (scan/add/delete), duplicate storage, invalidation complexity. **Use only if** you need to serve library when Jellyfin is offline or to attach heavy Lidify-only metadata; otherwise prefer B.
  - **Option B (recommended):** **Do not store** Jellyfin library data in Lidify. Proxy Jellyfin API on demand: when the frontend requests artists, albums, or tracks, Lidify calls Jellyfin, maps the response to the **same JSON shape** the frontend already uses (ids as `jellyfin:${itemId}` or raw Jellyfin id), and returns it. Playbacks and playlists store only the track identifier (`jellyfin:itemId`); when building the queue or stream URL, the backend resolves that id by calling Jellyfin (item details, stream URL). **Benefits:** no sync, no duplicate library storage, single source of truth (Jellyfin), less code and less overhead. **Optional:** a short-TTL cache (e.g. in-memory or Redis) for hot paths (e.g. “current album”, “recent artists”) to reduce latency and load on Jellyfin without a full mirror.
  - **User-specific data:** Playback state, play history, playlists, and “liked” flags stay in Lidify and reference `jellyfin:itemId`. That’s a small overlay (Lidify tables keyed by user + jellyfin item id), not a copy of the full library—so it fits Option B.

### 2. Vibe system and audio analysis

- **Issue:** Vibe (mood, energy, “similar tracks”) and radio rely on Lidify’s CLAP/Essentia pipeline and DB (Track columns like `bpm`, `energy`, `valence`, `moodHappy`, embeddings). Jellyfin doesn’t provide this.
- **Difficulty:** Hard if you build and run analysis yourself; **low–medium** if you delegate to AudioMuse-AI (see below).
- **Workarounds:**
  - **Option A:** Disable vibe (and vibe-heavy radio) for Jellyfin-sourced tracks; keep “Shuffle all” / basic “play album” from Jellyfin. Easiest.
  - **Option B:** Keep a **small “native” Lidify library** (e.g. a folder of favorites) that Lidify still scans and analyzes; vibe and radio use only that subset. Jellyfin is the main library; native is the “smart” subset. Medium effort.
  - **Option C:** Run analysis on Jellyfin audio inside Lidify: backend fetches a stream (or temp file) from Jellyfin, runs Essentia/CLAP, stores results in Lidify keyed by Jellyfin item ID. High effort (storage, queue, dedup, invalidation).
  - **Option D (recommended):** **Use [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI)** as the analysis and “vibe” backend. AudioMuse-AI already connects to Jellyfin (and Navidrome, Emby, etc.), runs local sonic analysis (Librosa, ONNX, CLAP), and exposes REST endpoints for similar songs, text search (“calm piano songs”), clustering, song paths, and mood-based playlists. Lidify (Lidifin) would call AudioMuse-AI’s API with a Jellyfin item ID and get back a list of similar Jellyfin item IDs; Lidify then builds the queue and streams from Jellyfin. No duplicate analysis in Lidify; one stack (Jellyfin + AudioMuse-AI) handles library + vibe. See the dedicated section below.

### 3. Discovery and “add to library”

- **Issue:** Today, “add to library” = Lidarr/Soulseek download → files to `MUSIC_PATH` → Lidify scan. If music lives in Jellyfin, we don’t want a second Lidify filesystem scan for music; we want new files to appear in Jellyfin.
- **Difficulty:** Low–medium.
- **Workaround:** Configure Lidarr (and any Soulseek output) to download into a directory that is **a Jellyfin music library**. So “add to library” still triggers Lidarr/Soulseek; when the download lands, Jellyfin (via its own scan or real-time monitor) indexes it. Lidify only reads from Jellyfin; no Lidify music scan. Optionally: call Jellyfin’s “refresh library” API after a download completes so the new album shows up quickly.

### 4. Playlists and playback state

- **Issue:** Playlists and playback state reference “track id”. If that becomes “Jellyfin item id” (or `jellyfin:xxx`), we need to resolve it when building the queue and when requesting the stream.
- **Difficulty:** Low–medium.
- **Workaround:** Store in Lidify DB a “track identifier” that can be either current Lidify `trackId` (if you keep native for some paths) or `jellyfin:${itemId}`. Playback state and playlist item tables already have a “track” reference; you can either add a `source` + `externalId` or use a single string id that the backend interprets. When serving the queue, backend resolves each id to metadata (from Jellyfin or Lidify) and to a stream URL (Jellyfin stream or Lidify stream). Frontend stays the same (it just gets track-like objects and a stream URL).

**Where to store playlists** is a separate design choice; see the next section.

---

## Playlists: Lidifin only vs create in Lidifin and push to Jellyfin

### Design choice: music-only playlists in Lidifin

**Lidifin playlists are music-only by default.** All items in a playlist reference Jellyfin music (`jellyfin:itemId`). The only other “playlist-like” use case is **podcasts** (e.g. “queue up a few episodes”); that is handled by the **Now Playing** window / queue instead of saved playlists—users add podcast episodes to the queue and listen; no need for a separate “podcast playlist” type. That keeps the model simple and makes every Lidifin playlist eligible for optional push to Jellyfin (no mixed-content edge cases).

---

When a user creates a playlist in Lidifin (music from Jellyfin), you have two main approaches for **where** to store it.

### Option A: Playlists stored in Lidifin only

**How it works:** Playlist metadata (name, order, created/updated) and playlist items (each referencing `jellyfin:itemId`) live only in Lidify’s DB. Jellyfin is not aware of these playlists.

| Pros | Cons |
|------|------|
| **Single source of truth** – no sync or conflict resolution. | Playlists are **only visible in Lidifin**. If the user opens Jellyfin’s app or another Jellyfin client, they don’t see these playlists. |
| **No dependency on Jellyfin playlist API** – simpler integration. | No “backup” of playlists inside Jellyfin if the user later stops using Lidify. |
| **Full control** – ordering, duplicates, custom fields, sharing (Lidify’s public playlists) all in one place. | |
| **Less code** – no create/sync to Jellyfin, no error handling for Jellyfin playlist failures. | |

**Recommendation:** Best default. Simple, one place to manage playlists.

---

### Option B: Create in Lidifin, then push to Jellyfin

**How it works:** When the user creates or updates a playlist in Lidifin, the backend also calls Jellyfin’s API (e.g. `createPlaylist`, add items by Jellyfin item ID) so the playlist exists in Jellyfin as well. Lidifin can store the Jellyfin playlist ID to keep the two in sync.

| Pros | Cons |
|------|------|
| **Visible everywhere** – the same playlist appears in Jellyfin’s UI, Jellyfin mobile app, and other Jellyfin clients. | **Sync logic** – create/update/delete in Lidifin must be pushed to Jellyfin; need to handle Jellyfin API errors and retries. |
| **One playlist, two UIs** – user can choose to manage it in Lidifin or in Jellyfin. | **Direction of edits** – if the user edits the playlist in Jellyfin, Lidifin doesn’t know unless you implement pull/sync (adds complexity). |
| **Portability** – playlists live in Jellyfin too, so they survive switching away from Lidify. | **User mapping** – Jellyfin playlists are per user; if Lidifin uses one Jellyfin user for all Lidifin users, all Lidifin playlists would appear under that one Jellyfin user (may or may not be desired). |

**Recommendation:** **Selected for build.** When we start building Lidifin, use this approach: create playlists in Lidifin and push to Jellyfin (one-way, Lidifin → Jellyfin on create/update). Lidifin remains the source of truth; avoid two-way sync in a first version.

---

### Option C: Hybrid (Lidifin as source of truth, optional push)

- **All playlists** are stored in Lidifin (name, order, items with `jellyfin:itemId`). Since playlists are music-only, any of them can be pushed to Jellyfin.
- Optionally push to Jellyfin (e.g. user setting “Also show in Jellyfin” or a global “Sync playlists to Jellyfin”). Lidifin remains the source of truth; one-way push on create/update/delete.

---

### Summary

| Approach | Best for |
|----------|----------|
| **Lidifin only** | Simplest; single source of truth; no Jellyfin playlist API. |
| **Push to Jellyfin** | **Selected for build.** Create in Lidifin, one-way push to Jellyfin on create/update so playlists appear in Jellyfin clients too; Lidifin remains source of truth. Since playlists are music-only, every playlist is pushable. |
| **Hybrid** | Lidifin only by default with an option to push; not selected. |

**Build decision:** Use **Option B (push to Jellyfin)**. When we start building Lidifin, implement one-way sync: create/update/delete playlists in Lidifin, then push to Jellyfin so the same playlists are visible in Jellyfin's UI and other clients. Jellyfin supports this via API (`createPlaylist`, add items by item ID); handle errors and retries; ignore edits made in Jellyfin for v1 (or add optional pull later).

---

### 5. Multi-user and auth

- **Issue:** Jellyfin has its own users; Lidify has its own. You need a consistent way to “whose library / whose playback.”
- **Difficulty:** Medium.
- **Workarounds:**
  - **Option A (simplest):** One Jellyfin user (or API key) for the whole Lidify instance. All Lidify users see the same Jellyfin library. Per-user state (playback, playlists, history) stays in Lidify and references Jellyfin item ids. No Jellyfin user mapping.
  - **Option B:** Map Lidify user → Jellyfin user (e.g. store Jellyfin user id or API key per Lidify user). Each user sees their own Jellyfin library. More setup and config (e.g. “connect Jellyfin account” in Lidify settings).

**Does Jellyfin support per-user 3rd party clients?** Yes. Jellyfin's API is **user-scoped**: you authenticate as a specific Jellyfin user (API key or auth token for that user), and all API calls (library, playlists, stream URLs) return **that user's** data. So Lidifin can implement "one Jellyfin user linked per Lidify user": when Lidify user A logs in, the backend uses A's linked Jellyfin credentials and loads A's library (and any cached/offline data for A); when user B logs in, the backend uses B's Jellyfin credentials and loads B's library and cache. No special Jellyfin feature is required—just store per–Lidify-user the Jellyfin user id and auth (e.g. token or API key) and use it for every Jellyfin API call made on behalf of that user.


### 6. Offline and caching

- **Issue:** Lidify has an offline cache (e.g. CachedTrack) for native tracks. For Jellyfin, you’d need to either rely on Jellyfin’s own offline features (if any) or implement caching of Jellyfin streams in Lidify.
- **Difficulty:** Medium if you want offline in Lidify for Jellyfin music.
- **Workaround:** Phase 1: no offline for Jellyfin music (stream always from Jellyfin). Later: optional “cache for offline” that downloads from Jellyfin stream URL and stores in Lidify’s cache, keyed by Jellyfin id.

### 7. Cover art and images

- **Issue:** Lidify today serves cover art from its own API (file paths, URLs, or proxied). Jellyfin has its own image API (e.g. `GET /Items/{id}/Images/Primary`).
- **Difficulty:** Low.
- **Workaround:** For Jellyfin-sourced items, frontend or backend uses Jellyfin’s image URLs (with token if required), or Lidify proxies Jellyfin image API so the rest of the app still uses “one place” for images.

### 8. Transcoding and quality

- **Issue:** Lidify currently controls transcoding (quality settings, cache). Jellyfin does its own transcoding for streams.
- **Difficulty:** Low.
- **Workaround:** Rely on Jellyfin’s transcoding and quality params in the stream URL. Lidify can pass through user “quality” preference as Jellyfin query params (bitrate, codec) if needed. No need to duplicate transcoding in Lidify for Jellyfin music.

### 9. Playlist import and “library after import”

- **Issue:** After Spotify/Deezer import, the “library” that contains the new album is currently Lidify’s scanned library. With Jellyfin, new downloads should appear in Jellyfin.
- **Difficulty:** Low (already covered by “discovery” workaround).
- **Workaround:** Same as discovery: import triggers Lidarr/Soulseek → files go to Jellyfin library path → Jellyfin rescans. Playlist in Lidify stores references to Jellyfin item ids once those items exist in Jellyfin (you may need a “match by metadata” step to resolve “added album” to Jellyfin ids after Jellyfin has indexed).

### 10. Dual source (optional): Jellyfin + native Lidify library

- **Issue:** If you want both “music from Jellyfin” and “music from Lidify scan” (e.g. a small analyzed subset for vibe), the UI and API must support two sources and merge or switch views.
- **Difficulty:** Medium.
- **Workaround:** Backend exposes a single “library” that is the union of Jellyfin + native (with a `source` or `sourceId` on each item). Stream endpoint accepts either `trackId` (native) or `jellyfin:itemId` and routes to Lidify stream or Jellyfin stream. More branching, but keeps one API surface for the frontend.

---

## What Stays the Same (no or minimal change)

- **Audiobooks:** Audiobookshelf integration and streaming unchanged.
- **Podcasts:** RSS, subscriptions, progress, episode streaming unchanged.
- **Discovery UI and flows:** Last.fm, Deezer, Soulseek search, “add to library” (which will add to Jellyfin’s path and thus to Jellyfin).
- **Playlist import:** Spotify/Deezer/YT Music import; only the “library” we match against and write into becomes Jellyfin (or Jellyfin + native).
- **Downloads:** Lidarr and Soulseek behavior unchanged; only the destination path is the Jellyfin library.
- **Lidify auth, users, playback state, playlists:** Same; only the “track” reference can be native id or `jellyfin:itemId`.
- **Made For You / recommendations:** Can stay; they need to work on “library” data—that data can come from Jellyfin (and optionally native) with an adapter so the rest of the code still sees artists/albums/tracks.

---

## Suggested phases

1. **Phase 1 – Jellyfin as default music library**  
   - Jellyfin is the **default** (and initial) music library and streaming source for Lidifin—not optional. Add Jellyfin config (server URL, API key).  
   - Implement a “Jellyfin adapter” that fetches artists/albums/tracks from Jellyfin and maps them to the same DTOs the frontend already uses.  
   - Implement stream route that, for `jellyfin:itemId`, returns a redirect or proxy to Jellyfin’s audio stream.  
   - Main Library view is fed from Jellyfin (adapter + stream route); playback state and playlists store `jellyfin:xxx`.  
   - No Lidify music scan for the main library when using Jellyfin; discovery/downloads point to Jellyfin library path; playlist import resolves to Jellyfin item ids after Jellyfin has indexed.

2. **Phase 2 – Vibe and advanced features**  
   - Use AudioMuse-AI for Jellyfin (recommended), or: no vibe, or native subset, or custom pipeline.  
   - Implement chosen option and adjust radio/mixes accordingly.

3. **Phase 3 (optional) – Offline, multi-user Jellyfin**  
   - **Offline play:** Optional cache that downloads Jellyfin streams into Lidify (e.g. CachedTrack-style) so users can play music when Jellyfin or the network is unavailable (e.g. on the go, no Wi‑Fi).  
   - **Multi-user:** Optional per-user Jellyfin account linking (each Lidify user sees their own Jellyfin library).

---

## Additional hurdles and clarifications (to align on)

These are areas that are either **heavier lifts**, **under-specified**, or **deployment/ops concerns** worth deciding up front so the plan stays clear.

### 1. Existing Lidify users / migration

- **Issue:** If someone already runs Lidify with a **native scanned library** (Artist, Album, Track in DB) and playlists that reference native `trackId`, what happens when we switch to Lidifin (Jellyfin as default)?
- **Decision:** **Lidifin is new installs only.** We do not try to migrate existing Lidify users over. No automatic migration, no upgrade path that converts native library or playlists to Jellyfin. Existing Lidify deployments that want to keep their current native library should stay on (current) Lidify; users who want Jellyfin as the music source install or set up Lidifin as a fresh deployment. Document this clearly so expectations are set.

### 2. Jellyfin unreachable or slow (failure modes)

- **Issue:** When Jellyfin is down, slow, or returns errors: library API fails, stream fails, playlist push fails. Users need clear feedback and, where possible, graceful degradation.
- **Decision:** Use a single, clear message: **"Jellyfin is slow or unreachable. Check your Jellyfin instance."** (or very similar). Apply it consistently:
  - **Library:** When loading artists/albums/tracks fails, show this message and a **Retry** button (no need for a full-page refresh).
  - **Stream:** When a track fails to load, show the same message (e.g. "Could not load track. Jellyfin is slow or unreachable—check your Jellyfin instance.") and **skip to the next track** in the queue so the user is not stuck.
  - **Playlist push:** If create/update in Lidifin succeeds but push to Jellyfin fails (timeout, 5xx), **save the playlist in Lidify anyway**, show a non-blocking warning (e.g. "Playlist saved. Could not sync to Jellyfin; we'll retry."), and **retry the push in the background**. Do not fail the whole create.

### 3. Jellyfin connection vs download folder (deployment)

- **Jellyfin connection** is set up via **URL** (IP address or hostname of the Jellyfin instance, e.g. `http://192.168.1.10:8096`). That is used for API calls (library, stream URLs, push playlists). No filesystem path is configured in Lidifin for "where Jellyfin lives"—only the server URL.
- **Download folder** is the only path we need in Lidifin: where Lidarr/Soulseek write new files when the user adds to library or imports a playlist. The user should set this to the **same folder** (or a subfolder) that their Jellyfin instance uses as its **music library**, so that when files land there, Jellyfin can scan and index them. So: one "download folder" setting; the user may choose to point it at the same folder as their Jellyfin music library (or a mounted path that Jellyfin scans, e.g. shared storage if Jellyfin is on another machine).
- **Playlists** are not affected by this. Playlists in Lidifin are metadata + references to Jellyfin item IDs; saving or pushing playlists uses the Jellyfin **API** (over the URL), not the download path. The download path is only for where new *files* go so Jellyfin can index them; it does not cause issues with saving or syncing playlists.
- **Deployment note:** If Jellyfin runs on a different machine (e.g. NAS), the download folder in Lidifin must still be a path that **both** the Lidify/Lidarr host can write to **and** Jellyfin can read (e.g. a network mount that matches Jellyfin's library path). Document this so users understand the constraint.

### 4. Playlist import: matching to Jellyfin item ids

- **Issue:** After Spotify/Deezer import, we download via Lidarr/Soulseek → files land in Jellyfin library path → Jellyfin rescans. Then we need to **resolve** “this imported row (artist/album/track name)” to a **Jellyfin item id** so the Lidifin playlist can reference `jellyfin:xxx`.
- **Difficulty:** Low–medium. Requires: (a) knowing when Jellyfin has finished indexing (poll or delay), (b) matching by metadata (title, artist, album; optional MBID if Jellyfin exposes it), (c) handling “not found” (e.g. keep as pending or drop).
- **Decision:** Do it in **Phase 1**. Don't defer: implement "match imported rows to Jellyfin item ids" as part of the initial build. After Lidarr/Soulseek download and (optionally) triggering a Jellyfin library scan, wait for Jellyfin to index (e.g. poll or short delay), then match by metadata (artist, album, track name; MBID if Jellyfin exposes it) and resolve playlist items to `jellyfin:xxx`. Handle "not found" (e.g. skip and report count, or keep as pending with a clear UI). Shipping this in Phase 1 avoids half-baked imports and tech debt; scope is bounded (low–medium).

### 5. Schema migration and backwards compatibility

- **Issue:** Today `PlaylistItem.trackId`, `Play.trackId`, `LikedTrack.trackId`, etc. are **foreign keys to Track**. Supporting `jellyfin:itemId` means either: (a) add a separate “external” field (e.g. `externalTrackId`) and keep `trackId` nullable for Jellyfin items, or (b) store a single string “track reference” and drop the FK for that column (resolve at read time). Either way we need **migrations** and a clear story for existing rows (all native today).
- **Decision:** Use a **single string column** for the track reference (Option B). Keep the column name `trackId` (or rename to `trackReference` if preferred) as a **String with no FK**. Values are either: a native Lidify track id (cuid) or `jellyfin:` + Jellyfin item id. At read time: if the value starts with `jellyfin:`, resolve via the Jellyfin adapter; otherwise look up `Track` by id. One column, one concept; no dual-column branching.
- **Migration:** For `PlaylistItem`, `Play`, `LikedTrack`, `PlaybackState` (trackId and queue JSON), `ListeningState`, `CachedTrack`: change the column to a string type (e.g. TEXT) and **drop the foreign key** to Track. Existing rows already have cuid strings—they stay as-is. New rows store either cuid (if we ever support native again) or `jellyfin:uuid`. No backfill of data needed; only schema change.
- **Backwards compatibility:** Lidifin is new-installs-only, so there are no existing Lidifin rows. For the shared codebase, existing classic Lidify rows have cuid in `trackId`; application code treats any value that does not start with `jellyfin:` as native and resolves via Prisma Track. So old data continues to work.
- **Trade-off:** We lose referential integrity (no FK) for native track ids—orphaned references are possible if a Track is deleted. Acceptable for Lidifin (no native music); if dual-source is added later, handle cleanup in application logic or soft-delete.

### 6. Resolving many Jellyfin ids at once (performance)

- **Issue:** When returning a **playlist** or **queue** with many items (e.g. 100 tracks), we “resolve each `jellyfin:xxx` to metadata + stream URL.” Naively that could be 100+ Jellyfin API calls per request (N+1).
- **Decision:** Do both: **batch resolution first**, then **short-TTL cache** as a complement.
  - **Batch:** Jellyfin's Items API supports an `ids` parameter (array of item ids). When resolving a playlist or queue, collect all unique `jellyfin:xxx` ids, call **one** (or a few) `GET /Items` requests with `ids=[...]`, then map the response back to the requested order. That removes N+1; e.g. 100 tracks → 1–2 API calls instead of 100.
  - **Cache:** Add a short-TTL cache (e.g. 5 minutes) keyed by Jellyfin item id for **resolved metadata** (title, artist, album, cover). Use in-memory or Redis. Repeated resolution of the same id (same playlist opened again, overlapping queues) hits the cache instead of Jellyfin. Optionally cache stream URL only if it's stable for the TTL; if Jellyfin uses time-limited tokens, resolve stream URL on demand when the user hits play.
  - **Order of operations:** For a given request, collect ids → check cache for each → batch-fetch from Jellyfin only the missing ids → merge and fill cache → return ordered list. Keeps playlist/queue load fast and avoids hammering Jellyfin.

### 7. Stream: redirect vs proxy

- **Issue:** We can either **redirect** the client to Jellyfin’s stream URL (with token) or **proxy** the stream through Lidify. Redirect: client hits Jellyfin directly; works only if the client can reach Jellyfin (e.g. same LAN or Jellyfin has public URL). Proxy: client only talks to Lidify; works from anywhere but uses Lidify’s bandwidth and CPU.
- **Decision:** **Default to redirect.** The backend gets the stream URL from Jellyfin (with auth token), then returns an HTTP redirect (e.g. 302) so the client fetches the audio directly from Jellyfin. Easier to implement (no stream piping in Lidify), less bandwidth and CPU overhead, and Jellyfin handles transcoding and range requests. Document that the **client must be able to reach Jellyfin** (same LAN, or Jellyfin behind a public URL / VPN). If the user is away from home and Jellyfin is only on the home network, redirect will fail until they use a VPN or expose Jellyfin. Optionally add **proxy as a fallback or setting** later (e.g. “Stream via Lidify” for remote use) if needed.

### 8. First-time setup and validation

**What this means:** When the user configures Jellyfin in Lidifin (Settings or onboarding), they enter a **URL** and **API key** (or token). If the URL has a typo, wrong port, or wrong host—or the API key is invalid or expired—Lidifin will later fail to load the library or stream, and the user will just see an **empty library** or generic errors with no clear cause. **Validation** means: before we rely on that config, we **test** that we can reach Jellyfin and that the credentials work (e.g. call a simple Jellyfin API endpoint), and if it fails, show a **clear error** right then so the user can fix it.

**What needs to be ironed out:**

- **When to validate:** (a) When they click **Save** in Settings (don't save if validation fails), and/or (b) a separate **"Test connection"** button so they can try without saving. Both is ideal.
- **What to call:** A single, low-cost Jellyfin API call that requires auth—e.g. `GET /System/Info` or `GET /Users/Me` (or equivalent). Success = server reachable and credentials valid; failure = show error.
- **What to show on failure:** Specific messages where possible, e.g. "Could not reach Jellyfin. Check the URL and that Jellyfin is running." vs "Jellyfin returned 401. Check your API key." Avoid generic "Something went wrong" or silently saving and then showing an empty library.
- **Onboarding:** If Lidifin has an onboarding flow, validate Jellyfin config in that flow (e.g. before "Finish" or "Next") so the user can't complete setup with broken Jellyfin and then see an empty app.

**Decision:** Add a **"Test connection"** button for Jellyfin in Settings, same pattern as the existing ones for Audiobookshelf, Lidarr, and Soulseek. That way users can test on first setup and again whenever they change Jellyfin URL or API key later. Optionally validate on Save as well (don't save if test fails). Keeps the UX consistent across integrations.

### 9. Security: storing Jellyfin credentials

**Options that balance security and ease of use:**

- **Option A – DB only (plain):** Store Jellyfin URL and API key in the database (e.g. SystemSettings or user table for per-user). User edits everything in Settings. **Pros:** Easiest UX; no env to touch. **Cons:** If the DB is dumped, credentials are visible. Mitigate by documenting good practices (restrict DB access, HTTPS, etc.); many self-hosted apps work this way.
- **Option B – DB with encryption at rest:** Store URL in DB (plain); encrypt the API key before saving (e.g. with a key derived from `SESSION_SECRET` or a dedicated `ENCRYPTION_KEY` env). Decrypt only when making Jellyfin API calls. **Pros:** Same UX as A; if someone gets the DB without the key, they get ciphertext. **Cons:** Slightly more code; key must live somewhere (env), so if env is compromised too, they can decrypt.
- **Option C – API key in env only:** Store only the Jellyfin URL in the DB (Settings UI); require the API key to be set via environment variable. **Pros:** Secret never in DB. **Cons:** Worse UX—user must edit .env or restart container to change the key; awkward for non-technical users.
- **Option D – Hybrid:** Support both: if `JELLYFIN_API_KEY` is set in env, use it and ignore any DB value; otherwise use (optionally encrypted) value from DB. Power users can keep the key in env; others use Settings. **Pros:** Flexibility. **Cons:** Two code paths; need to document both.

**Decision:** Implement **Option D (Hybrid)**. When the backend needs the Jellyfin API key: if `JELLYFIN_API_KEY` is set in the environment, use it (env overrides DB); otherwise use the value from the DB (store encrypted at rest, e.g. key from `SESSION_SECRET` or `ENCRYPTION_KEY`, decrypt when needed). URL stays in the DB; user can edit both URL and API key in Settings. Document that env takes precedence. In the Settings UI, when the key is provided via env, show a hint (e.g. "Using API key from environment") so users know the field in the UI is not in use. **Always:** never log or expose the API key (e.g. in error messages or API responses).


### 10. Existing native playlists when Library is Jellyfin-only

**For Lidifin (new installs only): we don't have to worry about this.** There is no migration or import from Lidify—no playlists, no library data. Lidifin playlists are created fresh and reference Jellyfin items only. The rest of this section is only for context or if the same codebase ever serves both "classic" Lidify and Lidifin.

**What “native” means:** In **current Lidify** (pre-Lidifin), the music library is “native”—Lidify **scans the filesystem** (e.g. `MUSIC_PATH`), stores artists, albums, and tracks in **Lidify’s own database** (Artist, Album, Track tables), and streams from files on disk. So “native library” = the library Lidify builds and stores itself by scanning, as opposed to the library that **Jellyfin** provides (which we only proxy, not copy). In **Lidifin**, Jellyfin is the library; we don’t run that scan, so there is no native music library. “Native playlists” here means playlists whose **items** reference those old Lidify-stored tracks (by track id / cuid), rather than `jellyfin:itemId`—so it’s about where the track data came from (Lidify scan vs Jellyfin), not a separate “library” feature.

**What the uncertainty was:** If we turn off native music scan in Phase 1 but the codebase still has a `Track` table and playlists that reference native track ids (e.g. in a shared app that can run as either "classic Lidify" or "Lidifin"), two things needed deciding: (1) **Do we show native library content in the main Library view?** If yes, we'd have to keep serving native artists/albums/tracks from the DB alongside Jellyfin, which complicates the API. If no, native content would only appear when opening "My Playlists" that contain native items. (2) **Do we need to migrate those playlists to Jellyfin ids?** Or can we leave them as native ids and still have playback work?

**Alignment (and how Lidifin changes it):** We decided **Lidifin is new installs only**, so in a pure Lidifin deployment there are **no** existing native playlists—this scenario doesn't apply. For the shared codebase or any edge case where native playlists exist: **Library view = Jellyfin only** (don't serve native library in the main browse). **Stream route accepts both** native cuid and `jellyfin:xxx`, so any playlist that still has native ids continues to play; no migration required. Native content is only visible when the user opens a playlist that contains it, not in the main Library tab. That keeps the product story simple.

---

## Summary table

| Hurdle | Difficulty | Suggested workaround |
|--------|------------|----------------------|
| Data model / ID mismatch | Medium | **Proxy + map only:** no library storage in Lidify; proxy Jellyfin API, map to existing API shape; ids as `jellyfin:itemId` in playback/playlists |
| Vibe / audio analysis | Low–Medium with AudioMuse-AI | **Recommended:** Use [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI) (Jellyfin-integrated, local sonic analysis + CLAP). Lidify calls its API with Jellyfin item IDs and uses returned IDs for vibe/radio. Otherwise: disable, or native subset, or custom pipeline. |
| Discovery / add to library | Low–Medium | Lidarr/Soulseek → Jellyfin library path; Jellyfin scan; no Lidify music scan |
| Playlists / playback state | Low–Medium | Store `jellyfin:xxx`; resolve to metadata + stream URL in backend |
| Multi-user / auth | Medium | One Jellyfin user for instance, or map Lidify user → Jellyfin user |
| Offline / caching | Medium | Phase 1: no offline; later: cache Jellyfin stream in Lidify |
| Cover art | Low | Use Jellyfin image API or proxy |
| Transcoding | Low | Use Jellyfin’s transcoding and params |
| Playlist import | Low | Same as discovery; match to Jellyfin ids after index |
| Dual source (Jellyfin + native) | Medium | Optional; single “library” API that merges both and routes stream by id type |

Overall: **feasible** to use Jellyfin as the music backend and keep audiobooks, podcasts, discovery, downloads, and playlist import. For **vibe/analysis**, delegating to **AudioMuse-AI** (optional companion service) avoids duplicating analysis in Lidify and gives full “similar tracks” and mood-based features for Jellyfin music. Supporting a dual (Jellyfin + native) library remains optional.
