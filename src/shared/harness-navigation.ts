import type { HarnessEntry } from './harness.js';
import type { HarnessProfile, HarnessLevel, HarnessNodeLevel } from './harness-cascade.js';
import type { OporaPlace } from './opora-identity.js';

export interface HarnessChoice {
  key: string; name: string; level: HarnessNodeLevel;
  ancestry: Partial<Record<HarnessNodeLevel, string>>;
}
export interface HarnessProjectChoice { floor: string; name: string; projectName: string; connected: boolean }
export interface HarnessHierarchyView extends HarnessProfile {
  schema: 'harness.hierarchy/1'; floor: string; target: string; level: HarnessLevel;
  bound: OporaPlace | null; linked: (OporaPlace & { name: string }) | null;
  bindingRevision: number; pathDigest: string; choices: HarnessChoice[]; notice: string;
  writable: boolean; globalWrite: boolean; canBind: boolean; preview: string; warning: string;
}
export interface HarnessResourceState { entry: HarnessEntry; checked: boolean; inherited: boolean; disabled: boolean; origin: string }
export const HARNESS_LEVEL_NAMES: Record<HarnessLevel, string> = {
  global: 'Globál', repository: 'Projekt / repozitář', page: 'Stránka', layer: 'Vrstva', area: 'Oblast', sector: 'Sektor', task: 'Karta',
};
