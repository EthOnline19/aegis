/**
 * ERC-8004 integration surface (SDK).
 *
 * Layout, frozen by the approved design (docs/ERC8004_DESIGN.md §5):
 * - `addresses.ts` — canonical registry addresses, chainId-keyed.
 * - `abi.ts` — minimal ABIs matching contracts/src/interfaces/erc8004.
 * - `mapping.ts` — the approved v2 score/value/tag constants (pinned
 *   identically in contracts/test/Erc8004Integration.t.sol).
 * - `encoding.ts` — pure byte-level helpers (requestHash, int128,
 *   reputationSum) shared with tests and the orchestrator.
 * - `clients.ts` — typed clients over viem. The SDK NEVER holds keys
 *   (plan §31): callers sign writes via their own wallet; this layer
 *   builds calldata and reads chain state.
 */
export { erc8004ForChain, ERC8004_ADDRESSES, ARC_TESTNET_CHAIN_ID } from "./addresses.ts";
export { IDENTITY_ABI, VALIDATION_ABI, REPUTATION_ABI, VERDICT_ACCEPTED_EVENT_ABI } from "./abi.ts";
export { deriveRequestHash, toFeedbackInt128, fromFeedbackInt128, reputationSum, keccakUtf8 } from "./encoding.ts";
export {
  TAG1,
  VALUE_DECIMALS,
  TAG2_BY_OUTCOME,
  SCORE_BY_OUTCOME,
  VALUE_BY_OUTCOME,
  VALUE_COVERED,
  VALUE_ATTEMPTED,
  VALUE_DENIED_OWNER_ORIGIN,
  SCORE_COVERED,
  SCORE_ATTEMPTED,
  SCORE_DENIED_OWNER_ORIGIN,
  verdictEndpoint,
  verdictRequestUri,
  outcomeFromByte,
} from "./mapping.ts";
export type { VerdictOutcome, VerdictRef, FeedbackEntry } from "./types.ts";
export { IdentityClient, ValidationClient, ReputationClient, type Submit, type Reader } from "./clients.ts";
