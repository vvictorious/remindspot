import {
  ClassificationCancelledError,
  ClassificationHttpError,
  ClassificationNetworkError,
  ClassificationTimeoutError,
  InvalidClassificationResponseError,
  classifyItem,
} from '../api/classification';
import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type {
  ClassificationAttemptSnapshot,
  ClassificationFailure,
} from '../models/item-transitions';
import type { Item } from '../models/Item';

export const MAX_CLASSIFICATION_CONCURRENCY = 2;
export const MAX_CLASSIFICATION_ATTEMPTS = 3;
export const CLASSIFICATION_RETRY_BASE_DELAY_MS = 2_000;

export type ClassificationWorkerState = {
  items: readonly Item[];
  isHydrated: boolean;
  isForeground: boolean;
  isDefinitelyOffline: boolean;
};

type Classify = typeof classifyItem;

export type ClassificationWorkerCallbacks = {
  markPending: (
    id: string,
    attempt: ClassificationAttemptSnapshot,
    nextAttemptAt: string | null,
  ) => void;
  applyResult: (
    id: string,
    attempt: ClassificationAttemptSnapshot,
    result: Awaited<ReturnType<Classify>>,
  ) => void;
  markFailed: (
    id: string,
    attempt: ClassificationAttemptSnapshot,
    failure: ClassificationFailure,
  ) => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ClassificationWorkerDependencies = ClassificationWorkerCallbacks & {
  classify?: Classify;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

type InFlightRequest = {
  itemId: string;
  controller: AbortController;
  attempt: ClassificationAttemptSnapshot;
};

type EligibleAttempt = {
  item: Item;
  attempt: ClassificationAttemptSnapshot;
  dueAt: number;
};

const initialState: ClassificationWorkerState = {
  items: [],
  isHydrated: false,
  isForeground: true,
  isDefinitelyOffline: false,
};

function requestKey(id: string, revision: number): string {
  return `${id}:${revision}`;
}

function attemptKey(
  id: string,
  attempt: ClassificationAttemptSnapshot,
): string {
  return `${requestKey(id, attempt.sourceRevision)}:${attempt.attemptCount}`;
}

function developmentLog(
  message: string,
  details: Record<string, unknown>,
): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info(`[classification] ${message}`, details);
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function retryTime(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getClassificationRetryDelayMs(
  attemptCount: number,
  random: number,
): number {
  const exponentialDelay =
    CLASSIFICATION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1);
  const jitterMultiplier = 0.75 + Math.min(1, Math.max(0, random)) * 0.5;
  return Math.round(exponentialDelay * jitterMultiplier);
}

function eligibleAttempt(item: Item): EligibleAttempt | null {
  if (item.completedAt !== undefined) {
    return null;
  }

  const classification = item.classification;
  const source = {
    sourceRevision: item.revision,
    sourceText: item.text,
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
  };

  switch (classification.status) {
    case 'unclassified':
      return {
        item,
        attempt: { ...source, attemptCount: 1 },
        dueAt: 0,
      };
    case 'pending':
      if (
        classification.sourceRevision !== item.revision ||
        classification.sourceText !== item.text ||
        classification.taxonomyVersion !== DESTINATION_TAXONOMY_VERSION ||
        classification.attemptCount > MAX_CLASSIFICATION_ATTEMPTS
      ) {
        return null;
      }
      return {
        item,
        attempt: {
          ...source,
          attemptCount: Math.max(1, classification.attemptCount),
        },
        dueAt: retryTime(classification.nextAttemptAt),
      };
    case 'failed':
      if (
        !classification.retryable ||
        classification.attemptCount >= MAX_CLASSIFICATION_ATTEMPTS ||
        classification.sourceRevision !== item.revision ||
        classification.sourceText !== item.text ||
        classification.taxonomyVersion !== DESTINATION_TAXONOMY_VERSION
      ) {
        return null;
      }
      return {
        item,
        attempt: {
          ...source,
          attemptCount: classification.attemptCount + 1,
        },
        dueAt: retryTime(classification.nextAttemptAt),
      };
    case 'current':
      return null;
  }
}

function classifyFailure(error: unknown): {
  failureKind: ClassificationFailure['failureKind'];
  retryable: boolean;
} {
  if (error instanceof InvalidClassificationResponseError) {
    return { failureKind: 'invalid-response', retryable: false };
  }
  if (error instanceof ClassificationNetworkError) {
    return { failureKind: 'network', retryable: true };
  }
  if (error instanceof ClassificationTimeoutError) {
    return { failureKind: 'timeout', retryable: true };
  }
  if (error instanceof ClassificationHttpError) {
    if (error.status === 400) {
      return { failureKind: 'invalid-request', retryable: false };
    }
    return {
      failureKind: 'server',
      retryable:
        error.status === 408 || error.status === 429 || error.status >= 500,
    };
  }
  return { failureKind: 'unknown', retryable: false };
}

export class ItemClassificationWorker {
  private readonly classify: Classify;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private callbacks: ClassificationWorkerCallbacks;

  private state = initialState;
  private isMounted = false;
  private timer: TimerHandle | null = null;
  private timerDueAt: number | null = null;
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly settledAttempts = new Set<string>();
  private readonly loggedCurrentItems = new Set<string>();

  constructor(dependencies: ClassificationWorkerDependencies) {
    this.classify = dependencies.classify ?? classifyItem;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.setTimer =
      dependencies.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.callbacks = dependencies;
  }

  setCallbacks(callbacks: ClassificationWorkerCallbacks): void {
    this.callbacks = callbacks;
  }

  start(): void {
    this.isMounted = true;
    this.schedulePump(0);
  }

  stop(): void {
    this.isMounted = false;
    this.clearScheduledPump();
    this.abortAll();
  }

  update(state: ClassificationWorkerState): void {
    this.state = state;
    this.removeSettledAttemptsThatChanged();
    this.removeCurrentLogsThatChanged();
    this.abortObsoleteRequests();

    if (!this.canRun()) {
      this.clearScheduledPump();
      this.abortAll();
      return;
    }

    this.schedulePump(0);
  }

  private canRun(): boolean {
    return (
      this.isMounted &&
      this.state.isHydrated &&
      this.state.isForeground &&
      !this.state.isDefinitelyOffline
    );
  }

  private schedulePump(delayMs: number): void {
    if (!this.canRun()) {
      return;
    }

    const dueAt = this.now() + Math.max(0, delayMs);
    if (this.timer !== null && this.timerDueAt !== null) {
      if (this.timerDueAt <= dueAt) {
        return;
      }
      this.clearScheduledPump();
    }

    this.timerDueAt = dueAt;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.timerDueAt = null;
        this.pump();
      },
      Math.max(0, delayMs),
    );
  }

  private clearScheduledPump(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
      this.timerDueAt = null;
    }
  }

  private pump(): void {
    if (!this.canRun()) {
      return;
    }

    const now = this.now();
    let nextDueAt: number | null = null;

    for (const item of this.state.items) {
      if (this.inFlight.size >= MAX_CLASSIFICATION_CONCURRENCY) {
        break;
      }

      if (item.completedAt !== undefined) {
        continue;
      }

      if (item.classification.status === 'current') {
        const key = requestKey(item.id, item.revision);
        if (!this.loggedCurrentItems.has(key)) {
          this.loggedCurrentItems.add(key);
          developmentLog('Skipping item because classification is current.', {
            itemId: item.id,
            revision: item.revision,
          });
        }
        continue;
      }

      const eligible = eligibleAttempt(item);
      if (eligible === null) {
        continue;
      }

      const key = requestKey(item.id, item.revision);
      const completedKey = attemptKey(item.id, eligible.attempt);
      if (this.inFlight.has(key) || this.settledAttempts.has(completedKey)) {
        continue;
      }

      if (eligible.dueAt > now) {
        nextDueAt =
          nextDueAt === null
            ? eligible.dueAt
            : Math.min(nextDueAt, eligible.dueAt);
        continue;
      }

      developmentLog('Selected item for classification.', {
        itemId: item.id,
        revision: item.revision,
        attemptCount: eligible.attempt.attemptCount,
      });
      this.startRequest(eligible);
    }

    if (
      this.inFlight.size < MAX_CLASSIFICATION_CONCURRENCY &&
      nextDueAt !== null
    ) {
      this.schedulePump(nextDueAt - now);
    }
  }

  private startRequest({ item, attempt }: EligibleAttempt): void {
    const key = requestKey(item.id, item.revision);
    const controller = new AbortController();
    this.inFlight.set(key, { itemId: item.id, controller, attempt });
    this.callbacks.markPending(item.id, attempt, null);
    developmentLog('Classification request started.', {
      itemId: item.id,
      revision: attempt.sourceRevision,
      attemptCount: attempt.attemptCount,
    });

    void this.classify(
      { text: attempt.sourceText },
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted || this.isCompleted(item.id)) {
          return;
        }
        developmentLog('Classification succeeded.', {
          itemId: item.id,
          revision: attempt.sourceRevision,
          outcome: result.outcome,
          categories: result.categories,
        });
        this.settledAttempts.add(attemptKey(item.id, attempt));
        this.callbacks.applyResult(item.id, attempt, result);
      })
      .catch((error: unknown) => {
        if (
          error instanceof ClassificationCancelledError ||
          controller.signal.aborted ||
          this.isCompleted(item.id)
        ) {
          return;
        }

        const classifiedFailure = classifyFailure(error);
        const canRetry =
          classifiedFailure.retryable &&
          attempt.attemptCount < MAX_CLASSIFICATION_ATTEMPTS;
        const nextAttemptAt = canRetry
          ? new Date(
              this.now() +
                getClassificationRetryDelayMs(
                  attempt.attemptCount,
                  this.random(),
                ),
            ).toISOString()
          : null;

        developmentLog('Classification failed.', {
          itemId: item.id,
          revision: attempt.sourceRevision,
          attemptCount: attempt.attemptCount,
          errorType: errorType(error),
          ...(error instanceof ClassificationHttpError
            ? { status: error.status }
            : {}),
          failureKind: classifiedFailure.failureKind,
          retryable: canRetry,
          nextAttemptAt,
        });
        this.settledAttempts.add(attemptKey(item.id, attempt));
        this.callbacks.markFailed(item.id, attempt, {
          failureKind: classifiedFailure.failureKind,
          retryable: canRetry,
          nextAttemptAt,
        });
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.schedulePump(0);
      });
  }

  private isCompleted(id: string): boolean {
    return this.state.items.some(
      (item) => item.id === id && item.completedAt !== undefined,
    );
  }

  private abortObsoleteRequests(): void {
    const itemsById = new Map(this.state.items.map((item) => [item.id, item]));

    for (const { itemId, controller, attempt } of this.inFlight.values()) {
      const item = itemsById.get(itemId);
      if (
        item === undefined ||
        item.completedAt !== undefined ||
        item.revision !== attempt.sourceRevision ||
        item.text !== attempt.sourceText ||
        item.classification.taxonomyVersion !== attempt.taxonomyVersion
      ) {
        controller.abort();
      }
    }
  }

  private abortAll(): void {
    for (const request of this.inFlight.values()) {
      request.controller.abort();
    }
  }

  private removeSettledAttemptsThatChanged(): void {
    const activeAttemptKeys = new Set<string>();
    for (const item of this.state.items) {
      if (item.classification.status === 'pending') {
        activeAttemptKeys.add(
          attemptKey(item.id, {
            sourceRevision: item.classification.sourceRevision,
            sourceText: item.classification.sourceText,
            taxonomyVersion: item.classification.taxonomyVersion,
            attemptCount: item.classification.attemptCount,
          }),
        );
      }
    }

    for (const key of this.settledAttempts) {
      if (!activeAttemptKeys.has(key)) {
        this.settledAttempts.delete(key);
      }
    }
  }

  private removeCurrentLogsThatChanged(): void {
    const currentKeys = new Set(
      this.state.items
        .filter((item) => item.classification.status === 'current')
        .map((item) => requestKey(item.id, item.revision)),
    );

    for (const key of this.loggedCurrentItems) {
      if (!currentKeys.has(key)) {
        this.loggedCurrentItems.delete(key);
      }
    }
  }
}
