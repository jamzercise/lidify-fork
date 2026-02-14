"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface QueuePanelContextType {
    isOpen: boolean;
    openQueue: () => void;
    closeQueue: () => void;
    toggleQueue: () => void;
}

const QueuePanelContext = createContext<QueuePanelContextType | null>(null);

export function QueuePanelProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const openQueue = useCallback(() => setIsOpen(true), []);
    const closeQueue = useCallback(() => setIsOpen(false), []);
    const toggleQueue = useCallback(() => setIsOpen((prev) => !prev), []);

    return (
        <QueuePanelContext.Provider value={{ isOpen, openQueue, closeQueue, toggleQueue }}>
            {children}
        </QueuePanelContext.Provider>
    );
}

export function useQueuePanel(): QueuePanelContextType {
    const ctx = useContext(QueuePanelContext);
    if (!ctx) throw new Error("useQueuePanel must be used within QueuePanelProvider");
    return ctx;
}
