/** Read-only attention for the current floor's linked workspace, without switchboard filtering. */
export interface BossAttentionItem {
  id: string;
  nodeId?: string;
  title: string;
  /** Full parent breadcrumb, starting with project and workspace; title is separate. */
  path: string[];
  reason: string;
  action: string;
  url?: string;
  kind: 'question' | 'approval' | 'system';
  /** Deterministic instructions, not generated promises of work or authorization to approve. */
  guidance?: {
    owner: string;
    activity: string;
    steps: string[];
    expected: string;
    blockers: string[];
    linkLabel: string;
    agentNext?: string;
  };
}

export interface BossAttention {
  project: { id: string; name: string } | null;
  workspace: { id: string; label: string } | null;
  checkedAt: number;
  scope: 'linked-workspace';
  status: 'ready' | 'partial' | 'loading' | 'disconnected' | 'not-linked' | 'error';
  items: BossAttentionItem[];
  system: BossAttentionItem[];
  error?: string;
}
