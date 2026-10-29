import { assert } from "chai";

import { oneToken, tokenBalance } from "../helpers";
import { PoolFixture, setupPool } from "./fixture";
import { addRewards, claim, stake, unstake } from "./actions";

describe("04-rewards-without-a-loop", () => {
  let env: PoolFixture;

  beforeEach(async () => {
    env = await setupPool();
  });

  it("splits a reward between three stakers in proportion to their stake", async () => {
    const [a, b, c] = env.stakers;
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(300));
    await stake(env, c, oneToken().muln(600));
    const before = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );

    await addRewards(env, oneToken().muln(100));
    await claim(env, a);
    await claim(env, b);
    await claim(env, c);

    const after = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );
    assert.equal(
      (after[0] - before[0]).toString(),
      oneToken().muln(10).toString(),
    );
    assert.equal(
      (after[1] - before[1]).toString(),
      oneToken().muln(30).toString(),
    );
    assert.equal(
      (after[2] - before[2]).toString(),
      oneToken().muln(60).toString(),
    );
  });

  it("three stakers with rewards arriving between their actions, paid in whatever order they claim", async () => {
    const [a, b, c] = env.stakers;

    // Staker A stakes 100 tokens (pool total = 100)
    await stake(env, a, oneToken().muln(100));

    // Reward 1: 50 tokens arrives (A owns 100% -> earns 50)
    await addRewards(env, oneToken().muln(50));

    // Staker B stakes 100 tokens (pool total = 200)
    await stake(env, b, oneToken().muln(100));

    // Reward 2: 100 tokens arrives (A has 50% -> earns 50, B has 50% -> earns 50)
    await addRewards(env, oneToken().muln(100));

    // Staker C stakes 200 tokens (pool total = 400)
    await stake(env, c, oneToken().muln(200));

    // Reward 3: 200 tokens arrives:
    // A: 100/400 (25%) -> earns 50
    // B: 100/400 (25%) -> earns 50
    // C: 200/400 (50%) -> earns 100
    await addRewards(env, oneToken().muln(200));

    // Balances before claiming
    const beforeA = await tokenBalance(env.context, a.tokens);
    const beforeB = await tokenBalance(env.context, b.tokens);
    const beforeC = await tokenBalance(env.context, c.tokens);

    // Claim in reverse order: C first, then B, then A
    await claim(env, c);
    await claim(env, b);
    await claim(env, a);

    const afterA = await tokenBalance(env.context, a.tokens);
    const afterB = await tokenBalance(env.context, b.tokens);
    const afterC = await tokenBalance(env.context, c.tokens);

    // A earned: 50 + 50 + 50 = 150
    assert.equal(
      (afterA - beforeA).toString(),
      oneToken().muln(150).toString(),
    );
    // B earned: 50 + 50 = 100
    assert.equal(
      (afterB - beforeB).toString(),
      oneToken().muln(100).toString(),
    );
    // C earned: 100
    assert.equal(
      (afterC - beforeC).toString(),
      oneToken().muln(100).toString(),
    );
  });

  it("a deposit does not change what was owed before it", async () => {
    const [a, b] = env.stakers;

    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(100));

    // Reward 1: 100 tokens (50 owed to A, 50 owed to B)
    await addRewards(env, oneToken().muln(100));

    // Staker A deposits another 100 tokens.
    // This must settle what A is owed BEFORE the stake changes.
    await stake(env, a, oneToken().muln(100));

    // A claims immediately before any new rewards arrive.
    // A must receive exactly the 50 tokens earned from period 1.
    const beforeClaimA = await tokenBalance(env.context, a.tokens);
    await claim(env, a);
    const afterClaimA = await tokenBalance(env.context, a.tokens);
    assert.equal(
      (afterClaimA - beforeClaimA).toString(),
      oneToken().muln(50).toString(),
    );

    // Reward 2: 300 tokens arrives.
    // Pool total = 300 (A has 200, B has 100).
    // A earns: 200 / 300 * 300 = 200.
    // B earns: 100 / 300 * 300 = 100.
    await addRewards(env, oneToken().muln(300));

    // A claims reward 2
    const beforeClaimA2 = await tokenBalance(env.context, a.tokens);
    await claim(env, a);
    const afterClaimA2 = await tokenBalance(env.context, a.tokens);
    assert.equal(
      (afterClaimA2 - beforeClaimA2).toString(),
      oneToken().muln(200).toString(),
    );

    // B claims everything (period 1 + period 2 = 50 + 100 = 150)
    const beforeClaimB = await tokenBalance(env.context, b.tokens);
    await claim(env, b);
    const afterClaimB = await tokenBalance(env.context, b.tokens);
    assert.equal(
      (afterClaimB - beforeClaimB).toString(),
      oneToken().muln(150).toString(),
    );
  });

  it("a staker who claims last after everyone else receives the exact right amount", async () => {
    const [a, b, c] = env.stakers;

    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(100));
    await stake(env, c, oneToken().muln(100));
    // Pool total = 300

    // Round 1: 90 tokens reward (30 each)
    await addRewards(env, oneToken().muln(90));

    // A claims and partially unstakes 50 tokens (A now has 50)
    await claim(env, a);
    await unstake(env, a, oneToken().muln(50));
    // Pool total = 250 (A: 50, B: 100, C: 100)

    // Round 2: 100 tokens reward
    // A: 50/250 * 100 = 20
    // B: 100/250 * 100 = 40
    // C: 100/250 * 100 = 40
    await addRewards(env, oneToken().muln(100));

    // B claims and fully unstakes (B now has 0)
    await claim(env, b);
    await unstake(env, b, oneToken().muln(100));
    // Pool total = 150 (A: 50, B: 0, C: 100)

    // Round 3: 150 tokens reward
    // A: 50/150 * 150 = 50
    // C: 100/150 * 150 = 100
    await addRewards(env, oneToken().muln(150));

    // A claims remaining rewards and fully unstakes
    await claim(env, a);
    await unstake(env, a, oneToken().muln(50));
    // Pool total = 100 (only C is left)

    // Staker C sat completely untouched through all actions.
    // Total owed to C: Round 1 (30) + Round 2 (40) + Round 3 (100) = 170 tokens.
    const beforeClaimC = await tokenBalance(env.context, c.tokens);
    await claim(env, c);
    const afterClaimC = await tokenBalance(env.context, c.tokens);
    assert.equal(
      (afterClaimC - beforeClaimC).toString(),
      oneToken().muln(170).toString(),
    );

    // C unstakes original 100 tokens
    await unstake(env, c, oneToken().muln(100));
    const finalBalanceC = await tokenBalance(env.context, c.tokens);
    assert.equal(
      (finalBalanceC - afterClaimC).toString(),
      oneToken().muln(100).toString(),
    );

    // Vault should be empty
    const vaultBal = await tokenBalance(env.context, env.vault);
    assert.equal(vaultBal.toString(), "0");
  });

  it("cannot add rewards when total_staked is zero", async () => {
    try {
      await addRewards(env, oneToken().muln(100));
      assert.fail("Should have failed with NothingStaked");
    } catch (err: any) {
      assert.match(err.message, /NothingStaked|0x1772/);
    }
  });
});
