import { useEffect, useState, useCallback } from 'react';
import { api } from '../services/api';

export type JobStatusRaw = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface GlobalEventPayload {
    type: string;
    data: any;
    timestamp: number;
}

// Keep a singleton subscriber so we don't open 50 event streams if 50 components use this hook
let globalEventSource: EventSource | null = null;
const globalSubscribers = new Set<(event: GlobalEventPayload) => void>();

let currentConnectionAttempts = 0;
const MAX_RECONNECT = 5;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let suppressNextStreamError = false;

const initStream = () => {
    if (globalEventSource) return;
    if (globalSubscribers.size === 0) return;

    suppressNextStreamError = false;

    console.log('[GlobalEvents] Initializing EventSource connection...');
    globalEventSource = api.createGlobalEventStream(
        (eventType, data) => {
            currentConnectionAttempts = 0; // Reset on successful message
            const payload: GlobalEventPayload = {
                type: eventType,
                data,
                timestamp: Date.now()
            };

            // Broadcast to all active hook consumers
            globalSubscribers.forEach(sub => sub(payload));
        },
        (error) => {
            if (suppressNextStreamError || globalSubscribers.size === 0) {
                suppressNextStreamError = false;
                return;
            }

            console.error('[GlobalEvents] Stream errored:', error);
            if (globalEventSource) {
                globalEventSource.close();
                globalEventSource = null;
            }

            // Exponential backoff reconnect
            if (currentConnectionAttempts < MAX_RECONNECT) {
                currentConnectionAttempts++;
                const backoffMs = Math.min(1000 * Math.pow(2, currentConnectionAttempts), 30000);
                console.log(`[GlobalEvents] Reconnecting in ${backoffMs}ms...`);
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                }
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    initStream();
                }, backoffMs);
            }
        }
    );
};

export function useGlobalEvents(interestEvents?: string[]) {
    const [lastEvent, setLastEvent] = useState<GlobalEventPayload | null>(null);
    const isDisabled = Array.isArray(interestEvents) && interestEvents.length === 0;
    const interestKey = isDisabled ? null : (interestEvents?.slice().sort().join('|') || '');

    const handleEvent = useCallback((payload: GlobalEventPayload) => {
        if (isDisabled) {
            return;
        }

        // Filter out events this component doesn't care about (if specified)
        if (interestKey) {
            const allowedEvents = interestKey.split('|');
            if (!allowedEvents.includes(payload.type)) {
                return;
            }
        }
        setLastEvent(payload);
    }, [interestKey, isDisabled]);

    useEffect(() => {
        if (isDisabled) {
            return;
        }

        // Subscribe to global broadcasts
        globalSubscribers.add(handleEvent);

        // Start stream after subscribing so initStream sees at least one consumer.
        if (!globalEventSource) {
            initStream();
        }

        return () => {
            // Unsubscribe on unmount
            globalSubscribers.delete(handleEvent);

            // If we are the last subscriber, close the stream to save resources
            if (globalSubscribers.size === 0 && globalEventSource) {
                suppressNextStreamError = true;
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                globalEventSource.close();
                globalEventSource = null;
                console.log('[GlobalEvents] All subscribers detached, closing stream.');
            }
        };
    }, [handleEvent, isDisabled]);

    return lastEvent;
}
