import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import type {
  AccountConfigContract as AccountSettings,
  MetadataConfigContract as MetadataSettings,
  NamingConfigContract as NamingSettings,
  PathConfigContract as PathSettings,
  PublicAppConfigContract as AppSettings,
  QualityConfigContract as QualitySettings,
} from "@contracts/config";

export type {
  AccountConfigContract as AccountSettings,
  MetadataConfigContract as MetadataSettings,
  NamingConfigContract as NamingSettings,
  PathConfigContract as PathSettings,
  PublicAppConfigContract as AppSettings,
  QualityConfigContract as QualitySettings,
} from "@contracts/config";

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

      setQualitySettings(qualityData);
      setAppSettings(appData);
      setMetadataSettings(metadataData);
      setPathSettings(pathData);
      setNamingSettings(namingData);
      setAccountSettings(accountData);
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

  const saveNamingSettings = useCallback(async (toSave: NamingSettings, notifySuccess: boolean) => {
    await api.updateNamingConfig(toSave);
    pendingNamingRef.current = null;

    if (notifySuccess) {
      toast({
        title: "Naming saved",
        description: "Naming templates updated.",
      });
    }
  }, [toast]);

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
        await saveNamingSettings(toSave, true);
      } catch (error: any) {
        toast({
          variant: "destructive",
          title: "Error saving naming settings",
          description: error.message,
        });
      }
    }, 600);
  };

  const flushNamingSettings = useCallback(async () => {
    if (namingSaveTimeoutRef.current) {
      clearTimeout(namingSaveTimeoutRef.current);
      namingSaveTimeoutRef.current = null;
    }

    const toSave = pendingNamingRef.current;
    if (!toSave) {
      return namingSettings;
    }

    try {
      await saveNamingSettings(toSave, false);
      return toSave;
    } catch (error) {
      pendingNamingRef.current = toSave;
      throw error;
    }
  }, [namingSettings, saveNamingSettings]);

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
    flushNamingSettings,
    updateAccountSettings,
    reload: loadSettings,
  };
};
