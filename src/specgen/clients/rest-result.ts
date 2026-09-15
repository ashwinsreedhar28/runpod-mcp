import type { ToolResult } from '../dispatch.js';
import { withRateLimitHint } from '../../_shared/rate-limit.js';

/** Preserve status even when the API error has no body; attach quota guidance. */
export function restError(response: Response, error: unknown): ToolResult {
  const payload = error ?? {
    error: response.statusText || `HTTP ${response.status}`,
  };
  return {
    ok: false,
    status: response.status,
    payload:
      response.status === 429
        ? withRateLimitHint(payload, response.headers)
        : payload,
  };
}
