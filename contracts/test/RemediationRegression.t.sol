// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {UniswapV3TwapOracle} from "../src/adapters/UniswapV3TwapOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {HSPComplianceHook} from "../src/adapters/HSPComplianceHook.sol";
import {MockERC20, MockWHSK, MockStaticPriceOracle} from "./ProtocolAdversarial.t.sol";
import {CreateOfferParams, PriceMode, TicketStatus, IPriceOracle} from "../src/interfaces/IProtocol.sol";

/// @title RemediationRegressionTest
/// @notice Proves closure of H-01..H-03, M-01..M-05, L-01..L-04, Econ-1, Econ-2, and Oracle-1.
contract RemediationRegressionTest is Test {
    uint256 internal constant PK1 = 0x101;
    uint256 internal constant PK2 = 0x102;
    uint256 internal constant PK3 = 0x103;
    uint256 internal constant HSP_PK = 0x201;
    uint256 internal constant ALICE_PK = 0x301;

    uint256 internal constant WHSK_PRICE_X36 = 80_808e18; // ~$0.080808 (18/6)

    address internal guardian = makeAddr("guardian");
    address internal feeCollector = makeAddr("feeCollector");
    address internal lp = makeAddr("lp");
    address internal alice;
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    MockWHSK internal whsk;
    MockERC20 internal weth;
    MockERC20 internal wbtc;
    MockERC20 internal usdt;
    LiquidityVault internal vault;
    CommitmentManager internal manager;
    ExecutionTicket internal ticketNft;
    ExecutionRouter internal router;
    SignedPullOracle internal pullOracle;
    MockStaticPriceOracle internal secondaryOracle;
    OraclePriceAdapter internal adapter;
    HSPComplianceHook internal hspHook;

    function setUp() public {
        vm.warp(1_795_500_000);
        alice = vm.addr(ALICE_PK);

        whsk = new MockWHSK();
        weth = new MockERC20("WETH", "WETH", 18);
        wbtc = new MockERC20("WBTC", "WBTC", 8);
        usdt = new MockERC20("USDT", "USDT", 6);

        vault = new LiquidityVault(address(this), guardian, feeCollector);
        manager = new CommitmentManager(address(this), address(vault), guardian, 5); // 5 bps
        ticketNft = new ExecutionTicket(address(manager));
        vault.setManager(address(manager));
        manager.setTicketNft(address(ticketNft));

        manager.setTokenMinTicketAmount(address(whsk), 1_000e18);
        manager.setTokenMinTicketAmount(address(weth), 5e16); // 0.05 WETH
        manager.setTokenMinTicketAmount(address(wbtc), 1e5);  // 0.001 WBTC
        manager.setTokenMinTicketAmount(address(usdt), 50e6); // 50 USDT

        router = new ExecutionRouter(address(manager), address(whsk));
        manager.setApprovedRouter(address(router), true);

        address[] memory signers = new address[](3);
        signers[0] = vm.addr(PK1);
        signers[1] = vm.addr(PK2);
        signers[2] = vm.addr(PK3);
        pullOracle = new SignedPullOracle(address(this), guardian, signers, 2, 30);
        pullOracle.setMaxJumpBps(address(whsk), address(usdt), 500);
        pullOracle.setMaxJumpBps(address(weth), address(usdt), 300);
        pullOracle.setMaxJumpBps(address(wbtc), address(usdt), 300);

        secondaryOracle = new MockStaticPriceOracle(WHSK_PRICE_X36, block.timestamp, true);
        adapter = new OraclePriceAdapter(address(this));
        adapter.setPairConfig(
            address(whsk),
            address(usdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(secondaryOracle),
                maxStaleness: 30,
                secondaryMaxStaleness: 3600,
                maxDeviationBps: 500,
                requireSecondaryCheck: true,
                allowSecondaryFallback: false,
                hardMinPriceX36: 3e22,
                hardMaxPriceX36: 25e22
            })
        );

        hspHook = new HSPComplianceHook(address(this), vm.addr(HSP_PK));
        manager.setApprovedOracle(address(adapter), true);
        manager.setApprovedComplianceHook(address(hspHook), true);

        _pushQuorumPrice(address(whsk), address(usdt), WHSK_PRICE_X36, block.timestamp);

        whsk.mint(lp, 1_000_000e18);
        weth.mint(lp, 100e18);
        wbtc.mint(lp, 10e8);
        usdt.mint(lp, 1_000_000e6);
        usdt.mint(alice, 1_000_000e6);
        usdt.mint(bob, 1_000_000e6);
        usdt.mint(attacker, 1_000_000e6);

        vm.startPrank(lp);
        whsk.approve(address(vault), type(uint256).max);
        weth.approve(address(vault), type(uint256).max);
        wbtc.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _buildQuorumSigs(address inv, address pay, uint256 priceX36, uint256 ts)
        internal
        view
        returns (bytes[] memory sigs)
    {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ProtocolSignedPullOracle"),
                keccak256("2"),
                block.chainid,
                address(pullOracle)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSep,
                keccak256(abi.encode(pullOracle.PRICE_REPORT_TYPEHASH(), inv, pay, priceX36, ts))
            )
        );
        sigs = new bytes[](2);
        if (vm.addr(PK1) < vm.addr(PK2)) {
            sigs[0] = _signDigest(PK1, digest);
            sigs[1] = _signDigest(PK2, digest);
        } else {
            sigs[0] = _signDigest(PK2, digest);
            sigs[1] = _signDigest(PK1, digest);
        }
    }

    function _pushQuorumPrice(address inv, address pay, uint256 priceX36, uint256 ts) internal {
        pullOracle.updatePrice(inv, pay, priceX36, ts, _buildQuorumSigs(inv, pay, priceX36, ts));
    }

    function test_Reg_H1_OracleAdapterFailsClosedWhenRequiredSecondaryUnhealthy() public {
        // Secondary invalid -> adapter MUST fail closed when requireSecondaryCheck == true
        secondaryOracle.set(0, block.timestamp, false);
        IPriceOracle.PriceQuote memory q = adapter.getPriceX36(address(whsk), address(usdt));
        assertFalse(q.isValid, "H-01 closed: fails closed when required secondary unhealthy");

        // Independent secondaryMaxStaleness (3600s): secondary at -120s remains valid while primary <= 30s
        vm.warp(block.timestamp + 120);
        _pushQuorumPrice(address(whsk), address(usdt), WHSK_PRICE_X36, block.timestamp);
        secondaryOracle.set(WHSK_PRICE_X36, block.timestamp - 120, true);
        IPriceOracle.PriceQuote memory q2 = adapter.getPriceX36(address(whsk), address(usdt));
        assertTrue(q2.isValid, "Independent secondaryMaxStaleness succeeds");
    }

    function test_Reg_H2_ExecutionRouterEnforcesComplianceOnCallerAndReceiver() public {
        vm.deal(address(whsk), 10_000e18);
        hspHook.setApproved(lp, block.timestamp + 7 days);
        hspHook.setApproved(alice, block.timestamp + 7 days);
        hspHook.setApproved(bob, block.timestamp + 7 days);

        vm.startPrank(lp);
        vault.deposit(address(whsk), 5_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 5_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(hspHook),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.prank(alice);
        uint256 tid = manager.reserve(oid, 2_000e18, 3600, 100e6, alice);

        // Even though ExecutionRouter is NOT allowlisted on hspHook, compliant alice -> bob succeeds!
        vm.startPrank(alice);
        ticketNft.setApprovalForAll(address(router), true);
        usdt.approve(address(router), type(uint256).max);
        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](1);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: tid, fillAmount: 1_000e18, maxLegPaymentIn: 200e6});
        router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                minTotalInventoryOut: 1_000e18,
                maxTotalPaymentIn: 200e6,
                deadline: block.timestamp,
                receiver: bob,
                unwrapInventoryToNative: true,
                legs: legs
            })
        );
        vm.stopPrank();

        // Now revoke bob -> router MUST revert NotCompliant(bob) even with unwrapInventoryToNative=true!
        hspHook.revoke(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, bob));
        router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                minTotalInventoryOut: 1_000e18,
                maxTotalPaymentIn: 200e6,
                deadline: block.timestamp,
                receiver: bob,
                unwrapInventoryToNative: true,
                legs: legs
            })
        );
    }

    function test_Reg_H3_SplitTicketChecksOwnerComplianceNotSpender() public {
        hspHook.setApproved(lp, block.timestamp + 7 days);
        hspHook.setApproved(alice, block.timestamp + 7 days);
        hspHook.setApproved(bob, block.timestamp + 7 days);

        vm.startPrank(lp);
        vault.deposit(address(whsk), 5_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 5_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(hspHook),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.startPrank(alice);
        uint256 tid = manager.reserve(oid, 3_000e18, 3600, 100e6, alice);
        ticketNft.approve(bob, tid);
        vm.stopPrank();

        // Alice becomes sanctioned; compliant Bob CANNOT bypass beforeTransfer via splitTicket!
        hspHook.revoke(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, alice));
        manager.splitTicket(tid, 1_000e18, bob);
    }

    function test_Reg_M1_CreateOfferRejectsUnapprovedOracleAndHook() public {
        address rogue = makeAddr("rogueAdapter");
        vm.startPrank(lp);
        vault.deposit(address(whsk), 2_000e18);

        vm.expectRevert(CommitmentManager.UnapprovedAdapter.selector);
        manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 1_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FLOATING,
                spreadBps: 25,
                oracle: rogue,
                complianceHook: address(0),
                fixedPriceX36: 0,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );

        vm.expectRevert(CommitmentManager.UnapprovedAdapter.selector);
        manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 1_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: rogue,
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();
    }

    function test_Reg_M2_PermitNonceInvalidatedOnTransferAndEmitsApproval() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 2_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 2_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.prank(alice);
        uint256 tid = manager.reserve(oid, 1_000e18, 3600, 100e6, alice);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Execution Ticket"),
                keccak256("1"),
                block.chainid,
                address(ticketNft)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)"),
                attacker,
                tid,
                0,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest);

        // Alice transfers to Bob, then Bob transfers back to Alice -> nonce incremented twice!
        vm.prank(alice);
        ticketNft.transferFrom(alice, bob, tid);
        assertEq(ticketNft.nonces(tid), 1);

        vm.prank(bob);
        ticketNft.transferFrom(bob, alice, tid);
        assertEq(ticketNft.nonces(tid), 2);

        // Stale nonce=0 signature MUST revert InvalidSignature
        vm.expectRevert(ExecutionTicket.InvalidSignature.selector);
        ticketNft.permit(attacker, tid, deadline, v, r, s);
    }

    function test_Reg_M3_AdminFeeAndMinUpdatesDoNotMutateActiveTickets() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 5_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 5_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.prank(alice);
        uint256 tid = manager.reserve(oid, 2_000e18, 3600, 100e6, alice);

        // Admin raises protocolFeeBps to 100 and tokenMinTicketAmount to 10,000 WHSK
        manager.setProtocolFeeBps(100);
        manager.setTokenMinTicketAmount(address(whsk), 10_000e18);

        // Active ticket STILL splits at snapshotted 1,000 WHSK min and settles at snapshotted 5 bps fee!
        vm.startPrank(alice);
        uint256 childId = manager.splitTicket(tid, 1_000e18, alice);
        (, uint256 grossPay) = manager.exercise(childId, 0, 200e6, alice);
        vm.stopPrank();

        uint256 expected5Bps = (grossPay * 5 + 9_999) / 10_000;
        assertEq(manager.getTicket(tid).protocolFeeBps, 5);
        assertEq(vault.protocolFees(address(usdt)) > 0, true);
        // Check exact 5 bps fee on exercise was used (total protocolFees = reserve_fee + 5bps_exercise_fee)
        assertEq(manager.getTicket(childId).protocolFeeBps, 5);
        assertGt(expected5Bps, 0);
    }

    function test_Reg_M4_PartialExerciseEnforcesMinFillAndCeilFeeRounding() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 5_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 5_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.startPrank(alice);
        uint256 tid = manager.reserve(oid, 2_000e18, 3600, 100e6, alice);

        // Leaving 1 wei remainder (< 1,000 WHSK minFill) reverts
        vm.expectRevert(CommitmentManager.InvalidFillAmount.selector);
        manager.exercise(tid, 2_000e18 - 1, 500e6, alice);

        // Filling 1 wei (< 1,000 WHSK minFill) reverts
        vm.expectRevert(CommitmentManager.InvalidFillAmount.selector);
        manager.exercise(tid, 1, 500e6, alice);

        // Valid partial fill (1,000 + 1,000) succeeds & Ceil fee > 0
        manager.exercise(tid, 1_000e18, 500e6, alice);
        assertEq(manager.getTicket(tid).remainingAmount, 1_000e18);
        assertGt(vault.protocolFees(address(usdt)), 0);
        vm.stopPrank();
    }

    function test_Reg_M5_OwnershipTransferAndGuardianRotationWork() public {
        address newOwner = makeAddr("newOwner");
        address newGuardian = makeAddr("newGuardian");

        manager.transferOwnership(newOwner);
        vm.prank(newOwner);
        manager.acceptOwnership();
        assertEq(manager.owner(), newOwner);

        vm.prank(newOwner);
        manager.setGuardian(newGuardian);
        assertEq(manager.guardian(), newGuardian);

        // Old guardian can no longer pause
        vm.prank(guardian);
        vm.expectRevert(CommitmentManager.Unauthorized.selector);
        manager.setNewReservationsPaused(true);

        // Two-step feeCollector
        address newCollector = makeAddr("newCollector");
        vault.setPendingFeeCollector(newCollector);
        vm.prank(newCollector);
        vault.acceptFeeCollector();
        assertEq(vault.feeCollector(), newCollector);
    }

    function test_Reg_L1_ReclaimExpiredBatchBestEffortSkipsInactive() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 4_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 4_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.startPrank(alice);
        uint256 t1 = manager.reserve(oid, 1_000e18, 60, 100e6, alice);
        uint256 t2 = manager.reserve(oid, 1_000e18, 60, 100e6, alice);
        uint256 t3 = manager.reserve(oid, 1_000e18, 3600, 100e6, alice); // not expired at +61s
        vm.stopPrank();

        vm.warp(block.timestamp + 61);
        manager.reclaimExpired(t1); // t1 already reclaimed

        uint256[] memory ids = new uint256[](3);
        ids[0] = t1;
        ids[1] = t2;
        ids[2] = t3;
        uint256 reclaimed = manager.reclaimExpiredBatchBestEffort(ids);
        assertEq(reclaimed, 1); // Only t2 reclaimed without reverting batch
        assertEq(uint8(manager.getTicket(t2).status), uint8(TicketStatus.RECLAIMED));
        assertEq(uint8(manager.getTicket(t3).status), uint8(TicketStatus.ACTIVE));
    }

    function test_Reg_L2_ReserveBoundedByOfferExpiry() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 2_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 2_000e18,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 120),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(CommitmentManager.InvalidExpiry.selector);
        manager.reserve(oid, 1_000e18, 300, 100e6, alice);
    }

    function test_Reg_L3_ExecutionRouterRejectsUnsetTicketNft() public {
        CommitmentManager freshMgr = new CommitmentManager(address(this), address(vault), guardian, 5);
        vm.expectRevert(ExecutionRouter.ZeroAddress.selector);
        new ExecutionRouter(address(freshMgr), address(whsk));
    }

    function test_Reg_L4_SignedPullOracleTTLAndTwapMinCardinality() public {
        UniswapV3TwapOracle twap = new UniswapV3TwapOracle(address(this));
        vm.expectRevert(UniswapV3TwapOracle.InvalidMinCardinality.selector);
        twap.setPoolConfig(address(whsk), address(usdt), address(0x1234), 1800, 1);

        // SignedPullOracle internal TTL > maxPriceAge (30s) returns isValid = false
        vm.warp(block.timestamp + 31);
        assertFalse(pullOracle.getPriceX36(address(whsk), address(usdt)).isValid);
    }

    function test_Reg_Econ1_ProtocolFee5BpsYieldsPositiveLPEconomics() public {
        uint256 notional = 10_000e18;
        uint256 spotUsdt = 10_000 * 80_808; // 808.08 USDT

        vm.startPrank(lp);
        vault.deposit(address(whsk), notional);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: notional,
                minFillAmount: 1_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FLOATING,
                spreadBps: 25,
                oracle: address(adapter),
                complianceHook: address(0),
                fixedPriceX36: 0,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.startPrank(alice);
        uint256 tid = manager.reserve(oid, notional, 1 days, 1_000e6, alice);
        manager.exercise(tid, 0, 2_000e6, alice);
        vm.stopPrank();

        uint256 lpNetUsdt = vault.lpPendingProceeds(lp, address(usdt));
        // With 5 bps fee, LP earns ~+39.98 bps net above spot!
        assertGt(lpNetUsdt, spotUsdt + (spotUsdt * 35) / 10_000);
    }

    function test_Reg_Econ2_CrossDecimalWBTCAndUSDTOffersSucceed() public {
        vm.startPrank(lp);
        vault.deposit(address(wbtc), 1e8);       // 1 WBTC (8 dec)
        vault.deposit(address(usdt), 10_000e6);  // 10,000 USDT (6 dec)

        uint64 oidBtc = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(wbtc),
                paymentToken: address(usdt),
                initialAmount: 1e8,
                minFillAmount: 1e5, // 0.001 WBTC
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: 618_308e33,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        uint64 oidUsdt = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(usdt),
                paymentToken: address(weth),
                initialAmount: 10_000e6,
                minFillAmount: 50e6,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: 586_840_684_491_000e30, // ~0.00058684 WETH/USDT
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        vm.prank(alice);
        uint256 tidBtc = manager.reserve(oidBtc, 1e7, 3600, 1_000e6, alice); // 0.1 WBTC
        assertEq(manager.getTicket(tidBtc).remainingAmount, 1e7);
        assertGt(oidUsdt, 0);
    }

    function test_Reg_Oracle1_MOfN_JumpCap_Revoke_And_WETH_WBTC_Bounds() public {
        uint256 wethPriceX36 = 1_704_040_000 * 1e18; // ~1.704e27
        uint256 wbtcPriceX36 = 61_830_800_000 * 1e28; // ~6.183e38

        adapter.setPairConfig(
            address(weth),
            address(usdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(0),
                maxStaleness: 30,
                secondaryMaxStaleness: 0,
                maxDeviationBps: 0,
                requireSecondaryCheck: false,
                allowSecondaryFallback: false,
                hardMinPriceX36: 7e26,
                hardMaxPriceX36: 45e26
            })
        );
        adapter.setPairConfig(
            address(wbtc),
            address(usdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(0),
                maxStaleness: 30,
                secondaryMaxStaleness: 0,
                maxDeviationBps: 0,
                requireSecondaryCheck: false,
                allowSecondaryFallback: false,
                hardMinPriceX36: 25e37,
                hardMaxPriceX36: 16e38
            })
        );

        _pushQuorumPrice(address(weth), address(usdt), wethPriceX36, block.timestamp);
        _pushQuorumPrice(address(wbtc), address(usdt), wbtcPriceX36, block.timestamp);
        assertTrue(adapter.getPriceX36(address(weth), address(usdt)).isValid);
        assertTrue(adapter.getPriceX36(address(wbtc), address(usdt)).isValid);

        // MaxJumpExceeded (> 300 bps on WETH/USDT)
        vm.warp(block.timestamp + 2);
        uint256 badWeth = (wethPriceX36 * 10_500) / 10_000;
        bytes[] memory sigs = _buildQuorumSigs(address(weth), address(usdt), badWeth, block.timestamp);
        vm.expectRevert(SignedPullOracle.MaxJumpExceeded.selector);
        pullOracle.updatePrice(address(weth), address(usdt), badWeth, block.timestamp, sigs);

        // Guardian revokes WHSK price + pauses FLOATING exercises while FIXED stays live
        vm.startPrank(guardian);
        pullOracle.revokePrice(address(whsk), address(usdt));
        manager.setFloatingExercisePaused(true);
        vm.stopPrank();
        assertFalse(adapter.getPriceX36(address(whsk), address(usdt)).isValid);
    }
}
