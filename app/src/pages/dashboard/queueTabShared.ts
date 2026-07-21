import type { SyntheticEvent } from "react";

export function isInteractiveElementTarget(target: EventTarget | null): target is HTMLElement {
    return target instanceof HTMLElement
        && Boolean(target.closest('button,a,input,label,[role="menuitem"],[data-queue-control="true"]'));
}

export function stopQueueControlEvent(event: SyntheticEvent<HTMLElement>) {
    event.stopPropagation();
}
