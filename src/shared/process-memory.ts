/** Read-only HTTP adapter to Opora's existing OpenViking integration. */
export interface MemoryRole { id: string; label: string; description: string }
export interface MemoryStatus {
  status: 'configured' | 'disabled' | 'unavailable' | 'needs_provisioning' | 'not_configured';
  reason: string; roles: MemoryRole[]; missingRoles: string[]; checkedAt: number;
}
export interface MemoryRecall {
  status: string; reason: string; role: string; truncated: boolean;
  items: { uri: string; text: string; origin: string; score: number }[];
}
