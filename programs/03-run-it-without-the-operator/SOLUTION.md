# Solution

## Why the caller does not matter

In `claim`, the recipient of the reward is strictly constrained to the token account owned by the user (`user_tokens`, verified via Anchor constraints `seeds = [b"user", user.owner.as_ref()]` and `token::authority = user.owner`). Regardless of which wallet signs and submits the transaction, the program enforces the exact same state transitions:
1. It reads the accrued rewards from `user.pending`.
2. It resets `user.pending` to 0 immediately (preventing duplicate claims).
3. It routes the user's portion of the payout directly to `user_tokens`.

The caller acts solely as an untrusted executor (or crank) whose identity only determines the destination of the caller fee (`caller_tokens`). If the primary reward were paid to the caller instead of the user:
- The protocol would suffer from severe MEV and front-running vulnerabilities. Arbitrary searchers or malicious actors would monitor the mempool or pending states to steal user rewards before the user or honest bots could execute the transaction.
- By inverting the operator role and decoupling transaction submission from reward entitlement, the user is guaranteed to receive their tokens while anyone can permissionlessly trigger the settlement.

## The caller's fee

The caller's fee is designed to incentivize third-party crank bots to execute claims on behalf of users without requiring the team to operate dedicated servers:
- **What it covers:** The fee must cover the baseline Solana network transaction fee (5,000 lamports), potential priority fees required for reliable inclusion during network congestion, and the ongoing operational overhead of running crank bots (RPC subscriptions, node hosting, capital costs), plus a small profit margin.
- **How it is sized:** The fee is sized proportionally at 1% (100 basis points) of the pending reward (`amount * 100 / 10_000`). For a typical reward payout of 100 tokens, a 1% fee equals 1 whole token ($1 \times 10^6$ base units), which exceeds the transaction cost by orders of magnitude at standard token valuations. If the user executes the claim for themselves (`caller == user.owner`), no fee is deducted (`fee = 0`), giving self-claiming users 100% of their rewards.
- **How it is capped:** To protect users during large reward distributions from paying an excessive fee for a constant-cost transaction, the caller fee is hard-capped at 5 whole tokens (`MAX_CALLER_FEE = 5_000_000` base units). This ensures the crank bot is generously compensated for its transaction overhead while preserving the vast majority of the rewards for the user.

## The price

- **Who brings the price:** Rather than relying on a centralized team bot pushing periodic updates on-chain, the price is now supplied via a pull oracle model. Whoever executes a trade or needs the price (e.g. the buyer or any permissionless caller) fetches the latest signed price off-chain and bundles an Ed25519 signature verification pre-instruction immediately preceding `set_price` within the same transaction.
- **What the program checks:** 
  1. It reads the instructions sysvar to locate the instruction immediately before `set_price` (`current_index - 1`).
  2. It verifies that the preceding instruction was executed by the native `Ed25519Program`.
  3. It parses the Ed25519 instruction to extract the signing public key and signed message payload using `parse_ed25519`.
  4. It enforces that `signed.pubkey == config.oracle`, ensuring only updates authorized by the designated oracle key can set the price.
  5. It deserializes the price and timestamp from the message.
  6. It checks freshness against the cluster clock: `now >= publish_time - 5 && now - publish_time <= config.max_price_age`.
- **When the update is too old:** If the timestamp is older than `config.max_price_age`, the transaction immediately reverts with `RewardsError::StalePrice`. The stale price is rejected, ensuring users and buyers can only trade on fresh, authentic data.

## Elimination of operator paths

All operator paths have been completely eliminated from the protocol:
1. **Old admin payout path (`pay_reward`):** Completely removed. Payouts no longer require an admin server or private key. Any user or third-party crank can invoke `claim` permissionlessly.
2. **Old team bot pricing path (`set_price`):** The old permissioned `set_price` instruction requiring a `bot` signature was eliminated. The `bot` key stored in `Config` has zero privileges and cannot set prices. `set_price` is now a permissionless pull instruction requiring an Ed25519 signature from `config.oracle` passed in the same transaction.
3. **No operator remains:** Zero off-chain team servers or bots are required for users to receive rewards or trade against the vault.

## What stays with the admin

Only two administrative actions retain admin-signer requirements:
1. `initialize`: Called exactly once during protocol deployment to configure the mint, vault, admin, oracle public key, and `max_price_age`.
2. `accrue`: Only the protocol admin can credit new rewards to user accounts (`user.pending += amount`), because rewards represent protocol liabilities and token allocations originating from the protocol treasury.

Why this is acceptable:
- Admin authority is strictly confined to treasury allocation and initial configuration.
- Neither operational reward distribution (`claim`) nor market pricing and trading (`set_price`, `buy`) depend on the admin's key or the team's bot.
- If the admin server or bot permanently stops running, all accrued rewards remain fully claimable by users and third-party cranks, and trading can continue permissionlessly using fresh oracle signatures.
