import { describe, expect, it } from 'vitest';

import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { Item } from '../models/Item';
import {
  ITEMS_STORAGE_KEY,
  normalizeStoredItems,
  parseStoredItems,
  serializeItems,
} from './items';

const baseItem = {
  id: 'item-1',
  text: 'Milk',
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
};

describe('item persistence', () => {
  it('keeps the existing AsyncStorage key', () => {
    expect(ITEMS_STORAGE_KEY).toBe('@there-you-go/reminders:v1');
  });

  it('normalizes a legacy item without losing existing data', () => {
    const [item] = normalizeStoredItems([
      {
        ...baseItem,
        legacyExtension: { keep: true },
      },
    ]);

    expect(item).toEqual({
      ...baseItem,
      legacyExtension: { keep: true },
      revision: 1,
      classification: {
        status: 'unclassified',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    });
  });

  it('preserves pending retry state across serialization', () => {
    const item: Item = {
      ...baseItem,
      revision: 3,
      classification: {
        status: 'pending',
        sourceRevision: 3,
        sourceText: 'Milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 2,
        nextAttemptAt: '2026-10-09T10:05:00.000Z',
      },
    };

    expect(parseStoredItems(serializeItems([item]))).toEqual([item]);
  });

  it('preserves failed retry state across serialization', () => {
    const item: Item = {
      ...baseItem,
      revision: 4,
      classification: {
        status: 'failed',
        sourceRevision: 4,
        sourceText: 'Milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 3,
        nextAttemptAt: '2026-10-09T10:15:00.000Z',
        retryable: true,
        failureKind: 'network',
      },
    };

    expect(parseStoredItems(serializeItems([item]))).toEqual([item]);
  });

  it.each([
    {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'no-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'needs-clarification',
      categories: [],
      clarificationQuestion: 'Which kind of charger?',
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'unsupported-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
  ])('preserves the $outcome result', (result) => {
    const stored = {
      ...baseItem,
      revision: 2,
      classification: {
        status: 'current',
        sourceRevision: 2,
        sourceText: 'Milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        result,
      },
    };

    expect(normalizeStoredItems([stored])[0].classification).toEqual(
      stored.classification,
    );
  });

  it.each([
    null,
    { status: 'pending', attemptCount: -1 },
    {
      status: 'pending',
      sourceRevision: 1,
      sourceText: 'Old text',
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      attemptCount: 1,
      nextAttemptAt: null,
    },
    {
      status: 'failed',
      sourceRevision: 1,
      sourceText: 'Milk',
      taxonomyVersion: 999,
      attemptCount: 1,
      nextAttemptAt: null,
      retryable: true,
      failureKind: 'network',
    },
    {
      status: 'current',
      sourceRevision: 1,
      sourceText: 'Milk',
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      result: {
        outcome: 'classified',
        categories: [],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    },
  ])('resets invalid optional metadata without dropping the item', (value) => {
    const [item] = normalizeStoredItems([
      {
        ...baseItem,
        customData: 'preserved',
        revision: 1,
        classification: value,
      },
    ]);

    expect(item).toMatchObject({
      ...baseItem,
      customData: 'preserved',
      revision: 1,
      classification: {
        status: 'unclassified',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    });
  });

  it('preserves completion without changing identity or classification', () => {
    const item: Item = {
      ...baseItem,
      revision: 2,
      completedAt: '2026-10-13T18:00:00.000Z',
      classification: {
        status: 'current',
        sourceRevision: 2,
        sourceText: 'Milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        result: {
          outcome: 'classified',
          categories: ['grocery-store'],
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        },
      },
    };

    expect(parseStoredItems(serializeItems([item]))).toEqual([item]);
  });

  it.each([
    '',
    '   ',
    'not-a-date',
    1_700_000_000_000,
  ])('drops invalid completion state %j and keeps the item active', (completedAt) => {
    const [item] = normalizeStoredItems([
      {
        ...baseItem,
        revision: 4,
        completedAt,
        classification: {
          status: 'pending',
          sourceRevision: 4,
          sourceText: 'Milk',
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
          attemptCount: 2,
          nextAttemptAt: null,
        },
      },
    ]);

    expect(item.completedAt).toBeUndefined();
    expect(item).toMatchObject({
      ...baseItem,
      revision: 4,
      classification: {
        status: 'pending',
        sourceRevision: 4,
        sourceText: 'Milk',
        attemptCount: 2,
      },
    });
  });

  it('rejects invalid storage containers and missing legacy fields', () => {
    expect(() => normalizeStoredItems({})).toThrow();
    expect(() =>
      normalizeStoredItems([{ id: 'item-1', text: 'Milk' }]),
    ).toThrow();
    expect(() => parseStoredItems('{not json')).toThrow();
  });
});
