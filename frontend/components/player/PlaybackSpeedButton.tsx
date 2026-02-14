"use client";

import { useState, useEffect, useRef } from "react";
import { Gauge } from "lucide-react";
import { cn } from "@/utils/cn";

// 0.5 to 2 in 0.05 steps => 31 options
const SPEED_OPTIONS = Array.from({ length: 31 }, (_, i) =>
    Math.round((0.5 + i * 0.05) * 100) / 100
);

function formatSpeed(rate: number): string {
    if (rate === 1) return "1x";
    return `${rate}x`;
}

interface PlaybackSpeedButtonProps {
    playbackRate: number;
    setPlaybackRate: (rate: number) => void;
    /** Only show when true (podcast or audiobook) */
    visible: boolean;
    /** Placement of dropdown: "top" or "bottom" */
    dropdownPlacement?: "top" | "bottom";
    size?: "sm" | "md";
    className?: string;
}

export function PlaybackSpeedButton({
    playbackRate,
    setPlaybackRate,
    visible,
    dropdownPlacement = "top",
    size = "md",
    className,
}: PlaybackSpeedButtonProps) {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("click", handleClick);
        return () => document.removeEventListener("click", handleClick);
    }, [open]);

    if (!visible) return null;

    const iconClass = size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4";

    return (
        <div className={cn("relative", className)} ref={menuRef}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110"
                aria-label={`Playback speed: ${formatSpeed(playbackRate)}`}
                aria-expanded={open}
                aria-haspopup="true"
                title={`Playback speed: ${formatSpeed(playbackRate)}`}
            >
                <Gauge className={iconClass} />
                <span className="sr-only">{formatSpeed(playbackRate)}</span>
            </button>
            {open && (
                <div
                    className={cn(
                        "absolute left-1/2 -translate-x-1/2 py-1.5 min-w-[100px] max-h-[60vh] overflow-y-auto bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl z-50",
                        dropdownPlacement === "top" ? "bottom-full mb-2" : "top-full mt-2"
                    )}
                    role="menu"
                >
                    <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-white/5">
                        Speed
                    </div>
                    {SPEED_OPTIONS.map((rate) => (
                        <button
                            key={rate}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setPlaybackRate(rate);
                                setOpen(false);
                            }}
                            className={cn(
                                "w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 transition-colors",
                                Math.abs(rate - playbackRate) < 0.01 ? "text-white font-medium" : "text-gray-300"
                            )}
                        >
                            {formatSpeed(rate)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
