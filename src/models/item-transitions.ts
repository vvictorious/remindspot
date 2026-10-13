import {
  DESTINATION_TAXONOMY_VERSION,
  type ClassificationFailureKind,
  type ClassificationSource,
  type CurrentClassification,
  type FailedClassification,
  type ItemClassificationResult,
  type PendingClassification,
} from './Classification';
import type { Item } from './Item';

export type ClassificationAttemptSnapshot = ClassificationSource & {
  attemptCount: number;
};

export type ClassificationFailure = {
  retryable: boolean;
  failureKind: ClassificationFailureKind;
  nextAttemptAt: string | null;
};

function pendingClassification(
  revision: number,
  text: string,
): PendingClassification {
  return {
    status: 'pending',
    sourceRevision: revision,
    sourceText: text,
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    attemptCount: 0,
    nextAttemptAt: null,
  };
}

function sourceMatchesItem(item: Item, source: ClassificationSource): boolean {
  return (
    source.taxonomyVersion === DESTINATION_TAXONOMY_VERSION &&
    source.sourceRevision === item.revision &&
    source.sourceText === item.text
  );
}

function attemptMatchesItem(
  item: Item,
  attempt: ClassificationAttemptSnapshot,
): boolean {
  const classification = item.classification;
  return (
    sourceMatchesItem(item, attempt) &&
    classification.status === 'pending' &&
    classification.sourceRevision === attempt.sourceRevision &&
    classification.sourceText === attempt.sourceText &&
    classification.taxonomyVersion === attempt.taxonomyVersion &&
    classification.attemptCount === attempt.attemptCount
  );
}

function isCompleted(item: Item): boolean {
  return item.completedAt !== undefined;
}

function canMarkPending(
  item: Item,
  attempt: ClassificationAttemptSnapshot,
): boolean {
  if (
    !sourceMatchesItem(item, attempt) ||
    !Number.isInteger(attempt.attemptCount) ||
    attempt.attemptCount < 0
  ) {
    return false;
  }

  const classification = item.classification;
  switch (classification.status) {
    case 'unclassified':
      return true;
    case 'pending':
      return attempt.attemptCount >= classification.attemptCount;
    case 'failed':
      return attempt.attemptCount > classification.attemptCount;
    case 'current':
      return false;
  }
}

export function createItem(id: string, text: string, now: string): Item | null {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return null;
  }

  const revision = 1;
  return {
    id,
    text: normalizedText,
    createdAt: now,
    updatedAt: now,
    revision,
    classification: pendingClassification(revision, normalizedText),
  };
}

export function updateItemText(
  items: readonly Item[],
  id: string,
  text: string,
  now: string,
): Item[] {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return deleteItem(items, id);
  }

  let changed = false;
  const nextItems = items.map((item) => {
    if (item.id !== id || item.text === normalizedText) {
      return item;
    }

    changed = true;
    const revision = item.revision + 1;
    return {
      ...item,
      text: normalizedText,
      updatedAt: now,
      revision,
      classification: pendingClassification(revision, normalizedText),
    };
  });

  return changed ? nextItems : (items as Item[]);
}

export function deleteItem(items: readonly Item[], id: string): Item[] {
  const nextItems = items.filter((item) => item.id !== id);
  return nextItems.length === items.length ? (items as Item[]) : nextItems;
}

export function completeItem(
  items: readonly Item[],
  id: string,
  completedAt: string,
): Item[] {
  let changed = false;
  const nextItems = items.map((item) => {
    if (item.id !== id || isCompleted(item)) {
      return item;
    }

    changed = true;
    return {
      ...item,
      completedAt,
    };
  });

  return changed ? nextItems : (items as Item[]);
}

export function undoItemCompletion(items: readonly Item[], id: string): Item[] {
  let changed = false;
  const nextItems = items.map((item) => {
    if (item.id !== id || !isCompleted(item)) {
      return item;
    }

    changed = true;
    const activeItem = { ...item };
    delete activeItem.completedAt;
    return activeItem;
  });

  return changed ? nextItems : (items as Item[]);
}

export function retryItemClassification(
  items: readonly Item[],
  id: string,
): Item[] {
  let changed = false;
  const nextItems = items.map((item) => {
    if (
      item.id !== id ||
      isCompleted(item) ||
      item.classification.status !== 'failed'
    ) {
      return item;
    }

    changed = true;
    return {
      ...item,
      classification: pendingClassification(item.revision, item.text),
    };
  });

  return changed ? nextItems : (items as Item[]);
}

export function markClassificationPending(
  items: readonly Item[],
  id: string,
  attempt: ClassificationAttemptSnapshot,
  nextAttemptAt: string | null,
): Item[] {
  let changed = false;
  const nextItems = items.map((item) => {
    if (item.id !== id || isCompleted(item) || !canMarkPending(item, attempt)) {
      return item;
    }

    const classification = item.classification;
    if (
      classification.status === 'pending' &&
      classification.attemptCount === attempt.attemptCount &&
      classification.nextAttemptAt === nextAttemptAt
    ) {
      return item;
    }

    changed = true;
    const nextClassification: PendingClassification = {
      status: 'pending',
      ...attempt,
      nextAttemptAt,
    };
    return {
      ...item,
      classification: nextClassification,
    };
  });

  return changed ? nextItems : (items as Item[]);
}

export function applyClassificationResult(
  items: readonly Item[],
  id: string,
  attempt: ClassificationAttemptSnapshot,
  result: ItemClassificationResult,
): Item[] {
  if (result.taxonomyVersion !== attempt.taxonomyVersion) {
    return items as Item[];
  }

  let changed = false;
  const nextItems = items.map((item) => {
    if (
      item.id !== id ||
      isCompleted(item) ||
      !attemptMatchesItem(item, attempt)
    ) {
      return item;
    }

    changed = true;
    const classification: CurrentClassification = {
      status: 'current',
      sourceRevision: attempt.sourceRevision,
      sourceText: attempt.sourceText,
      taxonomyVersion: attempt.taxonomyVersion,
      result,
    };
    return {
      ...item,
      classification,
    };
  });

  return changed ? nextItems : (items as Item[]);
}

export function markClassificationFailed(
  items: readonly Item[],
  id: string,
  attempt: ClassificationAttemptSnapshot,
  failure: ClassificationFailure,
): Item[] {
  let changed = false;
  const nextItems = items.map((item) => {
    if (
      item.id !== id ||
      isCompleted(item) ||
      !attemptMatchesItem(item, attempt)
    ) {
      return item;
    }

    changed = true;
    const classification: FailedClassification = {
      status: 'failed',
      sourceRevision: attempt.sourceRevision,
      sourceText: attempt.sourceText,
      taxonomyVersion: attempt.taxonomyVersion,
      attemptCount: attempt.attemptCount,
      nextAttemptAt: failure.nextAttemptAt,
      retryable: failure.retryable,
      failureKind: failure.failureKind,
    };
    return {
      ...item,
      classification,
    };
  });

  return changed ? nextItems : (items as Item[]);
}
