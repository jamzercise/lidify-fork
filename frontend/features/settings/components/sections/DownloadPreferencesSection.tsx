"use client";

import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import { SystemSettings } from "../../types";

interface DownloadPreferencesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function DownloadPreferencesSection({
    settings,
    onUpdate,
}: DownloadPreferencesSectionProps) {
    // Service configuration detection
    const isLidarrConfigured =
        settings.lidarrEnabled === true &&
        settings.lidarrUrl.trim() !== "" &&
        settings.lidarrApiKey.trim() !== "";

    const isSoulseekConfigured =
        settings.soulseekUsername.trim() !== "" &&
        settings.soulseekPassword.trim() !== "";

    const areBothServicesConfigured = isLidarrConfigured && isSoulseekConfigured;
    const isDisabled = !areBothServicesConfigured;

    // Dynamic fallback options based on primary source
    const getFallbackOptions = () => {
        if (settings.downloadSource === "soulseek") {
            return [
                { value: "none", label: "Skip track" },
                { value: "lidarr", label: "Download full album via Lidarr" },
            ];
        } else {
            return [
                { value: "none", label: "Skip album" },
                { value: "soulseek", label: "Try Soulseek for individual tracks" },
            ];
        }
    };

    return (
        <SettingsSection
            id="download-preferences"
            title="Download Preferences"
            description="Controls how missing tracks are acquired when you import playlists (Spotify, Deezer, YouTube Music) or use Discovery. Choose Soulseek for per-track P2P downloads, or Lidarr for full-album downloads from your indexers."
        >
            <SettingsRow
                label="Primary Download Source"
                description={
                    isDisabled
                        ? "Requires both Soulseek and Lidarr to be configured"
                        : "Which source to use first when importing playlists or filling Discovery: Soulseek (search P2P by track) or Lidarr (request full albums from indexers)."
                }
            >
                <SettingsSelect
                    value={settings.downloadSource || "soulseek"}
                    onChange={(v) =>
                        onUpdate({
                            downloadSource: v as "soulseek" | "lidarr",
                            primaryFailureFallback: "none"
                        })
                    }
                    options={[
                        { value: "soulseek", label: "Soulseek (Per-track)" },
                        { value: "lidarr", label: "Lidarr (Full albums)" },
                    ]}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label={
                    settings.downloadSource === "soulseek"
                        ? "When Soulseek Fails"
                        : "When Lidarr Fails"
                }
                description={
                    isDisabled
                        ? "Requires both Soulseek and Lidarr to be configured"
                        : settings.downloadSource === "soulseek"
                        ? "What to do if a track can't be found on Soulseek"
                        : "What to do if an album can't be found on Lidarr"
                }
            >
                <SettingsSelect
                    value={settings.primaryFailureFallback || "none"}
                    onChange={(v) =>
                        onUpdate({
                            primaryFailureFallback: v as "none" | "lidarr" | "soulseek",
                        })
                    }
                    options={getFallbackOptions()}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label="Soulseek Concurrent Downloads"
                description="How many Soulseek downloads can run at once when the app is fetching tracks (e.g. during playlist import). 1–10."
            >
                <SettingsSelect
                    value={settings.soulseekConcurrentDownloads?.toString() || "4"}
                    onChange={(v) =>
                        onUpdate({
                            soulseekConcurrentDownloads: parseInt(v),
                        })
                    }
                    options={[
                        { value: "1", label: "1" },
                        { value: "2", label: "2" },
                        { value: "3", label: "3" },
                        { value: "4", label: "4 (Default)" },
                        { value: "5", label: "5" },
                        { value: "6", label: "6" },
                        { value: "7", label: "7" },
                        { value: "8", label: "8" },
                        { value: "9", label: "9" },
                        { value: "10", label: "10" },
                    ]}
                    disabled={!isSoulseekConfigured}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
