import { describe, it } from 'vitest';
import { serviceRecoveryAcceptance } from './local-tools-acceptance.js';

// Other local-tool acceptance paths run directly through features/24_local_skills_cli.feature.
// These startup reconciliation paths have additional WebService wiring not exercised there.
describe('local operation boundary and recovery integration', () => {
  it('[BT_L06] [BT_L11] startup reconciles a durable receipt before scheduling', () => serviceRecoveryAcceptance(false));
  it('[BT_L06] startup retains a possibly launched command without guessing', () => serviceRecoveryAcceptance(true));
});
