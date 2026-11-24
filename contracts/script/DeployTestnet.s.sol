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
import {TestnetERC20} from "../src/mocks/TestnetERC20.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeL2 {
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    function nonce() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
}

/// @title DeployTestnet
/// @notice Reproducible HashKey Chain Testnet (Chain ID 133) deployment script for Tranche.
///         Deploys Safe v1.4.1 multisigs (3-of-5 Governance, 2-of-3 Guardian, 2-of-3 Treasury),
///         TimelockController, core Tranche contracts, M-of-N oracle, compliance hook, and testnet quote tokens.
contract DeployTestnet is Script {
    // Verified canonical HashKey Chain Testnet (Chain ID 133) infrastructure
    address public constant TESTNET_WHSK = 0x4200000000000000000000000000000000000006;
    address public constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address public constant SAFE_L2_V141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address public constant SAFE_PROXY_FACTORY_V141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address public constant SAFE_FALLBACK_HANDLER_V141 = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    uint16 public constant DEFAULT_PROTOCOL_FEE_BPS = 5; // 0.05%
    uint32 public constant DEFAULT_MAX_PRICE_AGE = 30;
    uint256 public constant DEFAULT_TESTNET_TIMELOCK_DELAY = 300; // 5 minutes for testnet operational validation

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
        TestnetERC20 tUsdt;
        TestnetERC20 tWbtc;
        TestnetERC20 tWeth;
    }

    error InvalidChainId(uint256 actual);
    error InvalidDeployer();

    function run() external returns (DeployedStack memory stack) {
        if (block.chainid != 133 && block.chainid != 31337) revert InvalidChainId(block.chainid);

        uint256 deployerPk = vm.envOr(
            "DEPLOYER_PRIVATE_KEY",
            uint256(keccak256("tranche.testnet.dryrun.deployer"))
        );
        address deployer = vm.addr(deployerPk);
        DeployConfig memory cfg = _loadConfigFromEnv(deployer);

        vm.startBroadcast(deployerPk);
        stack = deployAll(cfg);
        vm.stopBroadcast();

        _logSummary(cfg, stack);
    }

    /// @notice Deploys governance Safes, TimelockController, core contracts, adapters, and testnet quote tokens.
    ///         Transfers Ownable2Step pending ownership of all 6 admin-gated contracts to `timelock`.
    function deployAll(DeployConfig memory cfg) public returns (DeployedStack memory stack) {
        if (cfg.deployer == address(0)) revert InvalidDeployer();

        // 1. Governance & Emergency Topology (Safe v1.4.1 proxies + OZ TimelockController)
        stack.govSafe = _deploySafeProxy(cfg.govOwners, 3, cfg.saltNonceBase + 1);
        stack.guardianSafe = _deploySafeProxy(cfg.guardianOwners, 2, cfg.saltNonceBase + 2);
        stack.treasurySafe = _deploySafeProxy(cfg.treasuryOwners, 2, cfg.saltNonceBase + 3);

        address[] memory proposers = new address[](1);
        proposers[0] = stack.govSafe;
        address[] memory executors = new address[](1);
        executors[0] = stack.govSafe;

        stack.timelock = new TimelockController(
            cfg.timelockMinDelay,
            proposers,
            executors,
            cfg.deployer // Temporary admin to grant Guardian CANCELLER_ROLE and then renounce post-handover
        );
        stack.timelock.grantRole(stack.timelock.CANCELLER_ROLE(), stack.guardianSafe);

        // 2. Testnet Quote Tokens (labeled clearly; WHSK uses canonical Chain-133 predeploy)
        stack.tUsdt = new TestnetERC20("Tranche Testnet USDT", "tUSDT", 6, cfg.deployer);
        stack.tWbtc = new TestnetERC20("Tranche Testnet WBTC", "tWBTC", 8, cfg.deployer);
        stack.tWeth = new TestnetERC20("Tranche Testnet WETH", "tWETH", 18, cfg.deployer);

        // 3. Core Tranche Protocol Contracts (Strict Dependency Order)
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
        stack.router = new ExecutionRouter(address(stack.manager), TESTNET_WHSK);

        // 4. Oracle & Compliance Adapters
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

        // 5. Initial Allowlists, Decimal-Aware Minimums & Pair Price Bounds
        stack.manager.setApprovedOracle(address(stack.oracleAdapter), true);
        stack.manager.setApprovedComplianceHook(address(stack.complianceHook), true);
        stack.manager.setApprovedRouter(address(stack.router), true);

        stack.manager.setTokenMinTicketAmount(TESTNET_WHSK, 10e18); // 10 WHSK
        stack.manager.setTokenMinTicketAmount(address(stack.tUsdt), 1e6); // 1 tUSDT
        stack.manager.setTokenMinTicketAmount(address(stack.tWbtc), 1e4); // 0.0001 tWBTC
        stack.manager.setTokenMinTicketAmount(address(stack.tWeth), 1e15); // 0.001 tWETH

        stack.pullOracle.setMaxJumpBps(TESTNET_WHSK, address(stack.tUsdt), 500); // 5.0%
        stack.pullOracle.setMaxJumpBps(address(stack.tWeth), address(stack.tUsdt), 300); // 3.0%
        stack.pullOracle.setMaxJumpBps(address(stack.tWbtc), address(stack.tUsdt), 300); // 3.0%

        // No deep V3 TWAP pool on Chain-133 testnet -> requireSecondaryCheck=false, strict hard bounds enforced
        stack.oracleAdapter.setPairConfig(
            TESTNET_WHSK,
            address(stack.tUsdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(stack.pullOracle),
                secondaryFeed: address(0),
                maxStaleness: DEFAULT_MAX_PRICE_AGE,
                secondaryMaxStaleness: 0,
                maxDeviationBps: 0,
                requireSecondaryCheck: false,
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e21, // $0.001 per WHSK (18/6)
                hardMaxPriceX36: 1e26 // $100 per WHSK (18/6)
            })
        );
        stack.oracleAdapter.setPairConfig(
            address(stack.tWeth),
            address(stack.tUsdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(stack.pullOracle),
                secondaryFeed: address(0),
                maxStaleness: DEFAULT_MAX_PRICE_AGE,
                secondaryMaxStaleness: 0,
                maxDeviationBps: 0,
                requireSecondaryCheck: false,
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e26, // $100 per WETH (18/6)
                hardMaxPriceX36: 1e29 // $100,000 per WETH (18/6)
            })
        );
        stack.oracleAdapter.setPairConfig(
            address(stack.tWbtc),
            address(stack.tUsdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(stack.pullOracle),
                secondaryFeed: address(0),
                maxStaleness: DEFAULT_MAX_PRICE_AGE,
                secondaryMaxStaleness: 0,
                maxDeviationBps: 0,
                requireSecondaryCheck: false,
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e37, // $1,000 per WBTC (8/6)
                hardMaxPriceX36: 1e40 // $1,000,000 per WBTC (8/6)
            })
        );

        // 6. Initiate Ownable2Step Handover to TimelockController Across All 6 Admin-Gated Contracts
        stack.vault.transferOwnership(address(stack.timelock));
        stack.manager.transferOwnership(address(stack.timelock));
        stack.pullOracle.transferOwnership(address(stack.timelock));
        stack.oracleAdapter.transferOwnership(address(stack.timelock));
        stack.twapOracle.transferOwnership(address(stack.timelock));
        stack.complianceHook.transferOwnership(address(stack.timelock));
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

    function _loadConfigFromEnv(address deployer) internal view returns (DeployConfig memory cfg) {
        cfg.deployer = deployer;
        cfg.govOwners = new address[](5);
        cfg.govOwners[0] = vm.envOr("GOV_OWNER_1", vm.addr(uint256(keccak256("tranche.gov.1"))));
        cfg.govOwners[1] = vm.envOr("GOV_OWNER_2", vm.addr(uint256(keccak256("tranche.gov.2"))));
        cfg.govOwners[2] = vm.envOr("GOV_OWNER_3", vm.addr(uint256(keccak256("tranche.gov.3"))));
        cfg.govOwners[3] = vm.envOr("GOV_OWNER_4", vm.addr(uint256(keccak256("tranche.gov.4"))));
        cfg.govOwners[4] = vm.envOr("GOV_OWNER_5", vm.addr(uint256(keccak256("tranche.gov.5"))));

        cfg.guardianOwners = new address[](3);
        cfg.guardianOwners[0] = vm.envOr("GUARDIAN_OWNER_1", vm.addr(uint256(keccak256("tranche.guard.1"))));
        cfg.guardianOwners[1] = vm.envOr("GUARDIAN_OWNER_2", vm.addr(uint256(keccak256("tranche.guard.2"))));
        cfg.guardianOwners[2] = vm.envOr("GUARDIAN_OWNER_3", vm.addr(uint256(keccak256("tranche.guard.3"))));

        cfg.treasuryOwners = new address[](3);
        cfg.treasuryOwners[0] = vm.envOr("TREASURY_OWNER_1", vm.addr(uint256(keccak256("tranche.treasury.1"))));
        cfg.treasuryOwners[1] = vm.envOr("TREASURY_OWNER_2", vm.addr(uint256(keccak256("tranche.treasury.2"))));
        cfg.treasuryOwners[2] = vm.envOr("TREASURY_OWNER_3", vm.addr(uint256(keccak256("tranche.treasury.3"))));

        cfg.oracleSigners = new address[](3);
        cfg.oracleSigners[0] = vm.envOr("ORACLE_SIGNER_1", vm.addr(uint256(keccak256("tranche.oracle.1"))));
        cfg.oracleSigners[1] = vm.envOr("ORACLE_SIGNER_2", vm.addr(uint256(keccak256("tranche.oracle.2"))));
        cfg.oracleSigners[2] = vm.envOr("ORACLE_SIGNER_3", vm.addr(uint256(keccak256("tranche.oracle.3"))));

        cfg.hspAttestationSigner = vm.envOr(
            "HSP_ATTESTATION_SIGNER",
            vm.addr(uint256(keccak256("tranche.hsp.signer")))
        );
        cfg.timelockMinDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_TESTNET_TIMELOCK_DELAY);
        cfg.saltNonceBase = vm.envOr("SAFE_SALT_NONCE_BASE", uint256(133_2026_0001));
    }

    function _logSummary(DeployConfig memory cfg, DeployedStack memory stack) internal pure {
        console2.log("=== Tranche Testnet Deployment Summary ===");
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
        console2.log("tUSDT:", address(stack.tUsdt));
        console2.log("tWBTC:", address(stack.tWbtc));
        console2.log("tWETH:", address(stack.tWeth));
    }
}
