import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

export interface FoundryArtifact {
  abi: Abi;
  bytecode: Hex;
}

interface RawFoundryArtifact {
  abi: Abi;
  bytecode?: {
    object?: string;
  };
}

function findRepoRoot(): string {
  const candidates: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    candidates.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(process.cwd(), resolve(process.cwd(), ".."));

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "out", "CommitmentManager.sol", "CommitmentManager.json"))) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to locate Tranche Foundry artifacts directory (out/CommitmentManager.sol/CommitmentManager.json). Run `forge build` from the repository root.",
  );
}

const REPO_ROOT = findRepoRoot();

function loadArtifact(relativePath: string): FoundryArtifact {
  const fullPath = resolve(REPO_ROOT, "out", relativePath);
  const raw = JSON.parse(readFileSync(fullPath, "utf8")) as RawFoundryArtifact;
  const object = raw.bytecode?.object ?? "0x";
  const bytecode = (object.startsWith("0x") ? object : `0x${object}`) as Hex;
  return {
    abi: raw.abi,
    bytecode,
  };
}

export const ARTIFACTS = {
  LiquidityVault: loadArtifact("LiquidityVault.sol/LiquidityVault.json"),
  CommitmentManager: loadArtifact("CommitmentManager.sol/CommitmentManager.json"),
  ExecutionTicket: loadArtifact("ExecutionTicket.sol/ExecutionTicket.json"),
  ExecutionRouter: loadArtifact("ExecutionRouter.sol/ExecutionRouter.json"),
  V3PositionSegregator: loadArtifact("V3PositionSegregator.sol/V3PositionSegregator.json"),
  SignedPullOracle: loadArtifact("SignedPullOracle.sol/SignedPullOracle.json"),
  UniswapV3TwapOracle: loadArtifact("UniswapV3TwapOracle.sol/UniswapV3TwapOracle.json"),
  OraclePriceAdapter: loadArtifact("OraclePriceAdapter.sol/OraclePriceAdapter.json"),
  HSPComplianceHook: loadArtifact("HSPComplianceHook.sol/HSPComplianceHook.json"),
  MockWHSK: loadArtifact("ProtocolAdversarial.t.sol/MockWHSK.json"),
  MockERC20: loadArtifact("ProtocolAdversarial.t.sol/MockERC20.json"),
} as const;

export const ABIS = {
  LiquidityVault: ARTIFACTS.LiquidityVault.abi,
  CommitmentManager: ARTIFACTS.CommitmentManager.abi,
  ExecutionTicket: ARTIFACTS.ExecutionTicket.abi,
  ExecutionRouter: ARTIFACTS.ExecutionRouter.abi,
  V3PositionSegregator: ARTIFACTS.V3PositionSegregator.abi,
  SignedPullOracle: ARTIFACTS.SignedPullOracle.abi,
  UniswapV3TwapOracle: ARTIFACTS.UniswapV3TwapOracle.abi,
  OraclePriceAdapter: ARTIFACTS.OraclePriceAdapter.abi,
  HSPComplianceHook: ARTIFACTS.HSPComplianceHook.abi,
  MockWHSK: ARTIFACTS.MockWHSK.abi,
  MockERC20: ARTIFACTS.MockERC20.abi,
} as const;

export const BYTECODES = {
  LiquidityVault: ARTIFACTS.LiquidityVault.bytecode,
  CommitmentManager: ARTIFACTS.CommitmentManager.bytecode,
  ExecutionTicket: ARTIFACTS.ExecutionTicket.bytecode,
  ExecutionRouter: ARTIFACTS.ExecutionRouter.bytecode,
  V3PositionSegregator: ARTIFACTS.V3PositionSegregator.bytecode,
  SignedPullOracle: ARTIFACTS.SignedPullOracle.bytecode,
  UniswapV3TwapOracle: ARTIFACTS.UniswapV3TwapOracle.bytecode,
  OraclePriceAdapter: ARTIFACTS.OraclePriceAdapter.bytecode,
  HSPComplianceHook: ARTIFACTS.HSPComplianceHook.bytecode,
  MockWHSK: ARTIFACTS.MockWHSK.bytecode,
  MockERC20: ARTIFACTS.MockERC20.bytecode,
} as const;

/**
 * Standard ERC-20 / ERC-721 / OpenZeppelin utility errors not always emitted
 * directly into every caller contract ABI.
 */
export const STANDARD_TOKEN_ERRORS_ABI = [
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InvalidSender",
    inputs: [{ name: "sender", type: "address" }],
  },
  {
    type: "error",
    name: "ERC20InvalidReceiver",
    inputs: [{ name: "receiver", type: "address" }],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InvalidApprover",
    inputs: [{ name: "approver", type: "address" }],
  },
  {
    type: "error",
    name: "ERC20InvalidSpender",
    inputs: [{ name: "spender", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InvalidOwner",
    inputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "error",
    name: "ERC721IncorrectOwner",
    inputs: [
      { name: "sender", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "owner", type: "address" },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidSender",
    inputs: [{ name: "sender", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InvalidReceiver",
    inputs: [{ name: "receiver", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InsufficientApproval",
    inputs: [
      { name: "operator", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidApprover",
    inputs: [{ name: "approver", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InvalidOperator",
    inputs: [{ name: "operator", type: "address" }],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [{ name: "token", type: "address" }],
  },
  {
    type: "error",
    name: "ReentrancyGuardReentrantCall",
    inputs: [],
  },
] as const satisfies Abi;
