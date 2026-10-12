import { describe, expect, it } from 'vitest';

import {
  applyClassificationResult,
  createItem,
  updateItemText,
} from '../models/item-transitions';
import {
  DESTINATION_TAXONOMY_VERSION,
  type DestinationCategory,
  type ItemClassificationResult,
} from '../models/Classification';
import type { Item } from '../models/Item';
import {
  createPlaceRequestItemsSignature,
  parsePlaceRequestItemsSignature,
} from './place-item-projection';

function makeItem(): Item {
  const item = createItem('item-1', 'Milk', '2026-10-09T12:00:00.000Z');
  if (item === null) {
    throw new Error('Test item was not created.');
  }
  return item;
}

function classify(
  item: Item,
  categories: [DestinationCategory, ...DestinationCategory[]],
): Item {
  return applyResult(item, {
    outcome: 'classified',
    categories,
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
  });
}

function applyResult(item: Item, result: ItemClassificationResult): Item {
  return applyClassificationResult(
    [item],
    item.id,
    {
      sourceRevision: item.revision,
      sourceText: item.text,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      attemptCount: 0,
    },
    result,
  )[0];
}

describe('place item projection', () => {
  it('becomes eligible when a pending classification becomes current', () => {
    const pending = makeItem();
    const current = classify(pending, ['grocery-store']);

    expect(createPlaceRequestItemsSignature([pending])).toBe('[]');
    expect(
      parsePlaceRequestItemsSignature(
        createPlaceRequestItemsSignature([current]),
      ),
    ).toEqual([
      {
        id: 'item-1',
        revision: 1,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        categories: ['grocery-store'],
      },
    ]);
  });

  it('includes IDs, revisions, taxonomy versions, and all categories', () => {
    const item = makeItem();
    const classified = classify(item, [
      'grocery-store',
      'convenience-store',
    ]);
    const signature = createPlaceRequestItemsSignature([classified]);

    expect(parsePlaceRequestItemsSignature(signature)).toEqual([
      {
        id: 'item-1',
        revision: 1,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        categories: ['grocery-store', 'convenience-store'],
      },
    ]);
  });

  it('preserves shared categories on each classified item', () => {
    const first = classify(makeItem(), ['grocery-store']);
    const second = classify(
      { ...makeItem(), id: 'item-2' },
      ['grocery-store', 'convenience-store'],
    );

    expect(
      parsePlaceRequestItemsSignature(
        createPlaceRequestItemsSignature([first, second]),
      ),
    ).toEqual([
      {
        id: 'item-1',
        revision: 1,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        categories: ['grocery-store'],
      },
      {
        id: 'item-2',
        revision: 1,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        categories: ['grocery-store', 'convenience-store'],
      },
    ]);
  });

  it('excludes pending, failed, non-destination, clarification, and stale classifications', () => {
    const pending = makeItem();
    const failed: Item = {
      ...makeItem(),
      id: 'item-2',
      classification: {
        status: 'failed',
        sourceRevision: 1,
        sourceText: 'Milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 1,
        nextAttemptAt: null,
        retryable: false,
        failureKind: 'invalid-response',
      },
    };
    const noDestination = applyResult(
      { ...makeItem(), id: 'item-3' },
      {
        outcome: 'no-destination',
        categories: [],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    );
    const needsClarification = applyResult(
      { ...makeItem(), id: 'item-4' },
      {
        outcome: 'needs-clarification',
        categories: [],
        clarificationQuestion: 'Which kind?',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    );
    const stale = {
      ...classify({ ...makeItem(), id: 'item-5' }, ['grocery-store']),
      revision: 2,
    };

    expect(
      parsePlaceRequestItemsSignature(
        createPlaceRequestItemsSignature([
          pending,
          failed,
          noDestination,
          needsClarification,
          stale,
        ]),
      ),
    ).toEqual([]);
  });

  it('changes the signature when classification categories change', () => {
    const item = classify(makeItem(), ['grocery-store']);
    const initial = createPlaceRequestItemsSignature([item]);
    const changed = classify(makeItem(), ['convenience-store']);

    expect(createPlaceRequestItemsSignature([changed])).not.toBe(initial);
    expect(createPlaceRequestItemsSignature([])).not.toBe(initial);
  });

  it('keeps the signature stable when item or category order changes', () => {
    const first = classify(makeItem(), [
      'grocery-store',
      'convenience-store',
    ]);
    const second = classify(
      { ...makeItem(), id: 'item-2' },
      ['pharmacy'],
    );
    const reorderedFirst = classify(makeItem(), [
      'convenience-store',
      'grocery-store',
    ]);

    expect(
      createPlaceRequestItemsSignature([second, reorderedFirst]),
    ).toBe(createPlaceRequestItemsSignature([first, second]));
  });

  it('removes eligibility immediately after an item edit or deletion', () => {
    const classified = classify(makeItem(), ['grocery-store']);
    const [edited] = updateItemText(
      [classified],
      classified.id,
      'Oat milk',
      '2026-10-09T12:05:00.000Z',
    );

    expect(createPlaceRequestItemsSignature([classified])).not.toBe('[]');
    expect(createPlaceRequestItemsSignature([edited])).toBe('[]');
    expect(createPlaceRequestItemsSignature([])).toBe('[]');
  });
});
