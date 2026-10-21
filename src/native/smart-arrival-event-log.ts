export const SMART_ARRIVAL_DEVELOPMENT_EVENT_HISTORY_LIMIT = 100;

export const SMART_ARRIVAL_DEVELOPMENT_EVENT_TYPES = [
  'region-entry',
  'walking-qualified',
  'automotive-evidence',
  'evidence-rejected',
  'observation-ended',
  'notification-attempted',
  'notification-succeeded',
  'notification-failed',
] as const;

export type SmartArrivalDevelopmentEventType =
  (typeof SMART_ARRIVAL_DEVELOPMENT_EVENT_TYPES)[number];

export type SmartArrivalDevelopmentEvent = {
  sequence: number;
  recordedAt: string;
  type: SmartArrivalDevelopmentEventType;
  placeId: string | null;
  storeName: string | null;
  detail: string | null;
};

export type SmartArrivalDevelopmentEventHistory = {
  droppedEventCount: number;
  events: SmartArrivalDevelopmentEvent[];
};

const COMPACT_EVENT_FIELDS = [
  'detail',
  'placeId',
  'recordedAt',
  'sequence',
  'storeName',
  'type',
] as const;

const COMPACT_HISTORY_FIELDS = ['droppedEventCount', 'events'] as const;

export function smartArrivalDevelopmentEventFields(): readonly string[] {
  return COMPACT_EVENT_FIELDS;
}

export function smartArrivalDevelopmentEventHistoryFields(): readonly string[] {
  return COMPACT_HISTORY_FIELDS;
}

// Retention, deduplication, sequence numbers, and the dropped-event count are
// implemented in ThereYouGoSmartArrivalEventLog.swift. This module is only the
// Debug history contract visible to TypeScript. Release builds do not collect
// or persist the history.
