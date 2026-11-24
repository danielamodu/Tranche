// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployTestnet, ISafeL2} from "../script/DeployTestnet.s.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {HSPComplianceHook} from "../src/adapters/HSPComplianceHook.sol";
import {TestnetERC20} from "../src/mocks/TestnetERC20.sol";
import {
    CreateOfferParams,
    PriceMode,
    TicketStatus,
    IPriceOracle,
    IWETH9
} from "../src/interfaces/IProtocol.sol";

interface IMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData);
}

contract FeeOnTransferMockERC20 is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {
        _mint(msg.sender, 1_000_000e18);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100; // 1% transfer fee
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @title TestnetOperationalValidationTest
/// @notice Phase 3 operational, governance, oracle, lifecycle, and adversarial validation
///         executed against a live HashKey Chain Testnet (Chain ID 133) fork with real Safe v1.4.1 proxies,
///         TimelockController, canonical WHSK (0x4200...0006), and Multicall3.
contract TestnetOperationalValidationTest is Test {
    uint256 internal constant DEPLOYER_PK = 0xD001;

    uint256[] internal govPks;
    uint256[] internal guardianPks;
    uint256[] internal treasuryPks;
    uint256[] internal oraclePks;

    uint256 internal constant ORACLE_PK_4 = 0xB004;
    uint256 internal constant HSP_PK = 0xC001;
    uint256 internal constant LP_PK = 0xE001;
    uint256 internal constant TRADER1_PK = 0xE002;
    uint256 internal constant TRADER2_PK = 0xE003;

    address internal deployer;
    address internal lp;
    address internal trader1;
    address internal trader2;
    address internal keeper = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");

    DeployTestnet internal deployerScript;
    DeployTestnet.DeployedStack internal s;

    uint256 internal constant WHSK_PRICE_X36 = 80_808e18; // $0.080808 (18/6)
    uint256 internal constant WETH_PRICE_X36 = 3_000e24; // $3,000 (18/6)
    uint256 internal constant WBTC_PRICE_X36 = 90_000e34; // $90,000 (8/6)

    function setUp() public {
        deployerScript = new DeployTestnet();
        deployer = address(deployerScript);
        lp = vm.addr(LP_PK);
        trader1 = vm.addr(TRADER1_PK);
        trader2 = vm.addr(TRADER2_PK);

        govPks = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) govPks[i] = 0xA100 + i;

        guardianPks = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) guardianPks[i] = 0xA200 + i;

        treasuryPks = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) treasuryPks[i] = 0xA300 + i;

        oraclePks = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) oraclePks[i] = 0xB001 + i;

        DeployTestnet.DeployConfig memory cfg;
        cfg.deployer = deployer;
        cfg.govOwners = _addrs(govPks);
        cfg.guardianOwners = _addrs(guardianPks);
        cfg.treasuryOwners = _addrs(treasuryPks);
        cfg.oracleSigners = _addrs(oraclePks);
        cfg.hspAttestationSigner = vm.addr(HSP_PK);
        cfg.timelockMinDelay = 300;
        cfg.saltNonceBase = 133_2026_0001;

        vm.deal(deployer, 100 ether);
        vm.deal(lp, 50_000 ether);
        vm.deal(trader1, 10_000 ether);
        vm.deal(trader2, 10_000 ether);

        s = deployerScript.deployAll(cfg);

        // Mint testnet quote tokens for LP & traders
        vm.startPrank(deployer);
        s.tUsdt.mint(lp, 500_000e6);
        s.tUsdt.mint(trader1, 500_000e6);
        s.tUsdt.mint(trader2, 500_000e6);
        s.tWeth.mint(lp, 100e18);
        s.tWbtc.mint(lp, 10e8);
        vm.stopPrank();

        // Execute 3-of-5 Governance Safe + TimelockController ownership acceptance and renounce deployer admin role
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            deployerScript.buildAcceptOwnershipBatch(s);
        bytes32 salt = keccak256("phase3.initial.ownership.handover");
        _govExecuteBatchViaTimelock(targets, values, payloads, bytes32(0), salt);

        bytes32 adminRole = s.timelock.DEFAULT_ADMIN_ROLE();
        vm.prank(deployer);
        s.timelock.renounceRole(adminRole, deployer);

        // Seed fresh 2-of-3 oracle prices
        _pushOraclePrice(deployerScript.TESTNET_WHSK(), address(s.tUsdt), WHSK_PRICE_X36, oraclePks, 2);
        _pushOraclePrice(address(s.tWeth), address(s.tUsdt), WETH_PRICE_X36, oraclePks, 2);
        _pushOraclePrice(address(s.tWbtc), address(s.tUsdt), WBTC_PRICE_X36, oraclePks, 2);
    }

    // -------------------------------------------------------------------------
    // Section 2: Testnet Governance Topology & Controls
    // -------------------------------------------------------------------------

    function test_Governance_TopologyHandoverRotationVetoAndTreasuryClaim() public {
        assertEq(ISafeL2(s.govSafe).getThreshold(), 3);
        assertEq(ISafeL2(s.govSafe).getOwners().length, 5);
        assertEq(ISafeL2(s.guardianSafe).getThreshold(), 2);
        assertEq(ISafeL2(s.guardianSafe).getOwners().length, 3);
        assertEq(ISafeL2(s.treasurySafe).getThreshold(), 2);
        assertEq(ISafeL2(s.treasurySafe).getOwners().length, 3);

        // Verify zero EOA admin backdoors remain
        assertFalse(s.timelock.hasRole(s.timelock.DEFAULT_ADMIN_ROLE(), deployer));
        assertTrue(s.timelock.hasRole(s.timelock.PROPOSER_ROLE(), s.govSafe));
        assertTrue(s.timelock.hasRole(s.timelock.EXECUTOR_ROLE(), s.govSafe));
        assertTrue(s.timelock.hasRole(s.timelock.CANCELLER_ROLE(), s.guardianSafe));

        assertEq(s.vault.owner(), address(s.timelock));
        assertEq(s.manager.owner(), address(s.timelock));
        assertEq(s.pullOracle.owner(), address(s.timelock));
        assertEq(s.oracleAdapter.owner(), address(s.timelock));
        assertEq(s.twapOracle.owner(), address(s.timelock));
        assertEq(s.complianceHook.owner(), address(s.timelock));
        assertEq(s.vault.guardian(), s.guardianSafe);
        assertEq(s.manager.guardian(), s.guardianSafe);
        assertEq(s.pullOracle.guardian(), s.guardianSafe);
        assertEq(s.vault.feeCollector(), s.treasurySafe);

        // Unauthorized attacker / deployer cannot mutate any governance-controlled config
        vm.prank(deployer);
        vm.expectRevert();
        s.manager.setProtocolFeeBps(10);

        vm.prank(attacker);
        vm.expectRevert(LiquidityVault.Unauthorized.selector);
        s.vault.setDepositsPaused(true);

        // Schedule a timelocked fee increase to 15 bps and let 2-of-3 Guardian Safe cancel it
        bytes memory feeCall = abi.encodeWithSignature("setProtocolFeeBps(uint16)", uint16(15));
        bytes32 opSalt = keccak256("veto.fee.bump");
        bytes32 opId = s.timelock.hashOperation(address(s.manager), 0, feeCall, bytes32(0), opSalt);
        _execSafeTx(
            s.govSafe,
            govPks,
            3,
            address(s.timelock),
            abi.encodeWithSelector(
                s.timelock.schedule.selector, address(s.manager), 0, feeCall, bytes32(0), opSalt, uint256(300)
            )
        );
        assertTrue(s.timelock.isOperationPending(opId));

        _execSafeTx(
            s.guardianSafe,
            guardianPks,
            2,
            address(s.timelock),
            abi.encodeWithSelector(s.timelock.cancel.selector, opId)
        );
        assertFalse(s.timelock.isOperationPending(opId));
        assertEq(s.manager.protocolFeeBps(), 5);

        // Timelocked guardian rotation across Vault, Manager, PullOracle, then rotate back
        address newGuardian = makeAddr("newGuardianSafe");
        address[] memory targets = new address[](3);
        uint256[] memory values = new uint256[](3);
        bytes[] memory payloads = new bytes[](3);
        targets[0] = address(s.vault);
        targets[1] = address(s.manager);
        targets[2] = address(s.pullOracle);
        bytes memory rotData = abi.encodeWithSignature("setGuardian(address)", newGuardian);
        payloads[0] = rotData;
        payloads[1] = rotData;
        payloads[2] = rotData;

        _govExecuteBatchViaTimelock(targets, values, payloads, bytes32(0), keccak256("rotate.guardian.1"));
        assertEq(s.vault.guardian(), newGuardian);
        assertEq(s.manager.guardian(), newGuardian);
        assertEq(s.pullOracle.guardian(), newGuardian);

        // Two-step feeCollector transfer and acceptance by 2-of-3 Treasury Safe
        _govExecuteSingleViaTimelock(
            address(s.vault),
            abi.encodeWithSignature("setPendingFeeCollector(address)", s.treasurySafe),
            keccak256("fee.collector.handover")
        );
        _execSafeTx(
            s.treasurySafe,
            treasuryPks,
            2,
            address(s.vault),
            abi.encodeWithSignature("acceptFeeCollector()")
        );
        assertEq(s.vault.feeCollector(), s.treasurySafe);
    }

    // -------------------------------------------------------------------------
    // Section 3: Oracle Infrastructure & M-of-N Safeguards
    // -------------------------------------------------------------------------

    function test_Oracle_MOfN_SignerRotationAndBounds() public {
        address whsk = deployerScript.TESTNET_WHSK();
        address usdt = address(s.tUsdt);

        assertEq(s.oracleAdapter.getPriceX36(whsk, usdt).priceX36, WHSK_PRICE_X36);
        assertEq(s.oracleAdapter.getPriceX36(address(s.tWeth), usdt).priceX36, WETH_PRICE_X36);
        assertEq(s.oracleAdapter.getPriceX36(address(s.tWbtc), usdt).priceX36, WBTC_PRICE_X36);

        vm.warp(block.timestamp + 2);
        bytes[] memory oneSig = _signPriceReport(whsk, usdt, WHSK_PRICE_X36, block.timestamp, oraclePks, 1);
        vm.expectRevert(SignedPullOracle.InsufficientSignatures.selector);
        s.pullOracle.updatePrice(whsk, usdt, WHSK_PRICE_X36, block.timestamp, oneSig);

        uint256 jumpPrice = (WHSK_PRICE_X36 * 10_600) / 10_000;
        bytes[] memory jumpSigs = _signPriceReport(whsk, usdt, jumpPrice, block.timestamp, oraclePks, 2);
        vm.expectRevert(SignedPullOracle.MaxJumpExceeded.selector);
        s.pullOracle.updatePrice(whsk, usdt, jumpPrice, block.timestamp, jumpSigs);

        vm.warp(block.timestamp + 31);
        assertFalse(s.pullOracle.getPriceX36(whsk, usdt).isValid);
        assertFalse(s.oracleAdapter.getPriceX36(whsk, usdt).isValid);

        address signer4 = vm.addr(ORACLE_PK_4);
        address signer3 = vm.addr(oraclePks[2]);
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        targets[0] = address(s.pullOracle);
        targets[1] = address(s.pullOracle);
        payloads[0] = abi.encodeWithSignature("addSigner(address)", signer4);
        payloads[1] = abi.encodeWithSignature("removeSigner(address)", signer3);
        _govExecuteBatchViaTimelock(targets, values, payloads, bytes32(0), keccak256("rotate.oracle.signer"));

        assertTrue(s.pullOracle.isSigner(signer4));
        assertFalse(s.pullOracle.isSigner(signer3));

        uint256[] memory badPair = new uint256[](2);
        badPair[0] = oraclePks[0];
        badPair[1] = oraclePks[2];
        bytes[] memory compromisedSigs = _signPriceReport(whsk, usdt, WHSK_PRICE_X36, block.timestamp, badPair, 2);
        vm.expectRevert(SignedPullOracle.InvalidSigner.selector);
        s.pullOracle.updatePrice(whsk, usdt, WHSK_PRICE_X36, block.timestamp, compromisedSigs);

        uint256[] memory rotatedPair = new uint256[](2);
        rotatedPair[0] = oraclePks[0];
        rotatedPair[1] = ORACLE_PK_4;
        _pushOraclePrice(whsk, usdt, WHSK_PRICE_X36, rotatedPair, 2);
        assertTrue(s.oracleAdapter.getPriceX36(whsk, usdt).isValid);
    }

    function test_Oracle_GuardianRevokeAndFixedLiveness() public {
        address whsk = deployerScript.TESTNET_WHSK();
        address usdt = address(s.tUsdt);
        (uint256 fixedTid, uint256 floatTid) = _setupFixedAndFloatingTickets(whsk, usdt);

        _execSafeTx(
            s.guardianSafe,
            guardianPks,
            2,
            address(s.manager),
            abi.encodeWithSignature("setFloatingExercisePaused(bool)", true)
        );
        _execSafeTx(
            s.guardianSafe,
            guardianPks,
            2,
            address(s.pullOracle),
            abi.encodeWithSignature("revokePrice(address,address)", whsk, usdt)
        );

        assertFalse(s.pullOracle.getPriceX36(whsk, usdt).isValid);

        // Replay of earlier signed price report with ts <= revoked updatedAt fails
        bytes[] memory replaySigs = _signPriceReport(whsk, usdt, WHSK_PRICE_X36, block.timestamp, oraclePks, 2);
        vm.expectRevert(SignedPullOracle.StaleTimestamp.selector);
        s.pullOracle.updatePrice(whsk, usdt, WHSK_PRICE_X36, block.timestamp, replaySigs);

        vm.startPrank(trader1);
        IERC20(usdt).approve(address(s.vault), type(uint256).max);
        vm.expectRevert(CommitmentManager.FloatingExercisePaused.selector);
        s.manager.exercise(floatTid, 100e18, 20e6, trader1);

        (uint256 fixedFill, uint256 fixedPaid) = s.manager.exercise(fixedTid, 100e18, 20e6, trader1);
        assertEq(fixedFill, 100e18);
        assertGt(fixedPaid, 0);
        vm.stopPrank();

        vm.warp(block.timestamp + 400);
        s.manager.reclaimExpired(floatTid);
        assertEq(uint256(s.manager.getTicket(floatTid).status), uint256(TicketStatus.RECLAIMED));
    }

    // -------------------------------------------------------------------------
    // Section 4: Complete Protocol Lifecycle (Native HSK/WHSK, Permit, Split, Router)
    // -------------------------------------------------------------------------

    struct GasReport {
        uint256 wrap;
        uint256 deposit;
        uint256 createOffer;
        uint256 reserve;
        uint256 split;
        uint256 partialExercise;
        uint256 batchExercise;
        uint256 reclaim;
    }

    function test_Lifecycle_NativeWHSK_Permit_Split_PartialExercise_RouterBatch_TreasuryClaim() public {
        address whsk = deployerScript.TESTNET_WHSK();
        address usdt = address(s.tUsdt);
        GasReport memory g;

        vm.warp(block.timestamp + 1);
        _pushOraclePrice(whsk, usdt, WHSK_PRICE_X36, oraclePks, 2);

        uint256 lpHskBefore = lp.balance;
        uint256 traderUsdtBefore = s.tUsdt.balanceOf(trader1);

        (uint64 fixedOfferId, uint64 floatOfferId) = _lifecycleSetupOffers(whsk, usdt, g);
        (uint256 t1, uint256 t2) = _lifecycleReserveAndTransfer(usdt, fixedOfferId, floatOfferId, g);
        uint256 t1Child = _lifecycleSplitAndBatchExercise(whsk, usdt, t1, t2, g);
        _lifecycleReclaimAndSettle(fixedOfferId, floatOfferId, [t1, t1Child, t2], g);

        assertEq(lpHskBefore - lp.balance, 5_000e18);
        assertLt(s.tUsdt.balanceOf(trader1), traderUsdtBefore);

        _assertVaultSolvency(whsk);
        _assertVaultSolvency(usdt);

        console2.log("=== Gas Metrics (Chain 133 Fork) ===");
        console2.log("WHSK wrap:", g.wrap);
        console2.log("Vault deposit:", g.deposit);
        console2.log("createOffer:", g.createOffer);
        console2.log("reserve:", g.reserve);
        console2.log("splitTicket:", g.split);
        console2.log("partial exercise:", g.partialExercise);
        console2.log("router batchExercise (2 legs + unwrap):", g.batchExercise);
        console2.log("reclaimExpiredBatchBestEffort (2/3):", g.reclaim);
    }

    function _lifecycleSetupOffers(address whsk, address usdt, GasReport memory g)
        internal
        returns (uint64 fixedOfferId, uint64 floatOfferId)
    {
        vm.startPrank(lp);
        uint256 g0 = gasleft();
        IWETH9(whsk).deposit{value: 5_000e18}();
        g.wrap = g0 - gasleft();
        IERC20(whsk).approve(address(s.vault), 5_000e18);
        g0 = gasleft();
        s.vault.deposit(whsk, 5_000e18);
        g.deposit = g0 - gasleft();

        g0 = gasleft();
        fixedOfferId = s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: whsk,
                paymentToken: usdt,
                initialAmount: 2_500e18,
                minFillAmount: 100e18,
                expiry: uint40(block.timestamp + 7_200),
                minDuration: 60,
                maxDuration: 3_600,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: 82_000e18,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        g.createOffer = g0 - gasleft();

        floatOfferId = s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: whsk,
                paymentToken: usdt,
                initialAmount: 2_500e18,
                minFillAmount: 100e18,
                expiry: uint40(block.timestamp + 7_200),
                minDuration: 60,
                maxDuration: 3_600,
                basePremiumBps: 40,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FLOATING,
                spreadBps: 100,
                oracle: address(s.oracleAdapter),
                complianceHook: address(0),
                fixedPriceX36: 0,
                minPriceX36: 70_000e18,
                maxPriceX36: 100_000e18
            })
        );
        vm.stopPrank();
    }

    function _lifecycleReserveAndTransfer(
        address usdt,
        uint64 fixedOfferId,
        uint64 floatOfferId,
        GasReport memory g
    ) internal returns (uint256 t1, uint256 t2) {
        vm.startPrank(trader1);
        IERC20(usdt).approve(address(s.vault), type(uint256).max);
        uint256 g0 = gasleft();
        t1 = s.manager.reserve(fixedOfferId, 1_000e18, 600, 10e6, trader1);
        g.reserve = g0 - gasleft();
        t2 = s.manager.reserve(floatOfferId, 800e18, 600, 10e6, trader1);

        uint256 nonceBeforeTransfer = s.ticketNft.nonces(t1);
        s.ticketNft.transferFrom(trader1, trader2, t1);
        assertEq(s.ticketNft.nonces(t1), nonceBeforeTransfer + 1);
        s.ticketNft.transferFrom(trader1, trader2, t2);
        vm.stopPrank();
    }

    function _lifecycleSplitAndBatchExercise(
        address whsk,
        address usdt,
        uint256 t1,
        uint256 t2,
        GasReport memory g
    ) internal returns (uint256 t1Child) {
        vm.startPrank(trader2);
        IERC20(usdt).approve(address(s.vault), type(uint256).max);
        uint256 g0 = gasleft();
        t1Child = s.manager.splitTicket(t1, 300e18, trader2);
        g.split = g0 - gasleft();

        g0 = gasleft();
        (uint256 fill1, uint256 paid1) = s.manager.exercise(t1, 400e18, 50e6, trader2);
        g.partialExercise = g0 - gasleft();
        assertEq(fill1, 400e18);
        assertGt(paid1, 0);

        _execRouterBatchLeg(whsk, usdt, t1Child, t2, g);
        vm.stopPrank();
    }

    function _execRouterBatchLeg(
        address whsk,
        address usdt,
        uint256 t1Child,
        uint256 t2,
        GasReport memory g
    ) internal {
        uint256 deadline = block.timestamp + 300;
        _permitTicket(TRADER2_PK, address(s.router), t1Child, deadline);
        _permitTicket(TRADER2_PK, address(s.router), t2, deadline);
        IERC20(usdt).approve(address(s.router), type(uint256).max);

        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](2);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: t1Child, fillAmount: 300e18, maxLegPaymentIn: 40e6});
        legs[1] = ExecutionRouter.ExerciseLeg({ticketId: t2, fillAmount: 500e18, maxLegPaymentIn: 60e6});

        uint256 trader2NativeBefore = trader2.balance;
        uint256 g0 = gasleft();
        (uint256 batchOut, uint256 batchIn) = s.router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: whsk,
                paymentToken: usdt,
                minTotalInventoryOut: 800e18,
                maxTotalPaymentIn: 100e6,
                deadline: deadline,
                receiver: trader2,
                unwrapInventoryToNative: true,
                legs: legs
            })
        );
        g.batchExercise = g0 - gasleft();

        assertEq(batchOut, 800e18);
        assertGt(batchIn, 0);
        assertEq(trader2.balance - trader2NativeBefore, 800e18);
        assertEq(IERC20(usdt).balanceOf(address(s.router)), 0);
    }

    function _lifecycleReclaimAndSettle(
        uint64 fixedOfferId,
        uint64 floatOfferId,
        uint256[3] memory ticketIds,
        GasReport memory g
    ) internal {
        address whsk = deployerScript.TESTNET_WHSK();
        address usdt = address(s.tUsdt);

        vm.warp(block.timestamp + 601);
        uint256[] memory batchIds = new uint256[](3);
        batchIds[0] = ticketIds[0];
        batchIds[1] = ticketIds[1];
        batchIds[2] = ticketIds[2];
        uint256 g0 = gasleft();
        vm.prank(keeper);
        uint256 reclaimed = s.manager.reclaimExpiredBatchBestEffort(batchIds);
        g.reclaim = g0 - gasleft();
        assertEq(reclaimed, 2);

        uint256 expectedFees = s.vault.protocolFees(usdt);
        assertGt(expectedFees, 0);
        uint256 treasuryUsdtBefore = s.tUsdt.balanceOf(s.treasurySafe);
        _execSafeTx(
            s.treasurySafe,
            treasuryPks,
            2,
            address(s.vault),
            abi.encodeWithSignature("withdrawProtocolFees(address,address)", usdt, s.treasurySafe)
        );
        assertEq(s.tUsdt.balanceOf(s.treasurySafe) - treasuryUsdtBefore, expectedFees);

        uint256 lpUsdtBefore = s.tUsdt.balanceOf(lp);
        uint256 expectedProceeds = s.vault.lpPendingProceeds(lp, usdt);
        vm.startPrank(lp);
        s.vault.claimProceeds(usdt, 0, lp);
        s.manager.cancelOffer(fixedOfferId);
        s.manager.cancelOffer(floatOfferId);
        s.vault.withdrawFree(whsk, s.vault.lpFreeBalance(lp, whsk), lp);
        vm.stopPrank();

        assertEq(s.tUsdt.balanceOf(lp) - lpUsdtBefore, expectedProceeds);
    }

    // -------------------------------------------------------------------------
    // Section 5: Adversarial Operational Validation
    // -------------------------------------------------------------------------

    function test_Adversarial_Compliance_DuplicateKeeper_FeeToken_UnapprovedAdapters() public {
        address whsk = deployerScript.TESTNET_WHSK();
        address usdt = address(s.tUsdt);
        vm.warp(block.timestamp + 1);
        _pushOraclePrice(whsk, usdt, WHSK_PRICE_X36, oraclePks, 2);

        // 1. Non-compliant LP blocked on createOffer
        vm.startPrank(lp);
        IERC20(usdt).approve(address(s.vault), type(uint256).max);
        s.vault.deposit(usdt, 20_000e6);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, lp));
        s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: usdt,
                paymentToken: whsk,
                initialAmount: 5_000e6,
                minFillAmount: 100e6,
                expiry: uint40(block.timestamp + 3_600),
                minDuration: 60,
                maxDuration: 1_200,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(s.complianceHook),
                fixedPriceX36: 12e36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        // Attest LP and Trader1 via EIP-712 HSP attestation signature
        _submitHspAttestation(lp, block.timestamp + 7_200);
        _submitHspAttestation(trader1, block.timestamp + 7_200);

        vm.prank(lp);
        uint64 gatedOfferId = s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: usdt,
                paymentToken: whsk,
                initialAmount: 5_000e6,
                minFillAmount: 100e6,
                expiry: uint40(block.timestamp + 3_600),
                minDuration: 60,
                maxDuration: 1_200,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(s.complianceHook),
                fixedPriceX36: 12e36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );

        // Unattested Trader2 cannot reserve
        vm.startPrank(trader2);
        IWETH9(whsk).deposit{value: 1_000e18}();
        IERC20(whsk).approve(address(s.vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader2));
        s.manager.reserve(gatedOfferId, 500e6, 300, 100e18, trader2);
        vm.stopPrank();

        // Compliant Trader1 reserves, cannot transfer to unattested Trader2 or exercise via router with unattested receiver
        vm.startPrank(trader1);
        IWETH9(whsk).deposit{value: 1_000e18}();
        IERC20(whsk).approve(address(s.vault), type(uint256).max);
        uint256 gatedTid = s.manager.reserve(gatedOfferId, 500e6, 300, 100e18, trader1);

        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader2));
        s.ticketNft.transferFrom(trader1, trader2, gatedTid);

        s.ticketNft.approve(address(s.router), gatedTid);
        IERC20(whsk).approve(address(s.router), type(uint256).max);
        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](1);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: gatedTid, fillAmount: 200e6, maxLegPaymentIn: 100e18});
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader2));
        s.router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: usdt,
                paymentToken: whsk,
                minTotalInventoryOut: 200e6,
                maxTotalPaymentIn: 100e18,
                deadline: block.timestamp + 100,
                receiver: trader2,
                unwrapInventoryToNative: false,
                legs: legs
            })
        );
        vm.stopPrank();

        // 2. Duplicate keeper execution idempotency + INV-8 when LP is later revoked via Timelock
        _govExecuteSingleViaTimelock(
            address(s.complianceHook),
            abi.encodeWithSignature("revoke(address)", lp),
            keccak256("revoke.lp")
        );

        vm.warp(block.timestamp + 301);
        uint256[] memory ids = new uint256[](1);
        ids[0] = gatedTid;
        vm.prank(keeper);
        assertEq(s.manager.reclaimExpiredBatchBestEffort(ids), 1);
        // Duplicate keeper call immediately afterwards safely returns 0 without revert
        vm.prank(keeper);
        assertEq(s.manager.reclaimExpiredBatchBestEffort(ids), 0);

        // Revoked LP can still cancelOffer and withdrawFree 100% of inventory
        vm.startPrank(lp);
        s.manager.cancelOffer(gatedOfferId);
        s.vault.withdrawFree(usdt, 20_000e6, lp);
        vm.stopPrank();

        // 3. Fee-on-transfer token deposit rejected by vault
        FeeOnTransferMockERC20 feeToken = new FeeOnTransferMockERC20();
        feeToken.approve(address(s.vault), 1_000e18);
        vm.expectRevert(LiquidityVault.UnsupportedTokenBalanceDelta.selector);
        s.vault.deposit(address(feeToken), 1_000e18);

        // 4. Unapproved adapter & router registration rejected
        vm.prank(lp);
        vm.expectRevert(CommitmentManager.UnapprovedAdapter.selector);
        s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: whsk,
                paymentToken: usdt,
                initialAmount: 100e18,
                minFillAmount: 10e18,
                expiry: uint40(block.timestamp + 3_600),
                minDuration: 60,
                maxDuration: 1_200,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: attacker,
                complianceHook: address(0),
                fixedPriceX36: 82_000e18,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );

        vm.prank(attacker);
        vm.expectRevert(CommitmentManager.Unauthorized.selector);
        s.manager.exerciseFor(gatedTid, 100e6, 1e18, trader1, trader1, trader1);

        // 5. Multicall3 read batch against Chain-133 predeploy verifies vault accounting
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](4);
        calls[0] = IMulticall3.Call3(
            address(s.vault), false, abi.encodeWithSignature("totalLpFree(address)", usdt)
        );
        calls[1] = IMulticall3.Call3(
            address(s.vault), false, abi.encodeWithSignature("totalOfferAvailable(address)", usdt)
        );
        calls[2] = IMulticall3.Call3(
            address(s.vault), false, abi.encodeWithSignature("totalReserved(address)", usdt)
        );
        calls[3] = IMulticall3.Call3(
            address(s.vault), false, abi.encodeWithSignature("totalPendingProceeds(address)", usdt)
        );
        IMulticall3.Result[] memory res = IMulticall3(deployerScript.MULTICALL3()).aggregate3(calls);
        for (uint256 i = 0; i < 4; ++i) {
            assertTrue(res[i].success);
            assertEq(abi.decode(res[i].returnData, (uint256)), 0);
        }
        _assertVaultSolvency(usdt);
        _assertVaultSolvency(whsk);
    }

    struct PreflightGas {
        uint256 scheduleHandover;
        uint256 executeHandover;
        uint256 renounceAdmin;
        uint256 mintTweth;
        uint256 mintTusdt;
        uint256 lpTotal;
        uint256 traderTotal;
    }

    function test_Lifecycle_tWETH_tUSDT_AndHandoverGasBudget() public {
        PreflightGas memory pg;

        // 1. Fresh deploy on Chain-133 fork to measure exact handover + mint gas
        DeployTestnet.DeployConfig memory cfg;
        cfg.deployer = deployer;
        cfg.govOwners = _addrs(govPks);
        cfg.guardianOwners = _addrs(guardianPks);
        cfg.treasuryOwners = _addrs(treasuryPks);
        cfg.oracleSigners = _addrs(oraclePks);
        cfg.hspAttestationSigner = vm.addr(HSP_PK);
        cfg.timelockMinDelay = 60;
        cfg.saltNonceBase = 133_2026_9999;

        DeployTestnet.DeployedStack memory fresh = deployerScript.deployAll(cfg);

        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            deployerScript.buildAcceptOwnershipBatch(fresh);
        bytes32 salt = keccak256("tranche.testnet.ownership.handover.v1");

        uint256 g0 = gasleft();
        _execSafeTx(
            fresh.govSafe,
            govPks,
            3,
            address(fresh.timelock),
            abi.encodeWithSelector(
                fresh.timelock.scheduleBatch.selector, targets, values, payloads, bytes32(0), salt, uint256(60)
            )
        );
        pg.scheduleHandover = g0 - gasleft();

        vm.warp(block.timestamp + 61);
        g0 = gasleft();
        _execSafeTx(
            fresh.govSafe,
            govPks,
            3,
            address(fresh.timelock),
            abi.encodeWithSelector(fresh.timelock.executeBatch.selector, targets, values, payloads, bytes32(0), salt)
        );
        pg.executeHandover = g0 - gasleft();

        bytes32 adminRole = fresh.timelock.DEFAULT_ADMIN_ROLE();
        vm.prank(deployer);
        g0 = gasleft();
        fresh.timelock.renounceRole(adminRole, deployer);
        pg.renounceAdmin = g0 - gasleft();

        for (uint256 i = 0; i < 6; ++i) {
            assertEq(LiquidityVault(targets[i]).owner(), address(fresh.timelock));
        }
        assertFalse(fresh.timelock.hasRole(adminRole, deployer));

        // 2. Mint tWETH to LP and tUSDT to Trader1
        vm.startPrank(deployer);
        g0 = gasleft();
        fresh.tWeth.mint(lp, 0.05e18);
        pg.mintTweth = g0 - gasleft();
        g0 = gasleft();
        fresh.tUsdt.mint(trader1, 100e6);
        pg.mintTusdt = g0 - gasleft();
        vm.stopPrank();

        // 3. Complete tWETH/tUSDT LP-to-Trader lifecycle (zero HSK wrapping)
        uint64 offerId = _runTwethLpSetup(fresh, pg);
        _runTwethTraderFlow(fresh, offerId, pg);
        _runTwethLpSettle(fresh, offerId, pg);

        console2.log("=== Exact Chain-133 Fork Gas: Handover, Mints, tWETH/tUSDT Lifecycle ===");
        console2.log("scheduleHandover (3/5 Safe -> Timelock):", pg.scheduleHandover);
        console2.log("executeHandover (3/5 Safe -> 6x acceptOwnership):", pg.executeHandover);
        console2.log("renounceRole (DEFAULT_ADMIN_ROLE):", pg.renounceAdmin);
        console2.log("tWETH.mint:", pg.mintTweth);
        console2.log("tUSDT.mint:", pg.mintTusdt);
        console2.log("LP total (approve+deposit+createOffer+claim+cancel+withdraw):", pg.lpTotal);
        console2.log("Trader total (approve+reserve+exercise):", pg.traderTotal);
    }

    function _runTwethLpSetup(DeployTestnet.DeployedStack memory fresh, PreflightGas memory pg)
        internal
        returns (uint64 offerId)
    {
        vm.startPrank(lp);
        uint256 g0 = gasleft();
        IERC20(address(fresh.tWeth)).approve(address(fresh.vault), 0.02e18);
        fresh.vault.deposit(address(fresh.tWeth), 0.02e18);
        offerId = fresh.manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(fresh.tWeth),
                paymentToken: address(fresh.tUsdt),
                initialAmount: 0.02e18,
                minFillAmount: 0.001e18,
                expiry: uint40(block.timestamp + 3_600),
                minDuration: 60,
                maxDuration: 1_800,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: WETH_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        pg.lpTotal += (g0 - gasleft());
        vm.stopPrank();
    }

    function _runTwethTraderFlow(DeployTestnet.DeployedStack memory fresh, uint64 offerId, PreflightGas memory pg)
        internal
    {
        vm.startPrank(trader1);
        uint256 g0 = gasleft();
        IERC20(address(fresh.tUsdt)).approve(address(fresh.vault), 100e6);
        uint256 tid = fresh.manager.reserve(offerId, 0.01e18, 600, 1e6, trader1);
        (uint256 filled, uint256 paid) = fresh.manager.exercise(tid, 0.01e18, 35e6, trader1);
        pg.traderTotal += (g0 - gasleft());
        vm.stopPrank();

        assertEq(filled, 0.01e18);
        assertEq(paid, 30e6);
        assertEq(fresh.tWeth.balanceOf(trader1), 0.01e18);
        assertEq(uint256(fresh.manager.getTicket(tid).status), uint256(TicketStatus.EXERCISED));
    }

    function _runTwethLpSettle(DeployTestnet.DeployedStack memory fresh, uint64 offerId, PreflightGas memory pg)
        internal
    {
        vm.startPrank(lp);
        uint256 g0 = gasleft();
        fresh.vault.claimProceeds(address(fresh.tUsdt), 0, lp);
        fresh.manager.cancelOffer(offerId);
        fresh.vault.withdrawFree(address(fresh.tWeth), 0.01e18, lp);
        pg.lpTotal += (g0 - gasleft());
        vm.stopPrank();

        assertGt(fresh.tUsdt.balanceOf(lp), 0);
        assertEq(fresh.tWeth.balanceOf(lp), 0.04e18);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _setupFixedAndFloatingTickets(address inv, address pay)
        internal
        returns (uint256 fixedTid, uint256 floatTid)
    {
        vm.startPrank(lp);
        IWETH9(inv).deposit{value: 1_000e18}();
        IERC20(inv).approve(address(s.vault), 1_000e18);
        s.vault.deposit(inv, 1_000e18);

        uint64 oFixed = s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: inv,
                paymentToken: pay,
                initialAmount: 500e18,
                minFillAmount: 50e18,
                expiry: uint40(block.timestamp + 3_600),
                minDuration: 60,
                maxDuration: 1_200,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: 82_000e18,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        uint64 oFloat = s.manager.createOffer(
            CreateOfferParams({
                inventoryToken: inv,
                paymentToken: pay,
                initialAmount: 500e18,
                minFillAmount: 50e18,
                expiry: uint40(block.timestamp + 3_600),
                minDuration: 60,
                maxDuration: 1_200,
                basePremiumBps: 50,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FLOATING,
                spreadBps: 0,
                oracle: address(s.oracleAdapter),
                complianceHook: address(0),
                fixedPriceX36: 0,
                minPriceX36: 50_000e18,
                maxPriceX36: 120_000e18
            })
        );
        vm.stopPrank();

        vm.startPrank(trader1);
        IERC20(pay).approve(address(s.vault), type(uint256).max);
        fixedTid = s.manager.reserve(oFixed, 200e18, 300, 10e6, trader1);
        floatTid = s.manager.reserve(oFloat, 200e18, 300, 10e6, trader1);
        vm.stopPrank();
    }

    function _assertVaultSolvency(address token) internal view {
        uint256 tracked = s.vault.totalLpFree(token) + s.vault.totalOfferAvailable(token)
            + s.vault.totalReserved(token) + s.vault.totalPendingProceeds(token) + s.vault.protocolFees(token);
        assertGe(IERC20(token).balanceOf(address(s.vault)), tracked);
    }

    function _submitHspAttestation(address subject, uint256 expiry) internal {
        uint256 nonce = s.complianceHook.nonces(subject);
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ProtocolHSPCompliance"),
                keccak256("1"),
                block.chainid,
                address(s.complianceHook)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(s.complianceHook.ATTESTATION_TYPEHASH(), subject, nonce, expiry)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(HSP_PK, digest);
        s.complianceHook.submitAttestation(subject, nonce, expiry, abi.encodePacked(r, sigS, v));
    }

    function _permitTicket(uint256 ownerPk, address spender, uint256 tokenId, uint256 deadline) internal {
        uint256 nonce = s.ticketNft.nonces(tokenId);
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Execution Ticket"),
                keccak256("1"),
                block.chainid,
                address(s.ticketNft)
            )
        );
        bytes32 typehash = keccak256("Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(typehash, spender, tokenId, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(ownerPk, digest);
        s.ticketNft.permit(spender, tokenId, deadline, v, r, sigS);
    }

    function _govExecuteSingleViaTimelock(address target, bytes memory payload, bytes32 salt) internal {
        uint256 delay = s.timelock.getMinDelay();
        _execSafeTx(
            s.govSafe,
            govPks,
            3,
            address(s.timelock),
            abi.encodeWithSelector(s.timelock.schedule.selector, target, 0, payload, bytes32(0), salt, delay)
        );
        vm.warp(block.timestamp + delay);
        _execSafeTx(
            s.govSafe,
            govPks,
            3,
            address(s.timelock),
            abi.encodeWithSelector(s.timelock.execute.selector, target, 0, payload, bytes32(0), salt)
        );
    }

    function _govExecuteBatchViaTimelock(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory payloads,
        bytes32 predecessor,
        bytes32 salt
    ) internal {
        uint256 delay = s.timelock.getMinDelay();
        _execSafeTx(
            s.govSafe,
            govPks,
            3,
            address(s.timelock),
            abi.encodeWithSelector(
                s.timelock.scheduleBatch.selector, targets, values, payloads, predecessor, salt, delay
            )
        );
        vm.warp(block.timestamp + delay);
        _execSafeTx(
            s.govSafe,
            govPks,
            3,
            address(s.timelock),
            abi.encodeWithSelector(s.timelock.executeBatch.selector, targets, values, payloads, predecessor, salt)
        );
    }

    function _execSafeTx(
        address safeAddr,
        uint256[] memory signersPks,
        uint256 threshold,
        address to,
        bytes memory data
    ) internal {
        ISafeL2 safe = ISafeL2(safeAddr);
        uint256 safeNonce = safe.nonce();
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safeNonce
        );
        bytes memory signatures = _buildSortedSafeSignatures(txHash, signersPks, threshold);
        bool ok = safe.execTransaction(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
        );
        assertTrue(ok, "Safe execTransaction failed");
    }

    function _buildSortedSafeSignatures(bytes32 digest, uint256[] memory pks, uint256 count)
        internal
        pure
        returns (bytes memory packed)
    {
        uint256[] memory chosen = new uint256[](count);
        address[] memory addrs = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            chosen[i] = pks[i];
            addrs[i] = vm.addr(pks[i]);
        }
        // Sort ascending by address (required by Safe v1.4.1 & SignedPullOracle)
        for (uint256 i = 0; i < count; ++i) {
            for (uint256 j = i + 1; j < count; ++j) {
                if (addrs[j] < addrs[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (chosen[i], chosen[j]) = (chosen[j], chosen[i]);
                }
            }
        }
        for (uint256 i = 0; i < count; ++i) {
            (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(chosen[i], digest);
            packed = abi.encodePacked(packed, r, sigS, v);
        }
    }

    function _pushOraclePrice(
        address inv,
        address pay,
        uint256 priceX36,
        uint256[] memory pks,
        uint256 count
    ) internal {
        uint256 ts = block.timestamp;
        bytes[] memory sigs = _signPriceReport(inv, pay, priceX36, ts, pks, count);
        s.pullOracle.updatePrice(inv, pay, priceX36, ts, sigs);
    }

    function _signPriceReport(
        address inv,
        address pay,
        uint256 priceX36,
        uint256 ts,
        uint256[] memory pks,
        uint256 count
    ) internal view returns (bytes[] memory sigs) {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ProtocolSignedPullOracle"),
                keccak256("2"),
                block.chainid,
                address(s.pullOracle)
            )
        );
        bytes32 structHash = keccak256(abi.encode(s.pullOracle.PRICE_REPORT_TYPEHASH(), inv, pay, priceX36, ts));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));

        uint256[] memory chosen = new uint256[](count);
        address[] memory addrs = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            chosen[i] = pks[i];
            addrs[i] = vm.addr(pks[i]);
        }
        for (uint256 i = 0; i < count; ++i) {
            for (uint256 j = i + 1; j < count; ++j) {
                if (addrs[j] < addrs[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (chosen[i], chosen[j]) = (chosen[j], chosen[i]);
                }
            }
        }
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(chosen[i], digest);
            sigs[i] = abi.encodePacked(r, sigS, v);
        }
    }

    function _addrs(uint256[] memory pks) internal pure returns (address[] memory out) {
        out = new address[](pks.length);
        for (uint256 i = 0; i < pks.length; ++i) out[i] = vm.addr(pks[i]);
    }
}
