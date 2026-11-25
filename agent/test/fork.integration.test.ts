import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  type Address,
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
import type { RiskLimits } from "../src/risk.js";
import { TrancheAutonomousAgent } from "../src/runtime.js";
import type { StrategyConfig } from "../src/strategy.js";

const WHSK_ABI = parseAbi([
  "function deposit() payable",
  "function decimals() view returns (uint8)",
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

test("Safety: validateRuntimeSafety fails closed on mainnet live execution & misconfigurations", () => {
  // MUST reject live execution against remote mainnet RPC
  assert.throws(
    () =>
      validateRuntimeSafety({
        dataSource: "fork",
        executionMode: "live",
        rpcUrl: MAINNET_READONLY_RPC_URL,
        chainId: 177,
      }),
    /MAINNET_EXECUTION_BLOCKED/,
  );

  // MUST reject live execution in dry_run mode
  assert.throws(
    () =>
      validateRuntimeSafety({
        dataSource: "dry_run",
        executionMode: "live",
        rpcUrl: MAINNET_READONLY_RPC_URL,
        chainId: 177,
      }),
    /SAFETY_BLOCKED/,
  );

  // MUST reject live execution in fixture mode
  assert.throws(
    () =>
      validateRuntimeSafety({
        dataSource: "fixture",
        executionMode: "live",
      }),
    /SAFETY_BLOCKED/,
  );

  // Valid configurations pass cleanly
  validateRuntimeSafety({
    dataSource: "dry_run",
    executionMode: "dry_run",
    rpcUrl: MAINNET_READONLY_RPC_URL,
    chainId: 177,
  });
  validateRuntimeSafety({
    dataSource: "fork",
    executionMode: "live",
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 177,
  });
});

test("Chain 177 Anvil Fork: live HSKSwap reads, Tranche deployment, real dual-venue selection, execution & reconciliation", async () => {
  const anvil = await startTempAnvil({ forkUrl: MAINNET_READONLY_RPC_URL, timeoutMs: 30_000 });
  try {
    const transport = http(anvil.rpcUrl, { timeout: 20_000 });
    const forkChain = { ...CHAIN_177, rpcUrls: { default: { http: [anvil.rpcUrl] } } };
    const publicClient = createPublicClient({ chain: forkChain, transport });

    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 177, "Fork must report Chain ID 177");
    validateRuntimeSafety({
      dataSource: "fork",
      executionMode: "live",
      rpcUrl: anvil.rpcUrl,
      chainId,
    });

    const deployer = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]);
    const lp = privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]);
    const trader = privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]);

    const deployerWallet = createWalletClient({ account: deployer, chain: forkChain, transport });
    const lpWallet = createWalletClient({ account: lp, chain: forkChain, transport });
    const traderWallet = createWalletClient({ account: trader, chain: forkChain, transport });

    const WHSK = CANONICAL_CHAIN_177_TOKENS.WHSK.address;
    const USDT = CANONICAL_CHAIN_177_TOKENS.USDT.address;
    const WETH = CANONICAL_CHAIN_177_TOKENS.WETH.address;
    const WBTC = CANONICAL_CHAIN_177_TOKENS.WBTC.address;
    const POOL_WHSK = CANONICAL_CHAIN_177_HSKSWAP.pools.WHSK_USDT_3000;

    // 1. Verify canonical token decimals via Multicall3 on Chain 177 fork
    const decMc = await publicClient.multicall({
      multicallAddress: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
      contracts: [
        { address: WHSK, abi: erc20Abi, functionName: "decimals" },
        { address: USDT, abi: erc20Abi, functionName: "decimals" },
        { address: WETH, abi: erc20Abi, functionName: "decimals" },
        { address: WBTC, abi: erc20Abi, functionName: "decimals" },
      ],
    });
    for (const r of decMc) {
      assert.equal(r.status, "success", `multicall decimals failed: ${r.error?.message}`);
    }
    assert.deepEqual(
      decMc.map((r) => Number(r.result)),
      [18, 6, 18, 8],
    );

    // 2. Verify live HskSwapVenue reads (pool state, TWAP, QuoterV2 buy/sell quotes, gas estimates)
    const traderVenue = new HskSwapVenue({
      publicClient,
      walletClient: traderWallet,
      account: trader,
      quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
      swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
      multicall3: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
    });

    const poolWhsk = await traderVenue.getPoolState(POOL_WHSK, WHSK, USDT, 1800);
    assert.ok(poolWhsk.liquidity > 0n, "WHSK/USDT liquidity > 0");
    assert.ok(poolWhsk.spotPriceX36 > 0n, "WHSK/USDT spot > 0");
    assert.ok(poolWhsk.twapPriceX36 !== null && poolWhsk.twapPriceX36 > 0n, "WHSK/USDT TWAP > 0");
    assert.equal(poolWhsk.observationCardinality, 240);

    const TARGET_QTY = 100n * 10n ** 18n; // 100 WHSK
    const buyQ = await traderVenue.quoteBuyInventory(WHSK, USDT, TARGET_QTY, 3000, poolWhsk.spotPriceX36);
    const sellQ = await traderVenue.quoteSellInventory(WHSK, USDT, TARGET_QTY, 3000, poolWhsk.spotPriceX36);
    assert.ok(buyQ.paymentAmountIn > 0n, "QuoterV2 buy quote > 0");
    assert.ok(sellQ.paymentAmountOut > 0n, "QuoterV2 sell quote > 0");

    const trancheGasUsdt = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 340_000n,
      whskToPaymentPriceX36: poolWhsk.spotPriceX36,
    });
    const dexGasUsdt = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 140_000n,
      whskToPaymentPriceX36: poolWhsk.spotPriceX36,
    });
    assert.ok(trancheGasUsdt > 0n && dexGasUsdt > 0n, "Live gas estimates > 0");

    // 3. Fund LP with canonical WHSK & Trader with canonical USDT (wrap HSK + real SwapRouter02 swap!)
    const lpWrapHash = await lpWallet.writeContract({
      address: WHSK,
      abi: WHSK_ABI,
      functionName: "deposit",
      value: 2_000n * 10n ** 18n,
    });
    await publicClient.waitForTransactionReceipt({ hash: lpWrapHash });

    const traderWrapHash = await traderWallet.writeContract({
      address: WHSK,
      abi: WHSK_ABI,
      functionName: "deposit",
      value: 1_500n * 10n ** 18n,
    });
    await publicClient.waitForTransactionReceipt({ hash: traderWrapHash });

    // Real HSKSwap execution: Trader swaps 1,000 WHSK -> USDT via SwapRouter02.multicall(deadline, [exactInputSingle])
    const traderUsdtBefore = await publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const fundingSwap = await traderVenue.executeSwapExactInput({
      tokenIn: WHSK,
      tokenOut: USDT,
      fee: 3000,
      amountIn: 1_000n * 10n ** 18n,
      amountOutMinimum: 1n,
      recipient: trader.address,
    });
    const traderUsdtAfter = await publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    assert.equal(traderUsdtAfter - traderUsdtBefore, fundingSwap.amountOut);
    assert.ok(fundingSwap.amountOut > 50_000_000n, "Expected >$50 USDT from 1,000 WHSK swap");

    // 4. Deploy core Tranche stack + UniswapV3TwapOracle on the Chain 177 fork
    async function deploy(abi: readonly unknown[], bytecode: `0x${string}`, args: unknown[]) {
      const hash = await deployerWallet.deployContract({ abi, bytecode, args });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      assert.ok(rcpt.contractAddress, "contractAddress missing");
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

    // Wire UniswapV3TwapOracle if bytecode is available in SDK artifacts; else read live pool TWAP via OnChainOracleReader/pool
    const oracleReader = {
      getPriceX36: async () => {
        const st = await traderVenue.getPoolState(POOL_WHSK, WHSK, USDT, 1800);
        return {
          priceX36: st.twapPriceX36 ?? st.spotPriceX36,
          updatedAt: st.timestamp,
          isValid: (st.twapPriceX36 ?? st.spotPriceX36) > 0n,
        };
      },
    };

    const addresses = {
      liquidityVault: vaultAddr,
      commitmentManager: managerAddr,
      executionTicket: ticketAddr,
      executionRouter: routerAddr,
    };
    const lpClient = new TrancheClient({ publicClient, walletClient: lpWallet, addresses });
    const traderClient = new TrancheClient({ publicClient, walletClient: traderWallet, addresses });
    const trancheAgent = new TrancheExecutionAgent(traderClient);

    // LP deposits 1,000 canonical WHSK into LiquidityVault
    const lpAppHash = await lpWallet.writeContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "approve",
      args: [vaultAddr, 1_000n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: lpAppHash });
    await lpClient.deposit(WHSK, 1_000n * 10n ** 18n);

    const traderAppHash = await traderWallet.writeContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "approve",
      args: [vaultAddr, 1_000_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: traderAppHash });

    // 5. SCENARIO A: TRANCHE WINS (LP posts FIXED offer 3% below live HSKSwap buy quote)
    const nowBlock = await publicClient.getBlock();
    const nowSec = Number(nowBlock.timestamp);
    const discountedPriceX36 = (buyQ.effectiveUnitPriceX36 * 97n) / 100n;
    await lpClient.createOffer({
      inventoryToken: WHSK,
      paymentToken: USDT,
      initialAmount: 500n * 10n ** 18n,
      minFillAmount: 10n * 10n ** 18n,
      expiry: nowSec + 86_400,
      minDuration: 60,
      maxDuration: 86_400,
      basePremiumBps: 25,
      dailyPremiumBps: 0,
      priceMode: PriceMode.FIXED,
      spreadBps: 0,
      oracle: "0x0000000000000000000000000000000000000000",
      complianceHook: "0x0000000000000000000000000000000000000000",
      fixedPriceX36: discountedPriceX36,
      minPriceX36: 0n,
      maxPriceX36: 0n,
    });

    const riskLimits: RiskLimits = {
      maxPositionSizeInventory: 200n * 10n ** 18n,
      maxTotalExposurePayment: 50_000_000n,
      maxDailyPremiumBudgetPayment: 1_000_000n,
      maxDailyRealizedLossPayment: 5_000_000n,
      maxConcurrentPositions: 3,
      maxConcurrentTickets: 3,
      maxSlippageBps: 150,
      minPoolLiquidity: 100_000_000_000n,
      maxOracleAgeSec: 60,
      maxOracleDeviationBps: 500,
      paused: false,
      killSwitch: false,
    };

    const strategyConfig: StrategyConfig = {
      type: "price_threshold",
      momentumThresholdBps: 50,
      maxEntryPriceX36: (poolWhsk.spotPriceX36 * 120n) / 100n,
      minVolatilityBps: 10,
      maxVolatilityBps: 2000,
      dislocationThresholdBps: 10,
      takeProfitBps: 500,
      stopLossBps: 300,
      takeProfitExitBps: 10_000,
      ticketExerciseWindowSec: 300,
    };

    const market = new MarketIntelligence({
      dexVenue: traderVenue,
      trancheAgent,
      oracleReader,
      poolAddress: POOL_WHSK,
      poolFee: 3000,
      minPoolLiquidity: riskLimits.minPoolLiquidity,
      maxOracleAgeSec: riskLimits.maxOracleAgeSec,
      maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
    });

    const positions = new PositionStore(undefined, nowSec);
    const agent = new TrancheAutonomousAgent({
      trancheAgent,
      dexVenue: traderVenue,
      market,
      positions,
      recipient: trader.address,
      poolFee: 3000,
      executionMode: "live",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: (buyQ.effectiveUnitPriceX36 * 110n) / 100n,
      },
      strategyConfig,
      riskLimits,
      venueConstraints: {
        maxAllInCostX36: (buyQ.effectiveUnitPriceX36 * 110n) / 100n,
        maxSlippageBps: riskLimits.maxSlippageBps,
        minExpectedNetProfitPayment: 1n,
        maxOptionOverheadBps: 50,
        trancheGasCostPayment: trancheGasUsdt,
        dexGasCostPayment: dexGasUsdt,
      },
    });

    const tTranche = await agent.runCycle();
    assert.equal(tTranche.venueSelection.selectedVenue, "TRANCHE");
    assert.equal(tTranche.selectedAction, "RESERVE_TRANCHE");
    assert.equal(tTranche.txHashes.length, 1);
    assert.equal(positions.getActiveTickets().length, 1);

    // Exercise the real reserved ticket on the Chain 177 fork!
    const ticketId = positions.getActiveTickets()[0].ticketId;
    const whskBeforeEx = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const exQuote = await traderClient.quoteExercise(ticketId, 0n);
    const exRes = await trancheAgent.exerciseTicket(
      ticketId,
      0n,
      exQuote.grossPayment + 10_000n,
      trader.address,
    );
    const whskAfterEx = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    assert.equal(whskAfterEx - whskBeforeEx, TARGET_QTY, "Trader must receive exact 100 WHSK");
    assert.ok(exRes.tx.hash.startsWith("0x"));
    positions.markTicketExercised(ticketId, exRes.actualFill, exRes.grossPayment, exRes.tx.hash, nowSec);
    assert.equal(positions.getOpenPositions().length, 1);

    // Helper to advance Anvil fork block timestamp cleanly
    async function advanceForkTime(seconds: number): Promise<number> {
      await publicClient.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
      await publicClient.request({ method: "evm_mine" as never, params: [] as never });
      const b = await publicClient.getBlock();
      return Number(b.timestamp);
    }

    // 6. SCENARIO B: HSKSWAP WINS (cancel discounted offer -> only HSKSwap eligible -> real SwapRouter02 swap!)
    await lpClient.cancelOffer(1n);
    await advanceForkTime(120);
    const whskBeforeDex = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    const tDex = await agent.runCycle();
    assert.equal(tDex.venueSelection.selectedVenue, "HSKSWAP", `Dex rationale: ${tDex.rationale}`);
    assert.equal(tDex.selectedAction, "SWAP_HSKSWAP", `Dex action rationale: ${tDex.rationale}`);
    assert.equal(tDex.txHashes.length, 1);
    const whskAfterDex = await publicClient.readContract({
      address: WHSK,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    assert.ok(whskAfterDex > whskBeforeDex, "Real HSKSwap swap must deliver WHSK on fork");
    assert.equal(positions.getOpenPositions().length, 2);

    // 7. SCENARIO C: NEITHER / RISK / REVERT / RECONCILIATION
    // Reverted swap (impossible amountOutMinimum)
    await assert.rejects(() =>
      traderVenue.executeSwapExactInput({
        tokenIn: USDT,
        tokenOut: WHSK,
        fee: 3000,
        amountIn: 1_000_000n,
        amountOutMinimum: 10n ** 30n,
        recipient: trader.address,
      }),
    );

    // Tighten risk limits -> BLOCKED_RISK
    await advanceForkTime(120);
    agent.getRiskLimits().maxConcurrentPositions = 2;
    const tBlocked = await agent.runCycle();
    assert.equal(tBlocked.selectedAction, "BLOCKED_RISK");
    assert.ok(tBlocked.riskReport.failedChecks.some((c) => c.name === "max_concurrent_positions"));

    // Pending uncertain tx blocks entry until reconciled
    const tNow3 = await advanceForkTime(120);
    positions.beginPendingTx({
      id: "fork-timeout-1",
      decisionKey: "fork:timeout",
      action: "SWAP_HSKSWAP",
      createdAt: tNow3,
    });
    positions.markPendingTxUncertain("fork-timeout-1", "Simulated fork RPC timeout");
    agent.getRiskLimits().maxConcurrentPositions = 5;
    const tPending = await agent.runCycle();
    assert.equal(tPending.selectedAction, "BLOCKED_RISK");
    assert.ok(tPending.riskReport.failedChecks.some((c) => c.name === "no_pending_tx"));

    assert.equal(agent.reconcilePendingTx("fork-timeout-1"), true);
    assert.equal(positions.getPendingTxs().length, 0);

    // Reference unused imports cleanly
    assert.ok(OnChainOracleReader && TWAP_ORACLE_ABI);
  } finally {
    await stopTempAnvil(anvil.proc);
  }
});
