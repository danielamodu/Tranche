// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {V3PositionSegregator} from "../src/adapters/V3PositionSegregator.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {UniswapV3TwapOracle} from "../src/adapters/UniswapV3TwapOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {
    CreateOfferParams,
    PriceMode,
    TicketStatus,
    Ticket,
    INonfungiblePositionManager
} from "../src/interfaces/IProtocol.sol";

/// @title HashKeyForkPrototypeTest
/// @notice Phase 3 mainnet-fork mechanical prototype against live HashKey Chain state (block 30583147).
contract HashKeyForkPrototypeTest is Test {
    address internal constant NFPM = 0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address internal constant WHSK_USDT_POOL = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;

    uint256 internal constant REAL_TOKEN_ID = 33;
    address internal constant REAL_LP = 0x8fed6470991878e806bcb733FFB8392B5D07e95E;

    uint256 internal constant ORACLE_PK = 0xA11CE;
    address internal oracleSigner;

    address internal guardian = makeAddr("guardian");
    address internal feeCollector = makeAddr("feeCollector");
    address internal trader1 = makeAddr("trader1");
    address internal trader2 = makeAddr("trader2");
    address internal keeper = makeAddr("keeper");

    LiquidityVault internal vault;
    CommitmentManager internal manager;
    ExecutionTicket internal ticketNft;
    ExecutionRouter internal router;
    V3PositionSegregator internal segregator;
    SignedPullOracle internal pullOracle;
    UniswapV3TwapOracle internal twapOracle;
    OraclePriceAdapter internal oracleAdapter;

    function setUp() public {
        if (block.chainid != 177) return;

        oracleSigner = vm.addr(ORACLE_PK);
        vault = new LiquidityVault(guardian, feeCollector);
        manager = new CommitmentManager(address(vault), guardian, 50, 1_000e18);
        ticketNft = new ExecutionTicket(address(manager));
        vault.setManager(address(manager));
        manager.setTicketNft(address(ticketNft));

        router = new ExecutionRouter(address(manager), WHSK);
        segregator = new V3PositionSegregator(NFPM, address(vault));

        pullOracle = new SignedPullOracle(oracleSigner);
        twapOracle = new UniswapV3TwapOracle();
        twapOracle.setPoolConfig(WHSK, USDT, WHSK_USDT_POOL, 1800, 100);

        oracleAdapter = new OraclePriceAdapter();
        oracleAdapter.setPairConfig(
            WHSK,
            USDT,
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(twapOracle),
                maxStaleness: 30,
                maxDeviationBps: 500,
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e18,
                hardMaxPriceX36: 1e27
            })
        );
    }

    function _signAndPushPrice(uint256 priceX36, uint256 ts) internal {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ProtocolSignedPullOracle"),
                keccak256("1"),
                block.chainid,
                address(pullOracle)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(pullOracle.PRICE_REPORT_TYPEHASH(), WHSK, USDT, priceX36, ts)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, digest);
        pullOracle.updatePrice(WHSK, USDT, priceX36, ts, abi.encodePacked(r, s, v));
    }

    function _assertVaultSolvency() internal view {
        assertGe(
            IERC20(WHSK).balanceOf(address(vault)),
            vault.totalLpFree(WHSK) + vault.totalOfferAvailable(WHSK) + vault.totalReserved(WHSK)
                + vault.totalPendingProceeds(WHSK) + vault.protocolFees(WHSK),
            "INV-1 WHSK solvency violated"
        );
        assertGe(
            IERC20(USDT).balanceOf(address(vault)),
            vault.totalLpFree(USDT) + vault.totalOfferAvailable(USDT) + vault.totalReserved(USDT)
                + vault.totalPendingProceeds(USDT) + vault.protocolFees(USDT),
            "INV-1 USDT solvency violated"
        );
    }

    function _withdrawAndSegregateFromRealV3Nft() internal returns (uint256 col0) {
        assertEq(INonfungiblePositionManager(NFPM).ownerOf(REAL_TOKEN_ID), REAL_LP);
        (,, address t0, address t1,,,, uint128 fullLiq,,,,) = INonfungiblePositionManager(NFPM).positions(REAL_TOKEN_ID);
        assertEq(t0, WHSK);
        assertEq(t1, USDT);
        assertGt(fullLiq, 0);

        uint128 liqToPull = fullLiq / 10;
        uint256 lpUsdtBefore = IERC20(USDT).balanceOf(REAL_LP);

        vm.startPrank(REAL_LP);
        INonfungiblePositionManager(NFPM).approve(address(segregator), REAL_TOKEN_ID);
        uint256 col1;
        (col0, col1) = segregator.withdrawAndSegregate(
            V3PositionSegregator.WithdrawAndSegregateParams({
                tokenId: REAL_TOKEN_ID,
                liquidityToWithdraw: liqToPull,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp,
                depositToken0: true,
                depositToken1: false
            })
        );
        vm.stopPrank();

        assertGt(col0, 300_000e18, "Should collect >300k WHSK from 10% of tokenId 33");
        assertEq(vault.lpFreeBalance(REAL_LP, WHSK), col0);
        assertEq(IERC20(USDT).balanceOf(REAL_LP), lpUsdtBefore + col1);
        assertEq(IERC20(WHSK).balanceOf(address(segregator)), 0);
        assertEq(IERC20(USDT).balanceOf(address(segregator)), 0);
    }

    function _createOffers(uint256 twapPriceX36) internal returns (uint64 offerFixed, uint64 offerFloating) {
        vm.startPrank(REAL_LP);
        offerFixed = manager.createOffer(
            CreateOfferParams({
                inventoryToken: WHSK,
                paymentToken: USDT,
                initialAmount: 150_000e18,
                minFillAmount: 5_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 300,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 20,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: (twapPriceX36 * 10_200) / 10_000,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        offerFloating = manager.createOffer(
            CreateOfferParams({
                inventoryToken: WHSK,
                paymentToken: USDT,
                initialAmount: 150_000e18,
                minFillAmount: 5_000e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 300,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FLOATING,
                spreadBps: 25,
                oracle: address(oracleAdapter),
                complianceHook: address(0),
                fixedPriceX36: 0,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();
    }

    function _splitAndExerciseTickets(uint256 tFixed) internal {
        vm.startPrank(trader2);
        IERC20(USDT).approve(address(vault), type(uint256).max);
        IERC20(USDT).approve(address(router), type(uint256).max);
        ticketNft.setApprovalForAll(address(router), true);

        uint256 tChild = manager.splitTicket(tFixed, 40_000e18, trader2);
        assertEq(manager.getTicket(tFixed).remainingAmount, 60_000e18);
        assertEq(manager.getTicket(tChild).remainingAmount, 40_000e18);
        assertEq(vault.ticketReserved(tFixed), 60_000e18);
        assertEq(vault.ticketReserved(tChild), 40_000e18);

        (uint256 filledDirect,) = manager.exercise(tFixed, 25_000e18, 10_000e6, trader2);
        assertEq(filledDirect, 25_000e18);
        assertEq(IERC20(WHSK).balanceOf(trader2), 25_000e18);
        assertEq(manager.getTicket(tFixed).remainingAmount, 35_000e18);
        assertEq(vault.ticketReserved(tFixed), 35_000e18);

        uint256 hskBefore = trader2.balance;
        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](1);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: tChild, fillAmount: 0, maxLegPaymentIn: 10_000e6});
        (uint256 routerOut, uint256 routerPaid) = router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: WHSK,
                paymentToken: USDT,
                minTotalInventoryOut: 40_000e18,
                maxTotalPaymentIn: 10_000e6,
                deadline: block.timestamp,
                receiver: trader2,
                unwrapInventoryToNative: true,
                legs: legs
            })
        );
        assertEq(routerOut, 40_000e18);
        assertGt(routerPaid, 0);
        assertEq(trader2.balance, hskBefore + 40_000e18);
        assertEq(uint8(manager.getTicket(tChild).status), uint8(TicketStatus.EXERCISED));
        assertEq(IERC20(USDT).allowance(address(router), address(vault)), 0);
        assertEq(IERC20(USDT).balanceOf(address(router)), 0);
        vm.stopPrank();
    }

    function test_Fork_FullLifecycle_V3WithdrawSegregateReserveTransferPartialExerciseReclaim() public {
        if (block.chainid != 177) return;

        uint256 twapPriceX36 = twapOracle.getPriceX36(WHSK, USDT).priceX36;
        assertGt(twapPriceX36, 0, "Live WHSK/USDT TWAP must be > 0");
        _signAndPushPrice(twapPriceX36, block.timestamp);

        uint256 col0 = _withdrawAndSegregateFromRealV3Nft();
        _assertVaultSolvency();

        (uint64 offerFixed, uint64 offerFloating) = _createOffers(twapPriceX36);
        _assertVaultSolvency();

        deal(USDT, trader1, 50_000e6);
        deal(USDT, trader2, 50_000e6);

        vm.startPrank(trader1);
        IERC20(USDT).approve(address(vault), type(uint256).max);
        uint256 tFixed = manager.reserve(offerFixed, 100_000e18, 3600, 1_000e6, trader1);
        uint256 tFloat = manager.reserve(offerFloating, 100_000e18, 3600, 1_000e6, trader1);
        assertEq(ticketNft.ownerOf(tFixed), trader1);
        assertEq(ticketNft.ownerOf(tFloat), trader1);

        ticketNft.transferFrom(trader1, trader2, tFixed);
        assertEq(ticketNft.ownerOf(tFixed), trader2);
        vm.stopPrank();

        _splitAndExerciseTickets(tFixed);
        _assertVaultSolvency();

        vm.warp(block.timestamp + 3601);

        vm.prank(trader2);
        vm.expectRevert(CommitmentManager.TicketExpired.selector);
        manager.exercise(tFixed, 0, 10_000e6, trader2);

        uint256[] memory expiredIds = new uint256[](2);
        expiredIds[0] = tFixed;
        expiredIds[1] = tFloat;
        vm.prank(keeper);
        manager.reclaimExpiredBatch(expiredIds);

        Ticket memory t1Post = manager.getTicket(tFixed);
        Ticket memory t2Post = manager.getTicket(tFloat);
        assertEq(uint8(t1Post.status), uint8(TicketStatus.RECLAIMED));
        assertEq(uint8(t2Post.status), uint8(TicketStatus.RECLAIMED));
        assertEq(vault.ticketReserved(tFixed), 0);
        assertEq(vault.ticketReserved(tFloat), 0);
        assertEq(vault.offerBalance(offerFixed), 85_000e18);
        assertEq(vault.offerBalance(offerFloating), 150_000e18);

        vm.startPrank(REAL_LP);
        manager.cancelOffer(offerFixed);
        manager.cancelOffer(offerFloating);
        uint256 freeWhsk = vault.lpFreeBalance(REAL_LP, WHSK);
        assertEq(freeWhsk, col0 - 65_000e18);
        vault.withdrawFree(WHSK, freeWhsk, REAL_LP);
        uint256 pendingUsdt = vault.lpPendingProceeds(REAL_LP, USDT);
        assertGt(pendingUsdt, 0);
        vault.claimProceeds(USDT, 0, REAL_LP);
        vm.stopPrank();

        _assertVaultSolvency();
    }
}
