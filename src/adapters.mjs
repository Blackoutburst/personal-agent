import { createBoardBoundary } from './board-boundary.mjs';

export const BOARD_SOURCE = '25b35ad276cf9056f0cdd9d81791456a6499c189';

// Backend-only construction seam. HTTP modes never provide these trusted dependencies.
// New outbound operations must be implemented inside the shared boundary, never raw MCP passthrough.
export function createBoardAdapter(dependencies = {}) {
  return createBoardBoundary(dependencies);
}

export function adapterStatus(mode) {
  return {
    account: { state: mode === 'account' ? 'configured' : mode === 'demo' ? 'development-double' : 'unavailable',
      reason: mode === 'account' ? 'Platform session checks are configured. Verify your current sign-in below.' : 'Platform sign-in is not connected.' },
    board: { state: mode === 'demo' ? 'development-double' : 'unavailable', reason: 'No owner-scoped Board transport is configured; demo data is synthetic.' },
    provider: { state: 'unavailable', reason: 'A personal Codex connection is not configured.' },
    runtime: { state: 'unavailable', reason: 'Private per-user execution and recovery await orchestration qualification.' }
  };
}

// This fixture has no transport, credentials, claim operation, or model executor.
export function syntheticPreview() {
  return {
    synthetic: true,
    account: { subject: 'demo-subject', displayName: 'Development companion' },
    board: {
      sourceCommit: BOARD_SOURCE,
      policy: { synthetic: true, allowRead: true, allowExecution: false },
      work: { ready: [{ id: 'demo-ticket', title: 'Synthetic contract example', status: 'todo' }] },
      inbox: { messages: [], cursor: 'demo-cursor-no-server-acknowledgement' }
    },
    runtime: { state: 'unavailable' },
    effects: { externalCalls: 0, claims: 0, modelCalls: 0 },
    message: 'Synthetic read-only example. No account, Board session, provider or runtime is connected.'
  };
}
