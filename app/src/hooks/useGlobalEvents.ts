import { useEffect, useState, useCallback } from 'react';
import { api } from '../services/api';

export type CommandStatusRaw = 'queued' | 'started' | 'completed' | 'failed' | 'cancelled';

export interface GlobalEventPayload {
    type: string;
    data: any;
    timestamp: number;
}

// Keep a singleton subscriber so we don't open 50 event streams if 50 components use this hook
let globalEventSource: EventSource | null = null;
const globalSubscribers = new Set<(event: GlobalEventPayload) => void>();

let currentConnectionAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 30_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const initStream = () => {
    if (globalEventSource) return;
    if (globalSubscribers.size === 0) return;

    globalEventSource = api.createGlobalEventStream(
        (eventType, data) => {
            const payload: GlobalEventPayload = {
                type: eventType,
                data,
                timestamp: Date.now()
            };

            // Broadcast to all active hook consumers
            globalSubscribers.forEach(sub => sub(payload));
        },
        (error) => {
            if (globalSubscribers.size === 0) {
                return;
            }

            console.error('[GlobalEvents] Stream errored:', error);
            if (globalEventSource) {
                globalEventSource.close();
                globalEventSource = null;
            }

            // Retry for as long as there are subscribers. The delay grows
            // exponentially but is capped so a recovered server is eventually
            // rediscovered without producing a reconnect storm.
            currentConnectionAttempts++;
            const exponent = Math.min(currentConnectionAttempts - 1, 5);
            const backoffMs = Math.min(1000 * Math.pow(2, exponent), MAX_RECONNECT_DELAY_MS);
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                initStream();
            }, backoffMs);
        },
        () => {
            // A connected but idle event stream is healthy. Reset on open rather
            // than waiting for the first domain event to arrive.
            currentConnectionAttempts = 0;
        },
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
            if (globalSubscribers.size === 0) {
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                if (globalEventSource) {
                    globalEventSource.close();
                    globalEventSource = null;
                }
                currentConnectionAttempts = 0;
            }
        };
    }, [handleEvent, isDisabled]);

    return lastEvent;
}
