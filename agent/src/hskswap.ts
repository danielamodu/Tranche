import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export const PRICE_SCALE = 10n ** 36n;
export const BPS_DENOMINATOR = 10_000n;

export const CANONICAL_CHAIN_177_HSKSWAP = {
  factory: "0x972cA9D1662F5e029cD18327D29026532E84c742" as Address,
  quoterV2: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD" as Address,
  swapRouter02: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  pools: {
    WHSK_USDT_3000: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC" as Address,
    WETH_USDT_3000: "0xb92b79ed6b370D5cFee2E14B1D0983C258304C16" as Address,
    WBTC_USDT_3000: "0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A" as Address,
  },
} as const;

export const UNISWAP_V3_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const SWAP_ROUTER_02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

export interface DexPoolState {
  venue: string;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  fee: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  observationCardinality: number;
  spotPriceX36: bigint; // paymentToken raw units per inventoryToken raw unit * 1e36
  twapPriceX36: bigint | null;
  timestamp: number;
  blockNumber?: bigint;
}

export interface DexBuyQuote {
  venue: string;
  inventoryToken: Address;
  paymentToken: Address;
  inventoryAmountOut: bigint;
  paymentAmountIn: bigint;
  effectiveUnitPriceX36: bigint;
  priceImpactBps: number;
  gasEstimate: bigint;
}

export interface DexSellQuote {
  venue: string;
  inventoryToken: Address;
  paymentToken: Address;
  inventoryAmountIn: bigint;
  paymentAmountOut: bigint;
  effectiveUnitPriceX36: bigint;
  priceImpactBps: number;
  gasEstimate: bigint;
}

export interface DexSwapExecution {
  venue: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  quotedAmountOut?: bigint;
  realizedSlippageBps?: number;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

/** Modular DEX venue interface so additional AMM/RFQ venues can be added cleanly. */
export interface DexVenueAdapter {
  readonly name: string;
  getPoolState(
    poolAddress: Address,
    inventoryToken: Address,
    paymentToken: Address,
    twapWindowSec?: number,
  ): Promise<DexPoolState>;
  quoteBuyInventory(
    inventoryToken: Address,
    paymentToken: Address,
    inventoryAmountOut: bigint,
    fee: number,
    spotPriceX36: bigint,
  ): Promise<DexBuyQuote>;
  quoteSellInventory(
    inventoryToken: Address,
    paymentToken: Address,
    inventoryAmountIn: bigint,
    fee: number,
    spotPriceX36: bigint,
  ): Promise<DexSellQuote>;
  executeSwapExactInput(params: {
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    amountIn: bigint;
    amountOutMinimum: bigint;
    recipient: Address;
    deadlineSec?: number;
    expectedChainId?: number;
    quotedAmountOut?: bigint;
  }): Promise<DexSwapExecution>;
}

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Exact integer TickMath.getSqrtRatioAtTick matching contracts/src/adapters/UniswapV3TwapOracle.sol.
 * Eliminates IEEE-754 float precision loss and scientific-notation overflow on extreme ticks.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Tick out of bounds: ${tick}`);
  }
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = MAX_UINT256 / ratio;
  const shift = ratio >> 32n;
  return (ratio % (1n << 32n)) === 0n ? shift : shift + 1n;
}

export function sqrtPriceX96ToPriceX36(sqrtPriceX96: bigint, invIsToken0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const q192 = 1n << 192n;
  const num = sqrtPriceX96 * sqrtPriceX96;
  if (invIsToken0) {
    return (num * PRICE_SCALE) / q192;
  }
  return (q192 * PRICE_SCALE) / num;
}

export function tickToPriceX36(tick: number, invIsToken0: boolean): bigint {
  const sqrtPriceX96 = getSqrtRatioAtTick(tick);
  return sqrtPriceX96ToPriceX36(sqrtPriceX96, invIsToken0);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");
  if (a === 0n) return 0n;
  return (a + b - 1n) / b;
}

export function computePriceImpactBps(
  effectivePriceX36: bigint,
  referencePriceX36: bigint,
  side: "BUY" | "SELL",
): number {
  if (referencePriceX36 === 0n || effectivePriceX36 === 0n) return 0;
  if (side === "BUY") {
    if (effectivePriceX36 <= referencePriceX36) return 0;
    return Number(((effectivePriceX36 - referencePriceX36) * BPS_DENOMINATOR) / referencePriceX36);
  }
  if (effectivePriceX36 >= referencePriceX36) return 0;
  return Number(((referencePriceX36 - effectivePriceX36) * BPS_DENOMINATOR) / referencePriceX36);
}

export interface HskSwapVenueConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  account?: Account;
  quoterV2: Address;
  swapRouter02: Address;
  multicall3?: Address;
  /** When true, strips signer references and fails closed on any swap/approval attempt */
  readOnly?: boolean;
}

/**
 * Live HSKSwap V3 adapter backed by verified QuoterV2 & SwapRouter02 interfaces.
 * Restricted strictly to the configured swapRouter02 address (no arbitrary calls).
 */
export class HskSwapVenue implements DexVenueAdapter {
  public readonly name = "HSKSwapV3";
  public readonly readOnly: boolean;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly account?: Account;
  private readonly quoterV2: Address;
  private readonly swapRouter02: Address;
  private readonly multicall3: Address;

  constructor(config: HskSwapVenueConfig) {
    this.readOnly = config.readOnly ?? false;
    this.publicClient = config.publicClient;
    this.walletClient = this.readOnly ? undefined : config.walletClient;
    this.account = this.readOnly ? undefined : config.account;
    this.quoterV2 = config.quoterV2;
    this.swapRouter02 = config.swapRouter02;
    this.multicall3 = config.multicall3 ?? CANONICAL_CHAIN_177_HSKSWAP.multicall3;
  }

  async getPoolState(
    poolAddress: Address,
    inventoryToken: Address,
    paymentToken: Address,
    twapWindowSec = 1800,
  ): Promise<DexPoolState> {
    const [block, mc] = await Promise.all([
      this.publicClient.getBlock(),
      this.publicClient.multicall({
        multicallAddress: this.multicall3,
        allowFailure: true,
        contracts: [
          { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: "token0" },
          { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: "token1" },
          { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: "fee" },
          { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: "liquidity" },
          { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: "slot0" },
          {
            address: poolAddress,
            abi: UNISWAP_V3_POOL_ABI,
            functionName: "observe",
            args: [[twapWindowSec, 0]],
          },
        ],
      }),
    ]);

    if (
      mc[0].status !== "success" ||
      mc[1].status !== "success" ||
      mc[2].status !== "success" ||
      mc[3].status !== "success" ||
      mc[4].status !== "success"
    ) {
      throw new Error(`Failed to read HSKSwap pool state for ${poolAddress}`);
    }

    const token0 = mc[0].result as Address;
    const token1 = mc[1].result as Address;
    const fee = Number(mc[2].result);
    const liquidity = mc[3].result as bigint;
    const slot0 = mc[4].result as readonly [bigint, number, number, number, number, number, boolean];

    let invIsToken0: boolean;
    if (
      token0.toLowerCase() === inventoryToken.toLowerCase() &&
      token1.toLowerCase() === paymentToken.toLowerCase()
    ) {
      invIsToken0 = true;
    } else if (
      token1.toLowerCase() === inventoryToken.toLowerCase() &&
      token0.toLowerCase() === paymentToken.toLowerCase()
    ) {
      invIsToken0 = false;
    } else {
      throw new Error(`Pool ${poolAddress} tokens do not match ${inventoryToken}/${paymentToken}`);
    }

    const sqrtPriceX96 = slot0[0];
    const tick = Number(slot0[1]);
    const observationCardinality = Number(slot0[3]);
    const spotPriceX36 = sqrtPriceX96ToPriceX36(sqrtPriceX96, invIsToken0);

    let twapPriceX36: bigint | null = null;
    if (mc[5].status === "success") {
      const [tickCumulatives] = mc[5].result as readonly [readonly bigint[], readonly bigint[]];
      const delta = tickCumulatives[1] - tickCumulatives[0];
      const windowBig = BigInt(twapWindowSec);
      let meanTick = Number(delta / windowBig);
      // Uniswap V3 spec: round toward negative infinity on negative remainder
      if (delta < 0n && delta % windowBig !== 0n) {
        meanTick -= 1;
      }
      twapPriceX36 = tickToPriceX36(meanTick, invIsToken0);
    }

    return {
      venue: this.name,
      poolAddress,
      token0,
      token1,
      fee,
      liquidity,
      sqrtPriceX96,
      tick,
      observationCardinality,
      spotPriceX36,
      twapPriceX36,
      timestamp: Number(block.timestamp),
      blockNumber: block.number,
    };
  }

  async quoteBuyInventory(
    inventoryToken: Address,
    paymentToken: Address,
    inventoryAmountOut: bigint,
    fee: number,
    spotPriceX36: bigint,
  ): Promise<DexBuyQuote> {
    const sim = await this.publicClient.simulateContract({
      address: this.quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactOutputSingle",
      args: [
        {
          tokenIn: paymentToken,
          tokenOut: inventoryToken,
          amount: inventoryAmountOut,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const [paymentAmountIn, , , gasEstimate] = sim.result;
    const effectiveUnitPriceX36 = ceilDiv(paymentAmountIn * PRICE_SCALE, inventoryAmountOut);
    const priceImpactBps = computePriceImpactBps(effectiveUnitPriceX36, spotPriceX36, "BUY");

    return {
      venue: this.name,
      inventoryToken,
      paymentToken,
      inventoryAmountOut,
      paymentAmountIn,
      effectiveUnitPriceX36,
      priceImpactBps,
      gasEstimate,
    };
  }

  async quoteSellInventory(
    inventoryToken: Address,
    paymentToken: Address,
    inventoryAmountIn: bigint,
    fee: number,
    spotPriceX36: bigint,
  ): Promise<DexSellQuote> {
    const sim = await this.publicClient.simulateContract({
      address: this.quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: inventoryToken,
          tokenOut: paymentToken,
          amountIn: inventoryAmountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const [paymentAmountOut, , , gasEstimate] = sim.result;
    const effectiveUnitPriceX36 = (paymentAmountOut * PRICE_SCALE) / inventoryAmountIn;
    const priceImpactBps = computePriceImpactBps(effectiveUnitPriceX36, spotPriceX36, "SELL");

    return {
      venue: this.name,
      inventoryToken,
      paymentToken,
      inventoryAmountIn,
      paymentAmountOut,
      effectiveUnitPriceX36,
      priceImpactBps,
      gasEstimate,
    };
  }

  async executeSwapExactInput(params: {
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    amountIn: bigint;
    amountOutMinimum: bigint;
    recipient: Address;
    deadlineSec?: number;
    expectedChainId?: number;
    quotedAmountOut?: bigint;
  }): Promise<DexSwapExecution> {
    if (this.readOnly) {
      throw new Error(
        "READ_ONLY_MODE_BLOCKED: HskSwapVenue cannot approve tokens or broadcast swaps in read_only mode",
      );
    }
    if (!this.walletClient || !this.account) {
      throw new Error("HskSwapVenue requires walletClient and account to execute swaps");
    }

    // Pre-execution chain ID & signer token balance validation
    if (params.expectedChainId !== undefined) {
      const actualChainId = await this.publicClient.getChainId();
      if (actualChainId !== params.expectedChainId) {
        throw new Error(
          `Chain ID mismatch before swap: expected ${params.expectedChainId}, got ${actualChainId}`,
        );
      }
    }

    const tokenInBalance = await this.publicClient.readContract({
      address: params.tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
    if (tokenInBalance < params.amountIn) {
      throw new Error(
        `Insufficient balance of ${params.tokenIn}: have ${tokenInBalance}, need ${params.amountIn}`,
      );
    }

    // Check & approve exact allowance strictly to configured swapRouter02
    // Reset non-zero insufficient allowance to 0 first for USDT-style ERC20 safety
    const allowance = await this.publicClient.readContract({
      address: params.tokenIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.swapRouter02],
    });

    if (allowance < params.amountIn) {
      if (allowance > 0n) {
        const resetHash = await this.walletClient.writeContract({
          account: this.account,
          chain: this.walletClient.chain ?? null,
          address: params.tokenIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.swapRouter02, 0n],
        });
        const resetReceipt = await this.publicClient.waitForTransactionReceipt({ hash: resetHash });
        if (resetReceipt.status !== "success") {
          throw new Error(`ERC20 allowance reset reverted: ${resetHash}`);
        }
      }
      const approveHash = await this.walletClient.writeContract({
        account: this.account,
        chain: this.walletClient.chain ?? null,
        address: params.tokenIn,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.swapRouter02, params.amountIn],
      });
      const approveReceipt = await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== "success") {
        throw new Error(`ERC20 approve to SwapRouter02 reverted: ${approveHash}`);
      }
    }

    const balBefore = await this.publicClient.readContract({
      address: params.tokenOut,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [params.recipient],
    });

    // Enforce on-chain deadline via SwapRouter02.multicall(uint256 deadline, bytes[] data)
    const block = await this.publicClient.getBlock();
    const deadline = BigInt(params.deadlineSec ?? Number(block.timestamp) + 120);
    const swapCalldata = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee,
          recipient: params.recipient,
          amountIn: params.amountIn,
          amountOutMinimum: params.amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: this.walletClient.chain ?? null,
      address: this.swapRouter02,
      abi: SWAP_ROUTER_02_ABI,
      functionName: "multicall",
      args: [deadline, [swapCalldata]],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`HSKSwap exactInputSingle reverted: ${txHash}`);
    }

    const balAfter = await this.publicClient.readContract({
      address: params.tokenOut,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [params.recipient],
    });

    const amountOut = balAfter > balBefore ? balAfter - balBefore : 0n;
    if (amountOut < params.amountOutMinimum) {
      throw new Error(`Received amountOut ${amountOut} < minimum ${params.amountOutMinimum}`);
    }

    let realizedSlippageBps: number | undefined;
    if (params.quotedAmountOut && params.quotedAmountOut > 0n) {
      realizedSlippageBps =
        amountOut >= params.quotedAmountOut
          ? 0
          : Number(((params.quotedAmountOut - amountOut) * BPS_DENOMINATOR) / params.quotedAmountOut);
    }

    return {
      venue: this.name,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      amountOut,
      quotedAmountOut: params.quotedAmountOut,
      realizedSlippageBps,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  }
}
