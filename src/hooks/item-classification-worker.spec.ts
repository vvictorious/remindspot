import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClassificationCancelledError,
  ClassificationHttpError,
  ClassificationNetworkError,
  ClassificationTimeoutError,
  InvalidClassificationResponseError,
  type classifyItem,
} from '../api/classification';
import {
  DESTINATION_TAXONOMY_VERSION,
  type ItemClassificationResult,
} from '../models/Classification';
import {
  applyClassificationResult,
  completeItem,
  createItem,
  markClassificationFailed,
  markClassificationPending,
  undoItemCompletion,
  updateItemText,
} from '../models/item-transitions';
import type { Item } from '../models/Item';
import {
  CLASSIFICATION_RETRY_BASE_DELAY_MS,
  ItemClassificationWorker,
  MAX_CLASSIFICATION_ATTEMPTS,
} from './item-classification-worker';

const now = new Date('2026-10-09T12:00:00.000Z');
const classifiedResult: ItemClassificationResult = {
  outcome: 'classified',
  categories: ['grocery-store'],
  taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
};

type Classify = typeof classifyItem;

type ControlledRequest = {
  text: string;
  signal: AbortSignal;
  resolve: (result: ItemClassificationResult) => void;
  reject: (error: unknown) => void;
};

function createControlledClassifier(options: { rejectOnAbort?: boolean } = {}) {
  const requests: ControlledRequest[] = [];
  const classify = vi.fn<Classify>((request, requestOptions = {}) => {
    const signal = requestOptions.signal ?? new AbortController().signal;
    return new Promise<ItemClassificationResult>((resolve, reject) => {
      if (options.rejectOnAbort !== false) {
        signal.addEventListener(
          'abort',
          () => reject(new ClassificationCancelledError()),
          { once: true },
        );
      }
      requests.push({
        text: request.text,
        signal,
        resolve,
        reject,
      });
    });
  });
  return { classify, requests };
}

function makeItem(id = 'item-1', text = 'Milk'): Item {
  const item = createItem(id, text, now.toISOString());
  if (item === null) {
    throw new Error('Test item was not created.');
  }
  return item;
}

function createHarness(
  initialItems: Item[],
  classify: Classify,
  random = () => 0.5,
) {
  let items = initialItems;
  let isForeground = true;
  let isDefinitelyOffline = false;
  let isHydrated = true;
  let worker: ItemClassificationWorker;

  const sync = () => {
    worker.update({
      items,
      isHydrated,
      isForeground,
      isDefinitelyOffline,
    });
  };

  worker = new ItemClassificationWorker({
    classify,
    random,
    markPending: (id, attempt, nextAttemptAt) => {
      items = markClassificationPending(items, id, attempt, nextAttemptAt);
      sync();
    },
    applyResult: (id, attempt, result) => {
      items = applyClassificationResult(items, id, attempt, result);
      sync();
    },
    markFailed: (id, attempt, failure) => {
      items = markClassificationFailed(items, id, attempt, failure);
      sync();
    },
  });

  return {
    worker,
    start() {
      sync();
      worker.start();
    },
    get items() {
      return items;
    },
    setItems(nextItems: Item[]) {
      items = nextItems;
      sync();
    },
    setForeground(value: boolean) {
      isForeground = value;
      sync();
    },
    setOffline(value: boolean) {
      isDefinitelyOffline = value;
      sync();
    },
    setHydrated(value: boolean) {
      isHydrated = value;
      sync();
    },
  };
}

async function runReadyWork(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ItemClassificationWorker', () => {
  it('classifies a new item once and never reclassifies a current item', async () => {
    const { classify, requests } = createControlledClassifier();
    const harness = createHarness([makeItem()], classify);
    harness.start();

    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(requests[0]?.text).toBe('Milk');
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });

    requests[0]?.resolve(classifiedResult);
    await runReadyWork();
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'current',
      result: classifiedResult,
    });

    harness.setItems([...harness.items]);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('aborts an old edit and classifies the new revision', async () => {
    const { classify, requests } = createControlledClassifier({
      rejectOnAbort: false,
    });
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    const edited = updateItemText(
      harness.items,
      'item-1',
      'Oat milk',
      new Date(now.getTime() + 1_000).toISOString(),
    );
    harness.setItems(edited);
    expect(requests[0]?.signal.aborted).toBe(true);
    await vi.runOnlyPendingTimersAsync();

    expect(classify).toHaveBeenCalledTimes(2);
    expect(requests[1]?.text).toBe('Oat milk');
    requests[0]?.resolve(classifiedResult);
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(harness.items[0]?.text).toBe('Oat milk');
    expect(harness.items[0]?.classification.status).toBe('pending');
  });

  it('aborts deleted items and does not restore them from late results', async () => {
    const { classify, requests } = createControlledClassifier({
      rejectOnAbort: false,
    });
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    harness.setItems([]);
    expect(requests[0]?.signal.aborted).toBe(true);
    requests[0]?.resolve(classifiedResult);
    await runReadyWork();

    expect(harness.items).toEqual([]);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('deduplicates rerenders and limits concurrency to two', async () => {
    const { classify, requests } = createControlledClassifier();
    const harness = createHarness(
      [makeItem('item-1'), makeItem('item-2'), makeItem('item-3')],
      classify,
    );
    harness.start();
    await runReadyWork();

    expect(classify).toHaveBeenCalledTimes(2);
    harness.setItems([...harness.items]);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(2);

    requests[0]?.resolve(classifiedResult);
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('recovers a persisted pending attempt only when its delay is due', async () => {
    const item = makeItem();
    item.classification = {
      status: 'pending',
      sourceRevision: item.revision,
      sourceText: item.text,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      attemptCount: 2,
      nextAttemptAt: new Date(now.getTime() + 5_000).toISOString(),
    };
    const { classify } = createControlledClassifier();
    const harness = createHarness([item], classify);
    harness.start();

    await runReadyWork();
    expect(classify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(classify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      attemptCount: 2,
      nextAttemptAt: null,
    });
  });

  it('waits for hydration, foreground, and connectivity before starting', async () => {
    const { classify } = createControlledClassifier();
    const harness = createHarness([makeItem()], classify);
    harness.setHydrated(false);
    harness.start();
    await runReadyWork();
    expect(classify).not.toHaveBeenCalled();

    harness.setHydrated(true);
    harness.setForeground(false);
    await runReadyWork();
    expect(classify).not.toHaveBeenCalled();

    harness.setForeground(true);
    harness.setOffline(true);
    await runReadyWork();
    expect(classify).not.toHaveBeenCalled();
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    });

    harness.setOffline(false);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });
  });

  it('aborts in the background and resumes the interrupted attempt', async () => {
    const { classify, requests } = createControlledClassifier();
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    harness.setForeground(false);
    expect(requests[0]?.signal.aborted).toBe(true);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(1);

    harness.setForeground(true);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });
  });

  it('aborts when connectivity is lost and resumes on reconnect', async () => {
    const { classify, requests } = createControlledClassifier();
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    harness.setOffline(true);
    expect(requests[0]?.signal.aborted).toBe(true);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(1);

    harness.setOffline(false);
    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });
  });

  it('uses persisted exponential retry delays and stops after three attempts', async () => {
    const classify = vi
      .fn<Classify>()
      .mockRejectedValue(new ClassificationNetworkError(new Error('offline')));
    const harness = createHarness([makeItem()], classify);
    harness.start();

    await runReadyWork();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      retryable: true,
      nextAttemptAt: new Date(
        now.getTime() + CLASSIFICATION_RETRY_BASE_DELAY_MS,
      ).toISOString(),
    });

    await vi.advanceTimersByTimeAsync(CLASSIFICATION_RETRY_BASE_DELAY_MS);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'failed',
      attemptCount: 2,
      retryable: true,
      nextAttemptAt: new Date(
        now.getTime() +
          CLASSIFICATION_RETRY_BASE_DELAY_MS +
          CLASSIFICATION_RETRY_BASE_DELAY_MS * 2,
      ).toISOString(),
    });

    await vi.advanceTimersByTimeAsync(CLASSIFICATION_RETRY_BASE_DELAY_MS * 2);
    expect(classify).toHaveBeenCalledTimes(MAX_CLASSIFICATION_ATTEMPTS);
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'failed',
      attemptCount: MAX_CLASSIFICATION_ATTEMPTS,
      retryable: false,
      nextAttemptAt: null,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(classify).toHaveBeenCalledTimes(MAX_CLASSIFICATION_ATTEMPTS);
  });

  it.each([
    new ClassificationHttpError(400, 'Bad Request'),
    new InvalidClassificationResponseError('bad payload'),
  ])('does not retry a permanent failure', async (error) => {
    const classify = vi.fn<Classify>().mockRejectedValue(error);
    const harness = createHarness([makeItem()], classify);
    harness.start();

    await runReadyWork();
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      retryable: false,
      nextAttemptAt: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('logs the HTTP status when a classification request fails', async () => {
    vi.stubGlobal('__DEV__', true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const classify = vi
      .fn<Classify>()
      .mockRejectedValue(new ClassificationHttpError(503, 'Service Unavailable'));

    try {
      const harness = createHarness([makeItem()], classify);
      harness.start();
      await runReadyWork();

      expect(info).toHaveBeenCalledWith(
        '[classification] Classification failed.',
        expect.objectContaining({
          errorType: 'ClassificationHttpError',
          status: 503,
          failureKind: 'server',
          retryable: true,
        }),
      );
    } finally {
      info.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('omits HTTP status for a non-HTTP classification failure', async () => {
    vi.stubGlobal('__DEV__', true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const classify = vi
      .fn<Classify>()
      .mockRejectedValue(new ClassificationNetworkError(new Error('offline')));

    try {
      const harness = createHarness([makeItem()], classify);
      harness.start();
      await runReadyWork();

      expect(info).toHaveBeenCalledWith(
        '[classification] Classification failed.',
        expect.not.objectContaining({ status: expect.anything() }),
      );
    } finally {
      info.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not retry an upstream provider rejection', async () => {
    const classify = vi
      .fn<Classify>()
      .mockRejectedValue(
        new ClassificationHttpError(422, 'Unprocessable Entity'),
      );
    const harness = createHarness([makeItem()], classify);
    harness.start();

    await runReadyWork();
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureKind: 'server',
      retryable: false,
      nextAttemptAt: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ClassificationHttpError(429, 'Too Many Requests'),
    new ClassificationHttpError(503, 'Service Unavailable'),
    new ClassificationHttpError(504, 'Gateway Timeout'),
    new ClassificationTimeoutError(),
  ])('schedules a retry for a temporary server failure', async (error) => {
    const classify = vi.fn<Classify>().mockRejectedValue(error);
    const harness = createHarness([makeItem()], classify);
    harness.start();

    await runReadyWork();
    expect(harness.items[0]?.classification).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      retryable: true,
      nextAttemptAt: new Date(
        now.getTime() + CLASSIFICATION_RETRY_BASE_DELAY_MS,
      ).toISOString(),
    });
  });

  it('never starts work for a valid current item', async () => {
    const item = makeItem();
    item.classification = {
      status: 'current',
      sourceRevision: item.revision,
      sourceText: item.text,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      result: classifiedResult,
    };
    const { classify } = createControlledClassifier();
    const harness = createHarness([item], classify);
    harness.start();
    await runReadyWork();

    expect(classify).not.toHaveBeenCalled();
  });

  it('does not duplicate work across a Strict Mode-style setup replay', async () => {
    const { classify } = createControlledClassifier();
    const harness = createHarness([makeItem()], classify);

    harness.start();
    harness.worker.stop();
    harness.worker.start();
    await runReadyWork();

    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('does not start classification for a completed item', async () => {
    const [completed] = completeItem(
      [makeItem()],
      'item-1',
      now.toISOString(),
    );
    const { classify } = createControlledClassifier();
    const harness = createHarness([completed], classify);
    harness.start();
    await runReadyWork();

    expect(classify).not.toHaveBeenCalled();
    expect(harness.items[0]?.revision).toBe(1);
    expect(harness.items[0]?.classification.status).toBe('pending');
  });

  it('aborts in-flight classification and ignores a late result', async () => {
    const { classify, requests } = createControlledClassifier({
      rejectOnAbort: false,
    });
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    const completedAt = new Date(now.getTime() + 1_000).toISOString();
    const completed = completeItem(harness.items, 'item-1', completedAt);
    harness.setItems(completed);
    expect(requests[0]?.signal.aborted).toBe(true);

    requests[0]?.resolve(classifiedResult);
    await runReadyWork();

    expect(harness.items).toEqual(completed);
    expect(harness.items[0]?.revision).toBe(1);
    expect(harness.items[0]?.classification.status).toBe('pending');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('resumes the same revision after completion is undone', async () => {
    const { classify, requests } = createControlledClassifier({
      rejectOnAbort: false,
    });
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    const completed = completeItem(
      harness.items,
      'item-1',
      new Date(now.getTime() + 1_000).toISOString(),
    );
    harness.setItems(completed);
    expect(requests[0]?.signal.aborted).toBe(true);
    requests[0]?.resolve(classifiedResult);
    await runReadyWork();

    expect(harness.items[0]?.classification).toMatchObject({
      status: 'pending',
      sourceRevision: 1,
      nextAttemptAt: null,
    });

    const restored = undoItemCompletion(harness.items, 'item-1');
    harness.setItems(restored);
    await vi.runOnlyPendingTimersAsync();

    expect(restored[0]?.completedAt).toBeUndefined();
    expect(restored[0]?.revision).toBe(1);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(requests[1]?.text).toBe('Milk');
    expect(harness.items[0]?.revision).toBe(1);
  });

  it('aborts every request and timer when stopped', async () => {
    const { classify, requests } = createControlledClassifier();
    const harness = createHarness([makeItem()], classify);
    harness.start();
    await runReadyWork();

    harness.worker.stop();
    expect(requests[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
