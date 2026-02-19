-- Lidifin: Jellyfin as music source; track reference as string (no FK to Track)
-- Adds Jellyfin settings; adds jellyfinPlaylistId to Playlist; drops FKs from PlaylistItem, Play, LikedTrack, CachedTrack

-- SystemSettings: Jellyfin fields
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinUrl" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinApiKey" TEXT;

-- Playlist: Jellyfin playlist id for push/sync
ALTER TABLE "Playlist" ADD COLUMN IF NOT EXISTS "jellyfinPlaylistId" TEXT;

-- Drop foreign keys so trackId can be native cuid or jellyfin:itemId (resolved at read time)
ALTER TABLE "PlaylistItem" DROP CONSTRAINT IF EXISTS "PlaylistItem_trackId_fkey";
ALTER TABLE "Play" DROP CONSTRAINT IF EXISTS "Play_trackId_fkey";
ALTER TABLE "LikedTrack" DROP CONSTRAINT IF EXISTS "LikedTrack_trackId_fkey";
ALTER TABLE "CachedTrack" DROP CONSTRAINT IF EXISTS "CachedTrack_trackId_fkey";
