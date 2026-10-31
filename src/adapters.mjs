export const BOARD_SOURCE = '25b35ad276cf9056f0cdd9d81791456a6499c189';

export function adapterStatus(mode) {
  return {
    account: { state: mode === 'demo' ? 'development-double' : 'unavailable', reason: 'Central account validation awaits the account-service contract.' },
    board: { state: mode === 'demo' ? 'development-double' : 'unavailable', reason: 'No owner-scoped Board transport is configured; demo data is synthetic.' },
    provider: { state: 'unavailable', reason: 'Hosted subscription eligibility and personal connection are not qualified.' },
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
