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
  variant?: "default" | "destructive" | "warning";
  action?: React.ReactNode;
}

function mapVariantToIntent(variant?: string): ToastIntent {
  if (variant === "destructive") return "error";
  if (variant === "warning") return "warning";
  return "success";
}

export function useToast() {
  const { dispatchToast } = useToastController(TOASTER_ID);

  const toast = React.useCallback((options: ToastOptions) => {
    // Success toasts stay hidden. Errors, and provider-login recovery, show.
    if (options.variant !== "destructive" && options.variant !== "warning") {
      return;
    }

    const intent = mapVariantToIntent(options.variant);
    dispatchToast(
      <Toast>
        {options.title && <ToastTitle>{options.title}</ToastTitle>}
        {options.description && <ToastBody>{options.description}</ToastBody>}
      </Toast>,
      { intent, timeout: options.variant === "warning" ? 10000 : 5000 }
    );
  }, [dispatchToast]);

  return { toast, toasts: [] };
}
