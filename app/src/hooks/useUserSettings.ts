import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";

export interface QualitySettings {
  audio_quality: "low" | "normal" | "high" | "max";
  video_quality: "sd" | "hd" | "fhd";
  embed_cover: boolean;
  embed_lyrics: boolean;
  upgrade_existing_files: boolean;
}

export interface MetadataSettings {
  save_album_cover: boolean;
  album_cover_name: string;
  album_cover_resolution: "origin" | number;
  save_artist_picture: boolean;
  artist_picture_name: string;
  artist_picture_resolution: number | string;
  save_video_thumbnail: boolean;
  embed_video_thumbnail?: boolean;
  video_thumbnail_resolution: "origin" | "640x360" | "1280x720" | "160x107" | "480x320" | "750x500" | "1080x720";
  save_lyrics: boolean;
  save_album_review: boolean;
  save_artist_bio: boolean;
  enable_fingerprinting: boolean;
  write_tidal_url: boolean;
  mark_explicit: boolean;
  upc_target: "UPC" | "EAN" | "BARCODE";
  write_audio_metadata?: boolean;
  embed_replaygain?: boolean;
}

export interface PathSettings {
  music_path: string;
  atmos_path: string;
  video_path: string;
}

export interface NamingSettings {
  artist_folder: string;
  album_track_path_single: string;
  album_track_path_multi: string;
  video_file: string;
}

export interface AppSettings {
  theme: "light" | "dark" | "system";
  acoustid_api_key?: string;
}

export interface AccountSettings {
  userId?: number;
  username?: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string;
  countryCode?: string;
  picture?: string | null;
}

export const useUserSettings = () => {
  const [qualitySettings, setQualitySettings] = useState<QualitySettings | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [metadataSettings, setMetadataSettings] = useState<MetadataSettings | null>(null);
  const [pathSettings, setPathSettings] = useState<PathSettings | null>(null);
  const [namingSettings, setNamingSettings] = useState<NamingSettings | null>(null);
  const [accountSettings, setAccountSettings] = useState<AccountSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const namingSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNamingRef = useRef<NamingSettings | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const [qualityData, appData, metadataData, pathData, namingData, accountData] = await Promise.all([
        api.getQualityConfig(),
        api.getAppConfig(),
        api.getMetadataConfig(),
        api.getPathConfig(),
        api.getNamingConfig(),
        api.getAccountConfig()
      ]);

      setQualitySettings(qualityData as QualitySettings);
      setAppSettings(appData as AppSettings);
      setMetadataSettings(metadataData as MetadataSettings);
      setPathSettings(pathData as PathSettings);
      setNamingSettings(namingData as NamingSettings);
      setAccountSettings(accountData as AccountSettings);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error loading settings",
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    return () => {
      if (namingSaveTimeoutRef.current) {
        clearTimeout(namingSaveTimeoutRef.current);
      }
    };
  }, []);

  const updateQualitySettings = async (updates: Partial<QualitySettings>) => {
    try {
      if (!qualitySettings) return;

      const updatedSettings = { ...qualitySettings, ...updates };
      await api.updateQualityConfig(updatedSettings);

      setQualitySettings(updatedSettings);
      toast({
        title: "Settings saved",
        description: "Quality settings updated.",
      });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error saving settings",
        description: error.message,
      });
    }
  };

  const updateAppSettings = async (updates: Partial<AppSettings>) => {
    try {
      if (!appSettings) return;

      const updatedSettings = { ...appSettings, ...updates };
      await api.updateAppConfig(updatedSettings);

      setAppSettings(updatedSettings);
      toast({
        title: "Settings saved",
        description: "App settings updated.",
      });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error saving settings",
        description: error.message,
      });
    }
  };

  const updateMetadataSettings = async (updates: Partial<MetadataSettings>) => {
    try {
      if (!metadataSettings) return;

      const updatedSettings = { ...metadataSettings, ...updates };
      await api.updateMetadataConfig(updatedSettings);

      setMetadataSettings(updatedSettings);
      toast({
        title: "Settings saved",
        description: "Metadata settings updated.",
      });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error saving settings",
        description: error.message,
      });
    }
  };

  const updatePathSettings = async (updates: Partial<PathSettings>) => {
    try {
      if (!pathSettings) return;

      const updatedSettings = { ...pathSettings, ...updates };
      await api.updatePathConfig(updatedSettings);

      setPathSettings(updatedSettings);
      toast({
        title: "Settings saved",
        description: "Library paths updated.",
      });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error saving settings",
        description: error.message,
      });
    }
  };

  const updateNamingSettings = async (updates: Partial<NamingSettings>) => {
    const base = pendingNamingRef.current ?? namingSettings;
    if (!base) return;

    const next = { ...base, ...updates };
    pendingNamingRef.current = next;
    setNamingSettings(next);

    if (namingSaveTimeoutRef.current) {
      clearTimeout(namingSaveTimeoutRef.current);
    }

    namingSaveTimeoutRef.current = setTimeout(async () => {
      const toSave = pendingNamingRef.current;
      if (!toSave) return;

      try {
        await api.updateNamingConfig(toSave);
        pendingNamingRef.current = null;
        toast({
          title: "Naming saved",
          description: "Naming templates updated.",
        });
      } catch (error: any) {
        toast({
          variant: "destructive",
          title: "Error saving naming settings",
          description: error.message,
        });
      }
    }, 600);
  };

  const updateAccountSettings = async (updates: Partial<AccountSettings>) => {
    try {
      if (!accountSettings) return;

      const updatedSettings = { ...accountSettings, ...updates };
      await api.updateAccountConfig(updatedSettings);

      setAccountSettings(updatedSettings);
      // No toast needed for background updates usually, but good for debugging
    } catch (error: any) {
      console.error("Error updating account settings:", error);
    }
  };

  return {
    qualitySettings,
    appSettings,
    metadataSettings,
    pathSettings,
    namingSettings,
    accountSettings,
    loading,
    updateQualitySettings,
    updateAppSettings,
    updateMetadataSettings,
    updatePathSettings,
    updateNamingSettings,
    updateAccountSettings,
    reload: loadSettings,
  };
};
