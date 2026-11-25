// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
import {ISafeL2} from "../script/DeployTestnet.s.sol";
import {CommitmentManager} from "../src/CommitmentManager.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {IPriceOracle, CreateOfferParams, PriceMode, TicketStatus} from "../src/interfaces/IProtocol.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title MainnetForkTest
/// @notice End-to-end HashKey Chain Mainnet (177) fork readiness suite for DeployMainnet.s.sol.
///         Covers full deployment verification, governance handover & recovery, Guardian controls,
///         FIXED + FLOATING partial/full exercise lifecycles, cancel/reclaim/claim/withdraw,
///         HSKSwap SwapRouter02 unwind, INV-1 vault solvency, and all critical failure modes.
contract MainnetForkTest is Test {
    DeployMainnet internal deployScript;
    DeployMainnet.DeployConfig internal cfg;
    DeployMainnet.DeployedStack internal stack;

    uint256[] internal govPks;
    uint256[] internal guardianPks;
    uint256[] internal oraclePks;
    address internal deployer;
    address internal lp;
    address internal trader;
    uint256 internal deployGasUsed;

    function setUp() public {
        assertEq(block.chainid, 177, "must run on Chain 177 fork");

        deployScript = new DeployMainnet();
        deployer = address(deployScript);
        lp = makeAddr("mainnetLP");
        trader = makeAddr("mainnetTrader");

        govPks = new uint256[](5);
        address[] memory govOwners = new address[](5);
        for (uint256 i = 0; i < 5; ++i) {
            govPks[i] = 0xA100 + i + 1;
            govOwners[i] = vm.addr(govPks[i]);
        }

        guardianPks = new uint256[](3);
        address[] memory guardianOwners = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            guardianPks[i] = 0xB200 + i + 1;
            guardianOwners[i] = vm.addr(guardianPks[i]);
        }

        oraclePks = new uint256[](3);
        address[] memory treasuryOwners = new address[](3);
        address[] memory oracleSigners = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            treasuryOwners[i] = vm.addr(0xC300 + i + 1);
            oraclePks[i] = 0xD400 + i + 1;
            oracleSigners[i] = vm.addr(oraclePks[i]);
        }

        cfg = DeployMainnet.DeployConfig({
            deployer: deployer,
            govOwners: govOwners,
            guardianOwners: guardianOwners,
            treasuryOwners: treasuryOwners,
            oracleSigners: oracleSigners,
            hspAttestationSigner: vm.addr(0xE501),
            timelockMinDelay: 48 hours,
            saltNonceBase: 177_2026_9001
        });

        uint256 g0 = gasleft();
        stack = deployScript.deployAll(cfg);
        deployGasUsed = g0 - gasleft();
        console2.log("DeployMainnet.deployAll() gas used:", deployGasUsed);
    }

    function test_01_DeploymentConfigHandoverAndRecovery() public {
        // 1. Verify bytecode & wiring across all deployed contracts
        assertGt(stack.govSafe.code.length, 0);
        assertGt(stack.guardianSafe.code.length, 0);
        assertGt(stack.treasurySafe.code.length, 0);
        assertGt(address(stack.timelock).code.length, 0);
        assertGt(address(stack.vault).code.length, 0);
        assertGt(address(stack.manager).code.length, 0);
        assertGt(address(stack.ticketNft).code.length, 0);
        assertGt(address(stack.router).code.length, 0);

        assertEq(stack.vault.manager(), address(stack.manager));
        assertEq(stack.vault.guardian(), stack.guardianSafe);
        assertEq(stack.vault.feeCollector(), stack.treasurySafe);
        assertEq(address(stack.manager.ticketNft()), address(stack.ticketNft));
        assertEq(stack.manager.guardian(), stack.guardianSafe);
        assertEq(stack.manager.protocolFeeBps(), 5);
        assertEq(stack.router.whsk(), deployScript.MAINNET_WHSK());
        assertTrue(stack.manager.approvedOracles(address(stack.oracleAdapter)));
        assertTrue(stack.manager.approvedOracles(address(stack.twapOracle)));
        assertTrue(stack.manager.approvedRouters(address(stack.router)));

        // 2. Verify Safe thresholds & Timelock roles
        assertEq(ISafeL2(stack.govSafe).getThreshold(), 3);
        assertEq(ISafeL2(stack.govSafe).getOwners().length, 5);
        assertEq(ISafeL2(stack.guardianSafe).getThreshold(), 2);
        assertEq(ISafeL2(stack.guardianSafe).getOwners().length, 3);
        assertEq(ISafeL2(stack.treasurySafe).getThreshold(), 2);
        assertEq(ISafeL2(stack.treasurySafe).getOwners().length, 3);
        assertEq(stack.timelock.getMinDelay(), 48 hours);

        // 3. Test interrupted handover recovery: schedule -> Guardian cancels -> Gov re-schedules -> executes
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            deployScript.buildAcceptOwnershipBatch(stack);
        bytes32 badSalt = keccak256("tranche.mainnet.handover.cancelled");
        bytes32 opId = stack.timelock.hashOperationBatch(targets, values, payloads, bytes32(0), badSalt);

        _execSafeTx(
            stack.govSafe,
            govPks,
            3,
            address(stack.timelock),
            abi.encodeWithSelector(
                stack.timelock.scheduleBatch.selector, targets, values, payloads, bytes32(0), badSalt, 48 hours
            )
        );
        assertTrue(stack.timelock.isOperationPending(opId));

        // Guardian cancels interrupted batch
        _execSafeTx(
            stack.guardianSafe,
            guardianPks,
            2,
            address(stack.timelock),
            abi.encodeWithSelector(stack.timelock.cancel.selector, opId)
        );
        assertFalse(stack.timelock.isOperationPending(opId));

        // Complete clean handover
        _completeHandover();

        // 4. Verify deployer privileges are completely removed
        bytes32 propRole = stack.timelock.PROPOSER_ROLE();
        vm.startPrank(deployer);
        vm.expectRevert();
        stack.manager.setProtocolFeeBps(10);
        vm.expectRevert();
        stack.vault.setGuardian(deployer);
        vm.expectRevert();
        stack.timelock.grantRole(propRole, deployer);
        vm.stopPrank();
    }

    function test_02_CompleteLifecycleFixedFloatingAndSolvency() public {
        _completeHandover();

        address whsk = deployScript.MAINNET_WHSK();
        address usdt = deployScript.MAINNET_USDT();

        deal(whsk, lp, 2_000e18);
        deal(usdt, trader, 1_000e6);

        // 1. LP deposits canonical WHSK into LiquidityVault
        vm.startPrank(lp);
        IERC20(whsk).approve(address(stack.vault), 2_000e18);
        stack.vault.deposit(whsk, 2_000e18);

        // 2. Create FIXED offer (1,000 WHSK @ $0.085) and FLOATING offer (500 WHSK @ live TWAP + 0.25%)
        uint64 fixedOfferId = _createFixedOffer(whsk, usdt, 1_000e18, 85e21);
        uint64 floatOfferId = _createFloatingOffer(whsk, usdt, 500e18);
        vm.stopPrank();

        // 3. FIXED: Reserve 200 WHSK -> Partial exercise 80 WHSK -> Full exercise remaining 120 WHSK
        vm.startPrank(trader);
        IERC20(usdt).approve(address(stack.vault), type(uint256).max);
        _reservePartialThenFullExercise(fixedOfferId, 200e18, 80e18);

        // 4. FLOATING: Reserve 100 WHSK -> Partial exercise 40 WHSK -> Full exercise remaining 60 WHSK
        _reservePartialThenFullExercise(floatOfferId, 100e18, 40e18);
        assertEq(IERC20(whsk).balanceOf(trader), 300e18);

        // 5. Real HSKSwap SwapRouter02 unwind (100 WHSK -> USDT)
        _swapWhskToUsdt(100e18);
        vm.stopPrank();

        // 6. LP claims USDT proceeds, cancels unused offer balances, withdraws all remaining free WHSK
        uint256 pendingUsdt = stack.vault.lpPendingProceeds(lp, usdt);
        uint256 protoFeesUsdt = stack.vault.protocolFees(usdt);
        assertGt(pendingUsdt, 0);
        assertGt(protoFeesUsdt, 0);

        vm.startPrank(lp);
        stack.vault.claimProceeds(usdt, pendingUsdt, lp);
        stack.manager.cancelOffer(fixedOfferId); // releases 800 WHSK back to free
        stack.manager.cancelOffer(floatOfferId); // releases 400 WHSK back to free
        uint256 totalFreeWhsk = stack.vault.lpFreeBalance(lp, whsk);
        assertEq(totalFreeWhsk, 1_700e18); // 2000 deposited - 300 exercised
        stack.vault.withdrawFree(whsk, totalFreeWhsk, lp);
        vm.stopPrank();

        // 7. Treasury Safe withdraws protocol fees
        vm.prank(stack.treasurySafe);
        stack.vault.withdrawProtocolFees(usdt, stack.treasurySafe);
        assertEq(IERC20(usdt).balanceOf(stack.treasurySafe), protoFeesUsdt);

        // 8. Verify INV-1 Vault Solvency & exact zero residual accounting
        _assertVaultSolvency(whsk);
        _assertVaultSolvency(usdt);
        assertEq(IERC20(whsk).balanceOf(address(stack.vault)), 0);
        assertEq(IERC20(usdt).balanceOf(address(stack.vault)), 0);
    }

    function test_03_FailureModesPausesAndOracleDeviation() public {
        _completeHandover();

        address whsk = deployScript.MAINNET_WHSK();
        address usdt = deployScript.MAINNET_USDT();

        deal(whsk, lp, 500e18);
        deal(usdt, trader, 500e6);

        vm.startPrank(lp);
        IERC20(whsk).approve(address(stack.vault), 500e18);
        stack.vault.deposit(whsk, 500e18);
        uint64 fixedOfferId = _createFixedOffer(whsk, usdt, 200e18, 85e21);
        uint64 floatOfferId = _createFloatingOffer(whsk, usdt, 200e18);
        vm.stopPrank();

        // A. Insufficient inventory
        vm.startPrank(trader);
        IERC20(usdt).approve(address(stack.vault), type(uint256).max);
        vm.expectRevert(CommitmentManager.InsufficientOfferBalance.selector);
        stack.manager.reserve(fixedOfferId, 201e18, 1 hours, type(uint256).max, trader);

        // B. Slippage / maxPremium cap exceeded
        (uint256 prem,) = stack.manager.quoteReservation(fixedOfferId, 50e18, 1 hours);
        vm.expectRevert(CommitmentManager.SlippageExceeded.selector);
        stack.manager.reserve(fixedOfferId, 50e18, 1 hours, prem - 1, trader);

        // C. Insufficient payment balance (unfunded user)
        vm.stopPrank();
        address brokeUser = makeAddr("brokeUser");
        vm.startPrank(brokeUser);
        IERC20(usdt).approve(address(stack.vault), type(uint256).max);
        vm.expectRevert();
        stack.manager.reserve(fixedOfferId, 50e18, 1 hours, type(uint256).max, brokeUser);
        vm.stopPrank();

        // D. Slippage / maxPayment exceeded on exercise + Expired ticket + Reclaim
        vm.startPrank(trader);
        uint256 tId = stack.manager.reserve(fixedOfferId, 50e18, 1 hours, prem, trader);
        (, uint256 exPay,) = stack.manager.quoteExercise(tId, 0);
        vm.expectRevert(CommitmentManager.SlippageExceeded.selector);
        stack.manager.exercise(tId, 0, exPay - 1, trader);

        // Warp past expiry -> exercise reverts -> reclaimExpired returns inventory to offer
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(CommitmentManager.TicketExpired.selector);
        stack.manager.exercise(tId, 0, exPay, trader);
        stack.manager.reclaimExpired(tId);
        assertEq(stack.vault.offerBalance(fixedOfferId), 200e18);
        assertEq(uint8(stack.manager.getTicket(tId).status), uint8(TicketStatus.RECLAIMED));
        vm.stopPrank();

        // E. Invalid / Deviating SignedPullOracle price (>5% away from live TWAP -> OracleUnavailable)
        IPriceOracle.PriceQuote memory liveTwap = stack.twapOracle.getPriceX36(whsk, usdt);
        uint256 manipulatedPrice = (liveTwap.priceX36 * 120) / 100; // +20% > 5% maxDeviationBps
        _pushSignedPrice(whsk, usdt, manipulatedPrice, block.timestamp);
        assertFalse(stack.oracleAdapter.getPriceX36(whsk, usdt).isValid);

        vm.prank(trader);
        vm.expectRevert(CommitmentManager.OracleUnavailable.selector);
        stack.manager.reserve(floatOfferId, 50e18, 1 hours, type(uint256).max, trader);

        // Guardian revokes bad pull price -> adapter safely falls back to live TWAP
        _execSafeTx(
            stack.guardianSafe,
            guardianPks,
            2,
            address(stack.pullOracle),
            abi.encodeWithSignature("revokePrice(address,address)", whsk, usdt)
        );
        assertTrue(stack.oracleAdapter.getPriceX36(whsk, usdt).isValid);

        // F. Emergency pause controls: Guardian pauses deposits, reservations, and floating exercise
        (uint256 fPrem,) = stack.manager.quoteReservation(floatOfferId, 50e18, 1 hours);
        vm.prank(trader);
        uint256 floatTicketId = stack.manager.reserve(floatOfferId, 50e18, 1 hours, fPrem, trader);

        _execSafeTx(
            stack.guardianSafe,
            guardianPks,
            2,
            address(stack.vault),
            abi.encodeWithSignature("setDepositsPaused(bool)", true)
        );
        _execSafeTx(
            stack.guardianSafe,
            guardianPks,
            2,
            address(stack.manager),
            abi.encodeWithSignature("setNewReservationsPaused(bool)", true)
        );
        _execSafeTx(
            stack.guardianSafe,
            guardianPks,
            2,
            address(stack.manager),
            abi.encodeWithSignature("setFloatingExercisePaused(bool)", true)
        );

        deal(whsk, lp, 10e18);
        vm.startPrank(lp);
        IERC20(whsk).approve(address(stack.vault), 10e18);
        vm.expectRevert(LiquidityVault.DepositsPaused.selector);
        stack.vault.deposit(whsk, 10e18);
        // LP withdrawFree MUST still work even while deposits & reservations are paused!
        stack.vault.withdrawFree(whsk, 100e18, lp);
        vm.stopPrank();

        vm.startPrank(trader);
        vm.expectRevert(CommitmentManager.NewReservationsPaused.selector);
        stack.manager.reserve(fixedOfferId, 20e18, 1 hours, type(uint256).max, trader);
        vm.expectRevert(CommitmentManager.FloatingExercisePaused.selector);
        stack.manager.exercise(floatTicketId, 0, type(uint256).max, trader);
        vm.stopPrank();

        _assertVaultSolvency(whsk);
        _assertVaultSolvency(usdt);
    }

    function _completeHandover() internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            deployScript.buildAcceptOwnershipBatch(stack);
        bytes32 salt = keccak256("tranche.mainnet.ownership.handover.v1");

        _execSafeTx(
            stack.govSafe,
            govPks,
            3,
            address(stack.timelock),
            abi.encodeWithSelector(
                stack.timelock.scheduleBatch.selector, targets, values, payloads, bytes32(0), salt, 48 hours
            )
        );
        vm.warp(block.timestamp + 48 hours + 1);
        _execSafeTx(
            stack.govSafe,
            govPks,
            3,
            address(stack.timelock),
            abi.encodeWithSelector(stack.timelock.executeBatch.selector, targets, values, payloads, bytes32(0), salt)
        );
        bytes32 adminRole = stack.timelock.DEFAULT_ADMIN_ROLE();
        vm.prank(deployer);
        stack.timelock.renounceRole(adminRole, deployer);

        for (uint256 i = 0; i < 6; ++i) {
            assertEq(Ownable2Step(targets[i]).owner(), address(stack.timelock));
        }
        assertFalse(stack.timelock.hasRole(adminRole, deployer));
    }

    function _createFixedOffer(address inv, address pay, uint256 amt, uint256 priceX36) internal returns (uint64) {
        return stack.manager.createOffer(
            CreateOfferParams({
                inventoryToken: inv,
                paymentToken: pay,
                initialAmount: amt,
                minFillAmount: 10e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 3 days,
                basePremiumBps: 50,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FIXED,
                spreadBps: 0,
                oracle: address(0),
                complianceHook: address(0),
                fixedPriceX36: priceX36,
                minPriceX36: 0,
                maxPriceX36: 0
            })
        );
    }

    function _createFloatingOffer(address inv, address pay, uint256 amt) internal returns (uint64) {
        return stack.manager.createOffer(
            CreateOfferParams({
                inventoryToken: inv,
                paymentToken: pay,
                initialAmount: amt,
                minFillAmount: 10e18,
                expiry: uint40(block.timestamp + 7 days),
                minDuration: 60,
                maxDuration: 3 days,
                basePremiumBps: 30,
                dailyPremiumBps: 10,
                priceMode: PriceMode.FLOATING,
                spreadBps: 25,
                oracle: address(stack.oracleAdapter),
                complianceHook: address(0),
                fixedPriceX36: 0,
                minPriceX36: 1e21,
                maxPriceX36: 1e26
            })
        );
    }

    function _reservePartialThenFullExercise(uint64 offerId, uint256 totalAmt, uint256 partialAmt) internal {
        (uint256 prem,) = stack.manager.quoteReservation(offerId, totalAmt, 1 hours);
        uint256 ticketId = stack.manager.reserve(offerId, totalAmt, 1 hours, prem, trader);

        (uint256 actFill1, uint256 pay1,) = stack.manager.quoteExercise(ticketId, partialAmt);
        assertEq(actFill1, partialAmt);
        (uint256 filled1, uint256 paid1) = stack.manager.exercise(ticketId, partialAmt, pay1, trader);
        assertEq(filled1, partialAmt);
        assertEq(paid1, pay1);
        assertEq(stack.manager.getTicket(ticketId).remainingAmount, totalAmt - partialAmt);
        assertEq(uint8(stack.manager.getTicket(ticketId).status), uint8(TicketStatus.ACTIVE));

        (uint256 actFill2, uint256 pay2,) = stack.manager.quoteExercise(ticketId, 0);
        assertEq(actFill2, totalAmt - partialAmt);
        (uint256 filled2, uint256 paid2) = stack.manager.exercise(ticketId, 0, pay2, trader);
        assertEq(filled2, totalAmt - partialAmt);
        assertEq(paid2, pay2);
        assertEq(uint8(stack.manager.getTicket(ticketId).status), uint8(TicketStatus.EXERCISED));
    }

    function _swapWhskToUsdt(uint256 amountIn) internal {
        address whsk = deployScript.MAINNET_WHSK();
        address usdt = deployScript.MAINNET_USDT();
        IERC20(whsk).approve(deployScript.HSKSWAP_SWAP_ROUTER_02(), amountIn);
        uint256 usdtBefore = IERC20(usdt).balanceOf(trader);
        uint256 usdtOut = ISwapRouter02(deployScript.HSKSWAP_SWAP_ROUTER_02()).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: whsk,
                tokenOut: usdt,
                fee: 3000,
                recipient: trader,
                amountIn: amountIn,
                amountOutMinimum: 1,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(usdtOut, 0);
        assertEq(IERC20(usdt).balanceOf(trader) - usdtBefore, usdtOut);
        console2.log("HSKSwap live unwind 100 WHSK -> USDT (raw 6 dec):", usdtOut);
    }

    function _pushSignedPrice(address inv, address pay, uint256 priceX36, uint256 ts) internal {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                keccak256(
                    abi.encode(
                        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                        keccak256("ProtocolSignedPullOracle"),
                        keccak256("2"),
                        block.chainid,
                        address(stack.pullOracle)
                    )
                ),
                keccak256(abi.encode(stack.pullOracle.PRICE_REPORT_TYPEHASH(), inv, pay, priceX36, ts))
            )
        );

        uint256 pk0 = oraclePks[0];
        uint256 pk1 = oraclePks[1];
        if (vm.addr(pk1) < vm.addr(pk0)) (pk0, pk1) = (pk1, pk0);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signDigest(pk0, digest);
        sigs[1] = _signDigest(pk1, digest);

        stack.pullOracle.updatePrice(inv, pay, priceX36, ts, sigs);
    }

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assertVaultSolvency(address token) internal view {
        uint256 accounted = stack.vault.totalLpFree(token) + stack.vault.totalOfferAvailable(token)
            + stack.vault.totalReserved(token) + stack.vault.totalPendingProceeds(token)
            + stack.vault.protocolFees(token);
        assertEq(IERC20(token).balanceOf(address(stack.vault)), accounted, "INV-1 vault solvency mismatch");
    }

    function _execSafeTx(address safeAddr, uint256[] memory pks, uint256 threshold, address to, bytes memory data)
        internal
    {
        ISafeL2 safe = ISafeL2(safeAddr);
        uint256 safeNonce = safe.nonce();
        bytes32 txHash =
            safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safeNonce);

        address[] memory addrs = new address[](threshold);
        uint256[] memory sortedPks = new uint256[](threshold);
        for (uint256 i = 0; i < threshold; ++i) {
            sortedPks[i] = pks[i];
            addrs[i] = vm.addr(pks[i]);
        }
        for (uint256 i = 0; i < threshold; ++i) {
            for (uint256 j = i + 1; j < threshold; ++j) {
                if (addrs[j] < addrs[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (sortedPks[i], sortedPks[j]) = (sortedPks[j], sortedPks[i]);
                }
            }
        }
        bytes memory sigs;
        for (uint256 i = 0; i < threshold; ++i) {
            (uint8 v, bytes32 r, bytes32 sVal) = vm.sign(sortedPks[i], txHash);
            sigs = abi.encodePacked(sigs, r, sVal, v);
        }
        bool ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        assertTrue(ok, "Safe execTransaction failed");
    }
}
