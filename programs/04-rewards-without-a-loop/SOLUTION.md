# Solution

## The two numbers

### What does the pool store?
The pool stores:
1. `total_staked: u64`: The total amount of tokens currently staked across all participants.
2. `reward_per_token: u128`: The global accumulator representing the cumulative rewards distributed per unit of staked token since the pool's inception. To avoid truncation of small reward distributions across large total stakes, this value is scaled by a high-precision constant:
   $$\text{PRECISION} = 10^{18}$$

Whenever a reward `amount` is added to the pool while `total_staked > 0`, the pool increments:
$$\Delta R = \frac{\text{amount} \times 10^{18}}{\text{total\_staked}}$$
$$\text{pool.reward\_per\_token} \leftarrow \text{pool.reward\_per\_token} + \Delta R$$

### What does each staker store?
Each staker account stores:
1. `stake: u64`: The staker's current staked token balance.
2. `reward_per_token_paid: u128`: A snapshot of `pool.reward_per_token` at the time the staker was last settled.
3. `pending: u64`: The total accrued rewards credited from earlier intervals that have not yet been claimed.

### What is the formula for the amount a staker is owed?
At any given moment, the total reward amount owed to a staker is:
$$\text{owed} = \text{pending} + \frac{\text{stake} \times (\text{pool.reward\_per\_token} - \text{staker.reward\_per\_token\_paid})}{\text{PRECISION}}$$

Whenever the staker interacts with the pool (`stake`, `unstake`, or `claim`), the accrued difference since their last settlement is computed, added to `pending`, and `reward_per_token_paid` is brought up to date with `pool.reward_per_token`.

---

## Settle first

### Why settle before changing the stake?
The accumulator difference $(\text{pool.reward\_per\_token} - \text{staker.reward\_per\_token\_paid})$ captures the rewards distributed over the past interval, during which the staker's active deposit was strictly `staker.stake`.

If the program modified `staker.stake` *before* settling, the rewards distributed over that past interval would be calculated using the *new* stake instead of the stake that was actually present while those rewards accrued:
- If a staker deposits more tokens and you change the stake first, they retroactively earn rewards on newly deposited funds that were not present when the rewards were distributed.
- If a staker withdraws tokens and you reduce the stake first, they forfeit rewards they legitimately earned on the withdrawn funds while they were staked.

### Numerical demonstration
Consider a pool where:
- Total staked = 1,000 tokens.
- Alice has 100 tokens staked (10% of the pool).
- A reward of 100 tokens arrives. $\Delta R = \frac{100 \times 10^{18}}{1000} = 0.1 \times 10^{18}$.
- Alice is legitimately owed $100 \times 0.1 = 10$ tokens for this period.

#### Scenario A: Alice deposits an additional 100 tokens
- **Correct order (settle first):**
  1. Settle: $\text{accrued} = \frac{100 \times 0.1 \times 10^{18}}{10^{18}} = 10$ tokens added to `pending`. `reward_per_token_paid` is updated.
  2. Increase stake: Alice's stake becomes 200 tokens.
  3. Result: Alice is owed exactly **10 tokens** for the prior period.
- **Wrong order (change stake first):**
  1. Increase stake: Alice's stake becomes 200 tokens first.
  2. Settle: $\text{accrued} = \frac{200 \times 0.1 \times 10^{18}}{10^{18}} = 20$ tokens.
  3. Result: Alice steals **20 tokens**—claiming double the reward she actually earned.

#### Scenario B: Alice unstakes 50 tokens
- **Correct order (settle first):**
  1. Settle: Alice receives credit for her full **10 tokens** earned while holding 100 tokens staked.
  2. Reduce stake: Alice's stake becomes 50 tokens.
- **Wrong order (change stake first):**
  1. Reduce stake: Alice's stake becomes 50 tokens first.
  2. Settle: $\text{accrued} = \frac{50 \times 0.1 \times 10^{18}}{10^{18}} = 5$ tokens.
  3. Result: Alice loses **5 tokens** of legitimate earnings. If she had unstaked 100% of her balance (stake becomes 0), she would receive **0 tokens**, forfeiting all her rewards.

---

## The staker nobody touches

### What happens to a staker who never claims while rewards keep arriving?
Nothing touches their on-chain account. No transaction loads, reads, writes, or expends compute units or rent on their `Staker` account. Their account remains completely passive.

### Why is their amount still right when they come?
The pool's cumulative `reward_per_token` is the sum of every individual reward delta that occurred across all reward events $1 \dots n$:
$$\text{pool.reward\_per\_token}_{\text{now}} = \text{staker.reward\_per\_token\_paid} + \sum_{i=1}^n \Delta R_i$$

Because multiplication and division distribute over addition:
$$\sum_{i=1}^n \left( \frac{S \times \Delta R_i}{\text{PRECISION}} \right) = \frac{S \times \sum_{i=1}^n \Delta R_i}{\text{PRECISION}} = \frac{S \times (\text{pool.reward\_per\_token}_{\text{now}} - \text{staker.reward\_per\_token\_paid})}{\text{PRECISION}}$$

As long as the staker's stake $S$ was constant throughout that entire duration, evaluating this single multiplication and subtraction upon their return produces the exact mathematical total of what they would have received had their account been updated after each individual reward.

---

## What lazy loading does not cover

### An action that cannot wait for the owner to show up
**Slashing / Liquidation / Forced unbonding of an insolvent or delinquent participant.**

In protocols with collateral requirements, validator penalties, or loan-to-value health thresholds (e.g., lending money markets, proof-of-stake validator pools, or bounded prediction rounds):
- An underwater borrower or a slashed validator has an active financial incentive **never** to show up or call the contract, because settling would trigger a penalty, confiscate collateral, or realize bad debt.
- The protocol cannot afford to leave toxic debt or slashing unexecuted until the owner decides to interact.

### What the design needs for it
The protocol requires a **permissionless keeper / crank mechanism with economic incentives (paid executor)**:
1. **Permissionless trigger:** Any third party (keeper, searcher, bot) can invoke the liquidation/slashing instruction and pass the target account.
2. **Execution fee / Liquidation bounty:** The protocol compensates the executor with a portion of the liquidated collateral or a dedicated execution bounty (e.g., 1–5% of the debt or a gas reimbursement fee), turning protocol maintenance into a competitive market that ensures timely execution.
