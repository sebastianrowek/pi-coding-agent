/**
 * Shared spend pool for one rlm_query tool call. The investigator loop and all
 * analyst RPC handlers hold the same instance; Phase 5 hands it to nested
 * investigations unchanged ("children get whatever the parent has left" falls
 * out for free — there is only one pool).
 *
 * Contract: check exhausted() before launching a model call, add() after it
 * completes. A call already in flight when the budget trips is allowed to
 * finish and may overshoot maxUsd.
 */
export class BudgetTracker {
	readonly maxUsd: number;
	/** Backstop for models whose registry entry has no cost metadata (cost.total == 0). */
	readonly maxCalls: number;
	private spent = 0;
	private calls = 0;

	constructor(maxUsd: number, maxCalls: number) {
		this.maxUsd = maxUsd;
		this.maxCalls = maxCalls;
	}

	get spentUsd(): number {
		return this.spent;
	}

	get callCount(): number {
		return this.calls;
	}

	get remainingUsd(): number {
		return Math.max(0, this.maxUsd - this.spent);
	}

	exhausted(): boolean {
		return this.spent >= this.maxUsd || this.calls >= this.maxCalls;
	}

	/** Charge one completed model call. Still records after exhaustion so overshoot stays visible. */
	add(costUsd: number): void {
		this.spent += costUsd;
		this.calls += 1;
	}
}
