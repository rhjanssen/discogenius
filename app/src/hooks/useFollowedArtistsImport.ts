import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";

export const useFollowedArtistsImport = () => {
  const { toast } = useToast();

  const importFollowedArtists = async (
    onProgress?: (event: string, data: any) => void,
    providerId?: string | null,
  ) => {
    try {
      let totalArtists = 0;

      return new Promise((resolve, reject) => {
        const eventSource = api.createImportFollowedStream(
          (event, data) => {
            onProgress?.(event, data);

            switch (event) {
              case "status":
                toast({
                  title: "Import Progress",
                  description: data.message,
                });
                break;

              case "total":
                totalArtists = data.total;
                toast({
                  title: "Import Started",
                  description: `Found ${totalArtists} followed artists to import`,
                });
                break;

              case "artist-added":
                toast({
                  title: "Artist Added",
                  description: `${data.name} (${data.progress}/${data.total})`,
                });
                break;

              case "artist-updated":
                toast({
                  title: "Artist Updated",
                  description: `${data.name} (${data.progress}/${data.total})`,
                });
                break;

              case "artist-skipped":
                break;

              case "complete":
                eventSource.close();
                toast({
                  title: "Import Complete",
                  description: data.message || `Successfully imported ${data.added} artists. Use "Scan" to fetch albums.`,
                });
                resolve(data);
                break;

              case "error":
                toast({
                  title: "Import Error",
                  description: data.message,
                  variant: "destructive",
                });
                break;
            }
          },
          (error) => {
            eventSource.close();
            toast({
              title: "Import failed",
              description: error.message || "Could not import followed artists",
              variant: "destructive",
            });
            reject(error);
          },
          providerId,
        );
      });
    } catch (error: any) {
      console.error("Import error:", error);
      toast({
        title: "Import failed",
        description: error.message || "Could not import followed artists",
        variant: "destructive",
      });
      throw error;
    }
  };

  return {
    importFollowedArtists,
  };
};
