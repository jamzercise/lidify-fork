# Lidify Bug Handoff Guide
**Date:** 2025-12-26
**Project:** Lidify Music Server

---

## Overview

This document provides context for continuing work on several bugs in the Lidify application. The previous agent made partial fixes but issues remain.

---

## Bug 1: Mood Mixer - Multiple Issues

### Current State
- **Generation is slow** - Takes too long to generate mood mixes
- **UI not updating** - The playlist card on home page doesn't refresh when generating new mood mixes
- **Stale playlist persists** - User created "Happy" mix first, then replaced it 3 times with other emotions, but the original "Happy" card still shows on the home page even though the actual music changes

### Root Cause Analysis Needed
1. **Slow generation**: Check `backend/src/services/programmaticPlaylists.ts` - the `generateMoodOnDemand()` function (line ~3104) may be doing expensive database queries
2. **UI not updating**: The frontend uses React Query. Check:
   - `frontend/components/MoodMixer.tsx` - dispatches `window.dispatchEvent(new CustomEvent("mix-generated"))` and `"mixes-updated"` events
   - The home page component needs to listen for these events and invalidate/refetch
3. **Stale card**: The mix ID or cache key may not be changing. Look at:
   - How mood mix preferences are saved: `POST /mixes/mood/save-preferences`
   - How the home page fetches the mix to display

### Files to Investigate
- `backend/src/services/programmaticPlaylists.ts` - Main playlist generation logic
- `backend/src/routes/mixes.ts` - API endpoints for mood mixes
- `frontend/components/MoodMixer.tsx` - UI component
- `frontend/app/page.tsx` - Home page that displays mix cards
- `frontend/hooks/useQueries.ts` - React Query hooks

### Previous Fix Attempt
The previous agent added fallback logic in `generateMoodOnDemand()` (lines 3126-3183) to handle cases where enhanced audio analysis isn't available. The fix converts ML mood params to basic audio features as a fallback. This may have introduced complexity or bugs.

### Suggested Approach
1. **Check database indexes** - The query in `generateMoodOnDemand` filters by `analysisStatus`, `analysisMode`, and various audio features. Ensure proper indexes exist.
2. **Simplify the query** - Consider limiting the initial pool of tracks rather than applying all filters at once
3. **Fix cache invalidation** - The home page likely caches the mix data. Need to ensure proper invalidation when a new mix is generated
4. **User said "might need complete overhaul"** - Consider refactoring the mood mixer to be simpler

---

## Bug 2: Podcast Seeking - Still Broken

### Current Symptoms
1. **Slow press required** - User has to slowly press ±30s buttons, otherwise nothing happens
2. **Spam causes stuck state** - If user presses button rapidly, playback gets stuck in "perpetual play state" where fast forward/rewind stops working entirely

### Root Cause
The podcast seeking logic is complex and involves:
1. Checking cache status via API
2. Reloading the Howler audio engine
3. Seeking to position after reload
4. Multiple timeout-based checks

### Previous Fix Attempts
The previous agent added:
1. **Seek operation ID tracking** (`seekOperationIdRef`) to abort stale seeks
2. **Debouncing** (150ms) for podcast seeks via `seekDebounceRef`
3. **Better cleanup** of listeners and timeouts

These fixes were incomplete or introduced new issues.

### Files to Investigate
- `frontend/components/player/HowlerAudioElement.tsx` - Main seek handling logic (lines 672-853)
  - The seek handler is in `useEffect` starting around line 672
  - Uses `seekDebounceRef` and `pendingSeekTimeRef` for debouncing
  - Uses `seekOperationIdRef` to track/abort stale operations
- `frontend/lib/howler-engine.ts` - Low-level audio engine wrapper
  - `reload()` method (line ~293) - calls cleanup then load
  - `cleanup()` method (line ~438) - handles Howl instance teardown
  - The `cleanup()` has a delayed unload for playing audio which may cause race conditions

### Key Code Sections

**HowlerAudioElement.tsx - Seek Handler (lines 672-853):**
```typescript
useEffect(() => {
    const handleSeek = async (time: number) => {
        seekOperationIdRef.current += 1;
        const thisSeekId = seekOperationIdRef.current;
        
        // For podcasts: debounce, check cache, reload if cached, etc.
        // Complex async logic with multiple timeouts
    };
    
    const unsubscribe = audioSeekEmitter.subscribe(handleSeek);
    return unsubscribe;
}, [...deps]);
```

**howler-engine.ts - Cleanup (lines ~438-480):**
```typescript
private cleanup(): void {
    // Has delayed unload when wasPlaying (12ms fade + timeout)
    // This may race with new loads
}
```

### Suggested Approach
1. **Remove or increase debounce** - 150ms might be too short or the logic is wrong
2. **Fix the stuck state** - Likely caused by event listeners not being properly cleaned up
3. **Simplify the reload logic** - The cache check → reload → seek → play chain is fragile
4. **Consider immediate cleanup** - Skip the fade delay for podcast seeks to prevent race conditions
5. **Add loading/disabled state** - Disable seek buttons while a seek is in progress

---

## Bug 3: Similar Artists ("Fans Also Like") - Partially Fixed

### Current State
The previous agent made fixes to show library artists in the "Fans Also Like" section. The fix:
- Checks if similar artists exist in the user's library
- Returns `inLibrary` flag and `ownedAlbumCount`
- Shows a library badge icon

### Files Modified
- `backend/src/routes/library.ts` - Enhanced similar artists response (lines 1369-1533)
- `frontend/features/artist/types.ts` - Added `inLibrary?: boolean` to SimilarArtist type
- `frontend/features/artist/components/SimilarArtists.tsx` - Updated UI and navigation logic

### Status
Believed to be working but needs verification.

---

## Development Environment

### Key Commands
```bash
# Backend
cd backend
npm run dev        # Dev server with hot reload
npm run build      # Production build
npx tsc --noEmit   # Type check only

# Frontend
cd frontend
npm run dev        # Dev server
npm run build      # Production build
```

### Architecture
- **Backend**: Express.js + Prisma + PostgreSQL + Redis
- **Frontend**: Next.js 14 (App Router) + React Query + TailwindCSS
- **Audio**: Howler.js for playback
- **Analysis**: Essentia Docker container for audio feature extraction

### Database
- **Prisma** ORM with PostgreSQL
- Key models: Track, Album, Artist, User
- Tracks have `analysisStatus` and `analysisMode` fields for audio analysis state

---

## Priority Order

1. **Podcast seeking** - Most user-facing, core functionality broken
2. **Mood mixer UI not updating** - Confusing UX
3. **Mood mixer slow** - Performance issue

---

## Quick Reference - Key Files

| Feature | Backend | Frontend |
|---------|---------|----------|
| Mood Mixer | `services/programmaticPlaylists.ts`, `routes/mixes.ts` | `components/MoodMixer.tsx`, `app/page.tsx` |
| Podcast Seek | `routes/podcasts.ts` | `components/player/HowlerAudioElement.tsx`, `lib/howler-engine.ts` |
| Similar Artists | `routes/library.ts` (lines 1369-1533) | `features/artist/components/SimilarArtists.tsx` |

---

## Notes from Previous Agent

1. The mood mixer presets all use ML mood params (`moodHappy`, `moodSad`, etc.) which require `analysisMode: "enhanced"`. A fallback to basic audio features was added but may be causing issues.

2. The podcast seek debounce was added at 150ms with a `pendingSeekTimeRef` to coalesce rapid seeks. This approach may be flawed.

3. The Howler engine's `cleanup()` method has an intentional 12ms fade delay before unloading to reduce audio pops. This delay may cause race conditions with rapid reloads.

4. The `seekOperationIdRef` counter was intended to abort stale seek operations but the logic may have bugs in how it's checked across async boundaries.
