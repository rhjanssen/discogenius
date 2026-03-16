import {
  useToastController,
  Toast,
  ToastTitle,
  ToastBody,
  ToastIntent,
} from "@fluentui/react-components";
import * as React from "react";
import { TOASTER_ID } from "@/components/ui/toaster";

interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
  action?: React.ReactNode;
}

function mapVariantToIntent(variant?: string): ToastIntent {
  if (variant === "destructive") return "error";
  return "success";
}

export function useToast() {
  const { dispatchToast } = useToastController(TOASTER_ID);

  const toast = React.useCallback((options: ToastOptions) => {
    // Only show error toasts as requested by user
    if (options.variant !== "destructive") {
      return;
    }

    const intent = mapVariantToIntent(options.variant);
    dispatchToast(
      <Toast>
        {options.title && <ToastTitle>{options.title}</ToastTitle>}
        {options.description && <ToastBody>{options.description}</ToastBody>}
      </Toast>,
      { intent, timeout: 5000 }
    );
  }, [dispatchToast]);

  return { toast, toasts: [] };
}

// Standalone toast for use outside components (backwards compat)
export { useToast as toast };
