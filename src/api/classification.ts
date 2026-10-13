import {
  DESTINATION_CATEGORIES,
  DESTINATION_TAXONOMY_VERSION,
  type DestinationCategory,
  type ItemClassificationResult,
} from '../models/Classification';

export const CLASSIFICATION_REQUEST_TIMEOUT_MS = 22_000;

const MAX_CLARIFICATION_QUESTION_LENGTH = 160;
const destinationCategorySet = new Set<string>(DESTINATION_CATEGORIES);

export type ClassifyItemRequest = {
  text: string;
};

export type ClassificationRequestOptions = {
  signal?: AbortSignal;
};

export type ClassificationClientErrorKind =
  'http' | 'network' | 'timeout' | 'cancelled' | 'invalid-response';

export class ClassificationClientError extends Error {
  constructor(
    message: string,
    readonly kind: ClassificationClientErrorKind,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClassificationClientError';
  }
}

export class ClassificationHttpError extends ClassificationClientError {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(
      `The classification server request failed with status ${status}.`,
      'http',
    );
    this.name = 'ClassificationHttpError';
  }
}

export class ClassificationNetworkError extends ClassificationClientError {
  constructor(cause: unknown) {
    super('The classification server could not be reached.', 'network', cause);
    this.name = 'ClassificationNetworkError';
  }
}

export class ClassificationTimeoutError extends ClassificationClientError {
  constructor() {
    super('The classification server request timed out.', 'timeout');
    this.name = 'ClassificationTimeoutError';
  }
}

export class ClassificationCancelledError extends ClassificationClientError {
  constructor() {
    super('The classification server request was cancelled.', 'cancelled');
    this.name = 'ClassificationCancelledError';
  }
}

export class InvalidClassificationResponseError extends ClassificationClientError {
  constructor(message: string, cause?: unknown) {
    super(
      `The classification server returned an invalid response: ${message}`,
      'invalid-response',
      cause,
    );
    this.name = 'InvalidClassificationResponseError';
  }
}

function getServerBaseUrl() {
  const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

  if (!baseUrl) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL is not configured. Add it to the app .env.local file.',
    );
  }

  return baseUrl.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
}

function invalidResponse(message: string): never {
  throw new InvalidClassificationResponseError(message);
}

export function parseItemClassificationResult(
  value: unknown,
): ItemClassificationResult {
  if (!isRecord(value)) {
    return invalidResponse('expected an object.');
  }

  if (value.taxonomyVersion !== DESTINATION_TAXONOMY_VERSION) {
    return invalidResponse(
      `taxonomyVersion must be ${DESTINATION_TAXONOMY_VERSION}.`,
    );
  }

  if (!Array.isArray(value.categories)) {
    return invalidResponse('categories must be an array.');
  }

  const categories = value.categories;
  if (
    !categories.every(
      (category) =>
        typeof category === 'string' && destinationCategorySet.has(category),
    )
  ) {
    return invalidResponse(
      'categories must contain only supported destination categories.',
    );
  }

  switch (value.outcome) {
    case 'classified': {
      if (
        !hasExactlyKeys(value, ['outcome', 'categories', 'taxonomyVersion'])
      ) {
        return invalidResponse('classified contains unexpected properties.');
      }
      if (categories.length === 0) {
        return invalidResponse(
          'classified must contain at least one destination category.',
        );
      }
      if (new Set(categories).size !== categories.length) {
        return invalidResponse(
          'classified destination categories must be unique.',
        );
      }
      return {
        outcome: 'classified',
        categories: categories as [
          DestinationCategory,
          ...DestinationCategory[],
        ],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      };
    }
    case 'no-destination':
    case 'unsupported-destination':
      if (
        !hasExactlyKeys(value, ['outcome', 'categories', 'taxonomyVersion'])
      ) {
        return invalidResponse(
          `${value.outcome} contains unexpected properties.`,
        );
      }
      if (categories.length !== 0) {
        return invalidResponse(`${value.outcome} categories must be empty.`);
      }
      return {
        outcome: value.outcome,
        categories: [],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      };
    case 'needs-clarification': {
      if (
        !hasExactlyKeys(value, [
          'outcome',
          'categories',
          'clarificationQuestion',
          'taxonomyVersion',
        ])
      ) {
        return invalidResponse(
          'needs-clarification contains unexpected properties.',
        );
      }
      if (categories.length !== 0) {
        return invalidResponse('needs-clarification categories must be empty.');
      }
      if (
        typeof value.clarificationQuestion !== 'string' ||
        value.clarificationQuestion.trim().length === 0
      ) {
        return invalidResponse(
          'needs-clarification must include a clarificationQuestion.',
        );
      }

      const clarificationQuestion = value.clarificationQuestion.trim();
      if (clarificationQuestion.length > MAX_CLARIFICATION_QUESTION_LENGTH) {
        return invalidResponse(
          `clarificationQuestion must not exceed ${MAX_CLARIFICATION_QUESTION_LENGTH} characters.`,
        );
      }
      return {
        outcome: 'needs-clarification',
        categories: [],
        clarificationQuestion,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      };
    }
    default:
      return invalidResponse('outcome is not supported.');
  }
}

async function parseResponseBody(
  response: Response,
): Promise<ItemClassificationResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new InvalidClassificationResponseError(
      'body must contain valid JSON.',
      error,
    );
  }
  return parseItemClassificationResult(body);
}

export async function classifyItem(
  request: ClassifyItemRequest,
  options: ClassificationRequestOptions = {},
): Promise<ItemClassificationResult> {
  if (options.signal?.aborted) {
    throw new ClassificationCancelledError();
  }

  const endpoint = `${getServerBaseUrl()}/classification`;
  const controller = new AbortController();
  let interruption: 'timeout' | 'cancelled' | null = null;
  let rejectInterruption:
    ((reason: ClassificationClientError) => void) | undefined;

  const interrupted = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });

  const cancel = () => {
    interruption = 'cancelled';
    rejectInterruption?.(new ClassificationCancelledError());
    controller.abort();
  };
  options.signal?.addEventListener('abort', cancel, { once: true });

  const timeout = setTimeout(() => {
    interruption = 'timeout';
    rejectInterruption?.(new ClassificationTimeoutError());
    controller.abort();
  }, CLASSIFICATION_REQUEST_TIMEOUT_MS);

  const operation = (async () => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (interruption === 'timeout') {
        throw new ClassificationTimeoutError();
      }
      if (interruption === 'cancelled' || options.signal?.aborted) {
        throw new ClassificationCancelledError();
      }
      throw new ClassificationNetworkError(error);
    }

    if (!response.ok) {
      throw new ClassificationHttpError(response.status, response.statusText);
    }

    return parseResponseBody(response);
  })();

  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
