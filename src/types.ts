/** One pay-link option: a coin the streamer accepts and their own receiving address. */
export interface PayOption {
  currency: string;
  network: string;
  address: string;
  method?: string;
}

export interface Streamer {
  id: string;
  name: string;
  emoji: string;
  currency: string;
  /** Minor units. */
  presets: number[];
  min: number;
  max: number;
  /** Minor units: amount ≥ medium → medium alert, ≥ big → 🎉 confetti. */
  tiers: { medium: number; big: number };
  goal: Goal;
  nameMax: number;
  messageMax: number;
}

export interface Goal {
  label: string;
  emoji: string;
  /** Minor units. */
  target: number;
  /** Tips paid since this time count toward the goal. */
  since: string;
}

export type TipStatus =
  | "open" // ⏳ pay link out
  | "seen" // 👀 on its way
  | "review" // ⚠️ different amount, the streamer decides on send21
  | "accepted" // 👍 accepted, waiting for draft.confirmed
  | "paid" // ✅ alert queued (or held)
  | "declined" // ↩️ no alert
  | "unresolved" // 🚩 expired undecided: no alert
  | "expired" // ⌛ no alert
  | "flagged"; // 🚩 confirmed but does not match: never on stream

export interface Tip {
  /** Random 12 × [a-z0-9]. orderId on send21 is tip-<id>, also the Idempotency-Key. */
  id: string;
  orderId: string;
  /** Minor units. */
  amount: number;
  currency: string;
  name: string;
  message: string;
  options: PayOption[];
  status: TipStatus;
  paymentRequestId: string | null;
  payUrl: string | null;
  expiresAt: string | null;
  /** sha256 of the viewer's status-page key. */
  keyHash: string;
  paid?: { currency: string; network: string; txId: string; late: boolean; at: string };
  problems?: string[];
  createdAt: string;
  updatedAt: string;
}

export type Tier = "small" | "medium" | "big";

export type AlertState =
  | "held" // 🛡️ waiting for the streamer (moderation on, or a late payment)
  | "queued" // ⏳ waiting for the overlay
  | "shown" // ✅ the overlay played it and acked
  | "skipped"; // ⏭️ never shown

export interface Alert {
  /** Increasing number, also the overlay's ack id. */
  seq: number;
  tipId: string | null;
  test: boolean;
  name: string;
  message: string;
  amount: number;
  currency: string;
  tier: Tier;
  state: AlertState;
  /** Queue order: oldest first. A replay moves it to the end. */
  queuedAt: string;
  /** An overlay has it on screen until then; another poll will not get it meanwhile. */
  leaseUntil?: number;
  shownAt?: string;
  createdAt: string;
}
