import { useState } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import type { SearchResponseContract } from "@contracts/catalog";
import { getArtistPicture } from "@/utils/tidalImages";

export interface TidalArtist {
  id: number;
  name: string;
  imageUrl: string | null;
  tidalId: string;
  monitored?: boolean;
  inLibrary?: boolean;
}

export const useTidalSearch = () => {
  const [searchResults, setSearchResults] = useState<TidalArtist[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const { toast } = useToast();

  const searchArtists = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const data: SearchResponseContract = await api.search(query, ['artists'], 50);
      const formatted =
        data.results?.artists?.map((artist) => ({
          id: parseInt(String(artist.id)),
          name: artist.name,
          imageUrl: artist.imageId ? getArtistPicture(artist.imageId, "small") : null,
          tidalId: String(artist.id),
          monitored: !!artist.monitored,
          inLibrary: !!artist.in_library,
        })) || [];

      setSearchResults(formatted);
    } catch (error: any) {
      console.error('Search error:', error);
      toast({
        title: "Search failed",
        description: error.message || "Failed to search artists",
        variant: "destructive",
      });
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const addArtist = async (artist: TidalArtist) => {
    try {
      const data: any = await api.addArtist(artist.tidalId);

      toast({
        title: "Artist added",
        description: `${artist.name} has been added to your library`,
      });

      return data.id;
    } catch (error: any) {
      console.error('Add artist error:', error);
      toast({
        title: "Failed to add artist",
        description: error.message || "Could not add artist to library",
        variant: "destructive",
      });
      throw error;
    }
  };

  const importFollowedArtists = async (onProgress?: (event: string, data: any) => void) => {
    try {
      
      let totalArtists = 0;
      let addedCount = 0;
      let skippedCount = 0;
      let albumsCount = 0;

      return new Promise((resolve, reject) => {
        const eventSource = api.createImportFollowedStream(
          (event, data) => {
            
            // Call progress callback if provided
            if (onProgress) {
              onProgress(event, data);
            }
            
            switch (event) {
              case 'status':
                toast({
                  title: "Import Progress",
                  description: data.message,
                });
                break;
                
              case 'total':
                totalArtists = data.total;
                toast({
                  title: "Import Started",
                  description: `Found ${totalArtists} followed artists to import`,
                });
                break;
                
              case 'artist-added':
                addedCount = data.added;
                toast({
                  title: "Artist Added",
                  description: `${data.name} (${data.progress}/${data.total})`,
                });
                break;
                
              case 'artist-skipped':
                skippedCount = data.skipped;
                break;
                
              case 'albums-added':
                albumsCount = data.total;
                toast({
                  title: "Albums Synced",
                  description: `${data.count} albums added for ${data.artist}`,
                });
                break;
                
              case 'complete':
                eventSource.close();
                toast({
                  title: "Import Complete",
                  description: data.message || `Successfully imported ${data.added} artists. Use "Scan" to fetch albums.`,
                });
                resolve(data);
                break;
                
              case 'error':
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
          }
        );
      });
    } catch (error: any) {
      console.error('Import error:', error);
      toast({
        title: "Import failed",
        description: error.message || "Could not import followed artists",
        variant: "destructive",
      });
      throw error;
    }
  };

  return {
    searchResults,
    isSearching,
    searchArtists,
    addArtist,
    importFollowedArtists,
  };
};
