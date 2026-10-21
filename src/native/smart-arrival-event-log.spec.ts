import { describe, expect, it } from 'vitest';

import {
  SMART_ARRIVAL_DEVELOPMENT_EVENT_HISTORY_LIMIT,
  SMART_ARRIVAL_DEVELOPMENT_EVENT_TYPES,
  smartArrivalDevelopmentEventFields,
  smartArrivalDevelopmentEventHistoryFields,
} from './smart-arrival-event-log';

describe('Smart Arrival development event history contract', () => {
  it('keeps the Debug history shape aligned with the Swift record', () => {
    expect(SMART_ARRIVAL_DEVELOPMENT_EVENT_HISTORY_LIMIT).toBe(100);
    expect(SMART_ARRIVAL_DEVELOPMENT_EVENT_TYPES).toEqual([
      'region-entry',
      'walking-qualified',
      'automotive-evidence',
      'evidence-rejected',
      'observation-ended',
      'notification-attempted',
      'notification-succeeded',
      'notification-failed',
    ]);
    expect(smartArrivalDevelopmentEventFields()).toEqual([
      'detail',
      'placeId',
      'recordedAt',
      'sequence',
      'storeName',
      'type',
    ]);
    expect(smartArrivalDevelopmentEventHistoryFields()).toEqual([
      'droppedEventCount',
      'events',
    ]);
  });
});
