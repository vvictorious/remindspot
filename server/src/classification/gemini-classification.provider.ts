import { GoogleGenAI } from '@google/genai';
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ClassificationProvider } from './classification-provider';
import {
  GEMINI_CLASSIFICATION_DEADLINE_MS,
  GEMINI_CLASSIFICATION_MAX_ATTEMPTS,
  GEMINI_CLASSIFICATION_MIN_RETRY_BUDGET_MS,
  GEMINI_CLASSIFICATION_MODEL,
} from './gemini-classification-config';
import { GEMINI_CLASSIFICATION_PROMPT_V3 } from './gemini-classification-prompt';
import { GEMINI_CLASSIFICATION_SCHEMA } from './gemini-classification-schema';

type ProviderError = {
  cause?: unknown;
  code?: unknown;
  name?: unknown;
  status?: unknown;
};

class ClassificationDeadlineError extends Error {}

const TIMEOUT_ERROR_CODES = new Set<unknown>([
  408,
  '408',
  'DEADLINE_EXCEEDED',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const TRANSIENT_NETWORK_ERROR_CODES = new Set<unknown>([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT',
  'UND_ERR_SOCKET',
]);

function isRecord(value: unknown): value is ProviderError {
  return typeof value === 'object' && value !== null;
}

function errorChainIncludes(
  error: unknown,
  predicate: (candidate: ProviderError) => boolean,
) {
  const seen = new Set<unknown>();
  let candidate = error;

  while (isRecord(candidate) && !seen.has(candidate)) {
    if (predicate(candidate)) {
      return true;
    }
    seen.add(candidate);
    candidate = candidate.cause;
  }

  return false;
}

function isRateLimitError(error: unknown) {
  return errorChainIncludes(
    error,
    ({ code, status }) =>
      status === 429 ||
      code === 429 ||
      status === 'RESOURCE_EXHAUSTED' ||
      code === 'RESOURCE_EXHAUSTED',
  );
}

function isTimeoutError(error: unknown) {
  if (error instanceof ClassificationDeadlineError) {
    return true;
  }

  return errorChainIncludes(
    error,
    ({ code, name, status }) =>
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      name === 'RequestTimeoutError' ||
      name === 'DEADLINE_EXCEEDED' ||
      TIMEOUT_ERROR_CODES.has(code) ||
      TIMEOUT_ERROR_CODES.has(status),
  );
}

type GeminiClassificationFailureDetails = {
  failureReason: 'invalid-response' | 'provider-request';
  sdkErrorType?: string;
  sdkStatus?: number;
};

const failureDetails = new WeakMap<
  object,
  GeminiClassificationFailureDetails
>();

function sdkErrorType(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.name !== 'string' || !error.name) {
    return undefined;
  }

  return error.name;
}

function sdkStatus(error: unknown): number | undefined {
  if (
    !isRecord(error) ||
    typeof error.status !== 'number' ||
    !Number.isFinite(error.status)
  ) {
    return undefined;
  }

  return error.status;
}

function isUpstreamBadRequest(error: unknown) {
  return errorChainIncludes(error, ({ status }) => status === 400);
}

function invalidResponseException(): BadGatewayException {
  const exception = new BadGatewayException(
    'Classification provider returned an invalid response',
  );
  failureDetails.set(exception, { failureReason: 'invalid-response' });
  return exception;
}

function providerFailureDetails(
  error: unknown,
): GeminiClassificationFailureDetails {
  const details: GeminiClassificationFailureDetails = {
    failureReason: 'provider-request',
  };
  const errorType = sdkErrorType(error);
  const status = sdkStatus(error);
  if (errorType !== undefined) {
    details.sdkErrorType = errorType;
  }
  if (status !== undefined) {
    details.sdkStatus = status;
  }
  return details;
}

function providerRequestException(error: unknown): BadGatewayException {
  const exception = new BadGatewayException(
    'Classification provider request failed',
  );
  failureDetails.set(exception, providerFailureDetails(error));
  return exception;
}

function upstreamBadRequestException(
  error: unknown,
): UnprocessableEntityException {
  const exception = new UnprocessableEntityException(
    'Classification provider request failed',
  );
  failureDetails.set(exception, providerFailureDetails(error));
  return exception;
}

function isTransientError(error: unknown) {
  if (isRateLimitError(error) || error instanceof TypeError) {
    return true;
  }
  if (!isRecord(error)) {
    return true;
  }

  return errorChainIncludes(
    error,
    ({ code, status }) =>
      TRANSIENT_NETWORK_ERROR_CODES.has(code) ||
      (typeof status === 'number' && status >= 500),
  );
}

@Injectable()
export class GeminiClassificationProvider implements ClassificationProvider {
  private readonly logger = new Logger(GeminiClassificationProvider.name);
  private client?: GoogleGenAI;

  constructor(private readonly config: ConfigService) {}

  async classify(text: string): Promise<unknown> {
    const startedAt = performance.now();

    try {
      return await this.classifyWithProvider(text);
    } catch (error) {
      this.logFailure(error, startedAt);
      throw error;
    }
  }

  private async classifyWithProvider(text: string): Promise<unknown> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Classification service is unavailable',
      );
    }

    const client = (this.client ??= new GoogleGenAI({ apiKey }));
    const deadline = Date.now() + GEMINI_CLASSIFICATION_DEADLINE_MS;

    for (
      let attempt = 1;
      attempt <= GEMINI_CLASSIFICATION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new GatewayTimeoutException('Classification request timed out');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      const deadlineReached = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new ClassificationDeadlineError()),
          { once: true },
        );
      });

      try {
        const response = await Promise.race([
          client.models.generateContent({
            model: GEMINI_CLASSIFICATION_MODEL,
            contents: text,
            config: {
              systemInstruction: GEMINI_CLASSIFICATION_PROMPT_V3,
              responseMimeType: 'application/json',
              responseJsonSchema: GEMINI_CLASSIFICATION_SCHEMA,
              abortSignal: controller.signal,
              httpOptions: {
                timeout: remainingMs,
                retryOptions: { attempts: 1 },
              },
            },
          }),
          deadlineReached,
        ]);

        return this.parseResponse(response.text);
      } catch (error) {
        if (
          controller.signal.aborted ||
          Date.now() >= deadline ||
          isTimeoutError(error)
        ) {
          throw new GatewayTimeoutException('Classification request timed out');
        }

        if (error instanceof BadGatewayException) {
          throw error;
        }

        if (isUpstreamBadRequest(error)) {
          throw upstreamBadRequestException(error);
        }

        const canRetry =
          attempt < GEMINI_CLASSIFICATION_MAX_ATTEMPTS &&
          isTransientError(error) &&
          deadline - Date.now() >= GEMINI_CLASSIFICATION_MIN_RETRY_BUDGET_MS;
        if (canRetry) {
          continue;
        }

        if (isRateLimitError(error)) {
          throw new ServiceUnavailableException(
            'Classification service is unavailable',
          );
        }

        throw providerRequestException(error);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw providerRequestException(undefined);
  }

  private logFailure(error: unknown, startedAt: number): void {
    const statusCode =
      error instanceof HttpException ? error.getStatus() : undefined;
    const details =
      typeof error === 'object' && error !== null
        ? failureDetails.get(error)
        : undefined;
    if (typeof error === 'object' && error !== null) {
      failureDetails.delete(error);
    }

    this.logger.error({
      event: 'gemini_classification.failed',
      statusCode,
      errorType: error instanceof Error ? error.name : typeof error,
      durationMs: Math.round(performance.now() - startedAt),
      ...details,
    });
  }

  private parseResponse(text: string | undefined): unknown {
    if (!text?.trim()) {
      throw invalidResponseException();
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invalidResponseException();
    }
  }
}
