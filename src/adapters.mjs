import { createBoardBoundary } from './board-boundary.mjs';

export const BOARD_SOURCE = '25b35ad276cf9056f0cdd9d81791456a6499c189';

// Backend-only construction seam. HTTP modes never provide these trusted dependencies.
// New outbound operations must be implemented inside the shared boundary, never raw MCP passthrough.
export function createBoardAdapter(dependencies = {}) {
  return createBoardBoundary(dependencies);
}

// agents: whether per-owner agents (runtime file) are configured in account mode.
export function adapterStatus(mode, { agents = false } = {}) {
  const live = mode === 'account' && agents;
  return {
    account: { state: mode === 'account' ? 'configured' : mode === 'demo' ? 'development-double' : 'unavailable',
      reason: mode === 'account' ? 'Platform session checks are configured. Verify your current sign-in below.' : 'Platform sign-in is not connected.' },
    board: { state: mode === 'demo' ? 'development-double' : 'unavailable', reason: 'No owner-scoped Board transport is configured; demo data is synthetic.' },
    provider: live ? { state: 'configured', reason: 'Each owner’s own Claude or Codex subscription answers, on this server.' }
      : { state: 'unavailable', reason: 'No personal agent is configured.' },
    runtime: live ? { state: 'configured', reason: 'Replies run on the server, keep going when the page is closed and never re-run after a restart.' }
      : { state: 'unavailable', reason: 'Conversations need a configured personal agent.' }
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
