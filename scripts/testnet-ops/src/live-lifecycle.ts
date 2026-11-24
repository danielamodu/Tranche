import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABIS, PriceMode, TicketStatus, TrancheClient, type TrancheAddresses } from "@tranche/sdk";
import { FailoverRpcPool } from "./rpc-failover.js";

export interface LifecycleStepProof {
  stage: string;
  txHash: Hex;
  explorerUrl: string;
  gasUsed: bigint;
  eventVerified: string;
  summary: string;
}

export interface LiveLifecycleParams {
  publicClient: PublicClient;
  lpWalletClient: WalletClient;
  traderWalletClient: WalletClient;
  addresses: TrancheAddresses;
  inventoryToken: Address;
  paymentToken: Address;
  depositAmount: bigint;
  offerAmount: bigint;
  reserveAmount: bigint;
  minFillAmount: bigint;
  fixedPriceX36: bigint;
  explorerTxBaseUrl?: string;
}

function assertEventInLogs(logs: Log[], contractAddress: Address, abi: Abi, expectedEvent: string): void {
  const target = contractAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== target) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === expectedEvent) return;
    } catch {
      // ignore non-matching logs
    }
  }
  throw new Error(`Expected event ${expectedEvent} not found on ${contractAddress}`);
}

async function assertVaultSolvent(
  publicClient: PublicClient,
  vaultAddress: Address,
  token: Address,
): Promise<{ vaultBalance: bigint; sumBuckets: bigint }> {
  const [vaultBalance, lpFree, offerAvail, reserved, pendingProceeds, protocolFees] =
    (await Promise.all([
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vaultAddress],
      }),
      publicClient.readContract({
        address: vaultAddress,
        abi: ABIS.LiquidityVault as Abi,
        functionName: "totalLpFree",
        args: [token],
      }),
      publicClient.readContract({
        address: vaultAddress,
        abi: ABIS.LiquidityVault as Abi,
        functionName: "totalOfferAvailable",
        args: [token],
      }),
      publicClient.readContract({
        address: vaultAddress,
        abi: ABIS.LiquidityVault as Abi,
        functionName: "totalReserved",
        args: [token],
      }),
      publicClient.readContract({
        address: vaultAddress,
        abi: ABIS.LiquidityVault as Abi,
        functionName: "totalPendingProceeds",
        args: [token],
      }),
      publicClient.readContract({
        address: vaultAddress,
        abi: ABIS.LiquidityVault as Abi,
        functionName: "protocolFees",
        args: [token],
      }),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint];

  const sumBuckets = lpFree + offerAvail + reserved + pendingProceeds + protocolFees;
  if (vaultBalance < sumBuckets) {
    throw new Error(`INV-1 violated for ${token}: balance=${vaultBalance} < sumBuckets=${sumBuckets}`);
  }
  return { vaultBalance, sumBuckets };
}

async function approveIfNeeded(
  publicClient: PublicClient,
  walletClient: WalletClient,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const owner = walletClient.account!.address;
  const allowance = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (allowance >= amount) return;
  const hash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: walletClient.chain,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`ERC-20 approve failed: ${hash}`);
}

export async function runLiveLifecycle(params: LiveLifecycleParams): Promise<{
  offerId: bigint;
  ticketId: bigint;
  steps: LifecycleStepProof[];
}> {
  const { publicClient, lpWalletClient, traderWalletClient, addresses } = params;
  const lpAddr = lpWalletClient.account!.address;
  const traderAddr = traderWalletClient.account!.address;
  if (lpAddr.toLowerCase() === traderAddr.toLowerCase()) {
    throw new Error("LP and Trader must be separate accounts.");
  }

  const explorerBase = params.explorerTxBaseUrl ?? "https://testnet-explorer.hskchain.net/tx/";
  const lpClient = new TrancheClient({ publicClient, walletClient: lpWalletClient, addresses });
  const traderClient = new TrancheClient({ publicClient, walletClient: traderWalletClient, addresses });
  const steps: LifecycleStepProof[] = [];

  // 1. LP Deposit into LiquidityVault
  await approveIfNeeded(publicClient, lpWalletClient, params.inventoryToken, addresses.liquidityVault, params.depositAmount);
  const lpFreeBefore = (await publicClient.readContract({
    address: addresses.liquidityVault,
    abi: ABIS.LiquidityVault as Abi,
    functionName: "lpFreeBalance",
    args: [lpAddr, params.inventoryToken],
  })) as bigint;

  const depRes = await lpClient.deposit(params.inventoryToken, params.depositAmount);
  assertEventInLogs(depRes.receipt.logs, addresses.liquidityVault, ABIS.LiquidityVault as Abi, "Deposited");
  const lpFreeAfter = (await publicClient.readContract({
    address: addresses.liquidityVault,
    abi: ABIS.LiquidityVault as Abi,
    functionName: "lpFreeBalance",
    args: [lpAddr, params.inventoryToken],
  })) as bigint;
  if (lpFreeAfter - lpFreeBefore !== params.depositAmount) {
    throw new Error("LP free balance did not increment by exact depositAmount");
  }
  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.inventoryToken);
  steps.push({
    stage: "1. LP Deposit",
    txHash: depRes.hash,
    explorerUrl: `${explorerBase}${depRes.hash}`,
    gasUsed: depRes.gasUsed,
    eventVerified: "Deposited",
    summary: `Deposited ${params.depositAmount} inv units; vault INV-1 solvent`,
  });

  // 2. LP Offer Creation (FIXED)
  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  const offerRes = await lpClient.createOffer({
    inventoryToken: params.inventoryToken,
    paymentToken: params.paymentToken,
    initialAmount: params.offerAmount,
    minFillAmount: params.minFillAmount,
    expiry: Number(latestBlock.timestamp + 3_600n),
    minDuration: 60,
    maxDuration: 1_800,
    basePremiumBps: 50,
    dailyPremiumBps: 0,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: "0x0000000000000000000000000000000000000000",
    complianceHook: "0x0000000000000000000000000000000000000000",
    fixedPriceX36: params.fixedPriceX36,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });
  assertEventInLogs(offerRes.receipt.logs, addresses.commitmentManager, ABIS.CommitmentManager as Abi, "OfferCreated");
  const offerBalAfterCreate = (await publicClient.readContract({
    address: addresses.liquidityVault,
    abi: ABIS.LiquidityVault as Abi,
    functionName: "offerBalance",
    args: [offerRes.offerId],
  })) as bigint;
  if (offerBalAfterCreate !== params.offerAmount) {
    throw new Error(`Expected offerBalance=${params.offerAmount}, got ${offerBalAfterCreate}`);
  }
  steps.push({
    stage: "2. Offer Creation",
    txHash: offerRes.hash,
    explorerUrl: `${explorerBase}${offerRes.hash}`,
    gasUsed: offerRes.gasUsed,
    eventVerified: "OfferCreated",
    summary: `Offer #${offerRes.offerId} created with ${params.offerAmount} inv units`,
  });

  // 3. Trader Reservation & Ticket Issuance
  const resQuote = await traderClient.quoteReservation(offerRes.offerId, params.reserveAmount, 600);
  await approveIfNeeded(publicClient, traderWalletClient, params.paymentToken, addresses.liquidityVault, resQuote.grossPremium);
  const resTx = await traderClient.reserve(offerRes.offerId, params.reserveAmount, 600, resQuote.grossPremium, traderAddr);
  assertEventInLogs(resTx.receipt.logs, addresses.commitmentManager, ABIS.CommitmentManager as Abi, "TicketReserved");

  const ticketOwner = (await publicClient.readContract({
    address: addresses.executionTicket,
    abi: ABIS.ExecutionTicket as Abi,
    functionName: "ownerOf",
    args: [resTx.ticketId],
  })) as Address;
  if (ticketOwner.toLowerCase() !== traderAddr.toLowerCase()) {
    throw new Error(`Ticket #${resTx.ticketId} owner mismatch: ${ticketOwner} != ${traderAddr}`);
  }
  const ticketReserved = (await publicClient.readContract({
    address: addresses.liquidityVault,
    abi: ABIS.LiquidityVault as Abi,
    functionName: "ticketReserved",
    args: [resTx.ticketId],
  })) as bigint;
  if (ticketReserved !== params.reserveAmount) {
    throw new Error(`ticketReserved mismatch: ${ticketReserved} != ${params.reserveAmount}`);
  }
  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.inventoryToken);
  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.paymentToken);
  steps.push({
    stage: "3. Trader Reserve & Ticket Mint",
    txHash: resTx.hash,
    explorerUrl: `${explorerBase}${resTx.hash}`,
    gasUsed: resTx.gasUsed,
    eventVerified: "TicketReserved",
    summary: `Ticket #${resTx.ticketId} minted to ${traderAddr}; grossPremium=${resQuote.grossPremium}`,
  });

  // 4. Trader Exercise & Settlement
  const exQuote = await traderClient.quoteExercise(resTx.ticketId, params.reserveAmount);
  await approveIfNeeded(publicClient, traderWalletClient, params.paymentToken, addresses.liquidityVault, exQuote.grossPayment);
  const traderInvBefore = (await publicClient.readContract({
    address: params.inventoryToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [traderAddr],
  })) as bigint;

  const exTx = await traderClient.exercise(resTx.ticketId, params.reserveAmount, exQuote.grossPayment, traderAddr);
  assertEventInLogs(exTx.receipt.logs, addresses.commitmentManager, ABIS.CommitmentManager as Abi, "TicketExercised");
  const traderInvAfter = (await publicClient.readContract({
    address: params.inventoryToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [traderAddr],
  })) as bigint;
  if (traderInvAfter - traderInvBefore !== params.reserveAmount) {
    throw new Error("Trader did not receive exact exercised inventory");
  }
  const ticketState = await traderClient.getTicket(resTx.ticketId);
  if (ticketState.status !== TicketStatus.EXERCISED) {
    throw new Error(`Expected TicketStatus.EXERCISED, got ${ticketState.status}`);
  }
  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.inventoryToken);
  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.paymentToken);
  steps.push({
    stage: "4. Trader Exercise & Settlement",
    txHash: exTx.hash,
    explorerUrl: `${explorerBase}${exTx.hash}`,
    gasUsed: exTx.gasUsed,
    eventVerified: "TicketExercised",
    summary: `Filled ${params.reserveAmount} inv for ${exQuote.grossPayment} pay; ticket burned`,
  });

  // 5. LP Proceeds Claim & Unused Inventory Withdrawal
  const lpPayBefore = (await publicClient.readContract({
    address: params.paymentToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [lpAddr],
  })) as bigint;
  const claimTx = await lpClient.claimProceeds(params.paymentToken, 0n, lpAddr);
  assertEventInLogs(claimTx.receipt.logs, addresses.liquidityVault, ABIS.LiquidityVault as Abi, "ProceedsClaimed");
  const lpPayAfter = (await publicClient.readContract({
    address: params.paymentToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [lpAddr],
  })) as bigint;
  const claimedProceeds = lpPayAfter - lpPayBefore;
  if (claimedProceeds <= 0n) throw new Error("LP claimed 0 proceeds");
  steps.push({
    stage: "5. LP Claim Proceeds",
    txHash: claimTx.hash,
    explorerUrl: `${explorerBase}${claimTx.hash}`,
    gasUsed: claimTx.gasUsed,
    eventVerified: "ProceedsClaimed",
    summary: `LP claimed ${claimedProceeds} net paymentToken proceeds`,
  });

  const remOffer = (await publicClient.readContract({
    address: addresses.liquidityVault,
    abi: ABIS.LiquidityVault as Abi,
    functionName: "offerBalance",
    args: [offerRes.offerId],
  })) as bigint;
  if (remOffer > 0n) {
    await lpClient.cancelOffer(offerRes.offerId);
  }
  const lpFreeToWithdraw = (await publicClient.readContract({
    address: addresses.liquidityVault,
    abi: ABIS.LiquidityVault as Abi,
    functionName: "lpFreeBalance",
    args: [lpAddr, params.inventoryToken],
  })) as bigint;
  if (lpFreeToWithdraw > 0n) {
    const wdTx = await lpClient.withdrawFree(params.inventoryToken, lpFreeToWithdraw, lpAddr);
    assertEventInLogs(wdTx.receipt.logs, addresses.liquidityVault, ABIS.LiquidityVault as Abi, "WithdrawnFree");
    steps.push({
      stage: "6. LP Withdraw Unused Inventory",
      txHash: wdTx.hash,
      explorerUrl: `${explorerBase}${wdTx.hash}`,
      gasUsed: wdTx.gasUsed,
      eventVerified: "WithdrawnFree",
      summary: `LP withdrew ${lpFreeToWithdraw} unused inv units`,
    });
  }

  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.inventoryToken);
  await assertVaultSolvent(publicClient, addresses.liquidityVault, params.paymentToken);

  return { offerId: offerRes.offerId, ticketId: resTx.ticketId, steps };
}

async function main(): Promise<void> {
  const manifestPath = resolve(process.cwd(), "../../deployments/hashkey-testnet.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    deploymentStatus?: string;
    network: { chainId: number; rpcUrls: string[] };
    canonicalInfrastructure: { WHSK: { address: Address } };
    contracts: TrancheAddresses & { tUSDT?: Address };
  };

  if (manifest.deploymentStatus !== "LIVE_DEPLOYED") {
    throw new Error(
      `Refusing to run live lifecycle: deployments/hashkey-testnet.json status is "${manifest.deploymentStatus}". Deploy first and update live addresses.`,
    );
  }

  const lpPk = process.env.LP_PRIVATE_KEY as Hex | undefined;
  const traderPk = process.env.TRADER_PRIVATE_KEY as Hex | undefined;
  if (!lpPk || !traderPk) {
    throw new Error("LP_PRIVATE_KEY and TRADER_PRIVATE_KEY environment variables are required.");
  }

  const rpcPool = new FailoverRpcPool({ urls: manifest.network.rpcUrls });
  const chain = defineChain({
    id: manifest.network.chainId,
    name: "HashKey Chain Testnet",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [...manifest.network.rpcUrls] } },
  });
  const transport = rpcPool.toViemTransport();
  const publicClient = createPublicClient({ chain, transport });
  const lpWalletClient = createWalletClient({ account: privateKeyToAccount(lpPk), chain, transport });
  const traderWalletClient = createWalletClient({ account: privateKeyToAccount(traderPk), chain, transport });

  const result = await runLiveLifecycle({
    publicClient,
    lpWalletClient,
    traderWalletClient,
    addresses: manifest.contracts,
    inventoryToken: manifest.canonicalInfrastructure.WHSK.address,
    paymentToken: manifest.contracts.tUSDT!,
    depositAmount: parseUnits("20", 18),
    offerAmount: parseUnits("20", 18),
    reserveAmount: parseUnits("10", 18),
    minFillAmount: parseUnits("10", 18),
    fixedPriceX36: 82_000n * 10n ** 18n, // $0.082/WHSK
  });

  console.log("=== Tranche Live Testnet Lifecycle Proof ===");
  for (const s of result.steps) {
    console.log(`${s.stage} | tx=${s.txHash} | gas=${s.gasUsed} | event=${s.eventVerified} | ${s.summary}`);
    console.log(`  Explorer: ${s.explorerUrl}`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("[tranche-lifecycle]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
