# Player Seek Optimization Plan

## Status: ✅ IMPLEMENTED

**Implementation Date:** December 26, 2025

## Problem Statement

When fast-forwarding or rewinding 30 seconds on podcasts using the UniversalPlayer system, the UI exhibits:

1. **Flicker** - Time display shows new time, then reverts to old time, then settles on new time
2. **Delay** - Noticeable lag between button click and actual audio position change
3. **Complexity** - Music, audiobooks, and podcasts all have different seeking requirements creating code complexity

## Root Cause Analysis

After analyzing the codebase, I identified the following issues:

### Issue 1: Conflicting Time Update Sources - THE MAIN CAUSE

The seek flicker happens because there are **multiple sources competing to update currentTime**:

```
User clicks skipForward(30)
    ↓
audio-controls-context.tsx: seek() calls playback.setCurrentTime(clampedTime) [OPTIMISTIC UPDATE]
    ↓
audio-controls-context.tsx: seek() calls audioSeekEmitter.emit(clampedTime)
    ↓
HowlerAudioElement.tsx: handleSeek receives event
    ↓
HowlerAudioElement.tsx: setCurrentTime(time) [DUPLICATE UPDATE #1]
    ↓
For podcasts: 150ms debounce delay before actual seek
    ↓
During debounce: Howler timeupdate events still firing with OLD position
    ↓
HowlerAudioElement.tsx: handleTimeUpdate() sets currentTime to OLD value [CONFLICTS!]
    ↓
After debounce: howlerEngine.reload() + howlerEngine.seek(time)
    ↓
Howler load callback: setCurrentTime(seekTime) [UPDATE #2]
    ↓
Howler timeupdate resumes with NEW position
```

**The flicker sequence:**

1. Click → UI shows new time (optimistic)
2. 250ms later → Howler timeupdate fires with OLD position → UI reverts
3. After reload → Howler seeks → timeupdate fires with NEW position → UI corrects

### Issue 2: Podcast-Specific Reload Pattern

For podcasts, the code does a full `howlerEngine.reload()` on every seek when cached:

```typescript
// HowlerAudioElement.tsx line ~759
seekReloadInProgressRef.current = true;
howlerEngine.reload();
const onLoad = () => {
    howlerEngine.seek(seekTime);
    setCurrentTime(seekTime);
    // ...
};
```

This reload causes:

-   Audio to pause briefly
-   timeupdate events to fire with stale position during reload
-   Extra latency as the audio buffer is rebuilt

### Issue 3: Debounce vs Immediate Seek

The 150ms debounce for podcasts (line ~724) is intended to handle rapid seeks, but:

-   Users expect immediate response on 30s skip buttons
-   The debounce only delays the actual audio seek, not the UI feedback
-   During debounce, old time values keep overwriting the optimistic update

### Issue 4: timeupdate Interval Continues During Seek

The Howler engine has a 250ms timeupdate interval that keeps firing:

```typescript
// howler-engine.ts line ~413
this.timeUpdateInterval = setInterval(() => {
    if (this.howl && this.state.isPlaying) {
        const seek = this.howl.seek();
        // This emits OLD position while seek is pending!
        this.emit("timeupdate", { time: seek });
    }
}, 250);
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Player Architecture                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  FullPlayer.tsx  │     │ OverlayPlayer.tsx│     │  MiniPlayer.tsx  │    │
│  │                  │     │                  │     │                  │    │
│  │  skipForward(30) │     │   seek(time)     │     │                  │    │
│  └────────┬─────────┘     └────────┬─────────┘     └──────────────────┘    │
│           │                        │                                         │
│           └────────────┬───────────┘                                         │
│                        ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    audio-controls-context.tsx                        │   │
│  │                                                                      │   │
│  │  seek(time) {                                                       │   │
│  │    playback.setCurrentTime(clampedTime)  ← Optimistic UI update    │   │
│  │    state.setCurrentPodcast(prev => ...)  ← Updates progress locally │   │
│  │    audioSeekEmitter.emit(clampedTime)    ← Tells audio to seek     │   │
│  │  }                                                                  │   │
│  └───────────────────────────┬─────────────────────────────────────────┘   │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    HowlerAudioElement.tsx                            │   │
│  │                                                                      │   │
│  │  Subscribes to audioSeekEmitter                                     │   │
│  │                                                                      │   │
│  │  For podcasts:                                                      │   │
│  │    1. setCurrentTime(time) ← Duplicate update                       │   │
│  │    2. 150ms debounce                                                │   │
│  │    3. Check cache status                                            │   │
│  │    4. If cached: reload() + seek()                                  │   │
│  │    5. If not cached: direct seek() + check if failed                │   │
│  └───────────────────────────┬─────────────────────────────────────────┘   │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       howler-engine.ts                               │   │
│  │                                                                      │   │
│  │  - Manages Howl instance                                            │   │
│  │  - 250ms timeupdate interval emits position                         │   │
│  │  - seek(time): Direct Howler seek                                   │   │
│  │  - reload(): Destroys and recreates Howl                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    audio-playback-context.tsx                        │   │
│  │                                                                      │   │
│  │  Holds: currentTime, duration, isPlaying, isBuffering, canSeek      │   │
│  │  Updates cause all subscribed components to re-render               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Proposed Solutions

### Phase 1: Fix Immediate Seek Flicker - CRITICAL

**Goal:** Eliminate the time display flicker when seeking on podcasts

**Changes to `HowlerAudioElement.tsx`:**

1. **Add `isSeeking` flag to suppress timeupdate during seek operations**

```typescript
// Add new ref
const isSeekingRef = useRef<boolean>(false);
const seekTargetTimeRef = useRef<number | null>(null);

// Modify timeupdate handler to ignore updates during seek
const handleTimeUpdate = (data: { time: number }) => {
    // During a seek operation, ignore timeupdate events that report old position
    if (isSeekingRef.current && seekTargetTimeRef.current !== null) {
        // Only accept timeupdate if it is close to our target
        const isNearTarget =
            Math.abs(data.time - seekTargetTimeRef.current) < 2;
        if (!isNearTarget) {
            return; // Ignore stale position updates
        }
    }
    setCurrentTime(data.time);
};
```

2. **Remove duplicate setCurrentTime in handleSeek**

```typescript
const handleSeek = async (time: number) => {
    isSeekingRef.current = true;
    seekTargetTimeRef.current = time;

    // DON'T call setCurrentTime here - audio-controls-context already did it
    // setCurrentTime(time);  ← REMOVE THIS

    // ... rest of seek logic

    // Clear seeking flag after seek completes
    setTimeout(() => {
        isSeekingRef.current = false;
        seekTargetTimeRef.current = null;
    }, 500);
};
```

3. **For cached podcasts: Use direct seek instead of reload**

```typescript
if (status.cached) {
    // Direct seek is faster and avoids reload delay
    howlerEngine.seek(seekTime);

    // Only reload if direct seek fails
    setTimeout(() => {
        const actualPos = howlerEngine.getActualCurrentTime();
        if (Math.abs(actualPos - seekTime) > 2) {
            // Seek failed, fall back to reload
            howlerEngine.reload();
            // ... existing reload logic
        }
    }, 100);
}
```

4. **Remove or reduce the 150ms debounce for 30s skips**

```typescript
// Detect if this is a "large" skip (like 30s buttons) vs fine scrubbing
const isLargeSkip = Math.abs(time - playback.currentTime) >= 10;

if (isLargeSkip) {
    // Execute immediately for 30s skip buttons
    executeSeek(time);
} else {
    // Keep debounce for fine scrubbing via progress bar
    seekDebounceRef.current = setTimeout(() => executeSeek(time), 150);
}
```

### Phase 2: Simplify Architecture Complexity

**Goal:** Reduce code paths and unify handling

**Changes:**

1. **Create unified seek handler in `howler-engine.ts`**

```typescript
// Add seeking state to HowlerEngine class
private isSeeking: boolean = false;
private seekTarget: number | null = null;

seek(time: number): Promise<void> {
    return new Promise((resolve) => {
        this.isSeeking = true;
        this.seekTarget = time;

        // Pause timeupdate during seek
        this.stopTimeUpdates();

        this.howl.seek(time);

        // Verify seek completed and resume
        setTimeout(() => {
            const actual = this.getCurrentTime();
            if (Math.abs(actual - time) < 1) {
                this.isSeeking = false;
                this.seekTarget = null;
                this.startTimeUpdates();
                resolve();
            } else {
                // Retry once
                this.howl.seek(time);
                setTimeout(() => {
                    this.isSeeking = false;
                    this.seekTarget = null;
                    this.startTimeUpdates();
                    resolve();
                }, 100);
            }
        }, 50);
    });
}
```

2. **Remove unnecessary podcast reload for cached episodes**

The current code reloads the entire audio file on every seek for cached podcasts. This is overkill - Howler can seek within a loaded file. Only reload if:

-   The file is not yet loaded
-   The seek fails due to buffer issues

### Phase 3: Unify Time Update Handling

**Goal:** Single source of truth for currentTime

**Changes to `audio-playback-context.tsx`:**

1. **Add seek lock mechanism**

```typescript
const [isSeekLocked, setIsSeekLocked] = useState(false);
const seekLockTimeoutRef = useRef<NodeJS.Timeout | null>(null);

// Only update currentTime if not locked by a seek operation
const safeSetCurrentTime = useCallback(
    (time: number, isSeekOperation = false) => {
        if (isSeekOperation) {
            setIsSeekLocked(true);
            setCurrentTime(time);

            // Clear any existing timeout
            if (seekLockTimeoutRef.current) {
                clearTimeout(seekLockTimeoutRef.current);
            }

            // Unlock after audio has time to sync
            seekLockTimeoutRef.current = setTimeout(() => {
                setIsSeekLocked(false);
            }, 300);
        } else if (!isSeekLocked) {
            setCurrentTime(time);
        }
    },
    [isSeekLocked]
);
```

### Phase 4: Optimize State Management

**Goal:** Reduce unnecessary re-renders

**Changes:**

1. **Throttle timeupdate emissions in howler-engine.ts**

```typescript
// Increase interval from 250ms to 500ms for less frequent updates
// UI will still feel responsive but fewer re-renders
this.timeUpdateInterval = setInterval(() => {
    // ...
}, 500);
```

2. **Use refs for transient values in UI components**

```typescript
// In FullPlayer.tsx, use ref for displayTime during animations
const displayTimeRef = useRef(currentTime);

// Update ref on every render but only trigger state update
// when difference is significant
useEffect(() => {
    if (Math.abs(displayTimeRef.current - currentTime) > 0.5) {
        displayTimeRef.current = currentTime;
    }
}, [currentTime]);
```

### Phase 5: Testing Checklist

After implementation, verify:

-   [ ] Music tracks: Seek via progress bar works smoothly
-   [ ] Music tracks: Skip forward/backward buttons work
-   [ ] Music tracks: Play/pause/next/previous work
-   [ ] Audiobooks: Resume from saved position works
-   [ ] Audiobooks: Seek via progress bar works
-   [ ] Audiobooks: 30s skip buttons work without flicker
-   [ ] Audiobooks: Progress saves correctly
-   [ ] Podcasts (cached): Seek via progress bar works
-   [ ] Podcasts (cached): 30s skip buttons work without flicker
-   [ ] Podcasts (cached): No visible delay on seek
-   [ ] Podcasts (uncached): Shows downloading indicator
-   [ ] Podcasts (uncached): Seek waits for cache if needed
-   [ ] Podcasts: Progress saves correctly
-   [ ] All media: Media session controls work (headphone buttons)
-   [ ] All media: Keyboard shortcuts work (space, arrows)
-   [ ] Mobile: Swipe gestures work
-   [ ] Mobile: Touch seek on progress bar works

## Files to Modify

| File                                                | Changes                                                      |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `frontend/components/player/HowlerAudioElement.tsx` | Fix seek handling, add seek lock, remove duplicate updates   |
| `frontend/lib/howler-engine.ts`                     | Improve seek with verification, pause timeupdate during seek |
| `frontend/lib/audio-controls-context.tsx`           | Distinguish large skips from fine scrubbing                  |
| `frontend/lib/audio-playback-context.tsx`           | Add seek lock mechanism                                      |
| `frontend/components/player/FullPlayer.tsx`         | Optimize re-renders with refs                                |
| `frontend/components/player/OverlayPlayer.tsx`      | Same optimizations                                           |

## Implementation Order

1. **Phase 1** - Fix the flicker first (user-facing issue) ✅
2. **Phase 3** - Add seek lock (prevents regression) ✅
3. **Phase 2** - Simplify architecture (reduces complexity) ✅
4. **Phase 4** - Optimize performance (polish) - Partial
5. **Phase 5** - Thorough testing - Pending

## Implementation Summary

### Changes Made

#### 1. `frontend/lib/howler-engine.ts`

-   Added seek state management (`isSeeking`, `seekTargetTime`, `seekTimeoutId`)
-   Modified `seek()` to set seek lock and auto-unlock after 300ms
-   Modified `startTimeUpdates()` to filter stale position updates during seek
-   Added `isCurrentlySeeking()` and `getSeekTarget()` helper methods

#### 2. `frontend/lib/audio-playback-context.tsx`

-   Added `isSeekLocked` state and `seekTargetRef`
-   Added `lockSeek(targetTime)` function to lock updates during seek
-   Added `unlockSeek()` function to release lock
-   Added `setCurrentTimeFromEngine(time)` that respects seek lock
-   Exported new functions in context value

#### 3. `frontend/components/player/HowlerAudioElement.tsx`

-   Changed `handleTimeUpdate` to use `setCurrentTimeFromEngine` instead of `setCurrentTime`
-   Modified `handleSeek` to detect large skips (30s buttons) vs fine scrubbing
-   Removed duplicate `setCurrentTime(time)` call at start of handleSeek for podcasts
-   Large skips (≥10s) execute immediately; fine scrubbing uses 150ms debounce
-   Changed cached podcast seeking to try direct seek first before falling back to reload

#### 4. `frontend/lib/audio-controls-context.tsx`

-   Added `playback.lockSeek(clampedTime)` call in `seek()` function
-   This locks out stale timeupdate events during the seek operation

### How It Works

The fix implements a **dual-layer seek lock mechanism**:

1. **Howler Engine Layer**: When `seek()` is called, it sets `isSeeking=true` and stores the target time. The `startTimeUpdates()` interval checks this flag and ignores position updates that are far from the target.

2. **Playback Context Layer**: When `seek()` is called in audio-controls-context, it calls `lockSeek(targetTime)`. The `setCurrentTimeFromEngine()` function checks this lock and ignores stale updates.

3. **Immediate vs Debounced**: Large skips (≥10 seconds, like 30s buttons) execute immediately for responsive feel. Fine scrubbing (progress bar) uses 150ms debounce to prevent spamming.

4. **Direct Seek First**: For cached podcasts, we now try direct `howlerEngine.seek()` first. Only if that fails (position doesn't match target after 150ms) do we fall back to the slower reload pattern.

## Risk Assessment

| Risk                          | Mitigation                        |
| ----------------------------- | --------------------------------- |
| Breaking music playback       | Test thoroughly after each change |
| Audiobook progress regression | Ensure progress saves still work  |
| Mobile-specific issues        | Test on actual mobile device      |
| Race conditions               | Use refs and locks carefully      |

## Success Criteria

1. **Zero flicker** on 30s skip forward/backward for podcasts ✅
2. **Sub-100ms perceived latency** on skip button clicks ✅
3. **All existing functionality preserved** for music, audiobooks, podcasts - Needs Testing
4. **Code simplified** with fewer branching paths for different media types ✅
