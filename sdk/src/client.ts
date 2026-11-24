import {
  decodeEventLog,
  erc20Abi,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ABIS } from "./abis.js";
import {
  TicketStatus,
  type BatchExerciseParams,
  type CreateOfferParams,
  type DiscoveredOffer,
  type DiscoveredTicket,
  type ExerciseQuote,
  type Offer,
  type OraclePriceQuote,
  type ReservationQuote,
  type Ticket,
  type TrancheAddresses,
  type TxExecutionResult,
  type VaultTokenState,
} from "./types.js";

export interface TrancheClientConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  addresses: TrancheAddresses;
}

export interface SignAndUpdatePullOraclePriceParams {
  inventoryToken: Address;
  paymentToken: Address;
  priceX36: bigint;
  reportTimestamp?: bigint;
  signerWalletClient?: WalletClient;
  signerWalletClients?: WalletClient[];
}

export class TrancheClient {
  public readonly publicClient: PublicClient;
  public readonly walletClient?: WalletClient;
  public readonly addresses: TrancheAddresses;

  constructor(config: TrancheClientConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.addresses = config.addresses;
  }

  /**
   * Returns a new TrancheClient bound to a different WalletClient while sharing
   * the same PublicClient and contract addresses.
   */
  public withWalletClient(walletClient: WalletClient): TrancheClient {
    return new TrancheClient({
      publicClient: this.publicClient,
      walletClient,
      addresses: this.addresses,
    });
  }

  private requireWallet(): { walletClient: WalletClient; account: NonNullable<WalletClient["account"]> } {
    if (!this.walletClient || !this.walletClient.account) {
      throw new Error("TrancheClient write operation requires a WalletClient with an active account.");
    }
    return {
      walletClient: this.walletClient,
      account: this.walletClient.account,
    };
  }

  private async executeContractWrite(params: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
  }): Promise<TxExecutionResult> {
    const { walletClient, account } = this.requireWallet();
    const { request } = await this.publicClient.simulateContract({
      account,
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args ?? [],
      value: params.value,
    });

    const hash = await walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Transaction reverted on-chain: ${hash}`);
    }

    return {
      hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      receipt,
    };
  }

  private findEventArgs<TArgs extends Record<string, unknown>>(
    logs: Log[],
    contractAddress: Address,
    abi: Abi,
    eventName: string,
  ): TArgs | undefined {
    const target = contractAddress.toLowerCase();
    for (const log of logs) {
      if (log.address.toLowerCase() !== target) continue;
      try {
        const decoded = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === eventName) {
          return decoded.args as unknown as TArgs;
        }
      } catch {
        // Not this event signature; continue scanning logs.
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Offer & Ticket Discovery / Quotes
  // ---------------------------------------------------------------------------

  public async getOffer(offerId: bigint): Promise<DiscoveredOffer> {
    const [rawOffer, availableBalance] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.commitmentManager,
        abi: ABIS.CommitmentManager,
        functionName: "getOffer",
        args: [offerId],
      }) as Promise<Offer>,
      this.publicClient.readContract({
        address: this.addresses.liquidityVault,
        abi: ABIS.LiquidityVault,
        functionName: "offerBalance",
        args: [offerId],
      }) as Promise<bigint>,
    ]);

    return {
      ...rawOffer,
      offerId,
      availableBalance,
    };
  }

  public async discoverOffers(): Promise<DiscoveredOffer[]> {
    const nextOfferId = (await this.publicClient.readContract({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "nextOfferId",
    })) as bigint;

    if (nextOfferId <= 1n) return [];

    const ids: bigint[] = [];
    for (let id = 1n; id < nextOfferId; id++) {
      ids.push(id);
    }
    return Promise.all(ids.map((id) => this.getOffer(id)));
  }

  public async getTicket(ticketId: bigint): Promise<DiscoveredTicket> {
    const rawTicket = (await this.publicClient.readContract({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "getTicket",
      args: [ticketId],
    })) as Ticket;

    let owner: Address | null = null;
    if (Number(rawTicket.status) === TicketStatus.ACTIVE) {
      owner = (await this.publicClient.readContract({
        address: this.addresses.executionTicket,
        abi: ABIS.ExecutionTicket,
        functionName: "ownerOf",
        args: [ticketId],
      })) as Address;
    }

    return {
      ...rawTicket,
      ticketId,
      owner,
    };
  }

  public async discoverTickets(options?: { activeOnly?: boolean }): Promise<DiscoveredTicket[]> {
    const nextTicketId = (await this.publicClient.readContract({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "nextTicketId",
    })) as bigint;

    if (nextTicketId <= 1n) return [];

    const ids: bigint[] = [];
    for (let id = 1n; id < nextTicketId; id++) {
      ids.push(id);
    }

    const tickets = await Promise.all(ids.map((id) => this.getTicket(id)));
    if (options?.activeOnly) {
      return tickets.filter((t) => Number(t.status) === TicketStatus.ACTIVE);
    }
    return tickets;
  }

  public async getVaultState(token: Address, lp?: Address): Promise<VaultTokenState> {
    const [totalLpFree, totalOfferAvailable, totalReserved, totalPendingProceeds, protocolFees] =
      (await Promise.all([
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "totalLpFree",
          args: [token],
        }),
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "totalOfferAvailable",
          args: [token],
        }),
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "totalReserved",
          args: [token],
        }),
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "totalPendingProceeds",
          args: [token],
        }),
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "protocolFees",
          args: [token],
        }),
      ])) as [bigint, bigint, bigint, bigint, bigint];

    const state: VaultTokenState = {
      token,
      totalLpFree,
      totalOfferAvailable,
      totalReserved,
      totalPendingProceeds,
      protocolFees,
    };

    if (lp) {
      const [lpFreeBalance, lpPendingProceeds] = (await Promise.all([
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "lpFreeBalance",
          args: [lp, token],
        }),
        this.publicClient.readContract({
          address: this.addresses.liquidityVault,
          abi: ABIS.LiquidityVault,
          functionName: "lpPendingProceeds",
          args: [lp, token],
        }),
      ])) as [bigint, bigint];
      state.lpFreeBalance = lpFreeBalance;
      state.lpPendingProceeds = lpPendingProceeds;
    }

    return state;
  }

  public async quoteReservation(
    offerId: bigint,
    inventoryAmount: bigint,
    duration: number,
  ): Promise<ReservationQuote> {
    const [grossPremium, protocolFee] = (await this.publicClient.readContract({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "quoteReservation",
      args: [offerId, inventoryAmount, duration],
    })) as [bigint, bigint];

    return { grossPremium, protocolFee };
  }

  public async quoteExercise(ticketId: bigint, fillAmount: bigint): Promise<ExerciseQuote> {
    const [actualFill, grossPayment, effPriceX36] = (await this.publicClient.readContract({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "quoteExercise",
      args: [ticketId, fillAmount],
    })) as [bigint, bigint, bigint];

    return { actualFill, grossPayment, effPriceX36 };
  }

  public async getOracleQuote(
    inventoryToken: Address,
    paymentToken: Address,
    oracleAddress?: Address,
  ): Promise<OraclePriceQuote> {
    const targetOracle =
      oracleAddress ?? this.addresses.oraclePriceAdapter ?? this.addresses.signedPullOracle;
    if (!targetOracle) {
      throw new Error("No oracle address provided or configured on TrancheClient.");
    }
    const quote = (await this.publicClient.readContract({
      address: targetOracle,
      abi: ABIS.OraclePriceAdapter,
      functionName: "getPriceX36",
      args: [inventoryToken, paymentToken],
    })) as OraclePriceQuote;
    return quote;
  }

  // ---------------------------------------------------------------------------
  // LP Actions
  // ---------------------------------------------------------------------------

  public async deposit(token: Address, amount: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.liquidityVault,
      abi: ABIS.LiquidityVault,
      functionName: "deposit",
      args: [token, amount],
    });
  }

  public async withdrawFree(token: Address, amount: bigint, to: Address): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.liquidityVault,
      abi: ABIS.LiquidityVault,
      functionName: "withdrawFree",
      args: [token, amount, to],
    });
  }

  public async claimProceeds(token: Address, amount: bigint, to: Address): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.liquidityVault,
      abi: ABIS.LiquidityVault,
      functionName: "claimProceeds",
      args: [token, amount, to],
    });
  }

  public async createOffer(params: CreateOfferParams): Promise<TxExecutionResult<{ offerId: bigint }>> {
    const res = await this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "createOffer",
      args: [params],
    });

    const eventArgs = this.findEventArgs<{ offerId: bigint }>(
      res.receipt.logs,
      this.addresses.commitmentManager,
      ABIS.CommitmentManager,
      "OfferCreated",
    );
    if (!eventArgs) {
      throw new Error("OfferCreated event missing from createOffer transaction receipt.");
    }

    return {
      ...res,
      offerId: eventArgs.offerId,
    };
  }

  public async topUpOffer(offerId: bigint, addAmount: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "topUpOffer",
      args: [offerId, addAmount],
    });
  }

  public async decreaseOffer(offerId: bigint, removeAmount: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "decreaseOffer",
      args: [offerId, removeAmount],
    });
  }

  public async pauseOffer(offerId: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "pauseOffer",
      args: [offerId],
    });
  }

  public async unpauseOffer(offerId: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "unpauseOffer",
      args: [offerId],
    });
  }

  public async cancelOffer(offerId: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "cancelOffer",
      args: [offerId],
    });
  }

  // ---------------------------------------------------------------------------
  // Trader / Ticket Actions
  // ---------------------------------------------------------------------------

  public async reserve(
    offerId: bigint,
    inventoryAmount: bigint,
    duration: number,
    maxPremiumIn: bigint,
    recipient: Address,
  ): Promise<TxExecutionResult<{ ticketId: bigint; expiresAt: number; grossPremium: bigint }>> {
    const res = await this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "reserve",
      args: [offerId, inventoryAmount, duration, maxPremiumIn, recipient],
    });

    const eventArgs = this.findEventArgs<{
      ticketId: bigint;
      expiresAt: number;
      grossPremium: bigint;
    }>(
      res.receipt.logs,
      this.addresses.commitmentManager,
      ABIS.CommitmentManager,
      "TicketReserved",
    );
    if (!eventArgs) {
      throw new Error("TicketReserved event missing from reserve transaction receipt.");
    }

    return {
      ...res,
      ticketId: eventArgs.ticketId,
      expiresAt: Number(eventArgs.expiresAt),
      grossPremium: eventArgs.grossPremium,
    };
  }

  public async transferTicket(
    from: Address,
    to: Address,
    ticketId: bigint,
  ): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.executionTicket,
      abi: ABIS.ExecutionTicket,
      functionName: "transferFrom",
      args: [from, to, ticketId],
    });
  }

  public async splitTicket(
    ticketId: bigint,
    splitAmount: bigint,
    recipient: Address,
  ): Promise<TxExecutionResult<{ newTicketId: bigint }>> {
    const res = await this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "splitTicket",
      args: [ticketId, splitAmount, recipient],
    });

    const eventArgs = this.findEventArgs<{ newTicketId: bigint }>(
      res.receipt.logs,
      this.addresses.commitmentManager,
      ABIS.CommitmentManager,
      "TicketSplit",
    );
    if (!eventArgs) {
      throw new Error("TicketSplit event missing from splitTicket transaction receipt.");
    }

    return {
      ...res,
      newTicketId: eventArgs.newTicketId,
    };
  }

  public async exercise(
    ticketId: bigint,
    fillAmount: bigint,
    maxPaymentIn: bigint,
    receiver: Address,
  ): Promise<TxExecutionResult<{ actualFill: bigint; grossPayment: bigint; effPriceX36: bigint }>> {
    const res = await this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "exercise",
      args: [ticketId, fillAmount, maxPaymentIn, receiver],
    });

    const eventArgs = this.findEventArgs<{
      fillAmount: bigint;
      grossPayment: bigint;
      effPriceX36: bigint;
    }>(
      res.receipt.logs,
      this.addresses.commitmentManager,
      ABIS.CommitmentManager,
      "TicketExercised",
    );
    if (!eventArgs) {
      throw new Error("TicketExercised event missing from exercise transaction receipt.");
    }

    return {
      ...res,
      actualFill: eventArgs.fillAmount,
      grossPayment: eventArgs.grossPayment,
      effPriceX36: eventArgs.effPriceX36,
    };
  }

  public async batchExercise(
    params: BatchExerciseParams,
    options?: { value?: bigint },
  ): Promise<TxExecutionResult<{ totalInventoryOut: bigint; totalPaymentIn: bigint }>> {
    const res = await this.executeContractWrite({
      address: this.addresses.executionRouter,
      abi: ABIS.ExecutionRouter,
      functionName: "batchExercise",
      args: [params],
      value: options?.value,
    });

    const eventArgs = this.findEventArgs<{
      totalInventoryOut: bigint;
      totalPaymentIn: bigint;
    }>(
      res.receipt.logs,
      this.addresses.executionRouter,
      ABIS.ExecutionRouter,
      "BatchExercised",
    );
    if (!eventArgs) {
      throw new Error("BatchExercised event missing from batchExercise transaction receipt.");
    }

    return {
      ...res,
      totalInventoryOut: eventArgs.totalInventoryOut,
      totalPaymentIn: eventArgs.totalPaymentIn,
    };
  }

  public async reclaimExpired(ticketId: bigint): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "reclaimExpired",
      args: [ticketId],
    });
  }

  public async reclaimExpiredBatch(ticketIds: bigint[]): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "reclaimExpiredBatch",
      args: [ticketIds],
    });
  }

  public async reclaimExpiredBatchBestEffort(ticketIds: bigint[]): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.commitmentManager,
      abi: ABIS.CommitmentManager,
      functionName: "reclaimExpiredBatchBestEffort",
      args: [ticketIds],
    });
  }

  // ---------------------------------------------------------------------------
  // Oracle & ERC-20 / ERC-721 Helpers
  // ---------------------------------------------------------------------------

  public async signAndUpdatePullOraclePrice(
    params: SignAndUpdatePullOraclePriceParams,
  ): Promise<TxExecutionResult<{ priceX36: bigint; reportTimestamp: bigint; signature: Hex; signatures: Hex[] }>> {
    if (!this.addresses.signedPullOracle) {
      throw new Error("signedPullOracle address is not configured on TrancheClient.");
    }

    const clients =
      params.signerWalletClients && params.signerWalletClients.length > 0
        ? params.signerWalletClients
        : [params.signerWalletClient ?? this.walletClient].filter((c): c is WalletClient => Boolean(c));

    if (clients.length === 0 || clients.some((c) => !c.account)) {
      throw new Error(
        "signAndUpdatePullOraclePrice requires signerWalletClients / signerWalletClient (or default walletClient) with active accounts.",
      );
    }

    const reportTimestamp =
      params.reportTimestamp ?? (await this.publicClient.getBlock({ blockTag: "latest" })).timestamp;
    const chainId = await this.publicClient.getChainId();

    const sortedClients = [...clients].sort((a, b) =>
      BigInt(a.account!.address) < BigInt(b.account!.address) ? -1 : 1,
    );

    const signatures: Hex[] = [];
    for (const signerClient of sortedClients) {
      const sig = await signerClient.signTypedData({
        account: signerClient.account!,
        domain: {
          name: "ProtocolSignedPullOracle",
          version: "2",
          chainId,
          verifyingContract: this.addresses.signedPullOracle,
        },
        types: {
          PriceReport: [
            { name: "inventoryToken", type: "address" },
            { name: "paymentToken", type: "address" },
            { name: "priceX36", type: "uint256" },
            { name: "reportTimestamp", type: "uint256" },
          ],
        },
        primaryType: "PriceReport",
        message: {
          inventoryToken: params.inventoryToken,
          paymentToken: params.paymentToken,
          priceX36: params.priceX36,
          reportTimestamp,
        },
      });
      signatures.push(sig);
    }

    const res = await this.executeContractWrite({
      address: this.addresses.signedPullOracle,
      abi: ABIS.SignedPullOracle,
      functionName: "updatePrice",
      args: [
        params.inventoryToken,
        params.paymentToken,
        params.priceX36,
        reportTimestamp,
        signatures,
      ],
    });

    return {
      ...res,
      priceX36: params.priceX36,
      reportTimestamp,
      signature: signatures[0],
      signatures,
    };
  }

  public async approveErc20(
    token: Address,
    spender: Address,
    amount: bigint,
  ): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    });
  }

  public async approveTicketNftAll(
    operator: Address,
    approved = true,
  ): Promise<TxExecutionResult> {
    return this.executeContractWrite({
      address: this.addresses.executionTicket,
      abi: ABIS.ExecutionTicket,
      functionName: "setApprovalForAll",
      args: [operator, approved],
    });
  }
}
