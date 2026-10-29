// Structured fields copied from a Gemini HTTP error body. Status values,
// reason codes, and field-path segments must be members of an explicit
// allowlist. Free-form text is never copied, redacted, or logged.

const MAX_FIELD_LENGTH = 160;
const MAX_FIELD_VIOLATIONS = 5;

const UPSTREAM_STATUSES = new Set([
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
]);

// Published Google API ErrorInfo reasons. A reason outside this set is omitted,
// including one that might repeat item text.
const UPSTREAM_REASONS = new Set([
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_INVALID',
  'API_KEY_IOS_APP_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
  'BILLING_DISABLED',
  'CONSUMER_INVALID',
  'CONSUMER_SUSPENDED',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'SERVICE_DISABLED',
  'USER_PROJECT_DENIED',
]);

// Structural names from the generateContent request and this service's
// response schema. A segment outside this set is omitted.
const FIELD_SEGMENTS = new Set([
  'additionalProperties',
  'categories',
  'clarificationQuestion',
  'contents',
  'description',
  'enum',
  'generationConfig',
  'items',
  'maxItems',
  'outcome',
  'parts',
  'properties',
  'required',
  'responseJsonSchema',
  'responseMimeType',
  'responseSchema',
  'role',
  'systemInstruction',
  'taxonomyVersion',
  'text',
  'type',
]);

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';
const FIELD_SEGMENT = /^([A-Za-z][A-Za-z0-9]*)(?:\[\d+\])*$/;

export type GeminiFieldViolationDiagnostic = {
  field: string;
};

export type GeminiErrorDiagnostics = {
  upstreamStatus?: string;
  upstreamReason?: string;
  fieldViolations?: GeminiFieldViolationDiagnostic[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function googleErrorRecord(
  error: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(error) || typeof error.message !== 'string') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(error.message);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.error)) {
      return undefined;
    }
    return parsed.error;
  } catch {
    return undefined;
  }
}

function upstreamStatusFrom(
  error: Record<string, unknown>,
): string | undefined {
  const status = error.status;
  if (typeof status !== 'string' || !UPSTREAM_STATUSES.has(status)) {
    return undefined;
  }
  return status;
}

function upstreamReasonFrom(details: unknown): string | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }

  for (const detail of details) {
    if (!isPlainObject(detail) || detail['@type'] !== ERROR_INFO_TYPE) {
      continue;
    }
    const reason = detail.reason;
    if (typeof reason === 'string' && UPSTREAM_REASONS.has(reason)) {
      return reason;
    }
  }

  return undefined;
}

function allowlistedFieldPath(field: string): string | undefined {
  if (field.length === 0 || field.length > MAX_FIELD_LENGTH) {
    return undefined;
  }

  const segments = field.split('.');
  if (segments.length === 0) {
    return undefined;
  }

  for (const segment of segments) {
    const match = FIELD_SEGMENT.exec(segment);
    const name = match?.[1];
    if (name === undefined || !FIELD_SEGMENTS.has(name)) {
      return undefined;
    }
  }

  return field;
}

function fieldViolationsFrom(
  details: unknown,
): GeminiFieldViolationDiagnostic[] | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }

  const violations: GeminiFieldViolationDiagnostic[] = [];
  for (const detail of details) {
    if (violations.length >= MAX_FIELD_VIOLATIONS) {
      break;
    }
    if (!isPlainObject(detail) || detail['@type'] !== BAD_REQUEST_TYPE) {
      continue;
    }
    if (!Array.isArray(detail.fieldViolations)) {
      continue;
    }

    for (const entry of detail.fieldViolations) {
      if (violations.length >= MAX_FIELD_VIOLATIONS) {
        break;
      }
      if (!isPlainObject(entry) || typeof entry.field !== 'string') {
        continue;
      }
      const field = allowlistedFieldPath(entry.field);
      if (field === undefined) {
        continue;
      }
      violations.push({ field });
    }
  }

  return violations.length > 0 ? violations : undefined;
}

export function geminiErrorDiagnostics(error: unknown): GeminiErrorDiagnostics {
  const body = googleErrorRecord(error);
  if (body === undefined) {
    return {};
  }

  const diagnostics: GeminiErrorDiagnostics = {};
  const upstreamStatus = upstreamStatusFrom(body);
  const upstreamReason = upstreamReasonFrom(body.details);
  const fieldViolations = fieldViolationsFrom(body.details);

  if (upstreamStatus !== undefined) {
    diagnostics.upstreamStatus = upstreamStatus;
  }
  if (upstreamReason !== undefined) {
    diagnostics.upstreamReason = upstreamReason;
  }
  if (fieldViolations !== undefined) {
    diagnostics.fieldViolations = fieldViolations;
  }
  return diagnostics;
}
