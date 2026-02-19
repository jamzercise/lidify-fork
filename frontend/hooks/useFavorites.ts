"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface FavoritesState {
    tracks: Array<{
        id: string;
        title: string;
        duration: number;
        artist?: { id: string; name: string };
        album?: { id: string; title: string; coverArt?: string | null };
    }>;
    isLoading: boolean;
    error: string | null;
    favoriteIds: Set<string>;
    addFavorite: (trackId: string) => Promise<void>;
    removeFavorite: (trackId: string) => Promise<void>;
    isFavorite: (trackId: string) => boolean;
    refetch: () => Promise<void>;
}

export function useFavorites(): FavoritesState {
    const [tracks, setTracks] = useState<FavoritesState["tracks"]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchFavorites = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await api.getFavorites();
            setTracks(res.tracks ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load favorites");
            setTracks([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchFavorites();
    }, [fetchFavorites]);

    const favoriteIds = new Set(tracks.map((t) => t.id));

    const addFavorite = useCallback(
        async (trackId: string) => {
            try {
                await api.addFavorite(trackId);
                await fetchFavorites();
            } catch {
                fetchFavorites();
            }
        },
        [fetchFavorites]
    );

    const removeFavorite = useCallback(
        async (trackId: string) => {
            try {
                await api.removeFavorite(trackId);
                setTracks((prev) => prev.filter((t) => t.id !== trackId));
            } catch {
                fetchFavorites();
            }
        },
        [fetchFavorites]
    );

    const isFavorite = useCallback(
        (id: string) => favoriteIds.has(id),
        [tracks]
    );

    return {
        tracks,
        isLoading,
        error,
        favoriteIds,
        addFavorite,
        removeFavorite,
        isFavorite,
        refetch: fetchFavorites,
    };
}
