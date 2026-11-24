import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import {
  OfferStatus,
  PriceMode,
  TicketStatus,
  TrancheClient,
  decodeTrancheError,
  deployLocalTrancheStack,
  type DiscoveredOffer,
  type DiscoveredTicket,
  type TrancheDeployment,
} from "@tranche/sdk";
import {
  TrancheHSPAdapter,
  type HSPMandate,
  type HSPSettlementReceipt,
  type HSPStatusReport,
} from "@tranche/hsp-adapter";
import { erc20Abi, formatUnits, zeroAddress, type Address, type Hex } from "viem";

export type DemoPriceMode = "FIXED" | "FLOATING";

export interface EvidenceEntry {
  id: number;
  step: number;
  action: string;
  actor: string;
  txHash: Hex;
  blockNumber: string;
  gasUsed: string;
  detail: string;
  timestamp: string;
}

export interface VaultTokenSnapshot {
  symbol: "WHSK" | "USDT";
  decimals: number;
  address: Address;
  physicalBalance: string;
  physicalBalanceFormatted: string;
  accountedSum: string;
  accountedSumFormatted: string;
  inv1Solvent: boolean;
  totalLpFree: string;
  totalLpFreeFormatted: string;
  totalOfferAvailable: string;
  totalOfferAvailableFormatted: string;
  totalReserved: string;
  totalReservedFormatted: string;
  totalPendingProceeds: string;
  totalPendingProceedsFormatted: string;
  protocolFees: string;
  protocolFeesFormatted: string;
  lpFreeBalance: string;
  lpFreeBalanceFormatted: string;
  lpPendingProceeds: string;
  lpPendingProceedsFormatted: string;
}

export interface OfferSnapshot {
  offerId: string;
  lp: Address;
  priceMode: DemoPriceMode;
  status: "ACTIVE" | "PAUSED" | "CANCELLED";
  inventoryToken: Address;
  paymentToken: Address;
  availableBalance: string;
  availableBalanceFormatted: string;
  minFillAmount: string;
  minFillAmountFormatted: string;
  fixedPriceX36: string;
  spreadBps: number;
  oracle: Address;
  complianceHook: Address;
  minDuration: number;
  maxDuration: number;
  basePremiumBps: number;
  dailyPremiumBps: number;
  expiry: number;
}

export interface TicketSnapshot {
  ticketId: string;
  offerId: string;
  owner: Address | null;
  status: "NONE" | "ACTIVE" | "EXERCISED" | "RECLAIMED";
  priceMode: DemoPriceMode;
  initialAmount: string;
  initialAmountFormatted: string;
  remainingAmount: string;
  remainingAmountFormatted: string;
  reservedAt: number;
  expiresAt: number;
  spreadBps: number;
  fixedOrMinPriceX36: string;
}

export interface ActorBalancesSnapshot {
  role: string;
  address: Address;
  whsk: string;
  whskFormatted: string;
  usdt: string;
  usdtFormatted: string;
  hspCompliant: boolean;
}

export interface DemoState {
  initialized: boolean;
  projectName: "Tranche";
  networkLabel: string;
  rpcUrl: string;
  chainId: number;
  blockNumber: string;
  blockTimestamp: number;
  completedSteps: number[];
  nextStep: number | null;
  allCompleted: boolean;
  activeOfferId: string | null;
  activeTicketId: string | null;
  selectedPriceMode: DemoPriceMode;
  hspStatus: {
    activeMode: "LOCAL_EIP712_COMPLIANCE";
    localReport: HSPStatusReport;
    liveCaasReport: HSPStatusReport;
  };
  contracts: TrancheDeployment["addresses"];
  actors: ActorBalancesSnapshot[];
  offers: OfferSnapshot[];
  tickets: TicketSnapshot[];
  vault: {
    whsk: VaultTokenSnapshot;
    usdt: VaultTokenSnapshot;
    inv1Verified: boolean;
  };
  mandates: HSPMandate[];
  settlementReceipts: HSPSettlementReceipt[];
  stepOutputs: Record<number, unknown>;
  evidenceLog: EvidenceEntry[];
}

export interface Step1Options {
  priceMode?: DemoPriceMode;
  depositAmountWhsk?: string;
  offerAmountWhsk?: string;
}

export interface Step5Options {
  fillPercent?: number;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to allocate free port")));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function resolveAnvilBinary(): string {
  const windowsPath = "C:\\Users\\USER\\.foundry\\bin\\anvil.exe";
  if (existsSync(windowsPath)) return windowsPath;
  return "anvil";
}

async function startManagedAnvil(): Promise<{ rpcUrl: string; proc: ChildProcess }> {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(
    resolveAnvilBinary(),
    ["--host", "127.0.0.1", "--port", String(port), "--silent"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Anvil exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: string };
        if (body.result) {
          return { rpcUrl, proc };
        }
      }
    } catch {
      // Wait for Anvil RPC readiness.
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  proc.kill("SIGKILL");
  throw new Error("Timed out waiting for local Anvil RPC to start.");
}

async function stopManagedAnvil(proc: ChildProcess | undefined): Promise<void> {
  if (!proc) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore already dead process.
      }
      resolve();
    }, 2_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function offerStatusLabel(status: OfferStatus): "ACTIVE" | "PAUSED" | "CANCELLED" {
  switch (Number(status)) {
    case OfferStatus.ACTIVE:
      return "ACTIVE";
    case OfferStatus.PAUSED:
      return "PAUSED";
    default:
      return "CANCELLED";
  }
}

function ticketStatusLabel(status: TicketStatus): "NONE" | "ACTIVE" | "EXERCISED" | "RECLAIMED" {
  switch (Number(status)) {
    case TicketStatus.ACTIVE:
      return "ACTIVE";
    case TicketStatus.EXERCISED:
      return "EXERCISED";
    case TicketStatus.RECLAIMED:
      return "RECLAIMED";
    default:
      return "NONE";
  }
}

function priceModeLabel(mode: PriceMode): DemoPriceMode {
  return Number(mode) === PriceMode.FIXED ? "FIXED" : "FLOATING";
}

function parseWholeUnits(input: string | undefined, defaultWhole: bigint, decimals: number): bigint {
  if (!input) return defaultWhole * 10n ** BigInt(decimals);
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid whole token amount: ${input}`);
  }
  const value = BigInt(trimmed);
  if (value <= 0n) {
    throw new Error(`Token amount must be positive: ${input}`);
  }
  return value * 10n ** BigInt(decimals);
}

export class DemoStepError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "DemoStepError";
    this.statusCode = statusCode;
  }
}

export class TrancheDemoSession {
  private anvilProc?: ChildProcess;
  private deployment?: TrancheDeployment;
  private hspAdapter?: TrancheHSPAdapter;
  private liveCaasProbeAdapter?: TrancheHSPAdapter;

  private adminClient?: TrancheClient;
  private lpClient?: TrancheClient;
  private trader1Client?: TrancheClient;
  private trader2Client?: TrancheClient;
  private keeperClient?: TrancheClient;

  private completedSteps = new Set<number>();
  private activeOfferId: bigint | null = null;
  private activeTicketId: bigint | null = null;
  private selectedPriceMode: DemoPriceMode = "FIXED";
  private plannedReserveAmount = 1_000n * 10n ** 18n;
  private plannedDuration = 600;
  private lastQuoteGrossPremium: bigint | null = null;

  private mandates: HSPMandate[] = [];
  private settlementReceipts: HSPSettlementReceipt[] = [];
  private stepOutputs: Record<number, unknown> = {};
  private evidenceLog: EvidenceEntry[] = [];
  private evidenceSeq = 1;

  private queue: Promise<unknown> = Promise.resolve();

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  public async init(): Promise<DemoState> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      return this.buildState();
    });
  }

  public async reset(): Promise<DemoState> {
    return this.runSerialized(async () => {
      await stopManagedAnvil(this.anvilProc);
      this.anvilProc = undefined;
      await this.initializeInternal();
      return this.buildState();
    });
  }

  public async shutdown(): Promise<void> {
    await stopManagedAnvil(this.anvilProc);
    this.anvilProc = undefined;
  }

  public async getState(): Promise<DemoState> {
    return this.runSerialized(async () => {
      if (!this.deployment) {
        await this.initializeInternal();
      }
      return this.buildState();
    });
  }

  private async initializeInternal(): Promise<void> {
    const externalRpc = process.env.DEMO_RPC_URL?.trim();
    let rpcUrl = externalRpc;
    if (!rpcUrl) {
      const started = await startManagedAnvil();
      this.anvilProc = started.proc;
      rpcUrl = started.rpcUrl;
    }

    const deployment = await deployLocalTrancheStack(rpcUrl, {
      protocolFeeBps: 5,
      minTicketAmount: 100n * 10n ** 18n,
      maxStaleness: 3600,
      maxDeviationBps: 500,
      initialPriceX36: 8n * 10n ** 22n, // 1 WHSK = 0.08 USDT
    });

    this.deployment = deployment;
    this.adminClient = new TrancheClient({
      publicClient: deployment.publicClient,
      walletClient: deployment.accounts.admin.walletClient,
      addresses: deployment.addresses,
    });
    this.lpClient = this.adminClient.withWalletClient(deployment.accounts.lp.walletClient);
    this.trader1Client = this.adminClient.withWalletClient(deployment.accounts.trader1.walletClient);
    this.trader2Client = this.adminClient.withWalletClient(deployment.accounts.trader2.walletClient);
    this.keeperClient = this.adminClient.withWalletClient(deployment.accounts.keeper.walletClient);

    this.hspAdapter = new TrancheHSPAdapter({
      mode: "LOCAL_EIP712_COMPLIANCE",
      chainId: deployment.chainId,
      publicClient: deployment.publicClient,
      complianceHookAddress: deployment.addresses.hspComplianceHook,
      commitmentManagerAddress: deployment.addresses.commitmentManager,
      signerAccount: deployment.accounts.admin.walletClient.account,
      walletClient: deployment.accounts.admin.walletClient,
    });

    this.liveCaasProbeAdapter = new TrancheHSPAdapter({
      mode: "LIVE_HSP_CAAS",
      chainId: 177,
      publicClient: deployment.publicClient,
      complianceHookAddress: deployment.addresses.hspComplianceHook,
      commitmentManagerAddress: deployment.addresses.commitmentManager,
    });

    this.completedSteps.clear();
    this.activeOfferId = null;
    this.activeTicketId = null;
    this.selectedPriceMode = "FIXED";
    this.plannedReserveAmount = 1_000n * 10n ** 18n;
    this.plannedDuration = 600;
    this.lastQuoteGrossPremium = null;
    this.mandates = [];
    this.settlementReceipts = [];
    this.stepOutputs = {};
    this.evidenceLog = [];
    this.evidenceSeq = 1;
  }

  private requireReady(): {
    deployment: TrancheDeployment;
    hspAdapter: TrancheHSPAdapter;
    adminClient: TrancheClient;
    lpClient: TrancheClient;
    trader1Client: TrancheClient;
    trader2Client: TrancheClient;
    keeperClient: TrancheClient;
  } {
    if (
      !this.deployment ||
      !this.hspAdapter ||
      !this.adminClient ||
      !this.lpClient ||
      !this.trader1Client ||
      !this.trader2Client ||
      !this.keeperClient
    ) {
      throw new DemoStepError("Demo session is not initialized yet.", 500);
    }
    return {
      deployment: this.deployment,
      hspAdapter: this.hspAdapter,
      adminClient: this.adminClient,
      lpClient: this.lpClient,
      trader1Client: this.trader1Client,
      trader2Client: this.trader2Client,
      keeperClient: this.keeperClient,
    };
  }

  private async recordTxEvidence(params: {
    step: number;
    action: string;
    actor: string;
    txHash: Hex;
    detail: string;
    blockNumber?: bigint;
    gasUsed?: bigint;
  }): Promise<EvidenceEntry> {
    const { deployment } = this.requireReady();
    let blockNumber = params.blockNumber;
    let gasUsed = params.gasUsed;
    if (blockNumber === undefined || gasUsed === undefined) {
      const receipt = await deployment.publicClient.getTransactionReceipt({ hash: params.txHash });
      blockNumber = receipt.blockNumber;
      gasUsed = receipt.gasUsed;
    }

    const entry: EvidenceEntry = {
      id: this.evidenceSeq++,
      step: params.step,
      action: params.action,
      actor: params.actor,
      txHash: params.txHash,
      blockNumber: blockNumber.toString(),
      gasUsed: gasUsed.toString(),
      detail: params.detail,
      timestamp: new Date().toISOString(),
    };
    this.evidenceLog.push(entry);
    return entry;
  }

  private async attestSubject(
    step: number,
    actorLabel: string,
    subject: Address,
  ): Promise<{ txHash: Hex; blockNumber: string; gasUsed: string; expiry: string }> {
    const { deployment, hspAdapter } = this.requireReady();
    const block = await deployment.publicClient.getBlock({ blockTag: "latest" });
    const expiry = block.timestamp + 30n * 86_400n;
    const envelope = await hspAdapter.signAttestation({ subject, expiry });
    const txHash = await hspAdapter.submitAttestation(envelope);
    const ev = await this.recordTxEvidence({
      step,
      action: "HSPComplianceHook.submitAttestation",
      actor: actorLabel,
      txHash,
      detail: `EIP-712 compliance attestation for ${actorLabel} (${subject}) valid until ${expiry}`,
    });
    return {
      txHash,
      blockNumber: ev.blockNumber,
      gasUsed: ev.gasUsed,
      expiry: expiry.toString(),
    };
  }

  private async refreshPullOracleIfFloating(step: number): Promise<void> {
    if (this.selectedPriceMode !== "FLOATING") return;
    const { deployment, adminClient } = this.requireReady();
    const [latestBlock, pullQuote, adapterQuote] = await Promise.all([
      deployment.publicClient.getBlock({ blockTag: "latest" }),
      adminClient.getOracleQuote(
        deployment.addresses.whsk,
        deployment.addresses.usdt,
        deployment.addresses.signedPullOracle,
      ),
      adminClient.getOracleQuote(
        deployment.addresses.whsk,
        deployment.addresses.usdt,
        deployment.addresses.oraclePriceAdapter,
      ),
    ]);

    if (adapterQuote.isValid && latestBlock.timestamp - pullQuote.updatedAt <= 60n) {
      return;
    }

    if (latestBlock.timestamp <= pullQuote.updatedAt) {
      await deployment.publicClient.request({
        method: "evm_increaseTime" as never,
        params: [2] as never,
      });
      await deployment.publicClient.request({
        method: "evm_mine" as never,
        params: [] as never,
      });
    }

    const res = await adminClient.signAndUpdatePullOraclePrice({
      inventoryToken: deployment.addresses.whsk,
      paymentToken: deployment.addresses.usdt,
      priceX36: 8n * 10n ** 22n,
    });
    await this.recordTxEvidence({
      step,
      action: "SignedPullOracle.updatePrice",
      actor: "OracleSigner (Admin)",
      txHash: res.hash,
      blockNumber: res.blockNumber,
      gasUsed: res.gasUsed,
      detail: "Refreshed signed pull oracle quote: 1 WHSK = 0.08 USDT",
    });
  }

  /**
   * Step 1 — LP Supplies Inventory & Creates Offer
   */
  public async step1(options: Step1Options = {}): Promise<{ stepResult: unknown; state: DemoState }> {
    return this.runSerialized(async () => {
      if (!this.deployment) await this.initializeInternal();
      if (this.completedSteps.has(1)) {
        throw new DemoStepError("Step 1 already completed in this session. Call Reset to run again.");
      }

      const { deployment, lpClient } = this.requireReady();
      const { addresses, accounts, publicClient } = deployment;

      const priceModeChoice: DemoPriceMode = options.priceMode === "FLOATING" ? "FLOATING" : "FIXED";
      const depositAmount = parseWholeUnits(options.depositAmountWhsk, 10_000n, 18);
      const offerAmount = parseWholeUnits(options.offerAmountWhsk, 5_000n, 18);
      if (offerAmount > depositAmount) {
        throw new DemoStepError("Offer allocation cannot exceed deposited WHSK amount.");
      }

      this.selectedPriceMode = priceModeChoice;

      // 1a. Attest LP on HSPComplianceHook (LOCAL_EIP712_COMPLIANCE)
      const lpAttestation = await this.attestSubject(1, "LP", accounts.lp.address);

      // 1b. Deposit WHSK into LiquidityVault
      const depositRes = await lpClient.deposit(addresses.whsk, depositAmount);
      const depositEv = await this.recordTxEvidence({
        step: 1,
        action: "LiquidityVault.deposit",
        actor: "LP",
        txHash: depositRes.hash,
        blockNumber: depositRes.blockNumber,
        gasUsed: depositRes.gasUsed,
        detail: `LP deposited ${formatUnits(depositAmount, 18)} WHSK into LiquidityVault`,
      });

      // 1c. Refresh pull oracle if FLOATING
      await this.refreshPullOracleIfFloating(1);

      // 1d. Create offer gated by HSPComplianceHook
      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const offerExpiry = Number(latestBlock.timestamp) + 7 * 86_400;
      const isFixed = priceModeChoice === "FIXED";

      const createRes = await lpClient.createOffer({
        inventoryToken: addresses.whsk,
        paymentToken: addresses.usdt,
        initialAmount: offerAmount,
        minFillAmount: 100n * 10n ** 18n,
        expiry: offerExpiry,
        minDuration: 60,
        maxDuration: 86_400,
        basePremiumBps: 25,
        dailyPremiumBps: 50,
        priceMode: isFixed ? PriceMode.FIXED : PriceMode.FLOATING,
        spreadBps: isFixed ? 0 : 50,
        oracle: isFixed ? zeroAddress : addresses.oraclePriceAdapter,
        complianceHook: addresses.hspComplianceHook,
        fixedPriceX36: isFixed ? 8n * 10n ** 22n : 0n,
        minPriceX36: isFixed ? 0n : 10n ** 18n,
        maxPriceX36: isFixed ? 0n : 10n ** 26n,
      });

      const createEv = await this.recordTxEvidence({
        step: 1,
        action: "CommitmentManager.createOffer",
        actor: "LP",
        txHash: createRes.hash,
        blockNumber: createRes.blockNumber,
        gasUsed: createRes.gasUsed,
        detail: `Created Offer #${createRes.offerId} (${priceModeChoice}, ${formatUnits(offerAmount, 18)} WHSK, HSP-gated)`,
      });

      this.activeOfferId = createRes.offerId;
      this.completedSteps.add(1);

      const stepResult = {
        step: 1,
        title: "LP Supplies Inventory & Creates Offer",
        hspMode: "LOCAL_EIP712_COMPLIANCE",
        lpAddress: accounts.lp.address,
        offerId: createRes.offerId.toString(),
        priceMode: priceModeChoice,
        depositedWhsk: formatUnits(depositAmount, 18),
        allocatedToOfferWhsk: formatUnits(offerAmount, 18),
        lpFreeRemainingWhsk: formatUnits(depositAmount - offerAmount, 18),
        transactions: {
          attestation: lpAttestation,
          deposit: {
            txHash: depositRes.hash,
            blockNumber: depositEv.blockNumber,
            gasUsed: depositEv.gasUsed,
          },
          createOffer: {
            txHash: createRes.hash,
            blockNumber: createEv.blockNumber,
            gasUsed: createEv.gasUsed,
          },
        },
      };
      this.stepOutputs[1] = stepResult;

      return { stepResult, state: await this.buildState() };
    });
  }

  /**
   * Step 2 — Trader / Agent Discovers Offers
   */
  public async step2(): Promise<{ stepResult: unknown; state: DemoState }> {
    return this.runSerialized(async () => {
      if (!this.completedSteps.has(1) || this.activeOfferId === null) {
        throw new DemoStepError("Run Step 1 before Step 2.");
      }

      const { deployment, trader1Client } = this.requireReady();
      await this.refreshPullOracleIfFloating(2);

      const discovered = await trader1Client.discoverOffers();
      const target = discovered.find((o) => o.offerId === this.activeOfferId);
      if (!target) {
        throw new DemoStepError(`Active offer #${this.activeOfferId} not found on-chain.`);
      }

      const reserveAmount = this.plannedReserveAmount;
      const duration = this.plannedDuration;
      const quote = await trader1Client.quoteReservation(target.offerId, reserveAmount, duration);
      this.lastQuoteGrossPremium = quote.grossPremium;

      let oracleQuote: { priceX36: string; updatedAt: string; isValid: boolean } | null = null;
      if (deployment.addresses.oraclePriceAdapter) {
        const q = await trader1Client.getOracleQuote(
          deployment.addresses.whsk,
          deployment.addresses.usdt,
          deployment.addresses.oraclePriceAdapter,
        );
        oracleQuote = {
          priceX36: q.priceX36.toString(),
          updatedAt: q.updatedAt.toString(),
          isValid: q.isValid,
        };
      }

      this.completedSteps.add(2);

      const stepResult = {
        step: 2,
        title: "Trader / Agent Discovers Offers",
        offersCount: discovered.length,
        selectedOfferId: target.offerId.toString(),
        mode: priceModeLabel(target.priceMode),
        availableCapacityWhsk: formatUnits(target.availableBalance, 18),
        spreadBps: target.spreadBps,
        fixedPriceX36: target.fixedPriceX36.toString(),
        impliedStrikeUsdtPerWhsk:
          priceModeLabel(target.priceMode) === "FIXED"
            ? "0.08"
            : (0.08 * (1 + target.spreadBps / 10_000)).toFixed(4),
        expiry: target.expiry,
        oracleQuote,
        plannedReservation: {
          amountWhsk: formatUnits(reserveAmount, 18),
          durationSeconds: duration,
          grossPremiumRaw: quote.grossPremium.toString(),
          grossPremiumUsdt: formatUnits(quote.grossPremium, 6),
          protocolFeeRaw: quote.protocolFee.toString(),
          protocolFeeUsdt: formatUnits(quote.protocolFee, 6),
          lpNetPremiumUsdt: formatUnits(quote.grossPremium - quote.protocolFee, 6),
        },
      };
      this.stepOutputs[2] = stepResult;

      return { stepResult, state: await this.buildState() };
    });
  }

  /**
   * Step 3 — Trader Reserves Capacity & Receives Ticket
   */
  public async step3(): Promise<{ stepResult: unknown; state: DemoState }> {
    return this.runSerialized(async () => {
      if (!this.completedSteps.has(2) || this.activeOfferId === null) {
        throw new DemoStepError("Run Step 2 before Step 3.");
      }
      if (this.completedSteps.has(3)) {
        throw new DemoStepError("Step 3 already completed in this session. Call Reset to run again.");
      }

      const { deployment, trader1Client, hspAdapter } = this.requireReady();
      const { addresses, accounts, publicClient } = deployment;

      // 3a. Attest Trader 1 on HSPComplianceHook
      const trader1Attestation = await this.attestSubject(3, "Trader1", accounts.trader1.address);
      await this.refreshPullOracleIfFloating(3);

      const offerId = this.activeOfferId;
      const reserveAmount = this.plannedReserveAmount;
      const duration = this.plannedDuration;
      const quote = await trader1Client.quoteReservation(offerId, reserveAmount, duration);

      // 3b. Issue out-of-band HSPMandate
      const latest = await publicClient.getBlock({ blockTag: "latest" });
      const mandate = await hspAdapter.issueMandate({
        subject: accounts.trader1.address,
        counterparty: accounts.lp.address,
        action: "RESERVE",
        offerId,
        inventoryToken: addresses.whsk,
        paymentToken: addresses.usdt,
        maxAmount: quote.grossPremium,
        issuedAt: Number(latest.timestamp),
        expiresAt: Number(latest.timestamp) + 3600,
      });
      this.mandates.push(mandate);

      // Snapshot vault buckets before reserve
      const whskVaultBefore = await trader1Client.getVaultState(addresses.whsk, accounts.lp.address);

      // 3c. Execute on-chain reserve
      const reserveRes = await trader1Client.reserve(
        offerId,
        reserveAmount,
        duration,
        quote.grossPremium,
        accounts.trader1.address,
      );
      const reserveEv = await this.recordTxEvidence({
        step: 3,
        action: "CommitmentManager.reserve",
        actor: "Trader1",
        txHash: reserveRes.hash,
        blockNumber: reserveRes.blockNumber,
        gasUsed: reserveRes.gasUsed,
        detail: `Reserved Ticket #${reserveRes.ticketId} (${formatUnits(reserveAmount, 18)} WHSK, premium ${formatUnits(reserveRes.grossPremium, 6)} USDT)`,
      });

      const ticket = await trader1Client.getTicket(reserveRes.ticketId);
      const whskVaultAfter = await trader1Client.getVaultState(addresses.whsk, accounts.lp.address);

      this.activeTicketId = reserveRes.ticketId;
      this.completedSteps.add(3);

      const stepResult = {
        step: 3,
        title: "Trader Reserves Capacity & Receives Ticket",
        ticketId: reserveRes.ticketId.toString(),
        owner: ticket.owner,
        expiresAt: reserveRes.expiresAt,
        reservedWhsk: formatUnits(reserveAmount, 18),
        grossPremiumUsdt: formatUnits(reserveRes.grossPremium, 6),
        bucketShiftWhsk: {
          offerAvailableBefore: formatUnits(whskVaultBefore.totalOfferAvailable, 18),
          offerAvailableAfter: formatUnits(whskVaultAfter.totalOfferAvailable, 18),
          ticketReservedBefore: formatUnits(whskVaultBefore.totalReserved, 18),
          ticketReservedAfter: formatUnits(whskVaultAfter.totalReserved, 18),
        },
        mandateId: mandate.mandateId,
        transactions: {
          attestation: trader1Attestation,
          reserve: {
            txHash: reserveRes.hash,
            blockNumber: reserveEv.blockNumber,
            gasUsed: reserveEv.gasUsed,
          },
        },
      };
      this.stepOutputs[3] = stepResult;

      return { stepResult, state: await this.buildState() };
    });
  }

  /**
   * Step 4 — Ticket Transferred (Trader 1 -> Trader 2)
   */
  public async step4(): Promise<{ stepResult: unknown; state: DemoState }> {
    return this.runSerialized(async () => {
      if (!this.completedSteps.has(3) || this.activeTicketId === null) {
        throw new DemoStepError("Run Step 3 before Step 4.");
      }
      if (this.completedSteps.has(4)) {
        throw new DemoStepError("Step 4 already completed in this session. Call Reset to run again.");
      }

      const { deployment, trader1Client, trader2Client, hspAdapter } = this.requireReady();
      const { addresses, accounts, publicClient } = deployment;
      const ticketId = this.activeTicketId;

      // 4a. Attest Trader 2 on HSPComplianceHook
      const trader2Attestation = await this.attestSubject(4, "Trader2", accounts.trader2.address);

      // 4b. Issue out-of-band HSPMandate for TRANSFER
      const latest = await publicClient.getBlock({ blockTag: "latest" });
      const ticketBefore = await trader1Client.getTicket(ticketId);
      const mandate = await hspAdapter.issueMandate({
        subject: accounts.trader1.address,
        counterparty: accounts.trader2.address,
        action: "TRANSFER",
        offerId: ticketBefore.offerId,
        ticketId,
        inventoryToken: addresses.whsk,
        paymentToken: addresses.usdt,
        maxAmount: ticketBefore.remainingAmount,
        issuedAt: Number(latest.timestamp),
        expiresAt: Number(latest.timestamp) + 3600,
      });
      this.mandates.push(mandate);

      // 4c. Transfer ERC-721 ExecutionTicket from Trader 1 -> Trader 2
      const transferRes = await trader1Client.transferTicket(
        accounts.trader1.address,
        accounts.trader2.address,
        ticketId,
      );
      const transferEv = await this.recordTxEvidence({
        step: 4,
        action: "ExecutionTicket.transferFrom",
        actor: "Trader1",
        txHash: transferRes.hash,
        blockNumber: transferRes.blockNumber,
        gasUsed: transferRes.gasUsed,
        detail: `Transferred ExecutionTicket #${ticketId} from Trader1 to Trader2`,
      });

      const ticketAfter = await trader2Client.getTicket(ticketId);
      if (ticketAfter.owner?.toLowerCase() !== accounts.trader2.address.toLowerCase()) {
        throw new DemoStepError("Ticket ownership verification failed after transferFrom.", 500);
      }

      this.completedSteps.add(4);

      const stepResult = {
        step: 4,
        title: "Ticket Transferred",
        ticketId: ticketId.toString(),
        from: accounts.trader1.address,
        to: accounts.trader2.address,
        verifiedOwner: ticketAfter.owner,
        mandateId: mandate.mandateId,
        transactions: {
          attestation: trader2Attestation,
          transferFrom: {
            txHash: transferRes.hash,
            blockNumber: transferEv.blockNumber,
            gasUsed: transferEv.gasUsed,
          },
        },
      };
      this.stepOutputs[4] = stepResult;

      return { stepResult, state: await this.buildState() };
    });
  }

  /**
   * Step 5 — Ticket Exercised (Partial Fill, e.g. 60%)
   */
  public async step5(options: Step5Options = {}): Promise<{ stepResult: unknown; state: DemoState }> {
    return this.runSerialized(async () => {
      if (!this.completedSteps.has(4) || this.activeTicketId === null) {
        throw new DemoStepError("Run Step 4 before Step 5.");
      }
      if (this.completedSteps.has(5)) {
        throw new DemoStepError("Step 5 already completed in this session. Call Reset to run again.");
      }

      const { deployment, trader2Client, hspAdapter } = this.requireReady();
      const { addresses, accounts, publicClient } = deployment;
      const ticketId = this.activeTicketId;

      const fillPercent = options.fillPercent ?? 60;
      if (!Number.isInteger(fillPercent) || fillPercent < 10 || fillPercent > 95) {
        throw new DemoStepError("Partial fillPercent must be an integer between 10 and 95.");
      }

      await this.refreshPullOracleIfFloating(5);

      const ticketBefore = await trader2Client.getTicket(ticketId);
      const fillAmount = (ticketBefore.remainingAmount * BigInt(fillPercent)) / 100n;
      const exQuote = await trader2Client.quoteExercise(ticketId, fillAmount);

      const latest = await publicClient.getBlock({ blockTag: "latest" });
      const mandate = await hspAdapter.issueMandate({
        subject: accounts.trader2.address,
        counterparty: accounts.lp.address,
        action: "EXERCISE",
        offerId: ticketBefore.offerId,
        ticketId,
        inventoryToken: addresses.whsk,
        paymentToken: addresses.usdt,
        maxAmount: exQuote.grossPayment,
        issuedAt: Number(latest.timestamp),
        expiresAt: Number(latest.timestamp) + 3600,
      });
      this.mandates.push(mandate);

      const [trader2WhskBefore, trader2UsdtBefore, usdtVaultBefore] = await Promise.all([
        publicClient.readContract({
          address: addresses.whsk,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [accounts.trader2.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addresses.usdt,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [accounts.trader2.address],
        }) as Promise<bigint>,
        trader2Client.getVaultState(addresses.usdt, accounts.lp.address),
      ]);

      const exRes = await trader2Client.exercise(
        ticketId,
        fillAmount,
        exQuote.grossPayment,
        accounts.trader2.address,
      );
      const exEv = await this.recordTxEvidence({
        step: 5,
        action: "CommitmentManager.exercise",
        actor: "Trader2",
        txHash: exRes.hash,
        blockNumber: exRes.blockNumber,
        gasUsed: exRes.gasUsed,
        detail: `Partial fill (${fillPercent}%): ${formatUnits(exRes.actualFill, 18)} WHSK for ${formatUnits(exRes.grossPayment, 6)} USDT`,
      });

      const settlementReceipt = await hspAdapter.buildSettlementReceipt({
        txHash: exRes.hash,
        mandate,
        ticketId,
        exerciser: accounts.trader2.address,
        receiver: accounts.trader2.address,
        inventoryToken: addresses.whsk,
        paymentToken: addresses.usdt,
      });
      this.settlementReceipts.push(settlementReceipt);

      const [ticketAfter, trader2WhskAfter, trader2UsdtAfter, usdtVaultAfter] = await Promise.all([
        trader2Client.getTicket(ticketId),
        publicClient.readContract({
          address: addresses.whsk,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [accounts.trader2.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addresses.usdt,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [accounts.trader2.address],
        }) as Promise<bigint>,
        trader2Client.getVaultState(addresses.usdt, accounts.lp.address),
      ]);

      const lpProceedsDelta =
        (usdtVaultAfter.lpPendingProceeds ?? 0n) - (usdtVaultBefore.lpPendingProceeds ?? 0n);
      const protocolFeeDelta = usdtVaultAfter.protocolFees - usdtVaultBefore.protocolFees;

      this.completedSteps.add(5);

      const stepResult = {
        step: 5,
        title: "Ticket Exercised (Partial Fill)",
        ticketId: ticketId.toString(),
        fillPercent,
        actualFillRaw: exRes.actualFill.toString(),
        actualFillWhsk: formatUnits(exRes.actualFill, 18),
        grossPaymentRaw: exRes.grossPayment.toString(),
        grossPaymentUsdt: formatUnits(exRes.grossPayment, 6),
        effPriceX36: exRes.effPriceX36.toString(),
        remainingAmountRaw: ticketAfter.remainingAmount.toString(),
        remainingAmountWhsk: formatUnits(ticketAfter.remainingAmount, 18),
        trader2WhskReceived: formatUnits(trader2WhskAfter - trader2WhskBefore, 18),
        trader2UsdtPaid: formatUnits(trader2UsdtBefore - trader2UsdtAfter, 6),
        lpPendingProceedsCreditedUsdt: formatUnits(lpProceedsDelta, 6),
        protocolFeeCreditedUsdt: formatUnits(protocolFeeDelta, 6),
        settlementReceipt,
        transactions: {
          exercise: {
            txHash: exRes.hash,
            blockNumber: exEv.blockNumber,
            gasUsed: exEv.gasUsed,
          },
        },
      };
      this.stepOutputs[5] = stepResult;

      return { stepResult, state: await this.buildState() };
    });
  }

  /**
   * Step 6 — Expiry & Reclaim + LP Claim Proceeds + INV-1 Verification
   */
  public async step6(): Promise<{ stepResult: unknown; state: DemoState }> {
    return this.runSerialized(async () => {
      if (!this.completedSteps.has(5) || this.activeTicketId === null || this.activeOfferId === null) {
        throw new DemoStepError("Run Step 5 before Step 6.");
      }
      if (this.completedSteps.has(6)) {
        throw new DemoStepError("Step 6 already completed in this session. Call Reset to run again.");
      }

      const { deployment, keeperClient, lpClient } = this.requireReady();
      const { addresses, accounts, publicClient } = deployment;
      const ticketId = this.activeTicketId;
      const offerId = this.activeOfferId;

      const ticketBefore = await keeperClient.getTicket(ticketId);
      const offerBefore = await lpClient.getOffer(offerId);
      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const currentTs = Number(latestBlock.timestamp);
      const warpSeconds = Math.max(15, ticketBefore.expiresAt - currentTs + 15);

      await publicClient.request({
        method: "evm_increaseTime" as never,
        params: [warpSeconds] as never,
      });
      await publicClient.request({
        method: "evm_mine" as never,
        params: [] as never,
      });
      const postWarpBlock = await publicClient.getBlock({ blockTag: "latest" });

      // Keeper permissionlessly reclaims expired ticket (Keeper has NO HSP attestation -> demonstrates INV-8)
      const reclaimRes = await keeperClient.reclaimExpired(ticketId);
      const reclaimEv = await this.recordTxEvidence({
        step: 6,
        action: "CommitmentManager.reclaimExpired",
        actor: "Keeper (Permissionless)",
        txHash: reclaimRes.hash,
        blockNumber: reclaimRes.blockNumber,
        gasUsed: reclaimRes.gasUsed,
        detail: `Reclaimed ${formatUnits(ticketBefore.remainingAmount, 18)} unused WHSK from expired Ticket #${ticketId}; NFT burned`,
      });

      const ticketAfter = await keeperClient.getTicket(ticketId);
      const offerAfter = await lpClient.getOffer(offerId);

      // LP claims accumulated USDT proceeds
      const lpUsdtBefore = (await publicClient.readContract({
        address: addresses.usdt,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [accounts.lp.address],
      })) as bigint;
      const usdtVaultBeforeClaim = await lpClient.getVaultState(addresses.usdt, accounts.lp.address);
      const pendingBeforeClaim = usdtVaultBeforeClaim.lpPendingProceeds ?? 0n;

      let claimTxInfo: { txHash: Hex; blockNumber: string; gasUsed: string } | null = null;
      if (pendingBeforeClaim > 0n) {
        const claimRes = await lpClient.claimProceeds(addresses.usdt, 0n, accounts.lp.address);
        const claimEv = await this.recordTxEvidence({
          step: 6,
          action: "LiquidityVault.claimProceeds",
          actor: "LP",
          txHash: claimRes.hash,
          blockNumber: claimRes.blockNumber,
          gasUsed: claimRes.gasUsed,
          detail: `LP claimed ${formatUnits(pendingBeforeClaim, 6)} USDT net proceeds from LiquidityVault`,
        });
        claimTxInfo = {
          txHash: claimRes.hash,
          blockNumber: claimEv.blockNumber,
          gasUsed: claimEv.gasUsed,
        };
      }

      const lpUsdtAfter = (await publicClient.readContract({
        address: addresses.usdt,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [accounts.lp.address],
      })) as bigint;

      const state = await this.buildState();
      if (!state.vault.inv1Verified) {
        throw new DemoStepError("INV-1 physical vault solvency check failed!", 500);
      }

      this.completedSteps.add(6);

      const stepResult = {
        step: 6,
        title: "Expiry & Reclaim",
        warpedSeconds: warpSeconds,
        warpedBlockTimestamp: Number(postWarpBlock.timestamp),
        ticketId: ticketId.toString(),
        ticketStatusAfter: ticketStatusLabel(ticketAfter.status),
        nftBurned: ticketAfter.owner === null,
        reclaimedWhsk: formatUnits(ticketBefore.remainingAmount, 18),
        offerAvailableBeforeWhsk: formatUnits(offerBefore.availableBalance, 18),
        offerAvailableAfterWhsk: formatUnits(offerAfter.availableBalance, 18),
        lpClaimedUsdt: formatUnits(lpUsdtAfter - lpUsdtBefore, 6),
        inv1Solvent: state.vault.inv1Verified,
        vaultSolvency: {
          whsk: {
            physical: state.vault.whsk.physicalBalanceFormatted,
            accounted: state.vault.whsk.accountedSumFormatted,
            solvent: state.vault.whsk.inv1Solvent,
          },
          usdt: {
            physical: state.vault.usdt.physicalBalanceFormatted,
            accounted: state.vault.usdt.accountedSumFormatted,
            solvent: state.vault.usdt.inv1Solvent,
          },
        },
        transactions: {
          reclaimExpired: {
            txHash: reclaimRes.hash,
            blockNumber: reclaimEv.blockNumber,
            gasUsed: reclaimEv.gasUsed,
          },
          claimProceeds: claimTxInfo,
        },
      };
      this.stepOutputs[6] = stepResult;

      return { stepResult, state: await this.buildState() };
    });
  }

  public async runAllSteps(options: Step1Options & Step5Options = {}): Promise<{
    results: unknown[];
    state: DemoState;
  }> {
    if (this.completedSteps.size > 0) {
      await this.reset();
    }
    const r1 = await this.step1(options);
    const r2 = await this.step2();
    const r3 = await this.step3();
    const r4 = await this.step4();
    const r5 = await this.step5(options);
    const r6 = await this.step6();
    return {
      results: [r1.stepResult, r2.stepResult, r3.stepResult, r4.stepResult, r5.stepResult, r6.stepResult],
      state: r6.state,
    };
  }

  private async getVaultTokenSnapshot(
    symbol: "WHSK" | "USDT",
    token: Address,
    decimals: number,
  ): Promise<VaultTokenSnapshot> {
    const { deployment, lpClient } = this.requireReady();
    const [vaultState, physicalBalance] = await Promise.all([
      lpClient.getVaultState(token, deployment.accounts.lp.address),
      deployment.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [deployment.addresses.liquidityVault],
      }) as Promise<bigint>,
    ]);

    const accountedSum =
      vaultState.totalLpFree +
      vaultState.totalOfferAvailable +
      vaultState.totalReserved +
      vaultState.totalPendingProceeds +
      vaultState.protocolFees;

    const lpFreeBalance = vaultState.lpFreeBalance ?? 0n;
    const lpPendingProceeds = vaultState.lpPendingProceeds ?? 0n;

    return {
      symbol,
      decimals,
      address: token,
      physicalBalance: physicalBalance.toString(),
      physicalBalanceFormatted: formatUnits(physicalBalance, decimals),
      accountedSum: accountedSum.toString(),
      accountedSumFormatted: formatUnits(accountedSum, decimals),
      inv1Solvent: physicalBalance >= accountedSum,
      totalLpFree: vaultState.totalLpFree.toString(),
      totalLpFreeFormatted: formatUnits(vaultState.totalLpFree, decimals),
      totalOfferAvailable: vaultState.totalOfferAvailable.toString(),
      totalOfferAvailableFormatted: formatUnits(vaultState.totalOfferAvailable, decimals),
      totalReserved: vaultState.totalReserved.toString(),
      totalReservedFormatted: formatUnits(vaultState.totalReserved, decimals),
      totalPendingProceeds: vaultState.totalPendingProceeds.toString(),
      totalPendingProceedsFormatted: formatUnits(vaultState.totalPendingProceeds, decimals),
      protocolFees: vaultState.protocolFees.toString(),
      protocolFeesFormatted: formatUnits(vaultState.protocolFees, decimals),
      lpFreeBalance: lpFreeBalance.toString(),
      lpFreeBalanceFormatted: formatUnits(lpFreeBalance, decimals),
      lpPendingProceeds: lpPendingProceeds.toString(),
      lpPendingProceedsFormatted: formatUnits(lpPendingProceeds, decimals),
    };
  }

  private async buildState(): Promise<DemoState> {
    const { deployment, lpClient, hspAdapter } = this.requireReady();
    const { addresses, accounts, publicClient } = deployment;

    const [block, rawOffers, rawTickets, whskVault, usdtVault, localReport, liveCaasReport] =
      await Promise.all([
        publicClient.getBlock({ blockTag: "latest" }),
        lpClient.discoverOffers(),
        lpClient.discoverTickets(),
        this.getVaultTokenSnapshot("WHSK", addresses.whsk, 18),
        this.getVaultTokenSnapshot("USDT", addresses.usdt, 6),
        hspAdapter.getStatusReport(),
        this.liveCaasProbeAdapter!.getStatusReport(),
      ]);

    const actorList = [
      accounts.lp,
      accounts.trader1,
      accounts.trader2,
      accounts.keeper,
      accounts.admin,
    ];

    const actors: ActorBalancesSnapshot[] = await Promise.all(
      actorList.map(async (acc) => {
        const [whskBal, usdtBal, compliant] = await Promise.all([
          publicClient.readContract({
            address: addresses.whsk,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [acc.address],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: addresses.usdt,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [acc.address],
          }) as Promise<bigint>,
          hspAdapter.isCompliant(acc.address),
        ]);
        return {
          role: acc.role,
          address: acc.address,
          whsk: whskBal.toString(),
          whskFormatted: formatUnits(whskBal, 18),
          usdt: usdtBal.toString(),
          usdtFormatted: formatUnits(usdtBal, 6),
          hspCompliant: compliant,
        };
      }),
    );

    const offers: OfferSnapshot[] = rawOffers.map((o: DiscoveredOffer) => ({
      offerId: o.offerId.toString(),
      lp: o.lp,
      priceMode: priceModeLabel(o.priceMode),
      status: offerStatusLabel(o.status),
      inventoryToken: o.inventoryToken,
      paymentToken: o.paymentToken,
      availableBalance: o.availableBalance.toString(),
      availableBalanceFormatted: formatUnits(o.availableBalance, 18),
      minFillAmount: o.minFillAmount.toString(),
      minFillAmountFormatted: formatUnits(o.minFillAmount, 18),
      fixedPriceX36: o.fixedPriceX36.toString(),
      spreadBps: o.spreadBps,
      oracle: o.oracle,
      complianceHook: o.complianceHook,
      minDuration: o.minDuration,
      maxDuration: o.maxDuration,
      basePremiumBps: o.basePremiumBps,
      dailyPremiumBps: o.dailyPremiumBps,
      expiry: o.expiry,
    }));

    const tickets: TicketSnapshot[] = rawTickets.map((t: DiscoveredTicket) => ({
      ticketId: t.ticketId.toString(),
      offerId: t.offerId.toString(),
      owner: t.owner,
      status: ticketStatusLabel(t.status),
      priceMode: priceModeLabel(t.priceMode),
      initialAmount: t.initialAmount.toString(),
      initialAmountFormatted: formatUnits(t.initialAmount, 18),
      remainingAmount: t.remainingAmount.toString(),
      remainingAmountFormatted: formatUnits(t.remainingAmount, 18),
      reservedAt: t.reservedAt,
      expiresAt: t.expiresAt,
      spreadBps: t.spreadBps,
      fixedOrMinPriceX36: t.fixedOrMinPriceX36.toString(),
    }));

    const completedArr = [...this.completedSteps].sort((a, b) => a - b);
    const allCompleted = completedArr.length === 6;
    const nextStep = allCompleted ? null : (completedArr[completedArr.length - 1] ?? 0) + 1;

    return {
      initialized: true,
      projectName: "Tranche",
      networkLabel: "Local Anvil Sim — Zero Mainnet Spend",
      rpcUrl: deployment.rpcUrl,
      chainId: deployment.chainId,
      blockNumber: block.number.toString(),
      blockTimestamp: Number(block.timestamp),
      completedSteps: completedArr,
      nextStep,
      allCompleted,
      activeOfferId: this.activeOfferId?.toString() ?? null,
      activeTicketId: this.activeTicketId?.toString() ?? null,
      selectedPriceMode: this.selectedPriceMode,
      hspStatus: {
        activeMode: "LOCAL_EIP712_COMPLIANCE",
        localReport,
        liveCaasReport,
      },
      contracts: addresses,
      actors,
      offers,
      tickets,
      vault: {
        whsk: whskVault,
        usdt: usdtVault,
        inv1Verified: whskVault.inv1Solvent && usdtVault.inv1Solvent,
      },
      mandates: this.mandates,
      settlementReceipts: this.settlementReceipts,
      stepOutputs: this.stepOutputs,
      evidenceLog: this.evidenceLog,
    };
  }
}

export function formatTrancheError(err: unknown): { statusCode: number; message: string } {
  if (err instanceof DemoStepError) {
    return { statusCode: err.statusCode, message: err.message };
  }
  const decoded = decodeTrancheError(err);
  if (decoded.errorName !== "UnknownError") {
    return {
      statusCode: 400,
      message: `${decoded.contract}.${decoded.errorName}: ${decoded.rawMessage}`,
    };
  }
  return {
    statusCode: 500,
    message: err instanceof Error ? err.message : String(err),
  };
}
