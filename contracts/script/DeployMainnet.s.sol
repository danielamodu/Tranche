// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {UniswapV3TwapOracle} from "../src/adapters/UniswapV3TwapOracle.sol";
import {HSPComplianceHook} from "../src/adapters/HSPComplianceHook.sol";
import {IPriceOracle} from "../src/interfaces/IProtocol.sol";
import {ISafeProxyFactory, ISafeL2} from "./DeployTestnet.s.sol";

/// @title DeployMainnet
/// @notice Reproducible HashKey Chain Mainnet (Chain ID 177) deployment script for Tranche.
///         Uses canonical Chain 177 assets and live HSKSwap V3 TWAP pools only — zero mock tokens.
///         Deploys Safe v1.4.1 multisigs (3-of-5 Governance, 2-of-3 Guardian, 2-of-3 Treasury),
///         TimelockController, core Tranche contracts, M-of-N pull oracle + V3 TWAP circuit breaker,
///         and initiates Ownable2Step handover to TimelockController across all 6 admin-gated contracts.
contract DeployMainnet is Script {
    // Verified canonical HashKey Chain Mainnet (Chain ID 177) infrastructure
    address public constant MAINNET_WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address public constant MAINNET_USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address public constant MAINNET_WETH = 0xefd4bC9afD210517803f293ABABd701CaeeCdfd0;
    address public constant MAINNET_WBTC = 0x6119CA49a79f5825C8B345F8d7aC36B272565b14;

    // Verified live HSKSwap V3 pools on Chain 177 (all 0.30% fee, observationCardinality = 240)
    address public constant POOL_WHSK_USDT_3000 = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address public constant POOL_WETH_USDT_3000 = 0xb92b79ed6b370D5cFee2E14B1D0983C258304C16;
    address public constant POOL_WBTC_USDT_3000 = 0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A;

    // Verified Safe v1.4.1 & Multicall3 predeploys on Chain 177
    address public constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address public constant SAFE_L2_V141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address public constant SAFE_PROXY_FACTORY_V141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address public constant SAFE_FALLBACK_HANDLER_V141 = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    // Verified HSKSwap V3 periphery on Chain 177
    address public constant HSKSWAP_QUOTER_V2 = 0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD;
    address public constant HSKSWAP_SWAP_ROUTER_02 = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;

    uint16 public constant DEFAULT_PROTOCOL_FEE_BPS = 5; // 0.05%
    uint32 public constant DEFAULT_MAX_PRICE_AGE = 30; // 30s for SignedPullOracle
    uint32 public constant DEFAULT_TWAP_WINDOW = 1800; // 30m HSKSwap V3 TWAP
    uint16 public constant DEFAULT_TWAP_MIN_CARDINALITY = 2;
    uint16 public constant DEFAULT_MAX_DEVIATION_BPS = 500; // 5.0% pull-vs-TWAP circuit breaker
    uint256 public constant DEFAULT_MAINNET_TIMELOCK_DELAY = 48 hours;

    struct DeployConfig {
        address deployer;
        address[] govOwners; // length 5, threshold 3
        address[] guardianOwners; // length 3, threshold 2
        address[] treasuryOwners; // length 3, threshold 2
        address[] oracleSigners; // length 3, threshold 2
        address hspAttestationSigner;
        uint256 timelockMinDelay;
        uint256 saltNonceBase;
    }

    struct DeployedStack {
        address govSafe;
        address guardianSafe;
        address treasurySafe;
        TimelockController timelock;
        LiquidityVault vault;
        CommitmentManager manager;
        ExecutionTicket ticketNft;
        ExecutionRouter router;
        SignedPullOracle pullOracle;
        OraclePriceAdapter oracleAdapter;
        UniswapV3TwapOracle twapOracle;
        HSPComplianceHook complianceHook;
    }

    error InvalidChainId(uint256 actual);
    error InvalidDeployer();
    error InvalidRoleSetLength(uint256 actual, uint256 expected);
    error ZeroRoleAddress();
    error DuplicateRoleAddress(address duplicate);
    error MissingCanonicalBytecode(address target);
    error SafeVerificationFailed();
    error OwnershipHandoverInitFailed();
    error OracleVerificationFailed(address inventoryToken, address paymentToken);

    function run() external returns (DeployedStack memory stack) {
        if (block.chainid != 177 && block.chainid != 31337) revert InvalidChainId(block.chainid);

        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        DeployConfig memory cfg = _loadConfigFromEnv(deployer);

        vm.startBroadcast(deployerPk);
        stack = deployAll(cfg);
        vm.stopBroadcast();

        _logSummary(cfg, stack);

        if (vm.envOr("WRITE_MAINNET_MANIFEST", false)) {
            writeManifestJson(stack, "deployments/hashkey-mainnet-deployed.json");
        }
    }

    /// @notice Deploys governance Safes, TimelockController, core Tranche contracts, and mainnet oracles.
    ///         Verifies canonical Chain 177 bytecode, live TWAP oracle reads, Safe state, and pending ownership.
    function deployAll(DeployConfig memory cfg) public returns (DeployedStack memory stack) {
        if (cfg.deployer == address(0)) revert InvalidDeployer();
        if (cfg.hspAttestationSigner == address(0)) revert ZeroRoleAddress();
        _validateDistinctSet(cfg.govOwners, 5);
        _validateDistinctSet(cfg.guardianOwners, 3);
        _validateDistinctSet(cfg.treasuryOwners, 3);
        _validateDistinctSet(cfg.oracleSigners, 3);

        // 0. Verify canonical Chain 177 dependencies have deployed bytecode
        _requireCode(SAFE_L2_V141);
        _requireCode(SAFE_PROXY_FACTORY_V141);
        _requireCode(SAFE_FALLBACK_HANDLER_V141);
        _requireCode(MULTICALL3);
        _requireCode(MAINNET_WHSK);
        _requireCode(MAINNET_USDT);
        _requireCode(MAINNET_WETH);
        _requireCode(MAINNET_WBTC);
        _requireCode(POOL_WHSK_USDT_3000);
        _requireCode(POOL_WETH_USDT_3000);
        _requireCode(POOL_WBTC_USDT_3000);

        // 1. Governance & Emergency Topology (Safe v1.4.1 proxies + OZ TimelockController)
        stack.govSafe = _deploySafeProxy(cfg.govOwners, 3, cfg.saltNonceBase + 1);
        stack.guardianSafe = _deploySafeProxy(cfg.guardianOwners, 2, cfg.saltNonceBase + 2);
        stack.treasurySafe = _deploySafeProxy(cfg.treasuryOwners, 2, cfg.saltNonceBase + 3);
        _verifySafeState(stack.govSafe, 5, 3);
        _verifySafeState(stack.guardianSafe, 3, 2);
        _verifySafeState(stack.treasurySafe, 3, 2);

        address[] memory proposers = new address[](1);
        proposers[0] = stack.govSafe;
        address[] memory executors = new address[](1);
        executors[0] = stack.govSafe;

        stack.timelock = new TimelockController(
            cfg.timelockMinDelay,
            proposers,
            executors,
            cfg.deployer // Temporary admin to grant Guardian CANCELLER_ROLE; renounced after handover
        );
        stack.timelock.grantRole(stack.timelock.CANCELLER_ROLE(), stack.guardianSafe);

        // 2. Core Tranche Protocol Contracts (Strict Dependency Order, canonical WHSK)
        stack.vault = new LiquidityVault(cfg.deployer, stack.guardianSafe, stack.treasurySafe);
        stack.manager = new CommitmentManager(
            cfg.deployer,
            address(stack.vault),
            stack.guardianSafe,
            DEFAULT_PROTOCOL_FEE_BPS
        );
        stack.ticketNft = new ExecutionTicket(address(stack.manager));
        stack.vault.setManager(address(stack.manager));
        stack.manager.setTicketNft(address(stack.ticketNft));
        stack.router = new ExecutionRouter(address(stack.manager), MAINNET_WHSK);

        // 3. Oracle & Compliance Adapters
        stack.pullOracle = new SignedPullOracle(
            cfg.deployer,
            stack.guardianSafe,
            cfg.oracleSigners,
            2,
            DEFAULT_MAX_PRICE_AGE
        );
        stack.oracleAdapter = new OraclePriceAdapter(cfg.deployer);
        stack.twapOracle = new UniswapV3TwapOracle(cfg.deployer);
        stack.complianceHook = new HSPComplianceHook(cfg.deployer, cfg.hspAttestationSigner);

        // 4. Wire Live HSKSwap V3 TWAP Pools
        stack.twapOracle.setPoolConfig(
            MAINNET_WHSK, MAINNET_USDT, POOL_WHSK_USDT_3000, DEFAULT_TWAP_WINDOW, DEFAULT_TWAP_MIN_CARDINALITY
        );
        stack.twapOracle.setPoolConfig(
            MAINNET_WETH, MAINNET_USDT, POOL_WETH_USDT_3000, DEFAULT_TWAP_WINDOW, DEFAULT_TWAP_MIN_CARDINALITY
        );
        stack.twapOracle.setPoolConfig(
            MAINNET_WBTC, MAINNET_USDT, POOL_WBTC_USDT_3000, DEFAULT_TWAP_WINDOW, DEFAULT_TWAP_MIN_CARDINALITY
        );

        // 5. Initial Allowlists, Decimal-Aware Minimums & Dual-Feed Oracle Configs
        stack.manager.setApprovedOracle(address(stack.oracleAdapter), true);
        stack.manager.setApprovedOracle(address(stack.twapOracle), true);
        stack.manager.setApprovedComplianceHook(address(stack.complianceHook), true);
        stack.manager.setApprovedRouter(address(stack.router), true);

        stack.manager.setTokenMinTicketAmount(MAINNET_WHSK, 10e18); // 10 WHSK
        stack.manager.setTokenMinTicketAmount(MAINNET_USDT, 1e6); // 1 USDT
        stack.manager.setTokenMinTicketAmount(MAINNET_WBTC, 1e4); // 0.0001 WBTC
        stack.manager.setTokenMinTicketAmount(MAINNET_WETH, 1e15); // 0.001 WETH

        stack.pullOracle.setMaxJumpBps(MAINNET_WHSK, MAINNET_USDT, 500); // 5.0%
        stack.pullOracle.setMaxJumpBps(MAINNET_WETH, MAINNET_USDT, 300); // 3.0%
        stack.pullOracle.setMaxJumpBps(MAINNET_WBTC, MAINNET_USDT, 300); // 3.0%

        // Primary: 2-of-3 SignedPullOracle; Secondary: live HSKSwap V3 30m TWAP with 5% deviation check + fallback
        stack.oracleAdapter.setPairConfig(
            MAINNET_WHSK,
            MAINNET_USDT,
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(stack.pullOracle),
                secondaryFeed: address(stack.twapOracle),
                maxStaleness: DEFAULT_MAX_PRICE_AGE,
                secondaryMaxStaleness: DEFAULT_TWAP_WINDOW,
                maxDeviationBps: DEFAULT_MAX_DEVIATION_BPS,
                requireSecondaryCheck: true,
                allowSecondaryFallback: true,
                hardMinPriceX36: 1e21, // $0.001 / WHSK (18/6)
                hardMaxPriceX36: 1e26 // $100 / WHSK (18/6)
            })
        );
        stack.oracleAdapter.setPairConfig(
            MAINNET_WETH,
            MAINNET_USDT,
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(stack.pullOracle),
                secondaryFeed: address(stack.twapOracle),
                maxStaleness: DEFAULT_MAX_PRICE_AGE,
                secondaryMaxStaleness: DEFAULT_TWAP_WINDOW,
                maxDeviationBps: DEFAULT_MAX_DEVIATION_BPS,
                requireSecondaryCheck: true,
                allowSecondaryFallback: true,
                hardMinPriceX36: 1e26, // $100 / WETH (18/6)
                hardMaxPriceX36: 1e29 // $100,000 / WETH (18/6)
            })
        );
        stack.oracleAdapter.setPairConfig(
            MAINNET_WBTC,
            MAINNET_USDT,
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(stack.pullOracle),
                secondaryFeed: address(stack.twapOracle),
                maxStaleness: DEFAULT_MAX_PRICE_AGE,
                secondaryMaxStaleness: DEFAULT_TWAP_WINDOW,
                maxDeviationBps: DEFAULT_MAX_DEVIATION_BPS,
                requireSecondaryCheck: true,
                allowSecondaryFallback: true,
                hardMinPriceX36: 1e37, // $1,000 / WBTC (8/6)
                hardMaxPriceX36: 1e40 // $1,000,000 / WBTC (8/6)
            })
        );

        // Verify live oracle reads immediately post-configuration
        _verifyLiveOracle(stack.oracleAdapter, MAINNET_WHSK, MAINNET_USDT);
        _verifyLiveOracle(stack.oracleAdapter, MAINNET_WETH, MAINNET_USDT);
        _verifyLiveOracle(stack.oracleAdapter, MAINNET_WBTC, MAINNET_USDT);

        // 6. Initiate Ownable2Step Handover to TimelockController Across All 6 Admin-Gated Contracts
        stack.vault.transferOwnership(address(stack.timelock));
        stack.manager.transferOwnership(address(stack.timelock));
        stack.pullOracle.transferOwnership(address(stack.timelock));
        stack.oracleAdapter.transferOwnership(address(stack.timelock));
        stack.twapOracle.transferOwnership(address(stack.timelock));
        stack.complianceHook.transferOwnership(address(stack.timelock));

        address tl = address(stack.timelock);
        if (
            stack.vault.pendingOwner() != tl ||
            stack.manager.pendingOwner() != tl ||
            stack.pullOracle.pendingOwner() != tl ||
            stack.oracleAdapter.pendingOwner() != tl ||
            stack.twapOracle.pendingOwner() != tl ||
            stack.complianceHook.pendingOwner() != tl
        ) revert OwnershipHandoverInitFailed();
    }

    function buildAcceptOwnershipBatch(DeployedStack memory stack)
        public
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](6);
        values = new uint256[](6);
        payloads = new bytes[](6);

        targets[0] = address(stack.vault);
        targets[1] = address(stack.manager);
        targets[2] = address(stack.pullOracle);
        targets[3] = address(stack.oracleAdapter);
        targets[4] = address(stack.twapOracle);
        targets[5] = address(stack.complianceHook);

        bytes memory acceptData = abi.encodeWithSignature("acceptOwnership()");
        for (uint256 i = 0; i < 6; ++i) {
            payloads[i] = acceptData;
        }
    }

    /// @notice Writes a secret-free deployment manifest JSON with deployed addresses and protocol parameters.
    function writeManifestJson(DeployedStack memory stack, string memory outputPath) public {
        string memory root = "manifest";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "protocolFeeBps", DEFAULT_PROTOCOL_FEE_BPS);
        vm.serializeUint(root, "twapWindowSec", DEFAULT_TWAP_WINDOW);
        vm.serializeUint(root, "maxOracleDeviationBps", DEFAULT_MAX_DEVIATION_BPS);
        vm.serializeUint(root, "timelockMinDelaySec", stack.timelock.getMinDelay());
        vm.serializeAddress(root, "whsk", MAINNET_WHSK);
        vm.serializeAddress(root, "usdt", MAINNET_USDT);
        vm.serializeAddress(root, "weth", MAINNET_WETH);
        vm.serializeAddress(root, "wbtc", MAINNET_WBTC);
        vm.serializeAddress(root, "poolWhskUsdt3000", POOL_WHSK_USDT_3000);
        vm.serializeAddress(root, "poolWethUsdt3000", POOL_WETH_USDT_3000);
        vm.serializeAddress(root, "poolWbtcUsdt3000", POOL_WBTC_USDT_3000);
        vm.serializeAddress(root, "govSafe", stack.govSafe);
        vm.serializeAddress(root, "guardianSafe", stack.guardianSafe);
        vm.serializeAddress(root, "treasurySafe", stack.treasurySafe);
        vm.serializeAddress(root, "timelock", address(stack.timelock));
        vm.serializeAddress(root, "liquidityVault", address(stack.vault));
        vm.serializeAddress(root, "commitmentManager", address(stack.manager));
        vm.serializeAddress(root, "executionTicket", address(stack.ticketNft));
        vm.serializeAddress(root, "executionRouter", address(stack.router));
        vm.serializeAddress(root, "signedPullOracle", address(stack.pullOracle));
        vm.serializeAddress(root, "oraclePriceAdapter", address(stack.oracleAdapter));
        vm.serializeAddress(root, "uniswapV3TwapOracle", address(stack.twapOracle));
        string memory json = vm.serializeAddress(root, "hspComplianceHook", address(stack.complianceHook));
        vm.writeJson(json, outputPath);
    }

    function _deploySafeProxy(address[] memory owners, uint256 threshold, uint256 saltNonce)
        internal
        returns (address proxy)
    {
        bytes memory initializer = abi.encodeWithSelector(
            ISafeL2.setup.selector,
            owners,
            threshold,
            address(0),
            bytes(""),
            SAFE_FALLBACK_HANDLER_V141,
            address(0),
            uint256(0),
            payable(address(0))
        );
        proxy = ISafeProxyFactory(SAFE_PROXY_FACTORY_V141).createProxyWithNonce(
            SAFE_L2_V141,
            initializer,
            saltNonce
        );
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCanonicalBytecode(target);
    }

    function _verifyLiveOracle(OraclePriceAdapter adapter, address inv, address pay) internal view {
        IPriceOracle.PriceQuote memory q = adapter.getPriceX36(inv, pay);
        if (!q.isValid || q.priceX36 == 0) revert OracleVerificationFailed(inv, pay);
    }

    function _validateDistinctSet(address[] memory members, uint256 expectedLen) internal pure {
        if (members.length != expectedLen) revert InvalidRoleSetLength(members.length, expectedLen);
        for (uint256 i = 0; i < expectedLen; ++i) {
            if (members[i] == address(0)) revert ZeroRoleAddress();
            for (uint256 j = i + 1; j < expectedLen; ++j) {
                if (members[i] == members[j]) revert DuplicateRoleAddress(members[i]);
            }
        }
    }

    function _verifySafeState(address safeAddr, uint256 expectedOwners, uint256 expectedThreshold) internal view {
        if (
            ISafeL2(safeAddr).getThreshold() != expectedThreshold ||
            ISafeL2(safeAddr).getOwners().length != expectedOwners
        ) revert SafeVerificationFailed();
    }

    function _loadConfigFromEnv(address deployer) internal view returns (DeployConfig memory cfg) {
        cfg.deployer = deployer;
        cfg.govOwners = new address[](5);
        cfg.govOwners[0] = vm.envAddress("GOV_OWNER_1");
        cfg.govOwners[1] = vm.envAddress("GOV_OWNER_2");
        cfg.govOwners[2] = vm.envAddress("GOV_OWNER_3");
        cfg.govOwners[3] = vm.envAddress("GOV_OWNER_4");
        cfg.govOwners[4] = vm.envAddress("GOV_OWNER_5");

        cfg.guardianOwners = new address[](3);
        cfg.guardianOwners[0] = vm.envAddress("GUARDIAN_OWNER_1");
        cfg.guardianOwners[1] = vm.envAddress("GUARDIAN_OWNER_2");
        cfg.guardianOwners[2] = vm.envAddress("GUARDIAN_OWNER_3");

        cfg.treasuryOwners = new address[](3);
        cfg.treasuryOwners[0] = vm.envAddress("TREASURY_OWNER_1");
        cfg.treasuryOwners[1] = vm.envAddress("TREASURY_OWNER_2");
        cfg.treasuryOwners[2] = vm.envAddress("TREASURY_OWNER_3");

        cfg.oracleSigners = new address[](3);
        cfg.oracleSigners[0] = vm.envAddress("ORACLE_SIGNER_1");
        cfg.oracleSigners[1] = vm.envAddress("ORACLE_SIGNER_2");
        cfg.oracleSigners[2] = vm.envAddress("ORACLE_SIGNER_3");

        cfg.hspAttestationSigner = vm.envAddress("HSP_ATTESTATION_SIGNER");
        cfg.timelockMinDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MAINNET_TIMELOCK_DELAY);
        cfg.saltNonceBase = vm.envOr("SAFE_SALT_NONCE_BASE", uint256(177_2026_0001));
    }

    function _logSummary(DeployConfig memory cfg, DeployedStack memory stack) internal pure {
        console2.log("=== Tranche HashKey Chain Mainnet (177) Deployment Summary ===");
        console2.log("Deployer:", cfg.deployer);
        console2.log("Governance Safe (3/5):", stack.govSafe);
        console2.log("Guardian Safe (2/3):", stack.guardianSafe);
        console2.log("Treasury Safe (2/3):", stack.treasurySafe);
        console2.log("TimelockController:", address(stack.timelock));
        console2.log("LiquidityVault:", address(stack.vault));
        console2.log("CommitmentManager:", address(stack.manager));
        console2.log("ExecutionTicket:", address(stack.ticketNft));
        console2.log("ExecutionRouter:", address(stack.router));
        console2.log("SignedPullOracle:", address(stack.pullOracle));
        console2.log("OraclePriceAdapter:", address(stack.oracleAdapter));
        console2.log("UniswapV3TwapOracle:", address(stack.twapOracle));
        console2.log("HSPComplianceHook:", address(stack.complianceHook));
    }
}
