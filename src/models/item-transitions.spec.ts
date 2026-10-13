import { describe, expect, it } from 'vitest';

import {
  DESTINATION_TAXONOMY_VERSION,
  type ItemClassificationResult,
} from './Classification';
import {
  applyClassificationResult,
  completeItem,
  createItem,
  deleteItem,
  markClassificationFailed,
  markClassificationPending,
  retryItemClassification,
  undoItemCompletion,
  updateItemText,
  type ClassificationAttemptSnapshot,
} from './item-transitions';
import type { Item } from './Item';

const createdAt = '2026-10-09T10:00:00.000Z';
const editedAt = '2026-10-09T10:10:00.000Z';

function makeItem(): Item {
  const item = createItem('item-1', ' Milk ', createdAt);
  if (item === null) {
    throw new Error('Test item was not created.');
  }
  return item;
}

function attempt(
  item: Item,
  attemptCount: number,
): ClassificationAttemptSnapshot {
  return {
    sourceRevision: item.revision,
    sourceText: item.text,
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    attemptCount,
  };
}

function startAttempt(
  item: Item,
  attemptCount = 1,
): {
  item: Item;
  attempt: ClassificationAttemptSnapshot;
} {
  const nextAttempt = attempt(item, attemptCount);
  const [pendingItem] = markClassificationPending(
    [item],
    item.id,
    nextAttempt,
    null,
  );
  return { item: pendingItem, attempt: nextAttempt };
}

describe('item text transitions', () => {
  it('creates a normalized item and pending classification atomically', () => {
    expect(createItem('item-1', ' Milk ', createdAt)).toEqual({
      id: 'item-1',
      text: 'Milk',
      createdAt,
      updatedAt: createdAt,
      revision: 1,
      classification: {
        status: 'pending',
        sourceRevision: 1,
        sourceText: 'Milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 0,
        nextAttemptAt: null,
      },
    });
    expect(createItem('item-2', '   ', createdAt)).toBeNull();
  });

  it('increments revision and resets classification in the same edit', () => {
    const { item, attempt: activeAttempt } = startAttempt(makeItem(), 2);
    const [failedItem] = markClassificationFailed(
      [item],
      item.id,
      activeAttempt,
      {
        retryable: true,
        failureKind: 'server',
        nextAttemptAt: '2026-10-09T10:05:00.000Z',
      },
    );

    const [edited] = updateItemText(
      [failedItem],
      failedItem.id,
      ' Oat milk ',
      editedAt,
    );

    expect(edited).toEqual({
      ...failedItem,
      text: 'Oat milk',
      updatedAt: editedAt,
      revision: 2,
      classification: {
        status: 'pending',
        sourceRevision: 2,
        sourceText: 'Oat milk',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 0,
        nextAttemptAt: null,
      },
    });
  });

  it('does not revise or reclassify a normalized no-op edit', () => {
    const items = [makeItem()];
    expect(updateItemText(items, 'item-1', '  Milk  ', editedAt)).toBe(items);
  });

  it('deletes on an empty edit and supports explicit delete', () => {
    const items = [makeItem()];
    expect(updateItemText(items, 'item-1', ' ', editedAt)).toEqual([]);
    expect(deleteItem(items, 'item-1')).toEqual([]);
    expect(deleteItem(items, 'missing')).toBe(items);
  });
});

describe('item completion', () => {
  const completedAt = '2026-10-13T18:00:00.000Z';

  it('completes an item in place without changing its identity', () => {
    const first = makeItem();
    const second = createItem('item-2', 'Bread', createdAt);
    if (second === null) {
      throw new Error('Test item was not created.');
    }
    const items = [first, second];

    const completed = completeItem(items, second.id, completedAt);

    expect(completed.map((item) => item.id)).toEqual(['item-1', 'item-2']);
    expect(completed[0]).toBe(first);
    expect(completed[1]).toEqual({
      ...second,
      completedAt,
    });
    expect(completed[1]?.revision).toBe(second.revision);
    expect(completed[1]?.classification).toEqual(second.classification);
    expect(completed[1]?.updatedAt).toBe(second.updatedAt);
    expect(completeItem(completed, second.id, editedAt)).toBe(completed);
    expect(completeItem(items, 'missing', completedAt)).toBe(items);
  });

  it('undoes the most recent completion at its original index', () => {
    const first = makeItem();
    const second = createItem('item-2', 'Bread', createdAt);
    if (second === null) {
      throw new Error('Test item was not created.');
    }
    const completed = completeItem([first, second], second.id, completedAt);

    const restored = undoItemCompletion(completed, second.id);

    expect(restored.map((item) => item.id)).toEqual(['item-1', 'item-2']);
    expect(restored[0]).toBe(first);
    expect(restored[1]).toEqual(second);
    expect(restored[1]?.completedAt).toBeUndefined();
    expect(restored[1]?.revision).toBe(second.revision);
    expect(undoItemCompletion(restored, second.id)).toBe(restored);
  });

  it('ignores classification changes while an item is completed', () => {
    const { item, attempt: activeAttempt } = startAttempt(makeItem(), 2);
    const [completed] = completeItem([item], item.id, completedAt);
    const items = [completed];
    const result: ItemClassificationResult = {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    };

    expect(
      markClassificationPending(
        items,
        item.id,
        attempt(item, activeAttempt.attemptCount + 1),
        editedAt,
      ),
    ).toBe(items);
    expect(
      applyClassificationResult(items, item.id, activeAttempt, result),
    ).toBe(items);
    expect(
      markClassificationFailed(items, item.id, activeAttempt, {
        retryable: true,
        failureKind: 'timeout',
        nextAttemptAt: editedAt,
      }),
    ).toBe(items);

    const [failed] = markClassificationFailed([item], item.id, activeAttempt, {
      retryable: false,
      failureKind: 'invalid-response',
      nextAttemptAt: null,
    });
    const [completedFailure] = completeItem([failed], failed.id, completedAt);
    const failedItems = [completedFailure];
    expect(retryItemClassification(failedItems, failed.id)).toBe(failedItems);
    expect(failedItems[0]?.revision).toBe(failed.revision);
    expect(failedItems[0]?.classification).toBe(failed.classification);
  });
});

describe('classification transitions', () => {
  it('moves an unclassified legacy item to pending', () => {
    const item: Item = {
      ...makeItem(),
      classification: {
        status: 'unclassified',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    };
    const nextAttempt = attempt(item, 1);

    expect(
      markClassificationPending(
        [item],
        item.id,
        nextAttempt,
        '2026-10-09T10:01:00.000Z',
      )[0].classification,
    ).toEqual({
      status: 'pending',
      ...nextAttempt,
      nextAttemptAt: '2026-10-09T10:01:00.000Z',
    });
  });

  it('preserves attempts and retry delay when failing and rescheduling', () => {
    const { item, attempt: activeAttempt } = startAttempt(makeItem(), 2);
    const unchangedUpdatedAt = item.updatedAt;
    const retryAt = '2026-10-09T10:05:00.000Z';
    const [failed] = markClassificationFailed([item], item.id, activeAttempt, {
      retryable: true,
      failureKind: 'timeout',
      nextAttemptAt: retryAt,
    });

    expect(failed.updatedAt).toBe(unchangedUpdatedAt);
    expect(failed.revision).toBe(1);
    expect(failed.classification).toEqual({
      status: 'failed',
      ...activeAttempt,
      retryable: true,
      failureKind: 'timeout',
      nextAttemptAt: retryAt,
    });

    const retryAttempt = attempt(failed, 3);
    const nextRetryAt = '2026-10-09T10:15:00.000Z';
    const [pending] = markClassificationPending(
      [failed],
      failed.id,
      retryAttempt,
      nextRetryAt,
    );
    expect(pending.classification).toEqual({
      status: 'pending',
      ...retryAttempt,
      nextAttemptAt: nextRetryAt,
    });
    expect(pending.updatedAt).toBe(unchangedUpdatedAt);
  });

  it('does not allow retry attempt counts to move backward', () => {
    const { item } = startAttempt(makeItem(), 2);
    const staleAttempt = attempt(item, 1);
    expect(
      markClassificationPending([item], item.id, staleAttempt, null)[0],
    ).toBe(item);
  });

  it('explicitly retries a failed item with a fresh attempt cycle', () => {
    const { item, attempt: activeAttempt } = startAttempt(makeItem(), 3);
    const [failed] = markClassificationFailed([item], item.id, activeAttempt, {
      retryable: false,
      failureKind: 'invalid-response',
      nextAttemptAt: null,
    });

    const [retried] = retryItemClassification([failed], failed.id);

    expect(retried).toEqual({
      ...failed,
      classification: {
        status: 'pending',
        sourceRevision: failed.revision,
        sourceText: failed.text,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 0,
        nextAttemptAt: null,
      },
    });
    expect(retried.text).toBe(failed.text);
    expect(retried.revision).toBe(failed.revision);
    expect(retried.updatedAt).toBe(failed.updatedAt);
  });

  it('only explicitly retries failed items', () => {
    const item = makeItem();
    const items = [item];

    expect(retryItemClassification(items, item.id)).toBe(items);
    expect(retryItemClassification(items, 'missing')).toBe(items);
  });

  it.each<ItemClassificationResult>([
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
      clarificationQuestion: 'Which kind?',
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'unsupported-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
  ])(
    'preserves the $outcome result without changing item timestamps',
    (result) => {
      const { item, attempt: activeAttempt } = startAttempt(makeItem());
      const [classified] = applyClassificationResult(
        [item],
        item.id,
        activeAttempt,
        result,
      );

      expect(classified.classification).toEqual({
        status: 'current',
        sourceRevision: activeAttempt.sourceRevision,
        sourceText: activeAttempt.sourceText,
        taxonomyVersion: activeAttempt.taxonomyVersion,
        result,
      });
      expect(classified.updatedAt).toBe(createdAt);
      expect(classified.revision).toBe(1);
    },
  );

  it('rejects responses for older edits, attempts, and deleted items', () => {
    const original = makeItem();
    const { item: inFlight, attempt: oldAttempt } = startAttempt(original);
    const [edited] = updateItemText(
      [inFlight],
      inFlight.id,
      'Oat milk',
      editedAt,
    );
    const result: ItemClassificationResult = {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    };

    expect(
      applyClassificationResult([edited], edited.id, oldAttempt, result)[0],
    ).toBe(edited);

    const retryAttempt = attempt(inFlight, 2);
    const [newerAttempt] = markClassificationPending(
      [inFlight],
      inFlight.id,
      retryAttempt,
      null,
    );
    expect(
      applyClassificationResult(
        [newerAttempt],
        newerAttempt.id,
        oldAttempt,
        result,
      )[0],
    ).toBe(newerAttempt);

    expect(
      applyClassificationResult([], original.id, oldAttempt, result),
    ).toEqual([]);
  });

  it('rejects a result with a mismatched taxonomy version', () => {
    const { item, attempt: activeAttempt } = startAttempt(makeItem());
    const invalidResult = {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: 2,
    } as unknown as ItemClassificationResult;

    expect(
      applyClassificationResult(
        [item],
        item.id,
        activeAttempt,
        invalidResult,
      )[0],
    ).toBe(item);
  });
});
