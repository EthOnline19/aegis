/**
 * REPAYD x402 Pricing Meter — per-endpoint, pay-per-call pricing.
 *
 * Every gated endpoint of the Coverage & Risk API carries an exact tinybar
 * price (the fee schedule). The meter counts served calls per endpoint so
 * pay-per-call usage is observable, not just claimed.
 */

/** The gated endpoints of the service. */
export type EndpointId = "quote" | "verdicts" | "resume";

/** 1 HBAR = 10^8 tinybars. */
export const TINYBARS_PER_HBAR = 100_000_000n;

export interface EndpointPricing {
  readonly id: EndpointId;
  /** Full route pattern, e.g. "/v1/x402/quote". */
  readonly route: string;
  /** What the endpoint returns (surfaced in the 402 + directory). */
  readonly description: string;
  readonly mimeType: "application/json";
  /** Exact price in tinybars (HBAR asset 0.0.0). */
  readonly priceTinybars: bigint;
}

/**
 * The fee schedule: pay-per-call metering with a per-endpoint price.
 * Prices are tinybars of native HBAR (asset "0.0.0").
 */
export const ENDPOINT_PRICING: Readonly<Record<EndpointId, EndpointPricing>> = {
  quote: {
    id: "quote",
    route: "/v1/x402/quote",
    description: "REPAYD live risk quote — deterministic premium multiplier + monthly premium from the driving record",
    mimeType: "application/json",
    priceTinybars: 100_000n, // 0.001 HBAR
  },
  verdicts: {
    id: "verdicts",
    route: "/v1/x402/verdicts",
    description: "REPAYD ERC-8004-mirrored verdict record by digest (risk + outcome + payout)",
    mimeType: "application/json",
    priceTinybars: 200_000n, // 0.002 HBAR
  },
  resume: {
    id: "resume",
    route: "/v1/x402/resume",
    description: "REPAYD agent résumé block (ENSv2 record shape) by ENS name",
    mimeType: "application/json",
    priceTinybars: 150_000n, // 0.0015 HBAR
  },
};

/** Price as the x402 `AssetAmount` shape: { asset: "0.0.0", amount: "<tinybars>" }. */
export function assetAmount(id: EndpointId): { asset: "0.0.0"; amount: string } {
  return { asset: "0.0.0", amount: ENDPOINT_PRICING[id].priceTinybars.toString() };
}

/** Human-readable price, e.g. "0.001 HBAR". */
export function priceLabel(id: EndpointId): string {
  const hbar = Number(ENDPOINT_PRICING[id].priceTinybars) / Number(TINYBARS_PER_HBAR);
  return `${hbar} HBAR`;
}

/**
 * The call meter. One instance per service process; counts served
 * (i.e. paid-for) calls per endpoint. Exposed on /healthz.
 */
export class CallMeter {
  #counts: Record<EndpointId, number> = { quote: 0, verdicts: 0, resume: 0 };
  #tinybars: Record<EndpointId, bigint> = { quote: 0n, verdicts: 0n, resume: 0n };

  /** Record one served call. */
  record(id: EndpointId): void {
    this.#counts[id] += 1;
    this.#tinybars[id] += ENDPOINT_PRICING[id].priceTinybars;
  }

  /** Snapshot: per-endpoint served-call counts and billed tinybars. */
  snapshot(): {
    counts: Record<EndpointId, number>;
    billedTinybars: Record<EndpointId, bigint>;
    totalTinybars: bigint;
  } {
    const total =
      this.#tinybars.quote + this.#tinybars.verdicts + this.#tinybars.resume;
    return {
      counts: { ...this.#counts },
      billedTinybars: { ...this.#tinybars },
      totalTinybars: total,
    };
  }
}
