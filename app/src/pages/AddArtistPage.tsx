import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Avatar,
  Button,
  Caption1,
  Card,
  SearchBox,
  Spinner,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Add24Regular,
  CheckmarkCircle24Regular,
  MusicNote224Regular,
  Search24Regular,
} from "@fluentui/react-icons";
import type { SearchResultContract } from "@contracts/catalog";
import { EmptyState } from "@/components/ui/ContentState";
import { api } from "@/services/api";
import { getTidalImage } from "@/utils/tidalImages";
import { useToast } from "@/hooks/useToast";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";

const useStyles = makeStyles({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalM,
    maxWidth: "880px",
    width: "100%",
    boxSizing: "border-box",
    marginLeft: "auto",
    marginRight: "auto",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  searchBox: {
    width: "100%",
    maxWidth: "640px",
  },
  resultList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  resultRow: {
    display: "grid",
    gridTemplateColumns: "56px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    boxSizing: "border-box",
    "@media (max-width: 520px)": {
      gridTemplateColumns: "48px minmax(0, 1fr)",
    },
  },
  resultMeta: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  resultTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  resultSubtitle: {
    color: tokens.colorNeutralForeground2,
  },
  rowAction: {
    "@media (max-width: 520px)": {
      gridColumn: "1 / -1",
      justifySelf: "stretch",
    },
  },
  muted: {
    color: tokens.colorNeutralForeground2,
  },
});

function artistImage(item: SearchResultContract): string | undefined {
  return getTidalImage(item.imageId, "artist", "small") ?? undefined;
}

const AddArtistPage = () => {
  const styles = useStyles();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultContract[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addingArtistId, setAddingArtistId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookupIdRef = useRef(0);

  useEffect(() => {
    const term = query.trim();
    const lookupId = ++lookupIdRef.current;

    if (term.length < 2) {
      setResults([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setError(null);
      try {
        const response = await api.lookupArtists(term, 12, controller.signal);
        if (lookupId !== lookupIdRef.current) {
          return;
        }
        setResults(response.results.artists);
      } catch (lookupError: any) {
        if (lookupError?.name === "AbortError" || lookupId !== lookupIdRef.current) {
          return;
        }
        setResults([]);
        setError(lookupError?.message || "Artist lookup failed");
      } finally {
        if (lookupId === lookupIdRef.current) {
          setIsSearching(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const addArtist = async (artist: SearchResultContract) => {
    const artistId = String(artist.id);

    if (artist.in_library) {
      navigate(`/artist/${artistId}`);
      return;
    }

    setAddingArtistId(artistId);
    try {
      const result = await api.addArtist(artistId) as { id?: string; message?: string };
      const nextArtistId = String(result.id || artistId);
      toast({
        title: "Artist added",
        description: result.message || `${artist.name} was added to your library`,
      });
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
      queryClient.invalidateQueries({ queryKey: ["library"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      navigate(`/artist/${nextArtistId}`);
    } catch (addError: any) {
      toast({
        title: "Failed to add artist",
        description: addError?.message || "Please try again",
        variant: "destructive",
      });
    } finally {
      setAddingArtistId(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Title1>Add Artist</Title1>
        </div>
        <SearchBox
          autoFocus
          className={styles.searchBox}
          aria-label="Look up artist to add"
          placeholder="Look up artist by name or MusicBrainz ID"
          value={query}
          onChange={(_, data) => setQuery(data.value)}
        />
      </div>

      {query.trim().length < 2 ? (
        <EmptyState
          title="Look up an artist"
          description="Add artists from MusicBrainz, then scan and curate them from the library."
          icon={<Search24Regular />}
          minHeight="280px"
        />
      ) : isSearching && results.length === 0 ? (
        <EmptyState
          title="Searching"
          description="Looking up matching artists."
          icon={<Spinner size="medium" />}
          minHeight="280px"
        />
      ) : error ? (
        <EmptyState
          title="Lookup failed"
          description={error}
          icon={<MusicNote224Regular />}
          minHeight="280px"
        />
      ) : results.length === 0 ? (
        <EmptyState
          title="No artists found"
          description="Try a different artist name or MusicBrainz ID."
          icon={<Search24Regular />}
          minHeight="280px"
        />
      ) : (
        <div className={styles.resultList}>
          {isSearching ? (
            <Text className={styles.muted} size={200}>Refreshing results...</Text>
          ) : null}
          {results.map((artist) => {
            const artistId = String(artist.id);
            const isAdding = addingArtistId === artistId;

            return (
              <Card key={`${artistId}-${artist.name}`} className={styles.resultRow}>
                <Avatar
                  image={{ src: artistImage(artist) }}
                  name={artist.name}
                  size={48}
                  shape="circular"
                />
                <div className={styles.resultMeta}>
                  <Text className={styles.resultTitle} weight="semibold">{artist.name}</Text>
                  {artist.subtitle ? (
                    <Caption1 className={mergeClasses(styles.resultSubtitle, styles.resultTitle)}>
                      {artist.subtitle}
                    </Caption1>
                  ) : null}
                </div>
                <Button
                  className={styles.rowAction}
                  appearance={artist.in_library ? "secondary" : "primary"}
                  icon={isAdding ? <Spinner size="tiny" /> : artist.in_library ? <CheckmarkCircle24Regular /> : <Add24Regular />}
                  disabled={isAdding}
                  onClick={() => void addArtist(artist)}
                >
                  {artist.in_library ? "Open" : "Add"}
                </Button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AddArtistPage;
