import {
  Toaster as FluentToaster,
  useToastController,
  useId,
} from "@fluentui/react-components";

// Single global toaster ID
export const TOASTER_ID = "discogenius-toaster";

export function Toaster() {
  return (
    <FluentToaster
      toasterId={TOASTER_ID}
      position="bottom-end"
      pauseOnHover
      pauseOnWindowBlur
      limit={3}
    />
  );
}
