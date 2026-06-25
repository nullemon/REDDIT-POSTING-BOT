// SourceAdapter contract. Every source returns a normalized ImageItem[].
//
// Adapters MUST be self-contained and fail-soft: throwing is acceptable (the
// orchestrator wraps each fetch in try/catch so one dead source never kills the
// run), but adapters should prefer to log and return a partial/empty list when a
// single sub-request fails (e.g. one Twitter handle 404s) so the rest still flow.

import type { Env, ImageItem } from '../types';

export interface SourceAdapter {
  /** Human label for logs, e.g. "reddit:pics" or "twitter:account". */
  readonly key: string;
  fetch(): Promise<ImageItem[]>;
}

export interface AdapterCtx {
  env: Env;
}
