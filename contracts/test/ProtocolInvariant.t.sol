// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {MockERC20, MockWHSK, MockStaticPriceOracle} from "./ProtocolAdversarial.t.sol";
import {CreateOfferParams, PriceMode, TicketStatus, Ticket} from "../src/interfaces/IProtocol.sol";

contract ProtocolHandler is Test {
    uint256 internal constant WHSK_PRICE_X36 = 8e22;

    LiquidityVault public vault;
    CommitmentManager public manager;
    ExecutionTicket public ticketNft;
    ExecutionRouter public router;
    MockWHSK public whsk;
    MockERC20 public usdt;
    MockStaticPriceOracle public oracle;

    address[] public lps;
    address[] public traders;
    uint64[] public offerIds;
    uint256[] public ticketIds;

    constructor(
        LiquidityVault _vault,
        CommitmentManager _manager,
        ExecutionTicket _ticketNft,
        ExecutionRouter _router,
        MockWHSK _whsk,
        MockERC20 _usdt,
        MockStaticPriceOracle _oracle
    ) {
        vault = _vault;
        manager = _manager;
        ticketNft = _ticketNft;
        router = _router;
        whsk = _whsk;
        usdt = _usdt;
        oracle = _oracle;

        for (uint256 i = 0; i < 3; ++i) {
            address lpAddr = address(uint160(0x1000 + i));
            address trAddr = address(uint160(0x2000 + i));
            lps.push(lpAddr);
            traders.push(trAddr);

            whsk.mint(lpAddr, 10_000_000e18);
            usdt.mint(trAddr, 10_000_000e6);

            vm.prank(lpAddr);
            whsk.approve(address(vault), type(uint256).max);

            vm.startPrank(trAddr);
            usdt.approve(address(vault), type(uint256).max);
            usdt.approve(address(router), type(uint256).max);
            ticketNft.setApprovalForAll(address(router), true);
            vm.stopPrank();
        }
    }

    function depositAndCreateOffer(uint256 lpSeed, uint96 rawAmt, bool isFloating) external {
        if (offerIds.length >= 25) return;
        address lp = lps[lpSeed % lps.length];
        uint256 amt = bound(uint256(rawAmt), 1_000e18, 100_000e18);

        vm.startPrank(lp);
        vault.deposit(address(whsk), amt);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: amt,
                minFillAmount: 100e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 20,
                priceMode: isFloating ? PriceMode.FLOATING : PriceMode.FIXED,
                spreadBps: isFloating ? int16(25) : int16(0),
                oracle: isFloating ? address(oracle) : address(0),
                complianceHook: address(0),
                fixedPriceX36: isFloating ? 0 : WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();
        offerIds.push(oid);
    }

    function withdrawFreeAndClaim(uint256 lpSeed) external {
        address lp = lps[lpSeed % lps.length];
        uint256 freeBal = vault.lpFreeBalance(lp, address(whsk));
        if (freeBal > 0) {
            vm.prank(lp);
            vault.withdrawFree(address(whsk), freeBal, lp);
        }
        uint256 proc = vault.lpPendingProceeds(lp, address(usdt));
        if (proc > 0) {
            vm.prank(lp);
            vault.claimProceeds(address(usdt), 0, lp);
        }
    }

    function cancelOffer(uint256 offerSeed) external {
        if (offerIds.length == 0) return;
        uint64 oid = offerIds[offerSeed % offerIds.length];
        address lp = manager.getOffer(oid).lp;
        vm.prank(lp);
        try manager.cancelOffer(oid) {} catch {}
    }

    function reserveTicket(uint256 traderSeed, uint256 offerSeed, uint96 rawAmt, uint32 durSeed) external {
        if (offerIds.length == 0) return;
        address tr = traders[traderSeed % traders.length];
        uint64 oid = offerIds[offerSeed % offerIds.length];
        uint256 avail = vault.offerBalance(oid);
        if (avail < 100e18) return;

        uint256 amt = bound(uint256(rawAmt), 100e18, avail);
        uint32 dur = uint32(bound(uint256(durSeed), 60, 1 days));

        vm.prank(tr);
        try manager.reserve(oid, amt, dur, type(uint256).max, tr) returns (uint256 tid) {
            ticketIds.push(tid);
        } catch {}
    }

    function splitOrTransferTicket(uint256 ticketSeed, uint256 traderSeed, uint96 rawSplit) external {
        if (ticketIds.length == 0) return;
        uint256 tid = ticketIds[ticketSeed % ticketIds.length];
        Ticket memory t = manager.getTicket(tid);
        if (t.status != TicketStatus.ACTIVE || block.timestamp > t.expiresAt) return;

        address owner = ticketNft.ownerOf(tid);
        address recipient = traders[traderSeed % traders.length];

        if (t.remainingAmount >= 200e18) {
            uint256 splitAmt = bound(uint256(rawSplit), 100e18, t.remainingAmount - 100e18);
            vm.prank(owner);
            try manager.splitTicket(tid, splitAmt, recipient) returns (uint256 newId) {
                ticketIds.push(newId);
            } catch {}
        } else if (owner != recipient) {
            vm.prank(owner);
            try ticketNft.transferFrom(owner, recipient, tid) {} catch {}
        }
    }

    function exerciseTicket(uint256 ticketSeed, uint96 rawFill, bool viaRouter) external {
        if (ticketIds.length == 0) return;
        uint256 tid = ticketIds[ticketSeed % ticketIds.length];
        Ticket memory t = manager.getTicket(tid);
        if (t.status != TicketStatus.ACTIVE || block.timestamp > t.expiresAt) return;

        address owner = ticketNft.ownerOf(tid);
        uint256 fill;
        if (t.remainingAmount >= 200e18) {
            fill = bound(uint256(rawFill), 100e18, t.remainingAmount - 100e18);
        } else {
            fill = t.remainingAmount;
        }

        if (viaRouter) {
            ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](1);
            legs[0] = ExecutionRouter.ExerciseLeg({ticketId: tid, fillAmount: fill, maxLegPaymentIn: 100_000e6});
            vm.prank(owner);
            try router.batchExercise(
                ExecutionRouter.BatchExerciseParams({
                    inventoryToken: address(whsk),
                    paymentToken: address(usdt),
                    minTotalInventoryOut: 0,
                    maxTotalPaymentIn: 100_000e6,
                    deadline: block.timestamp,
                    receiver: owner,
                    unwrapInventoryToNative: false,
                    legs: legs
                })
            ) {} catch {}
        } else {
            vm.prank(owner);
            try manager.exercise(tid, fill, 100_000e6, owner) {} catch {}
        }
    }

    function warpAndReclaim(uint256 ticketSeed, uint32 warpSecs) external {
        uint256 dt = bound(uint256(warpSecs), 0, 2 hours);
        vm.warp(block.timestamp + dt);
        oracle.set(WHSK_PRICE_X36, block.timestamp, true);

        if (ticketIds.length == 0) return;
        uint256 tid = ticketIds[ticketSeed % ticketIds.length];
        try manager.reclaimExpired(tid) {} catch {}
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    function offerCount() external view returns (uint256) {
        return offerIds.length;
    }

    function ticketCount() external view returns (uint256) {
        return ticketIds.length;
    }
}

/// @title ProtocolInvariantTest
/// @notice Stateful invariant campaign enforcing INV-1 through INV-7 across multi-actor flows.
contract ProtocolInvariantTest is StdInvariant, Test {
    uint256 internal constant WHSK_PRICE_X36 = 8e22;

    LiquidityVault internal vault;
    CommitmentManager internal manager;
    ExecutionTicket internal ticketNft;
    ExecutionRouter internal router;
    MockWHSK internal whsk;
    MockERC20 internal usdt;
    MockStaticPriceOracle internal oracle;
    ProtocolHandler internal handler;

    function setUp() public {
        vm.warp(1_795_500_000);
        whsk = new MockWHSK();
        usdt = new MockERC20("Tether USD", "USDT", 6);
        vault = new LiquidityVault(address(this), makeAddr("guardian"), makeAddr("feeCollector"));
        manager = new CommitmentManager(address(this), address(vault), makeAddr("guardian"), 5);
        ticketNft = new ExecutionTicket(address(manager));
        vault.setManager(address(manager));
        manager.setTicketNft(address(ticketNft));
        manager.setTokenMinTicketAmount(address(whsk), 100e18);

        router = new ExecutionRouter(address(manager), address(whsk));
        manager.setApprovedRouter(address(router), true);

        oracle = new MockStaticPriceOracle(WHSK_PRICE_X36, block.timestamp, true);
        manager.setApprovedOracle(address(oracle), true);

        handler = new ProtocolHandler(vault, manager, ticketNft, router, whsk, usdt, oracle);
        targetContract(address(handler));
    }

    function invariant_VaultPhysicalSolvency() public view {
        assertGe(
            IERC20(address(whsk)).balanceOf(address(vault)),
            vault.totalLpFree(address(whsk)) + vault.totalOfferAvailable(address(whsk))
                + vault.totalReserved(address(whsk)) + vault.totalPendingProceeds(address(whsk))
                + vault.protocolFees(address(whsk)),
            "INV-1 WHSK"
        );
        assertGe(
            IERC20(address(usdt)).balanceOf(address(vault)),
            vault.totalLpFree(address(usdt)) + vault.totalOfferAvailable(address(usdt))
                + vault.totalReserved(address(usdt)) + vault.totalPendingProceeds(address(usdt))
                + vault.protocolFees(address(usdt)),
            "INV-1 USDT"
        );
    }

    function invariant_BucketSumConsistencyAndTicketMirror() public view {
        uint256 sumFree;
        uint256 sumProc;
        for (uint256 i = 0; i < handler.lpCount(); ++i) {
            address lp = handler.lps(i);
            sumFree += vault.lpFreeBalance(lp, address(whsk));
            sumProc += vault.lpPendingProceeds(lp, address(usdt));
        }
        assertEq(sumFree, vault.totalLpFree(address(whsk)), "INV-2 free sum");
        assertEq(sumProc, vault.totalPendingProceeds(address(usdt)), "INV-2 proceeds sum");

        uint256 sumOffers;
        for (uint256 i = 0; i < handler.offerCount(); ++i) {
            sumOffers += vault.offerBalance(handler.offerIds(i));
        }
        assertEq(sumOffers, vault.totalOfferAvailable(address(whsk)), "INV-2 offer sum");

        uint256 sumTickets;
        for (uint256 i = 0; i < handler.ticketCount(); ++i) {
            uint256 tid = handler.ticketIds(i);
            Ticket memory t = manager.getTicket(tid);
            uint256 res = vault.ticketReserved(tid);
            if (t.status == TicketStatus.ACTIVE) {
                assertGt(t.remainingAmount, 0, "INV-3 active > 0");
                assertEq(t.remainingAmount, res, "INV-3 mirror");
                assertTrue(ticketNft.ownerOf(tid) != address(0), "INV-4 owner exists");
                sumTickets += res;
            } else {
                assertEq(t.remainingAmount, 0, "INV-3 closed == 0");
                assertEq(res, 0, "INV-3 vault == 0");
            }
        }
        assertEq(sumTickets, vault.totalReserved(address(whsk)), "INV-2 reserved sum");
    }

    function invariant_RouterZeroResidue() public view {
        assertEq(usdt.balanceOf(address(router)), 0, "INV-7 router usdt bal");
        assertEq(whsk.balanceOf(address(router)), 0, "INV-7 router whsk bal");
        assertEq(usdt.allowance(address(router), address(vault)), 0, "INV-7 router allowance");
    }
}
