import {
  DESTINATION_CATEGORIES,
  DESTINATION_TAXONOMY_VERSION,
  type ClassificationFailureKind,
  type ItemClassification,
  type ItemClassificationResult,
} from '../models/Classification';
import type { Item } from '../models/Item';

export const ITEMS_STORAGE_KEY = '@there-you-go/reminders:v1';

const destinationCategorySet = new Set<string>(DESTINATION_CATEGORIES);
const failureKinds = new Set<ClassificationFailureKind>([
  'network',
  'timeout',
  'server',
  'invalid-request',
  'invalid-response',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isAttemptCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRetryDate(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function readCompletedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const completedAt = value.trim();
  if (completedAt.length === 0 || !Number.isFinite(Date.parse(completedAt))) {
    return undefined;
  }

  return completedAt;
}

function parseClassificationResult(
  value: unknown,
): ItemClassificationResult | null {
  if (
    !isRecord(value) ||
    value.taxonomyVersion !== DESTINATION_TAXONOMY_VERSION ||
    !Array.isArray(value.categories)
  ) {
    return null;
  }

  const categories = value.categories;
  if (
    !categories.every(
      (category) =>
        typeof category === 'string' && destinationCategorySet.has(category),
    ) ||
    new Set(categories).size !== categories.length
  ) {
    return null;
  }

  switch (value.outcome) {
    case 'classified':
      if (categories.length === 0) {
        return null;
      }
      return {
        outcome: 'classified',
        categories: categories as [
          (typeof DESTINATION_CATEGORIES)[number],
          ...(typeof DESTINATION_CATEGORIES)[number][],
        ],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      };
    case 'no-destination':
    case 'unsupported-destination':
      if (categories.length !== 0) {
        return null;
      }
      return {
        outcome: value.outcome,
        categories: [],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      };
    case 'needs-clarification': {
      if (
        categories.length !== 0 ||
        typeof value.clarificationQuestion !== 'string'
      ) {
        return null;
      }
      const clarificationQuestion = value.clarificationQuestion.trim();
      if (
        clarificationQuestion.length === 0 ||
        clarificationQuestion.length > 160
      ) {
        return null;
      }
      return {
        outcome: 'needs-clarification',
        categories: [],
        clarificationQuestion,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      };
    }
    default:
      return null;
  }
}

function unclassified(): ItemClassification {
  return {
    status: 'unclassified',
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
  };
}

function normalizeClassification(
  value: unknown,
  revision: number,
  text: string,
): ItemClassification {
  if (!isRecord(value)) {
    return unclassified();
  }

  if (value.status === 'unclassified') {
    return unclassified();
  }

  if (
    value.taxonomyVersion !== DESTINATION_TAXONOMY_VERSION ||
    value.sourceRevision !== revision ||
    value.sourceText !== text
  ) {
    return unclassified();
  }

  const source = {
    sourceRevision: revision,
    sourceText: text,
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
  };

  switch (value.status) {
    case 'pending':
      if (
        !isAttemptCount(value.attemptCount) ||
        !isRetryDate(value.nextAttemptAt)
      ) {
        return unclassified();
      }
      return {
        status: 'pending',
        ...source,
        attemptCount: value.attemptCount,
        nextAttemptAt: value.nextAttemptAt,
      };
    case 'current': {
      const result = parseClassificationResult(value.result);
      if (result === null || result.taxonomyVersion !== value.taxonomyVersion) {
        return unclassified();
      }
      return {
        status: 'current',
        ...source,
        result,
      };
    }
    case 'failed':
      if (
        !isAttemptCount(value.attemptCount) ||
        !isRetryDate(value.nextAttemptAt) ||
        typeof value.retryable !== 'boolean' ||
        typeof value.failureKind !== 'string' ||
        !failureKinds.has(value.failureKind as ClassificationFailureKind)
      ) {
        return unclassified();
      }
      return {
        status: 'failed',
        ...source,
        attemptCount: value.attemptCount,
        nextAttemptAt: value.nextAttemptAt,
        retryable: value.retryable,
        failureKind: value.failureKind as ClassificationFailureKind,
      };
    default:
      return unclassified();
  }
}

function normalizeItem(value: unknown): Item {
  if (!isRecord(value)) {
    throw new Error('Stored item is not an object.');
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new Error('Stored item is missing required item data.');
  }

  const revision = isPositiveInteger(value.revision) ? value.revision : 1;
  const completedAt = readCompletedAt(value.completedAt);
  const storedItem = { ...value };
  delete storedItem.completedAt;

  return {
    ...storedItem,
    id: value.id,
    text: value.text,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision,
    classification: normalizeClassification(
      value.classification,
      revision,
      value.text,
    ),
    ...(completedAt === undefined ? {} : { completedAt }),
  } as Item;
}

export function normalizeStoredItems(value: unknown): Item[] {
  if (!Array.isArray(value)) {
    throw new Error('Stored items are not an array.');
  }

  return value.map(normalizeItem);
}

export function parseStoredItems(value: string): Item[] {
  return normalizeStoredItems(JSON.parse(value) as unknown);
}

export function serializeItems(items: readonly Item[]): string {
  return JSON.stringify(items);
}
