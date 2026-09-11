/**
 * REPAYD Résumé — the ENSv2 insurance résumé (master plan §13/§35).
 *
 * One lookup — `resolve atlas.repayd.eth` — prices trust in the machine:
 *
 * ```
 * INSURED:     yes · policy v4 · cap $2,500 · pool healthy
 * DRIVING:     94/100 · 179-day clean streak · premium 0.72x
 * CLAIMS:      1 covered ($135) · 1 attempted (frozen, no loss)
 * ALIBI SDK:   installed (instruction chain live)
 * BACKING:     World-ID verified human
 * STATUS:      ACTIVE
 * ```
 *
 * Chain-independent and deterministic: no network, no clock, no randomness.
 * Every field carries a provenance label — VERIFIED (on-chain-derived) or
 * COMPUTED (this formula, published). Nothing is ever INFERRED.
 */

/** Provenance label — the honesty pattern from plan §9. */
export type Provenance = "VERIFIED" | "COMPUTED";

/** One line of the résumé: the human string plus its provenance label. */
export interface ResumeField {
  readonly key: FieldKey;
  readonly text: string;
  readonly provenance: Provenance;
}

/** The §13 field set, in display order. */
export type FieldKey = "INSURED" | "DRIVING" | "CLAIMS" | "ALIBI" | "BACKING" | "STATUS";

/** The full résumé — each field a string with a provenance label. */
export interface Resume {
  readonly INSURED: ResumeField;
  readonly DRIVING: ResumeField;
  readonly CLAIMS: ResumeField;
  readonly ALIBI: ResumeField;
  readonly BACKING: ResumeField;
  readonly STATUS: ResumeField;
}

/** Policy facts — read from PolicyRegistry + MutualPool (all on-chain). */
export interface PolicyInput {
  readonly version: number;
  readonly capUsd: number;
  readonly poolHealthy: boolean;
}

/** Driving record — streak/score from the Risk Subgraph, multiplier from the pricing formula. */
export interface DrivingInput {
  readonly cleanDays: number;
  readonly score: number;
  /** Product of pricing multipliers, e.g. 0.72. Omit to leave premium off the line. */
  readonly premiumMultiplier?: number;
}

/** Claims history — verdicts + payouts, all on-chain. */
export interface ClaimsInput {
  readonly covered: number;
  readonly attempted: number;
  /** USD payout of each covered claim, e.g. [135]. */
  readonly payoutsUsd: readonly number[];
}

/** Alibi SDK state — instruction hash-chain head commits on ENSv2. */
export interface AlibiInput {
  readonly installed: boolean;
  readonly instructionChainLive: boolean;
}

/** Backing human — World ID (one human, one insurance identity). */
export interface BackingInput {
  readonly worldIdVerified: boolean;
}

/** Everything `buildResume` needs. Assembled from live stack state + pricing output. */
export interface ResumeInput {
  readonly policy: PolicyInput;
  readonly driving: DrivingInput;
  readonly claims: ClaimsInput;
  readonly alibi: AlibiInput;
  readonly backing: BackingInput;
  /** e.g. "ACTIVE" or "ACTIVE since 2026-06". */
  readonly status: string;
}

const FIELD_ORDER: readonly FieldKey[] = [
  "INSURED",
  "DRIVING",
  "CLAIMS",
  "ALIBI",
  "BACKING",
  "STATUS",
];

/** Field label used in the rendered block (ALIBI renders as "ALIBI SDK", plan §13). */
const FIELD_LABEL: Record<FieldKey, string> = {
  INSURED: "INSURED",
  DRIVING: "DRIVING",
  CLAIMS: "CLAIMS",
  ALIBI: "ALIBI SDK",
  BACKING: "BACKING",
  STATUS: "STATUS",
};

/** ENS text-record key for each field (reverse-DNS, our namespace). */
const ENS_TEXT_KEY: Record<FieldKey, string> = {
  INSURED: "com.bulwark.insured",
  DRIVING: "com.bulwark.driving",
  CLAIMS: "com.bulwark.claims",
  ALIBI: "com.bulwark.alibi",
  BACKING: "com.bulwark.backing",
  STATUS: "com.bulwark.status",
};

/** $2,500 — thousands separators, no decimals unless fractional. */
export function usd(amount: number): string {
  const whole = Number.isInteger(amount);
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 0.72 → "0.72x" (two decimals). */
export function multiplier(x: number): string {
  return `${x.toFixed(2)}x`;
}

function insuredText(p: PolicyInput): string {
  const pool = p.poolHealthy ? "pool healthy" : "pool under strain";
  return `yes · policy v${p.version} · cap ${usd(p.capUsd)} · ${pool}`;
}

function drivingText(d: DrivingInput): string {
  const parts = [`${d.score}/100`, `${d.cleanDays}-day clean streak`];
  if (d.premiumMultiplier !== undefined) {
    parts.push(`premium ${multiplier(d.premiumMultiplier)}`);
  }
  return parts.join(" · ");
}

function claimsText(c: ClaimsInput): string {
  const parts: string[] = [];
  if (c.covered > 0) {
    const total = c.payoutsUsd.reduce((a, b) => a + b, 0);
    parts.push(
      total > 0
        ? `${c.covered} covered (${usd(total)})`
        : `${c.covered} covered`,
    );
  } else {
    parts.push("0 covered");
  }
  parts.push(c.attempted > 0 ? `${c.attempted} attempted (frozen, no loss)` : "0 attempted");
  return parts.join(" · ");
}

function alibiText(a: AlibiInput): string {
  if (!a.installed) return "not installed";
  return a.instructionChainLive
    ? "installed (instruction chain live)"
    : "installed (instruction chain not yet live)";
}

function backingText(b: BackingInput): string {
  return b.worldIdVerified ? "World-ID verified human" : "unverified backing";
}

/**
 * Build the §13 résumé. Deterministic: same input, same résumé, forever.
 *
 * Provenance: INSURED/CLAIMS/ALIBI/BACKING/STATUS are VERIFIED (read from
 * signed, public, on-chain state). DRIVING is COMPUTED — the premium
 * multiplier is pricing-formula output, so the whole line carries the
 * weaker (COMPUTED) label rather than over-claiming.
 */
export function buildResume(input: ResumeInput): Resume {
  return {
    INSURED: {
      key: "INSURED",
      text: insuredText(input.policy),
      provenance: "VERIFIED",
    },
    DRIVING: {
      key: "DRIVING",
      text: drivingText(input.driving),
      provenance: "COMPUTED",
    },
    CLAIMS: {
      key: "CLAIMS",
      text: claimsText(input.claims),
      provenance: "VERIFIED",
    },
    ALIBI: {
      key: "ALIBI",
      text: alibiText(input.alibi),
      provenance: "VERIFIED",
    },
    BACKING: {
      key: "BACKING",
      text: backingText(input.backing),
      provenance: "VERIFIED",
    },
    STATUS: {
      key: "STATUS",
      text: input.status,
      provenance: "VERIFIED",
    },
  };
}

/**
 * Render the résumé as the §13 terminal block — the `resolve` output.
 * Provenance labels ride along in brackets, plan §9 style.
 */
export function renderResume(resume: Resume): string {
  const width = Math.max(...FIELD_ORDER.map((k) => FIELD_LABEL[k].length));
  return FIELD_ORDER.map((k) => {
    const f = resume[k];
    const label = FIELD_LABEL[k].padEnd(width, " ");
    return `${label}: ${f.text} [${f.provenance}]`;
  }).join("\n");
}

/**
 * Flatten to ENS text records: one `com.bulwark.*` key per field, value is
 * "text [PROVENANCE]" so the label travels with the string on-chain.
 */
export function toEnsTextRecords(resume: Resume): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FIELD_ORDER) {
    const f = resume[k];
    out[ENS_TEXT_KEY[k]] = `${f.text} [${f.provenance}]`;
  }
  return out;
}

/** Parse a text-record value ("text [PROVENANCE]") back into a labeled field. */
export function parseEnsTextValue(value: string): { text: string; provenance: Provenance } {
  const m = /^(.*) \[(VERIFIED|COMPUTED)\]$/.exec(value.trim());
  if (!m || m[1] === undefined) return { text: value.trim(), provenance: "COMPUTED" };
  return { text: m[1], provenance: m[2] as Provenance };
}

/** Rebuild a Resume-shaped view from resolved ENS text records (resolve path). */
export function fromEnsTextRecords(
  records: Record<string, string>,
): Partial<Record<FieldKey, { text: string; provenance: Provenance }>> {
  const out: Partial<Record<FieldKey, { text: string; provenance: Provenance }>> = {};
  for (const k of FIELD_ORDER) {
    const raw = records[ENS_TEXT_KEY[k]];
    if (raw !== undefined && raw !== "") out[k] = parseEnsTextValue(raw);
  }
  return out;
}

export { FIELD_ORDER, FIELD_LABEL, ENS_TEXT_KEY };
