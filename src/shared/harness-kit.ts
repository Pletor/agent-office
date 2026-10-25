import type { HarnessCategory } from './harness.js';

/** Exact context transported in an accepted Opora specification; requires never grants capabilities. */
export interface HarnessKit {
  schema: 'harness.kit/1';
  problems: string[];
  resources: { slot: string; resource: string; category: HarnessCategory; digest: string; content: string; requires: string[] }[];
}
