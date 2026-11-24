// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {ExecutionTicket} from "../src/ExecutionTicket.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {SignedPullOracle} from "../src/adapters/SignedPullOracle.sol";
import {OraclePriceAdapter} from "../src/adapters/OraclePriceAdapter.sol";
import {HSPComplianceHook} from "../src/adapters/HSPComplianceHook.sol";
import {CreateOfferParams, PriceMode, TicketStatus, IComplianceHook} from "../src/interfaces/IProtocol.sol";

contract MockERC20 is ERC20 {
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

contract MockWHSK is ERC20 {
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

contract MockFoTToken is ERC20 {
    constructor() ERC20("Fee Token", "FOT") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockBlacklistToken is ERC20 {
    mapping(address => bool) public blacklisted;

    constructor() ERC20("Blacklist USD", "BUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setBlacklisted(address who, bool status) external {
        blacklisted[who] = status;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[from] && !blacklisted[to], "blacklisted");
        super._update(from, to, value);
    }
}

contract MockReentrantToken is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public armed;

    constructor() ERC20("Reentrant", "REENT") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function arm(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0)) {
            armed = false;
            (bool ok,) = attackTarget.call(attackCalldata);
            require(ok, "reentrant call failed");
        }
    }
}

contract MockRevertingCompliance is IComplianceHook {
    function beforeCreateOffer(address, address, address) external pure override {
        revert("hook down");
    }

    function beforeReserve(uint64, address, address, uint256) external pure override {
        revert("hook down");
    }

    function beforeTransfer(uint256, address, address) external pure override {
        revert("hook down");
    }

    function beforeExercise(uint256, address, address) external pure override {
        revert("hook down");
    }
}

contract MockStaticPriceOracle {
    uint256 public price;
    uint256 public updatedAt;
    bool public valid;

    constructor(uint256 _price, uint256 _updatedAt, bool _valid) {
        price = _price;
        updatedAt = _updatedAt;
        valid = _valid;
    }

    function set(uint256 _price, uint256 _updatedAt, bool _valid) external {
        price = _price;
        updatedAt = _updatedAt;
        valid = _valid;
    }

    function getPriceX36(address, address) external view returns (uint256, uint256, bool) {
        return (price, updatedAt, valid);
    }
}

/// @title ProtocolAdversarialTest
/// @notice Covers all 13 adversarial security vectors against the remediated contracts.
contract ProtocolAdversarialTest is Test {
    uint256 internal constant ORACLE_PK1 = 0x1111;
    uint256 internal constant ORACLE_PK2 = 0x1112;
    uint256 internal constant HSP_PK = 0x2222;
    uint256 internal constant WHSK_PRICE_X36 = 8e22;

    address internal guardian = makeAddr("guardian");
    address internal feeCollector = makeAddr("feeCollector");
    address internal lp = makeAddr("lp");
    address internal trader1 = makeAddr("trader1");
    address internal trader2 = makeAddr("trader2");
    address internal attacker = makeAddr("attacker");

    MockWHSK internal whsk;
    MockERC20 internal usdt;
    LiquidityVault internal vault;
    CommitmentManager internal manager;
    ExecutionTicket internal ticketNft;
    ExecutionRouter internal router;
    SignedPullOracle internal pullOracle;
    MockStaticPriceOracle internal secondaryOracle;
    OraclePriceAdapter internal oracleAdapter;
    HSPComplianceHook internal hspHook;

    function setUp() public {
        vm.warp(1_795_500_000);
        whsk = new MockWHSK();
        usdt = new MockERC20("Tether USD", "USDT", 6);

        vault = new LiquidityVault(address(this), guardian, feeCollector);
        manager = new CommitmentManager(address(this), address(vault), guardian, 5);
        ticketNft = new ExecutionTicket(address(manager));
        vault.setManager(address(manager));
        manager.setTicketNft(address(ticketNft));
        manager.setTokenMinTicketAmount(address(whsk), 100e18);

        router = new ExecutionRouter(address(manager), address(whsk));
        manager.setApprovedRouter(address(router), true);

        address[] memory signers = new address[](2);
        signers[0] = vm.addr(ORACLE_PK1);
        signers[1] = vm.addr(ORACLE_PK2);
        pullOracle = new SignedPullOracle(address(this), guardian, signers, 2, 30);

        secondaryOracle = new MockStaticPriceOracle(WHSK_PRICE_X36, block.timestamp, true);
        oracleAdapter = new OraclePriceAdapter(address(this));
        oracleAdapter.setPairConfig(
            address(whsk),
            address(usdt),
            OraclePriceAdapter.PairConfig({
                primaryFeed: address(pullOracle),
                secondaryFeed: address(secondaryOracle),
                maxStaleness: 30,
                secondaryMaxStaleness: 30,
                maxDeviationBps: 500,
                requireSecondaryCheck: true,
                allowSecondaryFallback: false,
                hardMinPriceX36: 1e18,
                hardMaxPriceX36: 1e27
            })
        );
        _pushOraclePrice(WHSK_PRICE_X36, block.timestamp);

        hspHook = new HSPComplianceHook(address(this), vm.addr(HSP_PK));
        manager.setApprovedOracle(address(oracleAdapter), true);
        manager.setApprovedComplianceHook(address(hspHook), true);

        whsk.mint(lp, 1_000_000e18);
        usdt.mint(trader1, 1_000_000e6);
        usdt.mint(trader2, 1_000_000e6);
        usdt.mint(attacker, 1_000_000e6);

        vm.prank(lp);
        whsk.approve(address(vault), type(uint256).max);
        vm.prank(trader1);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(trader2);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdt.approve(address(vault), type(uint256).max);
    }

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pushOraclePrice(uint256 priceX36, uint256 ts) internal {
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
                keccak256(abi.encode(pullOracle.PRICE_REPORT_TYPEHASH(), address(whsk), address(usdt), priceX36, ts))
            )
        );
        bytes[] memory sigs = new bytes[](2);
        if (vm.addr(ORACLE_PK1) < vm.addr(ORACLE_PK2)) {
            sigs[0] = _signDigest(ORACLE_PK1, digest);
            sigs[1] = _signDigest(ORACLE_PK2, digest);
        } else {
            sigs[0] = _signDigest(ORACLE_PK2, digest);
            sigs[1] = _signDigest(ORACLE_PK1, digest);
        }
        pullOracle.updatePrice(address(whsk), address(usdt), priceX36, ts, sigs);
    }

    function _createDefaultFixedOffer(uint256 amt) internal returns (uint64) {
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
        return oid;
    }

    function _createDefaultFloatingOffer(uint256 amt, address hook) internal returns (uint64) {
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
                dailyPremiumBps: 10,
                priceMode: PriceMode.FLOATING,
                spreadBps: 25,
                oracle: address(oracleAdapter),
                complianceHook: hook,
                fixedPriceX36: 0,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
        vm.stopPrank();
        return oid;
    }

    // --- Vector 1: Double Reservation ---
    function test_RevertWhen_DoubleReservationExceedsOfferCapacity() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.prank(trader1);
        manager.reserve(oid, 600e18, 3600, 100e6, trader1);

        vm.prank(attacker);
        vm.expectRevert(CommitmentManager.InsufficientOfferBalance.selector);
        manager.reserve(oid, 600e18, 3600, 100e6, attacker);
    }

    function test_RevertWhen_CrossOfferSharedBalanceDoubleReserve() public {
        vm.startPrank(lp);
        vault.deposit(address(whsk), 1_000e18);
        manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 1_000e18,
                minFillAmount: 100e18,
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
        vm.expectRevert(LiquidityVault.InsufficientBalance.selector);
        manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                initialAmount: 1_000e18,
                minFillAmount: 100e18,
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
    }

    // --- Vector 2: Inventory Double Spending ---
    function test_RevertWhen_ExerciseExceedsTicketRemaining() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.startPrank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);
        manager.exercise(tid, 300e18, 100e6, trader1);
        vm.expectRevert(CommitmentManager.InvalidFillAmount.selector);
        manager.exercise(tid, 300e18, 100e6, trader1);
        vm.stopPrank();
    }

    function test_RevertWhen_ParentExercisedBeyondSplitBalance() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.startPrank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);
        uint256 childId = manager.splitTicket(tid, 200e18, trader1);

        vm.expectRevert(CommitmentManager.InvalidFillAmount.selector);
        manager.exercise(tid, 400e18, 100e6, trader1);

        manager.exercise(tid, 300e18, 100e6, trader1);
        manager.exercise(childId, 200e18, 100e6, trader1);
        vm.stopPrank();
    }

    function test_DirectTokenTransferDoesNotInflateVaultAccounting() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        whsk.mint(attacker, 500e18);
        vm.prank(attacker);
        whsk.transfer(address(vault), 500e18);

        assertEq(vault.offerBalance(oid), 1_000e18);
        assertEq(vault.totalOfferAvailable(address(whsk)), 1_000e18);
        assertEq(vault.lpFreeBalance(attacker, address(whsk)), 0);
    }

    // --- Vector 3: Unauthorized Ticket Transfer / Exercise / Router Confused Deputy ---
    function test_RevertWhen_UnauthorizedExercise() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);

        vm.prank(attacker);
        vm.expectRevert(CommitmentManager.Unauthorized.selector);
        manager.exercise(tid, 0, 100e6, attacker);
    }

    function test_RevertWhen_RouterConfusedDeputyHijack() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.startPrank(trader1);
        uint256 victimTicket = manager.reserve(oid, 500e18, 3600, 100e6, trader1);
        ticketNft.setApprovalForAll(address(router), true);
        vm.stopPrank();

        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](1);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: victimTicket, fillAmount: 0, maxLegPaymentIn: 100e6});

        vm.startPrank(attacker);
        usdt.approve(address(router), type(uint256).max);
        vm.expectRevert(ExecutionRouter.NotTicketAuthorized.selector);
        router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                minTotalInventoryOut: 500e18,
                maxTotalPaymentIn: 100e6,
                deadline: block.timestamp,
                receiver: attacker,
                unwrapInventoryToNative: false,
                legs: legs
            })
        );
        vm.stopPrank();
    }

    // --- Vector 4: Partial Fill & Rounding Errors ---
    function testFuzz_PartialFillRoundingAlwaysFavorsLP(uint96 rawFill1, uint96 rawFill2) public {
        uint256 total = 1_000e18;
        uint256 f1 = bound(uint256(rawFill1), 100e18, 500e18);
        uint256 f2 = bound(uint256(rawFill2), 100e18, 400e18);

        uint64 oid = _createDefaultFixedOffer(total);
        vm.startPrank(trader1);
        uint256 tid = manager.reserve(oid, total, 3600, 1_000e6, trader1);
        (, uint256 paid1) = manager.exercise(tid, f1, 1_000e6, trader1);
        (, uint256 paid2) = manager.exercise(tid, f2, 1_000e6, trader1);
        vm.stopPrank();

        uint256 exactCeilTotal = Math.mulDiv(f1 + f2, WHSK_PRICE_X36, 1e36, Math.Rounding.Ceil);
        assertGe(paid1 + paid2, exactCeilTotal, "Sum of partial fills must never underpay LP");
    }

    function test_RevertWhen_PartialFillLeavesDustBelowMinFill() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.startPrank(trader1);
        uint256 tid = manager.reserve(oid, 1_000e18, 3600, 1_000e6, trader1);
        vm.expectRevert(CommitmentManager.InvalidFillAmount.selector);
        manager.exercise(tid, 1, 1_000e6, trader1);
        vm.stopPrank();
    }

    // --- Vector 5: Oracle Manipulation, Stale Updates & Outage Recovery ---
    function test_RevertWhen_OracleStaleZeroBoundsOrDeviated() public {
        uint64 oid = _createDefaultFloatingOffer(1_000e18, address(0));

        // 1. Stale (> 30s)
        vm.warp(block.timestamp + 31);
        vm.prank(trader1);
        vm.expectRevert(CommitmentManager.OracleUnavailable.selector);
        manager.reserve(oid, 100e18, 3600, 100e6, trader1);

        // 2. Deviation circuit breaker (> 500 bps vs secondary)
        _pushOraclePrice((WHSK_PRICE_X36 * 10_600) / 10_000, block.timestamp);
        secondaryOracle.set(WHSK_PRICE_X36, block.timestamp, true);
        vm.prank(trader1);
        vm.expectRevert(CommitmentManager.OracleUnavailable.selector);
        manager.reserve(oid, 100e18, 3600, 100e6, trader1);

        // 3. Hard bounds exceeded
        vm.warp(block.timestamp + 1);
        secondaryOracle.set(2e27, block.timestamp, true);
        _pushOraclePrice(2e27, block.timestamp);
        vm.prank(trader1);
        vm.expectRevert(CommitmentManager.OracleUnavailable.selector);
        manager.reserve(oid, 100e18, 3600, 100e6, trader1);
    }

    function test_BrokenOracleDoesNotBlockFixedOrReclaim() public {
        uint64 oidFloat = _createDefaultFloatingOffer(500e18, address(0));
        uint64 oidFixed = _createDefaultFixedOffer(500e18);

        vm.startPrank(trader1);
        uint256 tFloat = manager.reserve(oidFloat, 500e18, 300, 100e6, trader1);
        uint256 tFixed = manager.reserve(oidFixed, 500e18, 300, 100e6, trader1);
        vm.stopPrank();

        vm.warp(block.timestamp + 301);
        secondaryOracle.set(0, 0, false);

        manager.reclaimExpired(tFloat);
        assertEq(uint8(manager.getTicket(tFloat).status), uint8(TicketStatus.RECLAIMED));

        manager.reclaimExpired(tFixed);
        assertEq(uint8(manager.getTicket(tFixed).status), uint8(TicketStatus.RECLAIMED));
    }

    // --- Vector 6: LP Inventory Withdrawal ---
    function test_RevertWhen_LPWithdrawsReservedInventory() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 600e18, 3600, 100e6, trader1);

        vm.startPrank(lp);
        vm.expectRevert(LiquidityVault.InsufficientBalance.selector);
        manager.decreaseOffer(oid, 401e18);

        manager.pauseOffer(oid);
        manager.cancelOffer(oid);
        assertEq(vault.lpFreeBalance(lp, address(whsk)), 400e18);
        assertEq(vault.ticketReserved(tid), 600e18);
        vm.stopPrank();

        vm.prank(trader1);
        (uint256 filled,) = manager.exercise(tid, 0, 100e6, trader1);
        assertEq(filled, 600e18);
    }

    // --- Vector 7: Malicious ERC-20 Behavior ---
    function test_RevertWhen_FeeOnTransferTokenDeposited() public {
        MockFoTToken fot = new MockFoTToken();
        fot.mint(lp, 1_000e18);
        vm.startPrank(lp);
        fot.approve(address(vault), 1_000e18);
        vm.expectRevert(LiquidityVault.UnsupportedTokenBalanceDelta.selector);
        vault.deposit(address(fot), 1_000e18);
        vm.stopPrank();
    }

    function test_BlacklistedLP_DoesNotBlockTakerExercise() public {
        MockBlacklistToken busd = new MockBlacklistToken();
        busd.mint(trader1, 10_000e6);
        vm.prank(trader1);
        busd.approve(address(vault), type(uint256).max);

        vm.startPrank(lp);
        vault.deposit(address(whsk), 1_000e18);
        uint64 oid = manager.createOffer(
            CreateOfferParams({
                inventoryToken: address(whsk),
                paymentToken: address(busd),
                initialAmount: 1_000e18,
                minFillAmount: 100e18,
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

        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);

        busd.setBlacklisted(lp, true);

        vm.prank(trader1);
        (uint256 filled,) = manager.exercise(tid, 0, 100e6, trader1);
        assertEq(filled, 500e18);
        assertGt(vault.lpPendingProceeds(lp, address(busd)), 0);
    }

    // --- Vector 8: Reentrancy ---
    function test_RevertWhen_ReentrantERC20Callback() public {
        MockReentrantToken reent = new MockReentrantToken();
        reent.mint(lp, 1_000e18);

        vm.startPrank(lp);
        reent.approve(address(vault), type(uint256).max);
        reent.arm(address(vault), abi.encodeCall(LiquidityVault.withdrawFree, (address(reent), 100e18, lp)));
        vm.expectRevert("reentrant call failed");
        vault.deposit(address(reent), 500e18);
        vm.stopPrank();
    }

    // --- Vector 9: Reservation / Split Dust Griefing ---
    function test_RevertWhen_DustSplitBelowMinTicketAmount() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.startPrank(trader1);
        uint256 tid = manager.reserve(oid, 150e18, 3600, 100e6, trader1);
        vm.expectRevert(CommitmentManager.InvalidSplitAmount.selector);
        manager.splitTicket(tid, 50e18, trader1);
        vm.expectRevert(CommitmentManager.InvalidSplitAmount.selector);
        manager.splitTicket(tid, 100e18, trader1);
        vm.stopPrank();
    }

    // --- Vector 10: Expiry and Reclaim Boundary Race ---
    function test_Boundary_ExactExpiryTimestampExerciseAllowedReclaimBlocked() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);
        uint40 exp = manager.getTicket(tid).expiresAt;

        vm.warp(exp);
        vm.expectRevert(CommitmentManager.TicketNotExpired.selector);
        manager.reclaimExpired(tid);

        vm.prank(trader1);
        (uint256 filled,) = manager.exercise(tid, 200e18, 100e6, trader1);
        assertEq(filled, 200e18);

        vm.warp(exp + 1);
        vm.prank(trader1);
        vm.expectRevert(CommitmentManager.TicketExpired.selector);
        manager.exercise(tid, 0, 100e6, trader1);

        manager.reclaimExpired(tid);
        assertEq(vault.offerBalance(oid), 800e18);
    }

    // --- Vector 11: Batch Execution Failure Atomicity ---
    function test_BatchExerciseAtomicRevertAndZeroResidual() public {
        uint64 oid = _createDefaultFixedOffer(1_000e18);
        vm.startPrank(trader1);
        uint256 t1 = manager.reserve(oid, 300e18, 3600, 100e6, trader1);
        uint256 t2 = manager.reserve(oid, 300e18, 60, 100e6, trader1);
        ticketNft.setApprovalForAll(address(router), true);
        usdt.approve(address(router), type(uint256).max);

        vm.warp(block.timestamp + 61);
        ExecutionRouter.ExerciseLeg[] memory legs = new ExecutionRouter.ExerciseLeg[](2);
        legs[0] = ExecutionRouter.ExerciseLeg({ticketId: t1, fillAmount: 0, maxLegPaymentIn: 100e6});
        legs[1] = ExecutionRouter.ExerciseLeg({ticketId: t2, fillAmount: 0, maxLegPaymentIn: 100e6});

        vm.expectRevert(CommitmentManager.TicketExpired.selector);
        router.batchExercise(
            ExecutionRouter.BatchExerciseParams({
                inventoryToken: address(whsk),
                paymentToken: address(usdt),
                minTotalInventoryOut: 600e18,
                maxTotalPaymentIn: 200e6,
                deadline: block.timestamp,
                receiver: trader1,
                unwrapInventoryToNative: false,
                legs: legs
            })
        );
        vm.stopPrank();

        assertEq(manager.getTicket(t1).remainingAmount, 300e18);
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(usdt.allowance(address(router), address(vault)), 0);
    }

    // --- Vector 12: Slippage / Adverse Price Guard ---
    function test_RevertWhen_FloatingPriceExceedsMaxPaymentIn() public {
        uint64 oid = _createDefaultFloatingOffer(1_000e18, address(0));
        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);

        vm.warp(block.timestamp + 2);
        uint256 higherPrice = (WHSK_PRICE_X36 * 10_400) / 10_000;
        _pushOraclePrice(higherPrice, block.timestamp);
        secondaryOracle.set(higherPrice, block.timestamp, true);

        vm.prank(trader1);
        vm.expectRevert(CommitmentManager.SlippageExceeded.selector);
        manager.exercise(tid, 500e18, 40e6, trader1);
    }

    // --- Vector 13: HSP Compliance Attestation Replay & Non-Lockup Liveness ---
    function _signAttestation(address subject, uint256 nonce, uint256 expiry) internal view returns (bytes memory) {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ProtocolHSPCompliance"),
                keccak256("1"),
                block.chainid,
                address(hspHook)
            )
        );
        bytes32 structHash = keccak256(abi.encode(hspHook.ATTESTATION_TYPEHASH(), subject, nonce, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(HSP_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_HSPCompliance_EnforcesAndRevertsOnReplayExpiredRevoked() public {
        uint256 exp = block.timestamp + 1 days;
        bytes memory sigLp = _signAttestation(lp, 0, exp);
        bytes memory sigT1 = _signAttestation(trader1, 0, exp);

        hspHook.submitAttestation(lp, 0, exp, sigLp);
        hspHook.submitAttestation(trader1, 0, exp, sigT1);

        vm.expectRevert(HSPComplianceHook.InvalidNonce.selector);
        hspHook.submitAttestation(trader1, 0, exp, sigT1);

        uint64 oid = _createDefaultFloatingOffer(1_000e18, address(hspHook));
        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 3600, 100e6, trader1);

        vm.prank(trader1);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader2));
        ticketNft.transferFrom(trader1, trader2, tid);

        hspHook.revoke(trader1);
        vm.prank(trader1);
        vm.expectRevert(abi.encodeWithSelector(HSPComplianceHook.NotCompliant.selector, trader1));
        manager.exercise(tid, 0, 100e6, trader1);
    }

    function test_RevertingComplianceHookNeverBlocksWithdrawOrReclaim() public {
        MockRevertingCompliance brokenHook = new MockRevertingCompliance();
        hspHook.setApproved(lp, block.timestamp + 7 days);
        hspHook.setApproved(trader1, block.timestamp + 7 days);

        uint64 oid = _createDefaultFloatingOffer(1_000e18, address(hspHook));
        vm.prank(trader1);
        uint256 tid = manager.reserve(oid, 500e18, 300, 100e6, trader1);

        vm.startPrank(guardian);
        vault.setDepositsPaused(true);
        manager.setNewReservationsPaused(true);
        manager.setFloatingExercisePaused(true);
        vm.stopPrank();

        hspHook.revoke(lp);
        vm.startPrank(lp);
        manager.cancelOffer(oid);
        vault.withdrawFree(address(whsk), 500e18, lp);
        vault.claimProceeds(address(usdt), 0, lp);
        vm.stopPrank();

        vm.warp(block.timestamp + 301);
        manager.reclaimExpired(tid);
        assertEq(vault.lpFreeBalance(lp, address(whsk)), 500e18);

        vm.prank(lp);
        vault.withdrawFree(address(whsk), 500e18, lp);
        assertEq(whsk.balanceOf(lp), 1_000_000e18);
        assertTrue(address(brokenHook) != address(0));
    }
}
