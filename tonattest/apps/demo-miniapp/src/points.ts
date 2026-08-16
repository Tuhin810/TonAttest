/**
 * The app's own reward ledger.
 *
 * Deliberately trivial and in-memory: the point of the demo is that the reward
 * is entirely the app's business. The verification service never holds funds,
 * never awards anything, and does not know what a "point" is.
 */
export interface Award {
  readonly telegramUserId: string;
  readonly wallet: string;
  readonly points: number;
  readonly awardedAt: number;
  readonly nonce: string;
}

export class PointsLedger {
  readonly #balances = new Map<string, number>();
  readonly #spentNonces = new Set<string>();
  readonly #awards: Award[] = [];

  /**
   * Awards points for an attestation, once.
   *
   * The nonce check is the app's responsibility, and it is not optional: an
   * attestation is a bearer artifact, valid until it expires. Without
   * recording spent nonces, a user can replay one until then and collect the
   * reward repeatedly.
   */
  award(params: {
    telegramUserId: string;
    wallet: string;
    nonce: string;
    points: number;
    now: number;
  }): { awarded: boolean; reason?: string; balance: number } {
    const balance = this.#balances.get(params.telegramUserId) ?? 0;

    if (this.#spentNonces.has(params.nonce)) {
      return { awarded: false, reason: "This proof has already been redeemed", balance };
    }

    this.#spentNonces.add(params.nonce);
    const updated = balance + params.points;
    this.#balances.set(params.telegramUserId, updated);
    this.#awards.push({
      telegramUserId: params.telegramUserId,
      wallet: params.wallet,
      points: params.points,
      awardedAt: params.now,
      nonce: params.nonce,
    });

    return { awarded: true, balance: updated };
  }

  balanceOf(telegramUserId: string): number {
    return this.#balances.get(telegramUserId) ?? 0;
  }

  historyOf(telegramUserId: string): readonly Award[] {
    return this.#awards.filter((award) => award.telegramUserId === telegramUserId);
  }
}
