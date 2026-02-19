"use client";

import { useCallback } from "react";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useFavorites } from "@/hooks/useFavorites";
import { TracksList } from "@/features/library/components/TracksList";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Heart, AudioLines } from "lucide-react";
import { Track } from "@/features/library/types";

function mapFavoritesToTrack(
    t: { id: string; title: string; duration: number; artist?: { id: string; name: string }; album?: { id: string; title: string; coverArt?: string | null } }
): Track {
    return {
        id: t.id,
        title: t.title,
        duration: t.duration,
        album: t.album
            ? {
                  id: t.album.id,
                  title: t.album.title,
                  coverArt: t.album.coverArt ?? undefined,
                  artist: t.artist ? { id: t.artist.id, name: t.artist.name } : undefined,
              }
            : undefined,
    };
}

export default function FavoritesPage() {
    const { tracks, isLoading, error, favoriteIds, removeFavorite } = useFavorites();
    const { playTracks, addToQueue } = useAudioControls();

    const libraryTracks: Track[] = tracks.map(mapFavoritesToTrack);

    const formatTracksForAudio = useCallback((libraryTracks: Track[]) => {
        return libraryTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            artist: {
                id: track.album?.artist?.id ?? "",
                name: track.album?.artist?.name ?? "Unknown Artist",
            },
            album: {
                id: track.album?.id ?? "",
                title: track.album?.title ?? "Unknown Album",
                coverArt: track.album?.coverArt,
            },
        }));
    }, []);

    const handlePlay = useCallback(
        (list: Track[], startIndex?: number) => {
            const formatted = formatTracksForAudio(list);
            playTracks(formatted, startIndex ?? 0);
        },
        [formatTracksForAudio, playTracks],
    );

    const handleAddToQueue = useCallback(
        (track: Track) => {
            addToQueue({
                id: track.id,
                title: track.title,
                duration: track.duration,
                artist: {
                    id: track.album?.artist?.id ?? "",
                    name: track.album?.artist?.name ?? "Unknown Artist",
                },
                album: {
                    id: track.album?.id ?? "",
                    title: track.album?.title ?? "Unknown Album",
                    coverArt: track.album?.coverArt,
                },
            });
        },
        [addToQueue],
    );

    const handleToggleFavorite = useCallback(
        (trackId: string, isFavorite: boolean) => {
            if (isFavorite) removeFavorite(trackId);
        },
        [removeFavorite],
    );

    const noopDelete = useCallback(() => {}, []);
    const noopAddToPlaylist = useCallback(() => {}, []);

    return (
        <div className="min-h-screen">
            <LibraryHeader
                title="Favorites"
                subtitle="Jellyfin favorites — play or remove from list"
                showSync={false}
            />

            {error && (
                <div className="mx-4 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="flex justify-center min-h-[300px] items-center">
                    <GradientSpinner size="lg" />
                </div>
            ) : libraryTracks.length === 0 ? (
                <EmptyState
                    icon={<Heart className="w-12 h-12 text-gray-500" />}
                    title="No favorites yet"
                    description="Add tracks to favorites from the Library (heart icon on Jellyfin tracks) to see them here."
                />
            ) : (
                <TracksList
                    tracks={libraryTracks}
                    onPlay={handlePlay}
                    onAddToQueue={handleAddToQueue}
                    onAddToPlaylist={noopAddToPlaylist}
                    onDelete={noopDelete}
                    favoriteIds={favoriteIds}
                    onToggleFavorite={handleToggleFavorite}
                    hideDelete
                />
            )}
        </div>
    );
}
