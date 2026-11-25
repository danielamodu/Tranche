import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { MULTICALL3_ADDRESS, NETWORKS } from "@/config/networks";
import { getNetworkTokens, getTokenMeta } from "@/config/tokens";
import {
  ACTIVITY_EVENTS,
  ACTIVITY_LOOKBACK_BLOCKS,
  COMMITMENT_MANAGER_ABI,
  MULTICALL_CHUNK_SIZE,
  chunkedMulticall,
  decodeQuoteExerciseResult,
  decodeQuoteReservationResult,
  fetchAllOffers,
  fetchRecentActivity,
  tranchePublicClient,
} from "@/lib/protocol";

test("ABI: CommitmentManager exposes getOffer/getTicket and accurate quote/event signatures", () => {
  const fnNames = COMMITMENT_MANAGER_ABI.filter((item) => item.type === "function").map(
    (item) => item.name,
  );
  assert.ok(fnNames.includes("getOffer"), "must include getOffer");
  assert.ok(fnNames.includes("getTicket"), "must include getTicket");
  assert.ok(!fnNames.includes("offers"), "must NOT include nonexistent offers()");
  assert.ok(!fnNames.includes("tickets"), "must NOT include nonexistent tickets()");

  // Verify selectors match Solidity signatures
  const getOfferCalldata = encodeFunctionData({
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "getOffer",
    args: [1n],
  });
  assert.equal(getOfferCalldata.slice(0, 10), keccak256(toHex("getOffer(uint64)")).slice(0, 10));

  const getTicketCalldata = encodeFunctionData({
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "getTicket",
    args: [1n],
  });
  assert.equal(getTicketCalldata.slice(0, 10), keccak256(toHex("getTicket(uint256)")).slice(0, 10));

  // Verify 2-tuple quoteReservation decoding
  const resQuote = decodeQuoteReservationResult([1_000_000n, 500n]);
  assert.equal(resQuote.grossPremium, 1_000_000n);
  assert.equal(resQuote.protocolFee, 500n);
  assert.equal(resQuote.lpNetPremium, 999_500n);

  // Verify 3-tuple quoteExercise decoding (actualFill, grossPayment, effPriceX36)
  const exQuote = decodeQuoteExerciseResult([200_000_000_000_000_000_000n, 17_000_000n, 85_000_000_000_000_000_000_000n]);
  assert.equal(exQuote.actualFill, 200_000_000_000_000_000_000n);
  assert.equal(exQuote.grossPayment, 17_000_000n);
  assert.equal(exQuote.effectivePriceX36, 85_000_000_000_000_000_000_000n);
});

test("ABI: TicketExercised event decodes exact Solidity fields (ticketId, exerciser, receiver, fillAmount, grossPayment, effPriceX36)", () => {
  const exerciser = "0x1111111111111111111111111111111111111111" as Address;
  const receiver = "0x2222222222222222222222222222222222222222" as Address;

  const topics = encodeEventTopics({
    abi: ACTIVITY_EVENTS,
    eventName: "TicketExercised",
    args: { ticketId: 7n, exerciser, receiver },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [100_000_000_000_000_000_000n, 8_500_000n, 85_000_000_000_000_000_000_000n],
  );

  const decoded = decodeEventLog({
    abi: ACTIVITY_EVENTS,
    eventName: "TicketExercised",
    data,
    topics,
  });

  assert.equal(decoded.args.ticketId, 7n);
  assert.equal(decoded.args.exerciser.toLowerCase(), exerciser.toLowerCase());
  assert.equal(decoded.args.receiver.toLowerCase(), receiver.toLowerCase());
  assert.equal(decoded.args.fillAmount, 100_000_000_000_000_000_000n);
  assert.equal(decoded.args.grossPayment, 8_500_000n);
  assert.equal(decoded.args.effPriceX36, 85_000_000_000_000_000_000_000n);
});

test("RPC: chunkedMulticall batches into chunks <= MULTICALL_CHUNK_SIZE and handles partial failures gracefully", async () => {
  const observedBatchSizes: number[] = [];
  const fakeClient = {
    multicall: async ({ contracts, multicallAddress, allowFailure }: {
      contracts: readonly unknown[];
      multicallAddress?: Address;
      allowFailure?: boolean;
    }) => {
      assert.equal(multicallAddress, MULTICALL3_ADDRESS);
      assert.equal(allowFailure, true);
      observedBatchSizes.push(contracts.length);
      return contracts.map((_, idx) =>
        idx === 1
          ? { status: "failure" as const, error: new Error("mock revert") }
          : { status: "success" as const, result: BigInt(idx + 1) },
      );
    },
  } as unknown as Pick<PublicClient, "multicall">;

  const entries = Array.from({ length: 65 }, () => ({
    address: NETWORKS.testnet.contracts.commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "nextOfferId",
  }));

  const outcomes = await chunkedMulticall(fakeClient, entries, MULTICALL3_ADDRESS, MULTICALL_CHUNK_SIZE);
  assert.deepEqual(observedBatchSizes, [30, 30, 5]);
  assert.equal(outcomes.length, 65);
  assert.equal(outcomes[0].status, "success");
  assert.equal(outcomes[1].status, "failure");
  assert.equal(outcomes[2].status, "success");
  assert.ok(ACTIVITY_LOOKBACK_BLOCKS < 10_000n, "getLogs lookback must stay under 10,000 blocks");
});

test("Networks & Tokens: Chain 177 has canonical addresses, isLive=false, no testnet proof tx; Chain 133 preserved", () => {
  const main = NETWORKS.mainnet;
  assert.equal(main.chainId, 177);
  assert.equal(main.isLive, false);
  assert.equal(main.liveExerciseProofTx, null);
  assert.equal(main.contracts.WHSK, "0xB210D2120d57b758EE163cFfb43e73728c471Cf1");
  assert.equal(main.contracts.USDT, "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029");
  assert.equal(main.contracts.WETH, "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0");
  assert.equal(main.contracts.WBTC, "0x6119CA49a79f5825C8B345F8d7aC36B272565b14");
  assert.equal(main.contracts.commitmentManager, "0x0000000000000000000000000000000000000000");

  const mainTokens = getNetworkTokens(main);
  assert.equal(getTokenMeta(main.contracts.USDT, mainTokens).symbol, "USDT");
  assert.equal(getTokenMeta(main.contracts.WETH, mainTokens).symbol, "WETH");
  assert.equal(getTokenMeta(main.contracts.WBTC, mainTokens).symbol, "WBTC");
  assert.equal(getTokenMeta(main.contracts.WHSK, mainTokens).symbol, "WHSK");

  const testNet = NETWORKS.testnet;
  assert.equal(testNet.chainId, 133);
  assert.equal(testNet.isLive, true);
  assert.ok(testNet.liveExerciseProofTx !== null);
  const testTokens = getNetworkTokens(testNet);
  assert.equal(getTokenMeta(testNet.contracts.USDT, testTokens).symbol, "tUSDT");
  assert.equal(getTokenMeta(testNet.contracts.WETH, testTokens).symbol, "tWETH");
  assert.equal(getTokenMeta(testNet.contracts.WBTC, testTokens).symbol, "tWBTC");
  assert.equal(getTokenMeta(testNet.contracts.WHSK, testTokens).symbol, "WHSK");
});

test("Chain 133 Live Regression: fetchAllOffers (Multicall3 + getOffer), quoteReservation (2-tuple), fetchRecentActivity (<10k blocks)", async () => {
  const offers = await fetchAllOffers(tranchePublicClient, NETWORKS.testnet);
  assert.ok(offers.length >= 5, `expected >= 5 live offers on Chain 133, got ${offers.length}`);

  const activeOffer = offers.find((o) => o.status === 0 && o.availableBalance >= o.minFillAmount);
  assert.ok(activeOffer, "expected at least one active funded offer on Chain 133");

  const rawQuote = await tranchePublicClient.readContract({
    address: NETWORKS.testnet.contracts.commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "quoteReservation",
    args: [activeOffer.offerId, activeOffer.minFillAmount, activeOffer.minDuration],
  });
  const parsed = decodeQuoteReservationResult(rawQuote);
  assert.ok(parsed.grossPremium > 0n, "grossPremium should be > 0");
  assert.ok(parsed.lpNetPremium <= parsed.grossPremium);

  const activity = await fetchRecentActivity(tranchePublicClient, NETWORKS.testnet);
  assert.ok(activity.totalTickets >= 1, `expected >= 1 ticket on Chain 133, got ${activity.totalTickets}`);
});
