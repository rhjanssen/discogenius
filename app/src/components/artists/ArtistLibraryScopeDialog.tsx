import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Radio,
  RadioGroup,
  Text,
  makeStyles,
  tokens,
  type DialogOpenChangeData,
  type DialogOpenChangeEvent,
  type RadioGroupOnChangeData,
} from "@fluentui/react-components";
import { useEffect, useId, useMemo, useState } from "react";
import type { ArtistLibraryOption } from "@/services/api";

export type ArtistPolicy = "all" | "new" | "none";
export type ArtistLibraryAction = "monitor" | "policy" | "unmonitor";

type ArtistLibraryScopeDialogProps = {
  open: boolean;
  action: ArtistLibraryAction;
  artistName: string;
  libraries: ArtistLibraryOption[];
  initialLibraryIds: number[];
  initialPolicy?: ArtistPolicy;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (libraryIds: number[], policy: ArtistPolicy) => Promise<void> | void;
};

const useStyles = makeStyles({
  choices: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalS,
  },
  fieldset: {
    border: 0,
    margin: `${tokens.spacingVerticalM} 0 0`,
    padding: 0,
    minInlineSize: 0,
  },
  legend: {
    fontWeight: tokens.fontWeightSemibold,
    padding: 0,
  },
  library: {
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    "@media (forced-colors: active)": {
      border: "1px solid CanvasText",
    },
  },
  rootPath: {
    marginLeft: "28px",
    color: tokens.colorNeutralForeground3,
    overflowWrap: "anywhere",
  },
  policy: {
    marginTop: tokens.spacingVerticalL,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginTop: tokens.spacingVerticalS,
  },
});

const copy = {
  monitor: {
    title: "Choose libraries",
    description: "Monitoring adds the artist to the selected libraries. Policy All may start automatic acquisition after curation.",
    confirm: "Monitor",
  },
  policy: {
    title: "Set acquisition policy",
    description: "The policy changes only the selected library memberships.",
    confirm: "Apply policy",
  },
  unmonitor: {
    title: "Choose libraries to leave",
    description: "Unmonitoring removes the artist from the selected libraries. Existing media files are not deleted.",
    confirm: "Unmonitor",
  },
} satisfies Record<ArtistLibraryAction, { title: string; description: string; confirm: string }>;

export function ArtistLibraryScopeDialog({
  open,
  action,
  artistName,
  libraries,
  initialLibraryIds,
  initialPolicy = "all",
  busy = false,
  onOpenChange,
  onConfirm,
}: ArtistLibraryScopeDialogProps) {
  const styles = useStyles();
  const [selectedIds, setSelectedIds] = useState<number[]>(initialLibraryIds);
  const [policy, setPolicy] = useState<ArtistPolicy>(initialPolicy);
  const [submittedWithoutSelection, setSubmittedWithoutSelection] = useState(false);
  const validationMessageId = useId();
  const actionCopy = copy[action];

  useEffect(() => {
    if (!open) return;
    setSelectedIds(initialLibraryIds);
    setPolicy(initialPolicy);
    setSubmittedWithoutSelection(false);
  }, [initialLibraryIds, initialPolicy, open]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const handleOpenChange = (_event: DialogOpenChangeEvent, data: DialogOpenChangeData) => {
    if (!busy) onOpenChange(data.open);
  };
  const toggleLibrary = (libraryId: number, checked: boolean) => {
    setSubmittedWithoutSelection(false);
    setSelectedIds((current) => checked
      ? [...new Set([...current, libraryId])]
      : current.filter((id) => id !== libraryId));
  };
  const submit = async () => {
    if (selectedIds.length === 0) {
      setSubmittedWithoutSelection(true);
      return;
    }
    await onConfirm(selectedIds, policy);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{actionCopy.title}</DialogTitle>
          <DialogContent>
            <Text block>{artistName}</Text>
            <Text block>{actionCopy.description}</Text>
            <fieldset
              className={styles.fieldset}
              aria-invalid={submittedWithoutSelection || undefined}
              aria-describedby={submittedWithoutSelection ? validationMessageId : undefined}
            >
              <legend className={styles.legend}>Libraries <span aria-hidden="true">*</span></legend>
              <div className={styles.choices}>
                {libraries.map((library) => (
                  <div className={styles.library} key={library.id}>
                    <Checkbox
                      checked={selected.has(library.id)}
                      label={library.name}
                      onChange={(_event, data) => toggleLibrary(library.id, data.checked === true)}
                    />
                    <Text size={200} className={styles.rootPath}>{library.root_path}</Text>
                  </div>
                ))}
              </div>
            </fieldset>
            {submittedWithoutSelection ? (
              <Text id={validationMessageId} block role="alert" className={styles.error}>Select at least one library.</Text>
            ) : null}
            {action !== "unmonitor" ? (
              <Field className={styles.policy} label="Acquisition policy">
                <RadioGroup
                  value={policy}
                  onChange={(_event, data: RadioGroupOnChangeData) => setPolicy(data.value as ArtistPolicy)}
                >
                  <Radio value="all" label="All eligible releases" />
                  <Radio value="new" label="Only releases newer than the current latest release" />
                  <Radio value="none" label="Paused: keep membership without automatic acquisition" />
                </RadioGroup>
              </Field>
            ) : null}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" disabled={busy}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={busy || libraries.length === 0} onClick={() => void submit()}>
              {busy ? "Applying…" : actionCopy.confirm}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
