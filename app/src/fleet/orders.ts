/**
 * The browser's order store. The service keeps no orders, so this is the only
 * record of a fleet buy: the signed order, its slices, and what became of each.
 *
 * The one rule that matters: a slice is marked *sent* before the request goes
 * out. If the reply is lost, that slice becomes "unconfirmed" and is never sent
 * again; it is settled later against what the fleet's draw actually spent.
 * That is what keeps a slice from running twice across service instances.
 */

export type WireOrder = {
  id: string;
  campaign: string;
  token: string;
  totalWei: string;
  wallets: string[];
  entropy: string;
  windowMs: number;
  createdAt: string;
  owner: string;
};

export type SliceState = "pending" | "sent" | "sponsored" | "rejected" | "failed" | "unconfirmed";

export type SliceRecord = {
  index: number;
  wallet: string;
  amountWei: string;
  dueAt: string;
  state: SliceState;
  attempts: number;
  txHash?: string;
  reason?: string;
};

export type OrderRecord = {
  order: WireOrder;
  symbol: string;
  slices: SliceRecord[];
  cancelled: boolean;
  placedAt: string;
  /** The fleet's remaining draw when slices were last sent; a lost reply is reconciled against its change. */
  remainingAtSend?: string;
};

export type OrderStore = {
  list(): OrderRecord[];
  get(id: string): OrderRecord | undefined;
  add(record: OrderRecord): void;
  update(id: string, fn: (record: OrderRecord) => OrderRecord): void;
};

/** One send plus two retries. */
export const MAX_ATTEMPTS = 3;

const retryable = (slice: SliceRecord): boolean =>
  (slice.state === "pending" || slice.state === "rejected") && slice.attempts < MAX_ATTEMPTS;

export const pendingIndices = (record: OrderRecord): number[] =>
  record.cancelled ? [] : record.slices.filter(retryable).map((slice) => slice.index);

const withSlices = (record: OrderRecord, map: (slice: SliceRecord) => SliceRecord): OrderRecord => ({
  ...record,
  slices: record.slices.map(map),
});

export const markSent = (record: OrderRecord, indices: number[]): OrderRecord => {
  const chosen = new Set(indices);
  return withSlices(record, (slice) =>
    chosen.has(slice.index) && retryable(slice) ? { ...slice, state: "sent", attempts: slice.attempts + 1 } : slice,
  );
};

export type ExecutedSlice = { index: number; status: string; txHash?: string; userOpHash?: string; reason?: string };

export const applyResults = (record: OrderRecord, executed: ExecutedSlice[]): OrderRecord => {
  const byIndex = new Map(executed.map((entry) => [entry.index, entry]));
  return withSlices(record, (slice) => {
    const result = byIndex.get(slice.index);
    if (result) {
      if (result.status === "sponsored") {
        const hash = result.txHash ?? result.userOpHash;
        return { ...slice, state: "sponsored", ...(hash ? { txHash: hash } : {}) };
      }
      return {
        ...slice,
        state: slice.attempts < MAX_ATTEMPTS ? "rejected" : "failed",
        ...(result.reason ? { reason: result.reason } : {}),
      };
    }
    // Sent, but the service ran nothing for it: it was not due yet. Nothing
    // happened, so it may be sent again.
    return slice.state === "sent" ? { ...slice, state: "pending" } : slice;
  });
};

export const markUnconfirmed = (record: OrderRecord, indices: number[]): OrderRecord => {
  const chosen = new Set(indices);
  return withSlices(record, (slice) =>
    chosen.has(slice.index) && slice.state === "sent" ? { ...slice, state: "unconfirmed" } : slice,
  );
};

/**
 * Settles unconfirmed slices against how much the draw's spend grew: the
 * smallest slices are credited first while their sum fits, the rest failed.
 * Conservative on purpose: it never credits more than the chain shows.
 */
export const reconcile = (record: OrderRecord, spentDeltaWei: string): OrderRecord => {
  let budget = BigInt(spentDeltaWei);
  const credited = new Set<number>();
  for (const slice of [...record.slices]
    .filter((slice) => slice.state === "unconfirmed")
    .sort((a, b) => (BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1))) {
    if (BigInt(slice.amountWei) <= budget) {
      budget -= BigInt(slice.amountWei);
      credited.add(slice.index);
    }
  }
  return withSlices(record, (slice) =>
    slice.state !== "unconfirmed" ? slice : credited.has(slice.index) ? { ...slice, state: "sponsored" } : { ...slice, state: "failed" },
  );
};

export const progress = (record: OrderRecord): { done: number; total: number; nextDueAt: string | undefined; finished: boolean } => {
  const done = record.slices.filter((slice) => slice.state === "sponsored").length;
  const pending = pendingIndices(record);
  const nextDueAt = record.slices
    .filter((slice) => pending.includes(slice.index))
    .map((slice) => slice.dueAt)
    .sort()[0];
  const inFlight = record.slices.some((slice) => slice.state === "sent" || slice.state === "unconfirmed");
  return { done, total: record.slices.length, nextDueAt, finished: record.cancelled || (pending.length === 0 && !inFlight) };
};

export const createOrderStore = (storage: Storage, owner: string): OrderStore => {
  const key = `chit-orders:${owner.toLowerCase()}`;
  const read = (): OrderRecord[] => {
    try {
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as OrderRecord[]) : [];
    } catch {
      return [];
    }
  };
  const write = (records: OrderRecord[]): void => storage.setItem(key, JSON.stringify(records));
  return {
    list: () => read(),
    get: (id) => read().find((record) => record.order.id.toLowerCase() === id.toLowerCase()),
    add: (record) => write([record, ...read()]),
    update: (id, fn) => write(read().map((record) => (record.order.id.toLowerCase() === id.toLowerCase() ? fn(record) : record))),
  };
};
