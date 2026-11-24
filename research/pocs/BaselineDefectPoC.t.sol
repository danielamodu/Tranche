// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {CreateOfferParams, PriceMode, IPriceOracle} from "../src/interfaces/IProtocol.sol";

contract BaselineMockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @title BaselineDefectPoCTest
/// @notice Reproduces economic & oracle configuration defects on frozen baseline commit f5d61e76.
contract BaselineDefectPoCTest is Test {
    uint256 internal constant ORACLE_PK = 0xA11CE;
    address internal guardian = makeAddr("guardian");
    address internal feeCollector = makeAddr("feeCollector");
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    BaselineMockToken internal whsk;
    BaselineMockToken internal weth;
    BaselineMockToken internal wbtc;
    BaselineMockToken internal usdt;
    LiquidityVault internal vault;
    CommitmentManager internal manager;
    ExecutionTicket internal ticketNft;
    SignedPullOracle internal pullOracle;
    OraclePriceAdapter internal adapter;

    function setUp() public {
        vm.warp(1_795_500_000);
        whsk = new BaselineMockToken("WHSK", "WHSK", 18);
        weth = new BaselineMockToken("WETH", "WETH", 18);
        wbtc = new BaselineMockToken("WBTC", "WBTC", 8);
        usdt = new BaselineMockToken("USDT", "USDT", 6);

        vault = new LiquidityVault(guardian, feeCollector);
        // Repo default: protocolFeeBps = 50 (0.50%), minTicketAmount = 100e18
        manager = new CommitmentManager(address(vault), guardian, 50, 100e18);
        ticketNft = new ExecutionTicket(address(manager));
        vault.setManager(address(manager));
        manager.setTicketNft(address(ticketNft));

        pullOracle = new SignedPullOracle(vm.addr(ORACLE_PK));
        adapter = new OraclePriceAdapter();

        whsk.mint(lp, 1_000_000e18);
        weth.mint(lp, 100e18);
        wbtc.mint(lp, 10e8);
        usdt.mint(lp, 1_000_000e6);
        usdt.mint(trader, 1_000_000e6);

        vm.startPrank(lp);
        whsk.approve(address(vault), type(uint256).max);
        weth.approve(address(vault), type(uint256).max);
        wbtc.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vm.stopPrank();

        vm.prank(trader);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _pushPrice(address inv, address pay, uint256 priceX36, uint256 ts) internal {
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
            abi.encode(pullOracle.PRICE_REPORT_TYPEHASH(), inv, pay, priceX36, ts)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, digest);
        pullOracle.updatePrice(inv, pay, priceX36, ts, abi.encodePacked(r, s, v));
    }

    /// @notice Econ-1: Repo default protocolFeeBps = 50 yields negative LP net P&L on (10, 10, 25) baseline.
    function test_PoC_Econ1_ProtocolFee50BpsCreatesNegativeLPEconomics() public {
        // 1 WHSK = 0.080808 USDT => priceX36 = 80_808 * 1e18
        uint256 spotX36 = 80_808e18;
        uint256 notional = 10_000e18; // ~808.08 USDT
        uint256 spotUsdt = (10_000 * 80_808); // 808,080,000 raw = 808.08 USDT

        adapter.setPairConfig(
            address(whsk),
            address(usdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(0),
                maxStaleness: 30,
                maxDeviationBps: 0,
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e18,
                hardMaxPriceX36: 1e27
            })
        );
        _pushPrice(address(whsk), address(usdt), spotX36, block.timestamp);

        vm.startPrank(lp);
        vault.deposit(address(whsk), notional);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: notional,
                minFillAmount: 100e18,
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

        vm.startPrank(trader);
        uint256 tid = manager.reserve(oid, notional, 1 days, 1_000e6, trader);
        manager.exercise(tid, 0, 2_000e6, trader);
        vm.stopPrank();

        uint256 lpNetUsdt = vault.lpPendingProceeds(lp, address(usdt));
        uint256 protocolFeeUsdt = vault.protocolFees(address(usdt));
        // LP receives LESS USDT than spot value (808.08 USDT) even at zero adverse markout!
        assertLt(lpNetUsdt, spotUsdt, "LP loses vs spot due to 50 bps fee on full exercise notional");
        assertGt(protocolFeeUsdt, (spotUsdt * 50) / 10_000);
    }

    /// @notice Econ-2: Global raw minTicketAmount = 100e18 blocks 8-dec WBTC and 6-dec USDT offers.
    function test_PoC_Econ2_GlobalMinTicketAmountBlocksWBTCAndUSDT() public {
        vm.startPrank(lp);
        vault.deposit(address(wbtc), 1e8); // 1 WBTC (~$61,830)
        vm.expectRevert(CommitmentManager.InvalidAmountBounds.selector);
        manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(wbtc),
                paymentToken: address(usdt),
                initialAmount: 1e8,
                minFillAmount: 1e6, // 0.01 WBTC (~$618)
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: 618_308e33, // ~$61,830.80
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );

        vault.deposit(address(usdt), 10_000e6); // $10,000 USDT cash-secured put
        vm.expectRevert(CommitmentManager.InvalidAmountBounds.selector);
        manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(usdt),
                paymentToken: address(weth),
                initialAmount: 10_000e6,
                minFillAmount: 1_000e6,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 1 days,
                basePremiumBps: 10,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: 1e45,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();
    }

    /// @notice Oracle-1: Frozen test bounds 1e18..1e27 reject valid WETH/USDT (1.704e27) and WBTC/USDT (6.183e38).
    function test_PoC_Oracle1_TestHardBoundsRejectValidWETHAndWBTC() public {
        uint256 wethPriceX36 = 1_704_040_000 * 1e18; // ~1.704e27
        uint256 wbtcPriceX36 = 61_830_800_000 * 1e28; // ~6.183e38

        OraclePriceAdapter.PairConfig memory testCfg = OraclePriceAdapter.PairConfig({
            primaryFeed: address(pullOracle),
            secondaryFeed: address(0),
            maxStaleness: 30,
            maxDeviationBps: 0,
            allowSecondaryFallback: false,
            hardMinPriceX36: 1e18,
            hardMaxPriceX36: 1e27
        });

        adapter.setPairConfig(address(weth), address(usdt), testCfg);
        adapter.setPairConfig(address(wbtc), address(usdt), testCfg);
        _pushPrice(address(weth), address(usdt), wethPriceX36, block.timestamp);
        _pushPrice(address(wbtc), address(usdt), wbtcPriceX36, block.timestamp);

        IPriceOracle.PriceQuote memory qWeth = adapter.getPriceX36(address(weth), address(usdt));
        IPriceOracle.PriceQuote memory qWbtc = adapter.getPriceX36(address(wbtc), address(usdt));
        assertFalse(qWeth.isValid, "1e27 bound rejects valid WETH/USDT price");
        assertFalse(qWbtc.isValid, "1e27 bound rejects valid WBTC/USDT price");
    }
}
