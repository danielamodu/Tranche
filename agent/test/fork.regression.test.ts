import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABIS, ANVIL_PRIVATE_KEYS, BYTECODES, PriceMode, TrancheClient } from "@tranche/sdk";
import { TrancheExecutionAgent } from "../src/agent.js";
import { startTempAnvil, stopTempAnvil } from "../src/anvil.js";
import { CANONICAL_CHAIN_177_HSKSWAP, HskSwapVenue } from "../src/hskswap.js";
import { MarketIntelligence } from "../src/market.js";
import { PositionStore } from "../src/positions.js";
import {
  CANONICAL_CHAIN_177_TOKENS,
  MAINNET_READONLY_RPC_URL,
  OnChainOracleReader,
  estimateGasCostInPaymentUnits,
  validateRuntimeSafety,
} from "../src/protocol-config.js";
import { TransactionReconciler } from "../src/reconciler.js";
import type { RiskLimits } from "../src/risk.js";
import { TrancheAutonomousAgent } from "../src/runtime.js";
import type { StrategyConfig } from "../src/strategy.js";

const WHSK_ABI = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
]);

const TWAP_ORACLE_ABI = parseAbi([
  "constructor(address _owner)",
  "function setPoolConfig(address inventoryToken, address paymentToken, address pool, uint32 twapWindow, uint16 minCardinality)",
  "function getPriceX36(address inventoryToken, address paymentToken) view returns ((uint256 priceX36, uint256 updatedAt, bool isValid))",
]);

const CHAIN_177 = defineChain({
  id: 177,
  name: "HashKey Chain Mainnet (Local Fork)",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  contracts: { multicall3: { address: CANONICAL_CHAIN_177_HSKSWAP.multicall3 } },
});

function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

test("Workstream 2: Controlled Chain 177 Fork Execution Regression (all 10 scenarios + cost comparison report)", async () => {
  const anvil = await startTempAnvil({ forkUrl: MAINNET_READONLY_RPC_URL, timeoutMs: 35_000 });
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-fork-reg-"));

  try {
    const transport = http(anvil.rpcUrl, { timeout: 25_000 });
    const forkChain = { ...CHAIN_177, rpcUrls: { default: { http: [anvil.rpcUrl] } } };
    const publicClient = createPublicClient({ chain: forkChain, transport });

    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 177);
    validateRuntimeSafety({ dataSource: "fork", executionMode: "live", rpcUrl: anvil.rpcUrl, chainId });

    const deployer = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]);
    const lp = privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]);
    const trader = privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]);

    const deployerWallet = createWalletClient({ account: deployer, chain: forkChain, transport });
    const lpWallet = createWalletClient({ account: lp, chain: forkChain, transport });
    const traderWallet = createWalletClient({ account: trader, chain: forkChain, transport });

    const WHSK = CANONICAL_CHAIN_177_TOKENS.WHSK.address;
    const USDT = CANONICAL_CHAIN_177_TOKENS.USDT.address;
    const POOL_WHSK = CANONICAL_CHAIN_177_HSKSWAP.pools.WHSK_USDT_3000;
    const TARGET_QTY = 100n * 10n ** 18n;

    const traderVenue = new HskSwapVenue({
      publicClient,
      walletClient: traderWallet,
      account: trader,
      quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
      swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
      multicall3: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
    });

    const poolInit = await traderVenue.getPoolState(POOL_WHSK, WHSK, USDT, 1800);
    const forkBlock = poolInit.blockNumber ?? (await publicClient.getBlockNumber());
    const gasPriceWei = await publicClient.getGasPrice();

    // Fund LP with WHSK & Trader with USDT via real SwapRouter02 swap
    const lpWrap = await lpWallet.writeContract({
      address: WHSK,
      abi: WHSK_ABI,
      functionName: "deposit",
      value: 2_000n * 10n ** 18n,
    });
    await publicClient.waitForTransactionReceipt({ hash: lpWrap });

    const traderWrap = await traderWallet.writeContract({
      address: WHSK,
      abi: WHSK_ABI,
      functionName: "deposit",
      value: 1_500n * 10n ** 18n,
    });
    await publicClient.waitForTransactionReceipt({ hash: traderWrap });

    await traderVenue.executeSwapExactInput({
      tokenIn: WHSK,
      tokenOut: USDT,
      fee: 3000,
      amountIn: 1_000n * 10n ** 18n,
      amountOutMinimum: 1n,
      recipient: trader.address,
    });

    // Deploy Tranche stack + UniswapV3TwapOracle on local fork
    async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[]) {
      const hash = await deployerWallet.deployContract({ abi, bytecode, args });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      assert.ok(rcpt.contractAddress);
      return rcpt.contractAddress;
    }

    const vaultAddr = await deploy(ABIS.LiquidityVault, BYTECODES.LiquidityVault, [
      deployer.address,
      deployer.address,
      deployer.address,
    ]);
    const managerAddr = await deploy(ABIS.CommitmentManager, BYTECODES.CommitmentManager, [
      deployer.address,
      vaultAddr,
      deployer.address,
      5,
    ]);
    const ticketAddr = await deploy(ABIS.ExecutionTicket, BYTECODES.ExecutionTicket, [managerAddr]);
    for (const call of [
      { address: vaultAddr, abi: ABIS.LiquidityVault, functionName: "setManager", args: [managerAddr] },
      { address: managerAddr, abi: ABIS.CommitmentManager, functionName: "setTicketNft", args: [ticketAddr] },
      { address: managerAddr, abi: ABIS.CommitmentManager, functionName: "setTokenMinTicketAmount", args: [WHSK, 10n * 10n ** 18n] },
    ] as const) {
      const h = await deployerWallet.writeContract(call as never);
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const routerAddr = await deploy(ABIS.ExecutionRouter, BYTECODES.ExecutionRouter, [
      managerAddr,
      WHSK,
    ]);
    const approveRouterHash = await deployerWallet.writeContract({
      address: managerAddr,
      abi: ABIS.CommitmentManager,
      functionName: "setApprovedRouter",
      args: [routerAddr, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveRouterHash });

    const twapOracleAddr = await deploy(TWAP_ORACLE_ABI, BYTECODES.UniswapV3TwapOracle, [deployer.address]);
    const oracleCfgHash = await deployerWallet.writeContract({
      address: twapOracleAddr,
      abi: TWAP_ORACLE_ABI,
      functionName: "setPoolConfig",
      args: [WHSK, USDT, POOL_WHSK, 1800, 10],
    });
    await publicClient.waitForTransactionReceipt({ hash: oracleCfgHash });

    const addresses = {
      liquidityVault: vaultAddr,
      commitmentManager: managerAddr,
      executionTicket: ticketAddr,
      executionRouter: routerAddr,
      oraclePriceAdapter: twapOracleAddr,
    };

    const lpClient = new TrancheClient({ publicClient, walletClient: lpWallet, addresses });
    const traderClient = new TrancheClient({ publicClient, walletClient: traderWallet, addresses });
    const traderTrancheAgent = new TrancheExecutionAgent(traderClient);
    const oracleReader = new OnChainOracleReader(publicClient, twapOracleAddr);

    // Approve & deposit 500 WHSK from LP, approve USDT from Trader
    const lpAppHash = await lpWallet.writeContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "approve",
      args: [vaultAddr, 1_000n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: lpAppHash });
    await lpClient.deposit(WHSK, 500n * 10n ** 18n);

    const traderAppHash = await traderWallet.writeContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "approve",
      args: [vaultAddr, 1_000_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: traderAppHash });

    const nowBlock = await publicClient.getBlock();
    const nowSec = Number(nowBlock.timestamp);
    const poolAfterFund = await traderVenue.getPoolState(POOL_WHSK, WHSK, USDT, 1800);
    const offerFixedPriceX36 = (poolAfterFund.spotPriceX36 * 9800n) / 10_000n;

    await lpClient.createOffer({
      inventoryToken: WHSK,
      paymentToken: USDT,
      initialAmount: 500n * 10n ** 18n,
      minFillAmount: 10n * 10n ** 18n,
      minDuration: 60,
      maxDuration: 86_400,
      expiry: nowSec + 86_400 * 7,
      basePremiumBps: 10,
      dailyPremiumBps: 5,
      priceMode: PriceMode.FIXED,
      fixedPriceX36: offerFixedPriceX36,
      spreadBps: 0,
      minPriceX36: 0n,
      maxPriceX36: 0n,
      oracle: "0x0000000000000000000000000000000000000000" as Address,
      complianceHook: "0x0000000000000000000000000000000000000000" as Address,
    });

    const trancheGasUsdt = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 340_000n,
      whskToPaymentPriceX36: poolAfterFund.spotPriceX36,
    });
    const dexGasUsdt = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 140_000n,
      whskToPaymentPriceX36: poolAfterFund.spotPriceX36,
    });

    const baseRiskLimits = (): RiskLimits => ({
      maxPositionSizeInventory: 200n * 10n ** 18n,
      maxTotalExposurePayment: 50_000_000n,
      maxDailyPremiumBudgetPayment: 1_000_000n,
      maxDailyRealizedLossPayment: 5_000_000n,
      maxConcurrentPositions: 5,
      maxConcurrentTickets: 5,
      maxSlippageBps: 150,
      minPoolLiquidity: 100_000_000_000n,
      maxOracleAgeSec: 120,
      maxOracleDeviationBps: 500,
      paused: false,
      killSwitch: false,
    });

    const baseStrategy = (): StrategyConfig => ({
      type: "price_threshold",
      momentumThresholdBps: 50,
      maxEntryPriceX36: poolAfterFund.spotPriceX36 * 2n,
      minVolatilityBps: 10,
      maxVolatilityBps: 2000,
      dislocationThresholdBps: 20,
      takeProfitBps: 500,
      stopLossBps: 300,
      takeProfitExitBps: 10_000,
      ticketExerciseWindowSec: 300,
    });

    const scenarios: Record<string, unknown> = {};

    // =========================================================================
    // SCENARIO 1: Tranche offer discovery, reservation & exercise
    // =========================================================================
    const state1 = path.join(tmpDir, "s1-state.json");
    const pos1 = new PositionStore(state1, nowSec);
    const market1 = new MarketIntelligence({
      dexVenue: traderVenue,
      trancheAgent: traderTrancheAgent,
      oracleReader,
      poolAddress: POOL_WHSK,
      poolFee: 3000,
      minPoolLiquidity: 100_000_000_000n,
      maxOracleAgeSec: 120,
      maxOracleDeviationBps: 500,
    });
    const agent1 = new TrancheAutonomousAgent({
      trancheAgent: traderTrancheAgent,
      dexVenue: traderVenue,
      market: market1,
      positions: pos1,
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: baseRiskLimits(),
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
        trancheGasCostPayment: trancheGasUsdt,
        dexGasCostPayment: dexGasUsdt,
      },
      reconciler: new TransactionReconciler(publicClient),
    });

    const usdtBeforeTranche = await publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const whskBeforeTranche = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });

    const t1 = await agent1.runCycle();
    assert.equal(t1.selectedAction, "RESERVE_TRANCHE");
    assert.equal(t1.venueSelection.selectedVenue, "TRANCHE");
    assert.equal(t1.txHashes.length, 1);

    const activeTicket = pos1.getActiveTickets()[0];
    assert.ok(activeTicket, "Expected reserved Tranche ticket");
    const reserveReceipt = await publicClient.getTransactionReceipt({ hash: t1.txHashes[0] });

    // Exercise full reserved ticket on-chain on fork
    const exQuote = await traderClient.quoteExercise(activeTicket.ticketId, 0n);
    const exRes = await traderTrancheAgent.exerciseTicket(
      activeTicket.ticketId,
      0n,
      (exQuote.grossPayment * 10_100n) / 10_000n,
      trader.address,
    );
    const exerciseReceipt = await publicClient.getTransactionReceipt({ hash: exRes.tx.hash });
    const createdPos = pos1.markTicketExercised(
      activeTicket.ticketId,
      exRes.actualFill,
      exRes.grossPayment,
      exRes.tx.hash,
      Number((await publicClient.getBlock()).timestamp),
    );

    const usdtAfterTranche = await publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const whskAfterTranche = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });

    const actualTrancheUsdtSpent = usdtBeforeTranche - usdtAfterTranche;
    const actualTrancheWhskReceived = whskAfterTranche - whskBeforeTranche;
    const expectedTrancheUsdtExGas =
      t1.venueSelection.tranche.reservationPremiumPayment + t1.venueSelection.tranche.exercisePayment;
    assert.equal(actualTrancheWhskReceived, TARGET_QTY);
    assert.equal(actualTrancheUsdtSpent, expectedTrancheUsdtExGas);

    scenarios["1_tranche_reserve_and_exercise"] = {
      passed: true,
      snapshot: {
        blockNumber: t1.snapshot.blockNumber,
        timestamp: t1.snapshot.timestamp,
        spotPriceX36: t1.snapshot.pool.spotPriceX36,
        twapPriceX36: t1.snapshot.pool.twapPriceX36,
        liquidity: t1.snapshot.pool.liquidity,
        marketRegime: t1.snapshot.marketRegime,
      },
      selectedVenue: t1.venueSelection.selectedVenue,
      selectedAction: t1.selectedAction,
      reasoning: t1.rationale,
      expectedExecutionCostPayment: t1.venueSelection.tranche.acquisitionCostPayment,
      expectedTokenPaymentExGas: expectedTrancheUsdtExGas,
      actualTokenPaymentSpent: actualTrancheUsdtSpent,
      costDiscrepancyPayment: actualTrancheUsdtSpent - expectedTrancheUsdtExGas,
      slippageBps: 0,
      gasUsedReserve: reserveReceipt.gasUsed,
      gasUsedExercise: exerciseReceipt.gasUsed,
      totalGasUsed: reserveReceipt.gasUsed + exerciseReceipt.gasUsed,
      txReceipts: {
        reserve: { hash: reserveReceipt.transactionHash, blockNumber: reserveReceipt.blockNumber, status: reserveReceipt.status },
        exercise: { hash: exerciseReceipt.transactionHash, blockNumber: exerciseReceipt.blockNumber, status: exerciseReceipt.status },
      },
      positionAccounting: {
        ticketId: activeTicket.ticketId,
        positionId: createdPos.positionId,
        receivedInventory: actualTrancheWhskReceived,
        costBasisPayment: createdPos.entryCostPayment,
        reservationPremiumPaid: createdPos.reservationPremiumPaid,
      },
      riskEvaluation: { allowed: t1.riskReport.allowed, failedChecks: t1.riskReport.failedChecks },
    };

    // =========================================================================
    // SCENARIO 10: Duplicate execution prevention (same cooldown bucket)
    // =========================================================================
    const tDup = await agent1.runCycle(t1.timestamp);
    assert.equal(tDup.selectedAction, "SKIPPED_DUPLICATE");
    assert.equal(tDup.txHashes.length, 0);
    scenarios["10_duplicate_execution_prevention"] = {
      passed: true,
      decisionKey: tDup.decisionKey,
      selectedAction: tDup.selectedAction,
      txCount: tDup.txHashes.length,
      rationale: tDup.rationale,
    };

    // =========================================================================
    // SCENARIO 2: HSKSwap quote & SwapRouter02 execution
    // =========================================================================
    // Use an agent whose TrancheClient sees no offers so HSKSwap is deterministically selected
    const emptyTrancheAgent = new TrancheExecutionAgent({
      discoverOffers: async () => [],
      publicClient,
    } as unknown as TrancheClient);
    const state2 = path.join(tmpDir, "s2-state.json");
    const pos2 = new PositionStore(state2, nowSec);
    const market2 = new MarketIntelligence({
      dexVenue: traderVenue,
      trancheAgent: emptyTrancheAgent,
      oracleReader,
      poolAddress: POOL_WHSK,
      poolFee: 3000,
      minPoolLiquidity: 100_000_000_000n,
      maxOracleAgeSec: 120,
      maxOracleDeviationBps: 500,
    });
    const agent2 = new TrancheAutonomousAgent({
      trancheAgent: emptyTrancheAgent,
      dexVenue: traderVenue,
      market: market2,
      positions: pos2,
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: baseRiskLimits(),
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
        trancheGasCostPayment: trancheGasUsdt,
        dexGasCostPayment: dexGasUsdt,
      },
    });

    const usdtBeforeDex = await publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const whskBeforeDex = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });

    const t2 = await agent2.runCycle();
    assert.equal(t2.selectedAction, "SWAP_HSKSWAP");
    assert.equal(t2.venueSelection.selectedVenue, "HSKSWAP");
    assert.equal(t2.txHashes.length, 1);
    const swapReceipt = await publicClient.getTransactionReceipt({ hash: t2.txHashes[0] });

    const usdtAfterDex = await publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const whskAfterDex = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });

    const actualDexUsdtSpent = usdtBeforeDex - usdtAfterDex;
    const actualDexWhskReceived = whskAfterDex - whskBeforeDex;
    const quotedDexUsdtExGas = t2.snapshot.dexBuyQuote!.paymentAmountIn;
    const dexPos = pos2.getOpenPositions()[0];
    assert.ok(dexPos);
    assert.equal(actualDexUsdtSpent, quotedDexUsdtExGas);
    const realizedOutDiffBps =
      actualDexWhskReceived >= TARGET_QTY
        ? 0
        : Number(((TARGET_QTY - actualDexWhskReceived) * 10_000n) / TARGET_QTY);

    scenarios["2_hskswap_quote_and_swap"] = {
      passed: true,
      snapshot: {
        blockNumber: t2.snapshot.blockNumber,
        timestamp: t2.snapshot.timestamp,
        spotPriceX36: t2.snapshot.pool.spotPriceX36,
        twapPriceX36: t2.snapshot.pool.twapPriceX36,
        liquidity: t2.snapshot.pool.liquidity,
        marketRegime: t2.snapshot.marketRegime,
      },
      selectedVenue: t2.venueSelection.selectedVenue,
      selectedAction: t2.selectedAction,
      reasoning: t2.rationale,
      expectedExecutionCostPayment: t2.venueSelection.hskswap.acquisitionCostPayment,
      expectedTokenPaymentExGas: quotedDexUsdtExGas,
      actualTokenPaymentSpent: actualDexUsdtSpent,
      costDiscrepancyPayment: actualDexUsdtSpent - quotedDexUsdtExGas,
      quotedPriceImpactBps: t2.snapshot.dexBuyQuote!.priceImpactBps,
      realizedOutputShortfallBps: realizedOutDiffBps,
      gasUsedSwap: swapReceipt.gasUsed,
      txReceipt: {
        hash: swapReceipt.transactionHash,
        blockNumber: swapReceipt.blockNumber,
        status: swapReceipt.status,
      },
      positionAccounting: {
        positionId: dexPos.positionId,
        receivedInventory: actualDexWhskReceived,
        costBasisPayment: dexPos.entryCostPayment,
      },
      riskEvaluation: { allowed: t2.riskReport.allowed, failedChecks: t2.riskReport.failedChecks },
    };

    // =========================================================================
    // SCENARIO 3: No-trade decision (unreachable minExpectedNetProfitPayment)
    // =========================================================================
    const agent3 = new TrancheAutonomousAgent({
      trancheAgent: traderTrancheAgent,
      dexVenue: traderVenue,
      market: market1,
      positions: new PositionStore(undefined, nowSec),
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: baseRiskLimits(),
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 50_000_000n, // unreachable $50 edge on ~$8 trade
        maxOptionOverheadBps: 100,
      },
    });
    const t3 = await agent3.runCycle();
    assert.equal(t3.selectedAction, "WAIT");
    assert.equal(t3.venueSelection.selectedVenue, "NONE");
    assert.equal(t3.txHashes.length, 0);
    scenarios["3_no_trade_decision"] = {
      passed: true,
      selectedVenue: t3.venueSelection.selectedVenue,
      selectedAction: t3.selectedAction,
      rationale: t3.rationale,
      txCount: t3.txHashes.length,
    };

    // =========================================================================
    // SCENARIO 4: Risk-limit rejection (maxPositionSizeInventory exceeded)
    // =========================================================================
    const tightLimits = baseRiskLimits();
    tightLimits.maxPositionSizeInventory = 50n * 10n ** 18n; // < 100 WHSK target
    const agent4 = new TrancheAutonomousAgent({
      trancheAgent: traderTrancheAgent,
      dexVenue: traderVenue,
      market: market1,
      positions: new PositionStore(undefined, nowSec),
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: tightLimits,
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
      },
    });
    const t4 = await agent4.runCycle();
    assert.equal(t4.selectedAction, "BLOCKED_RISK");
    assert.equal(t4.riskReport.allowed, false);
    assert.ok(t4.riskReport.failedChecks.some((c) => c.name === "max_position_size"));
    assert.equal(t4.txHashes.length, 0);
    scenarios["4_risk_limit_rejection"] = {
      passed: true,
      selectedAction: t4.selectedAction,
      failedChecks: t4.riskReport.failedChecks,
      txCount: t4.txHashes.length,
    };

    // =========================================================================
    // SCENARIO 5: Insufficient liquidity / slippage rejection
    // =========================================================================
    const agent5 = new TrancheAutonomousAgent({
      trancheAgent: emptyTrancheAgent,
      dexVenue: traderVenue,
      market: market2,
      positions: new PositionStore(undefined, nowSec),
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: { ...baseRiskLimits(), maxSlippageBps: 1 }, // 1 bps cap < live 30 bps pool fee impact
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 1,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
      },
    });
    const t5 = await agent5.runCycle();
    assert.equal(t5.selectedAction, "WAIT");
    assert.equal(t5.venueSelection.selectedVenue, "NONE");
    assert.ok(t5.venueSelection.hskswap.rejectionReasons.some((r) => r.includes("SLIPPAGE_EXCEEDED")));
    assert.equal(t5.txHashes.length, 0);
    scenarios["5_slippage_rejection"] = {
      passed: true,
      selectedVenue: t5.venueSelection.selectedVenue,
      selectedAction: t5.selectedAction,
      rejectionReasons: t5.venueSelection.hskswap.rejectionReasons,
      txCount: t5.txHashes.length,
    };

    // =========================================================================
    // SCENARIO 6: Failed transaction handling (revert caught without corrupting state)
    // =========================================================================
    const failingDex: HskSwapVenue = Object.assign(Object.create(Object.getPrototypeOf(traderVenue)), traderVenue, {
      async executeSwapExactInput() {
        throw new Error("SwapRouter02: Too little received");
      },
    });
    const pos6 = new PositionStore(path.join(tmpDir, "s6-state.json"), nowSec);
    const agent6 = new TrancheAutonomousAgent({
      trancheAgent: emptyTrancheAgent,
      dexVenue: failingDex,
      market: market2,
      positions: pos6,
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: baseRiskLimits(),
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
      },
    });
    const t6 = await agent6.runCycle();
    assert.equal(t6.selectedAction, "EXECUTION_FAILED");
    assert.equal(pos6.getPendingTxs().length, 0, "Deterministic revert clears pending tx cleanly");
    assert.equal(pos6.isStateCorrupted(), false);
    scenarios["6_failed_tx_handling"] = {
      passed: true,
      selectedAction: t6.selectedAction,
      error: t6.error,
      pendingTxsRemaining: pos6.getPendingTxs().length,
      stateCorrupted: pos6.isStateCorrupted(),
    };

    // =========================================================================
    // SCENARIOS 7, 8, 9: Uncertain tx -> Restart with pending tx -> Reconciliation
    // =========================================================================
    const state789 = path.join(tmpDir, "s789-state.json");
    const timeoutDex: HskSwapVenue = Object.assign(Object.create(Object.getPrototypeOf(traderVenue)), traderVenue, {
      async executeSwapExactInput() {
        throw new Error("RPC network timeout waiting for receipt");
      },
    });
    const pos7 = new PositionStore(state789, nowSec);
    const agent7 = new TrancheAutonomousAgent({
      trancheAgent: emptyTrancheAgent,
      dexVenue: timeoutDex,
      market: market2,
      positions: pos7,
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: baseRiskLimits(),
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
      },
    });

    // Scenario 7: Timeout leaves UNCERTAIN_TIMEOUT pending tx
    const t7 = await agent7.runCycle();
    assert.equal(t7.selectedAction, "EXECUTION_FAILED");
    assert.equal(pos7.getPendingTxs().length, 1);
    assert.equal(pos7.getPendingTxs()[0].status, "UNCERTAIN_TIMEOUT");
    scenarios["7_uncertain_tx_handling"] = {
      passed: true,
      selectedAction: t7.selectedAction,
      pendingTxStatus: pos7.getPendingTxs()[0].status,
      pendingTxId: pos7.getPendingTxs()[0].id,
    };

    // Scenario 8: Restart with persisted pending tx MUST block new entries
    const pos8 = new PositionStore(state789, nowSec);
    assert.equal(pos8.getPendingTxs().length, 1);
    const agent8 = new TrancheAutonomousAgent({
      trancheAgent: emptyTrancheAgent,
      dexVenue: traderVenue,
      market: market2,
      positions: pos8,
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
      },
      strategyConfig: baseStrategy(),
      riskLimits: baseRiskLimits(),
      venueConstraints: {
        maxAllInCostX36: poolAfterFund.spotPriceX36 * 2n,
        maxSlippageBps: 150,
        minExpectedNetProfitPayment: 10_000n,
        maxOptionOverheadBps: 100,
      },
    });
    const t8 = await agent8.runCycle(t7.timestamp + 120);
    assert.equal(t8.selectedAction, "BLOCKED_RISK");
    assert.ok(t8.riskReport.failedChecks.some((c) => c.name === "no_pending_tx"));
    scenarios["8_restart_with_pending_tx"] = {
      passed: true,
      restoredPendingCount: pos8.getPendingTxs().length,
      selectedAction: t8.selectedAction,
      failedChecks: t8.riskReport.failedChecks,
    };

    // Scenario 9: Reconciliation after restart (both automated via TransactionReconciler on fork receipt & explicit clear)
    const reconciler = new TransactionReconciler(publicClient);
    const autoRec = await reconciler.reconcile({
      id: "fork-reconcile-check",
      decisionKey: "fork-rec",
      action: "SWAP_HSKSWAP",
      createdAt: nowSec,
      status: "UNCERTAIN_TIMEOUT",
      chainId: 177,
      txHash: swapReceipt.transactionHash,
    });
    assert.equal(autoRec.status, "CONFIRMED");
    assert.equal(autoRec.canClearPending, true);

    const cleared = agent8.reconcilePendingTx(pos8.getPendingTxs()[0].id);
    assert.equal(cleared, true);
    assert.equal(pos8.getPendingTxs().length, 0);
    scenarios["9_reconciliation_after_restart"] = {
      passed: true,
      reconcilerForkReceiptCheck: autoRec,
      manualPendingCleared: cleared,
      remainingPendingTxs: pos8.getPendingTxs().length,
    };

    // Write machine-readable evidence report
    const evidenceDir = path.resolve("..", "docs", "submission-evidence", "raw");
    mkdirSync(evidenceDir, { recursive: true });
    const reportPath = path.join(evidenceDir, "fork-regression-report.json");
    const report = {
      generatedAt: new Date().toISOString(),
      network: "HashKey Chain Mainnet (Local Anvil Fork — Zero Public Broadcasts)",
      chainId: 177,
      forkBlockNumber: forkBlock.toString(),
      gasPriceWei: gasPriceWei.toString(),
      scenariosPassed: Object.keys(scenarios).length,
      scenariosTotal: 10,
      scenarios,
    };
    writeFileSync(reportPath, jsonSafe(report), "utf8");
    assert.equal(Object.keys(scenarios).length, 10);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await stopTempAnvil(anvil.proc);
  }
});
