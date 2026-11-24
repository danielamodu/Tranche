// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    ICommitmentManager,
    ILiquidityVault,
    IExecutionTicket,
    IPriceOracle,
    IComplianceHook,
    PriceMode,
    OfferStatus,
    TicketStatus,
    Offer,
    Ticket,
    CreateOfferParams
} from "./interfaces/IProtocol.sol";

/// @title CommitmentManager
/// @notice Manages LP offers, dual-mode ticket reservations, partial/full exercises, splits, and expiry reclaims.
contract CommitmentManager is ICommitmentManager, Ownable2Step, ReentrancyGuard {
    uint256 public constant PRICE_SCALE = 1e36;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 100; // 1.00% hard ceiling
    uint32 public constant MIN_OFFER_DURATION = 60; // 1 minute
    uint32 public constant MAX_OFFER_DURATION = 30 days;

    error ZeroAddress();
    error ZeroAmount();
    error Unauthorized();
    error NewReservationsPaused();
    error FloatingExercisePaused();
    error InvalidTokenPair();
    error InvalidExpiry();
    error InvalidDurationBounds();
    error InvalidFeeBps();
    error InvalidPriceParams();
    error InvalidAmountBounds();
    error UnapprovedAdapter();
    error OfferNotActive();
    error OfferExpired();
    error OfferCancelled();
    error InsufficientOfferBalance();
    error SlippageExceeded();
    error TicketNotActive();
    error TicketExpired();
    error TicketNotExpired();
    error InvalidFillAmount();
    error InvalidSplitAmount();
    error OracleUnavailable();
    error ZeroPaymentCalculated();

    event OfferCreated(uint64 indexed offerId, address indexed lp, PriceMode priceMode);
    event OfferToppedUp(uint64 indexed offerId, uint256 amount);
    event OfferDecreased(uint64 indexed offerId, uint256 amount);
    event OfferStatusUpdated(uint64 indexed offerId, OfferStatus status);
    event TicketReserved(
        uint256 indexed ticketId,
        uint64 indexed offerId,
        address indexed recipient,
        uint256 inventoryAmount,
        uint40 expiresAt,
        uint256 grossPremium
    );
    event TicketExercised(
        uint256 indexed ticketId,
        address indexed exerciser,
        address indexed receiver,
        uint256 fillAmount,
        uint256 grossPayment,
        uint256 effPriceX36
    );
    event TicketSplit(
        uint256 indexed fromTicketId,
        uint256 indexed newTicketId,
        address indexed recipient,
        uint256 splitAmount
    );
    event TicketReclaimed(uint256 indexed ticketId, uint256 releasedAmount, bool returnedToOffer);
    event ProtocolFeeBpsUpdated(uint16 protocolFeeBps);
    event TokenMinTicketAmountUpdated(address indexed token, uint256 minAmount);
    event GuardianUpdated(address indexed guardian);
    event NewReservationsPausedSet(bool paused);
    event FloatingExercisePausedSet(bool paused);
    event ApprovedOracleSet(address indexed oracle, bool approved);
    event ApprovedComplianceHookSet(address indexed hook, bool approved);
    event ApprovedRouterSet(address indexed router, bool approved);

    struct ExerciseArgs {
        uint256 ticketId;
        uint256 fillAmount;
        uint256 maxPaymentIn;
        address exerciser;
        address payer;
        address tokenReceiver;
        address finalReceiver;
    }

    ILiquidityVault public immutable override vault;
    IExecutionTicket public override ticketNft;

    address public guardian;
    bool public newReservationsPaused;
    bool public floatingExercisePaused;

    uint64 public nextOfferId = 1;
    uint256 public nextTicketId = 1;
    uint16 public protocolFeeBps;

    mapping(address => uint256) public tokenMinTicketAmount;
    mapping(address => bool) public approvedOracles;
    mapping(address => bool) public approvedComplianceHooks;
    mapping(address => bool) public approvedRouters;

    mapping(uint64 => Offer) internal _offers;
    mapping(uint256 => Ticket) internal _tickets;

    constructor(
        address _owner,
        address _vault,
        address _guardian,
        uint16 _protocolFeeBps
    ) Ownable(_owner) {
        if (_vault == address(0) || _guardian == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();
        vault = ILiquidityVault(_vault);
        guardian = _guardian;
        protocolFeeBps = _protocolFeeBps;
    }

    function setTicketNft(address _ticketNft) external onlyOwner {
        if (address(ticketNft) != address(0)) revert Unauthorized();
        if (_ticketNft == address(0)) revert ZeroAddress();
        ticketNft = IExecutionTicket(_ticketNft);
    }

    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ZeroAddress();
        guardian = _guardian;
        emit GuardianUpdated(_guardian);
    }

    function setProtocolFeeBps(uint16 _protocolFeeBps) external onlyOwner {
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeBps();
        protocolFeeBps = _protocolFeeBps;
        emit ProtocolFeeBpsUpdated(_protocolFeeBps);
    }

    function setTokenMinTicketAmount(address token, uint256 minAmount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenMinTicketAmount[token] = minAmount;
        emit TokenMinTicketAmountUpdated(token, minAmount);
    }

    function setApprovedOracle(address oracle, bool approved) external onlyOwner {
        if (oracle == address(0)) revert ZeroAddress();
        approvedOracles[oracle] = approved;
        emit ApprovedOracleSet(oracle, approved);
    }

    function setApprovedComplianceHook(address hook, bool approved) external onlyOwner {
        if (hook == address(0)) revert ZeroAddress();
        approvedComplianceHooks[hook] = approved;
        emit ApprovedComplianceHookSet(hook, approved);
    }

    function setApprovedRouter(address router, bool approved) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        approvedRouters[router] = approved;
        emit ApprovedRouterSet(router, approved);
    }

    function setNewReservationsPaused(bool paused) external {
        if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized();
        newReservationsPaused = paused;
        emit NewReservationsPausedSet(paused);
    }

    function setFloatingExercisePaused(bool paused) external {
        if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized();
        floatingExercisePaused = paused;
        emit FloatingExercisePausedSet(paused);
    }

    /// @inheritdoc ICommitmentManager
    function createOffer(CreateOfferParams calldata p) external override nonReentrant returns (uint64 offerId) {
        if (newReservationsPaused) revert NewReservationsPaused();
        if (p.inventoryToken == address(0) || p.paymentToken == address(0)) revert ZeroAddress();
        if (p.inventoryToken == p.paymentToken) revert InvalidTokenPair();
        if (p.expiry <= block.timestamp) revert InvalidExpiry();
        if (p.minDuration < MIN_OFFER_DURATION || p.maxDuration < p.minDuration || p.maxDuration > MAX_OFFER_DURATION) {
            revert InvalidDurationBounds();
        }
        if (p.basePremiumBps > BPS_DENOMINATOR || p.dailyPremiumBps > BPS_DENOMINATOR) revert InvalidFeeBps();

        uint256 tokenMin = tokenMinTicketAmount[p.inventoryToken];
        if (p.minFillAmount == 0 || p.minFillAmount < tokenMin) revert InvalidAmountBounds();

        if (p.complianceHook != address(0)) {
            if (!approvedComplianceHooks[p.complianceHook]) revert UnapprovedAdapter();
            IComplianceHook(p.complianceHook).beforeCreateOffer(msg.sender, p.inventoryToken, p.paymentToken);
        }

        if (p.priceMode == PriceMode.FIXED) {
            if (p.fixedPriceX36 == 0) revert InvalidPriceParams();
            if (p.oracle != address(0) && !approvedOracles[p.oracle]) revert UnapprovedAdapter();
        } else {
            if (p.oracle == address(0) || !approvedOracles[p.oracle]) revert UnapprovedAdapter();
            if (p.spreadBps <= -int16(uint16(BPS_DENOMINATOR))) revert InvalidPriceParams();
            if (p.maxPriceX36 > 0 && p.minPriceX36 > p.maxPriceX36) revert InvalidPriceParams();
        }

        offerId = nextOfferId++;
        _offers[offerId] = Offer({
            lp: msg.sender,
            createdAt: uint40(block.timestamp),
            expiry: p.expiry,
            priceMode: p.priceMode,
            status: OfferStatus.ACTIVE,
            inventoryToken: p.inventoryToken,
            minDuration: p.minDuration,
            maxDuration: p.maxDuration,
            basePremiumBps: p.basePremiumBps,
            dailyPremiumBps: p.dailyPremiumBps,
            paymentToken: p.paymentToken,
            spreadBps: p.spreadBps,
            protocolFeeBps: protocolFeeBps,
            oracle: p.oracle,
            complianceHook: p.complianceHook,
            minFillAmount: p.minFillAmount,
            fixedPriceX36: p.fixedPriceX36,
            minPriceX36: p.minPriceX36,
            maxPriceX36: p.maxPriceX36
        });

        if (p.initialAmount > 0) {
            vault.allocateToOffer(msg.sender, p.inventoryToken, offerId, p.initialAmount);
        }

        emit OfferCreated(offerId, msg.sender, p.priceMode);
    }

    function topUpOffer(uint64 offerId, uint256 addAmount) external override nonReentrant {
        if (newReservationsPaused) revert NewReservationsPaused();
        Offer storage o = _offers[offerId];
        if (o.lp != msg.sender) revert Unauthorized();
        if (o.status == OfferStatus.CANCELLED) revert OfferCancelled();
        if (block.timestamp >= o.expiry) revert OfferExpired();
        if (addAmount == 0) revert ZeroAmount();

        vault.allocateToOffer(msg.sender, o.inventoryToken, offerId, addAmount);
        emit OfferToppedUp(offerId, addAmount);
    }

    /// @dev Never blocked by pause flags.
    function decreaseOffer(uint64 offerId, uint256 removeAmount) external override nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.lp != msg.sender) revert Unauthorized();
        if (removeAmount == 0) revert ZeroAmount();

        vault.deallocateFromOffer(msg.sender, o.inventoryToken, offerId, removeAmount);
        emit OfferDecreased(offerId, removeAmount);
    }

    function pauseOffer(uint64 offerId) external override nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.lp != msg.sender) revert Unauthorized();
        if (o.status != OfferStatus.ACTIVE) revert OfferNotActive();
        o.status = OfferStatus.PAUSED;
        emit OfferStatusUpdated(offerId, OfferStatus.PAUSED);
    }

    function unpauseOffer(uint64 offerId) external override nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.lp != msg.sender) revert Unauthorized();
        if (o.status != OfferStatus.PAUSED) revert OfferNotActive();
        o.status = OfferStatus.ACTIVE;
        emit OfferStatusUpdated(offerId, OfferStatus.ACTIVE);
    }

    /// @dev Never blocked by pause flags.
    function cancelOffer(uint64 offerId) external override nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.lp != msg.sender) revert Unauthorized();
        if (o.status == OfferStatus.CANCELLED) revert OfferCancelled();

        o.status = OfferStatus.CANCELLED;
        uint256 rem = vault.offerBalance(offerId);
        if (rem > 0) {
            vault.deallocateFromOffer(msg.sender, o.inventoryToken, offerId, rem);
        }
        emit OfferStatusUpdated(offerId, OfferStatus.CANCELLED);
    }

    /// @inheritdoc ICommitmentManager
    function reserve(
        uint64 offerId,
        uint256 inventoryAmount,
        uint32 duration,
        uint256 maxPremiumIn,
        address recipient
    ) external override nonReentrant returns (uint256 ticketId) {
        if (newReservationsPaused) revert NewReservationsPaused();
        if (recipient == address(0)) revert ZeroAddress();

        Offer storage o = _offers[offerId];
        if (o.lp == address(0) || o.status != OfferStatus.ACTIVE) revert OfferNotActive();
        if (block.timestamp >= o.expiry) revert OfferExpired();
        if (duration < o.minDuration || duration > o.maxDuration) revert InvalidDurationBounds();
        if (block.timestamp + duration > o.expiry) revert InvalidExpiry();

        if (inventoryAmount == 0 || inventoryAmount < o.minFillAmount) revert InvalidAmountBounds();
        if (vault.offerBalance(offerId) < inventoryAmount) revert InsufficientOfferBalance();

        if (o.complianceHook != address(0)) {
            IComplianceHook(o.complianceHook).beforeReserve(offerId, msg.sender, recipient, inventoryAmount);
        }

        (uint256 grossPremium, uint256 fee) = _quoteReservation(o, inventoryAmount, duration);
        if (grossPremium > maxPremiumIn) revert SlippageExceeded();

        ticketId = nextTicketId++;
        uint40 expiresAt = uint40(block.timestamp + duration);
        _writeTicketSnapshot(ticketId, offerId, o, inventoryAmount, expiresAt);

        vault.reserveFromOffer(offerId, ticketId, o.inventoryToken, inventoryAmount);
        if (grossPremium > 0) {
            vault.collectFeeAndProceeds(msg.sender, o.paymentToken, o.lp, grossPremium - fee, fee);
        }
        ticketNft.mint(recipient, ticketId);

        emit TicketReserved(ticketId, offerId, recipient, inventoryAmount, expiresAt, grossPremium);
    }

    function _writeTicketSnapshot(
        uint256 ticketId,
        uint64 offerId,
        Offer storage o,
        uint256 inventoryAmount,
        uint40 expiresAt
    ) internal {
        _tickets[ticketId] = Ticket({
            offerId: offerId,
            reservedAt: uint40(block.timestamp),
            expiresAt: expiresAt,
            priceMode: o.priceMode,
            status: TicketStatus.ACTIVE,
            spreadBps: o.spreadBps,
            protocolFeeBps: o.protocolFeeBps,
            lp: o.lp,
            inventoryToken: o.inventoryToken,
            paymentToken: o.paymentToken,
            oracle: o.oracle,
            complianceHook: o.complianceHook,
            initialAmount: inventoryAmount,
            remainingAmount: inventoryAmount,
            minFillAmount: o.minFillAmount,
            fixedOrMinPriceX36: o.priceMode == PriceMode.FIXED ? o.fixedPriceX36 : o.minPriceX36,
            maxPriceX36: o.priceMode == PriceMode.FIXED ? 0 : o.maxPriceX36
        });
    }

    /// @inheritdoc ICommitmentManager
    function exercise(
        uint256 ticketId,
        uint256 fillAmount,
        uint256 maxPaymentIn,
        address receiver
    ) external override nonReentrant returns (uint256 actualFill, uint256 grossPayment) {
        return _exercise(
            ExerciseArgs({
                ticketId: ticketId,
                fillAmount: fillAmount,
                maxPaymentIn: maxPaymentIn,
                exerciser: msg.sender,
                payer: msg.sender,
                tokenReceiver: receiver,
                finalReceiver: receiver
            })
        );
    }

    /// @inheritdoc ICommitmentManager
    function exerciseFor(
        uint256 ticketId,
        uint256 fillAmount,
        uint256 maxPaymentIn,
        address exerciser,
        address tokenReceiver,
        address finalReceiver
    ) external override nonReentrant returns (uint256 actualFill, uint256 grossPayment) {
        if (!approvedRouters[msg.sender]) revert Unauthorized();
        return _exercise(
            ExerciseArgs({
                ticketId: ticketId,
                fillAmount: fillAmount,
                maxPaymentIn: maxPaymentIn,
                exerciser: exerciser,
                payer: msg.sender,
                tokenReceiver: tokenReceiver,
                finalReceiver: finalReceiver
            })
        );
    }

    function _exercise(ExerciseArgs memory a)
        internal
        returns (uint256 actualFill, uint256 grossPayment)
    {
        if (a.tokenReceiver == address(0) || a.finalReceiver == address(0)) revert ZeroAddress();
        if (!ticketNft.isAuthorized(a.exerciser, a.ticketId)) revert Unauthorized();

        Ticket storage t = _tickets[a.ticketId];
        if (t.status != TicketStatus.ACTIVE) revert TicketNotActive();
        if (block.timestamp > t.expiresAt) revert TicketExpired();
        if (t.priceMode == PriceMode.FLOATING && floatingExercisePaused) revert FloatingExercisePaused();

        if (t.complianceHook != address(0)) {
            IComplianceHook(t.complianceHook).beforeExercise(a.ticketId, a.exerciser, a.finalReceiver);
        }

        actualFill = a.fillAmount == 0 ? t.remainingAmount : a.fillAmount;
        if (actualFill == 0 || actualFill > t.remainingAmount) revert InvalidFillAmount();

        uint256 newRem = t.remainingAmount - actualFill;
        if (newRem != 0 && (actualFill < t.minFillAmount || newRem < t.minFillAmount)) {
            revert InvalidFillAmount();
        }

        (uint256 grossPay, uint256 fee, uint256 effPriceX36) = _quoteExercise(t, actualFill);
        if (grossPay == 0) revert ZeroPaymentCalculated();
        if (grossPay > a.maxPaymentIn) revert SlippageExceeded();

        grossPayment = grossPay;
        t.remainingAmount = newRem;
        if (newRem == 0) {
            t.status = TicketStatus.EXERCISED;
        }

        _dispatchSettle(a.ticketId, t, actualFill, a.payer, grossPay - fee, fee, a.tokenReceiver);
        if (newRem == 0) {
            ticketNft.burn(a.ticketId);
        }

        emit TicketExercised(a.ticketId, a.exerciser, a.finalReceiver, actualFill, grossPay, effPriceX36);
    }

    function _dispatchSettle(
        uint256 ticketId,
        Ticket storage t,
        uint256 fillAmt,
        address payer,
        uint256 lpNet,
        uint256 fee,
        address receiver
    ) internal {
        vault.settleExercise(
            ticketId,
            t.inventoryToken,
            fillAmt,
            payer,
            t.paymentToken,
            t.lp,
            lpNet,
            fee,
            receiver
        );
    }

    /// @inheritdoc ICommitmentManager
    function splitTicket(uint256 ticketId, uint256 splitAmount, address recipient)
        external
        override
        nonReentrant
        returns (uint256 newTicketId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (!ticketNft.isAuthorized(msg.sender, ticketId)) revert Unauthorized();

        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.ACTIVE) revert TicketNotActive();
        if (block.timestamp > t.expiresAt) revert TicketExpired();

        uint256 minAmt = t.minFillAmount;
        if (splitAmount == 0 || splitAmount < minAmt || splitAmount >= t.remainingAmount) {
            revert InvalidSplitAmount();
        }
        uint256 parentRem = t.remainingAmount - splitAmount;
        if (parentRem < minAmt) revert InvalidSplitAmount();

        if (t.complianceHook != address(0)) {
            address owner = ticketNft.ownerOf(ticketId);
            IComplianceHook(t.complianceHook).beforeTransfer(ticketId, owner, recipient);
        }

        t.remainingAmount = parentRem;
        newTicketId = nextTicketId++;
        _copySplitTicket(newTicketId, t, splitAmount);

        vault.splitTicketReserved(ticketId, newTicketId, t.inventoryToken, splitAmount);
        ticketNft.mint(recipient, newTicketId);

        emit TicketSplit(ticketId, newTicketId, recipient, splitAmount);
    }

    function _copySplitTicket(uint256 newTicketId, Ticket storage t, uint256 splitAmount) internal {
        _tickets[newTicketId] = Ticket({
            offerId: t.offerId,
            reservedAt: t.reservedAt,
            expiresAt: t.expiresAt,
            priceMode: t.priceMode,
            status: TicketStatus.ACTIVE,
            spreadBps: t.spreadBps,
            protocolFeeBps: t.protocolFeeBps,
            lp: t.lp,
            inventoryToken: t.inventoryToken,
            paymentToken: t.paymentToken,
            oracle: t.oracle,
            complianceHook: t.complianceHook,
            initialAmount: splitAmount,
            remainingAmount: splitAmount,
            minFillAmount: t.minFillAmount,
            fixedOrMinPriceX36: t.fixedOrMinPriceX36,
            maxPriceX36: t.maxPriceX36
        });
    }

    /// @inheritdoc ICommitmentManager
    function reclaimExpired(uint256 ticketId) external override nonReentrant {
        _reclaimExpired(ticketId);
    }

    /// @inheritdoc ICommitmentManager
    function reclaimExpiredBatch(uint256[] calldata ticketIds) external override nonReentrant {
        uint256 len = ticketIds.length;
        for (uint256 i = 0; i < len; ++i) {
            _reclaimExpired(ticketIds[i]);
        }
    }

    /// @inheritdoc ICommitmentManager
    function reclaimExpiredBatchBestEffort(uint256[] calldata ticketIds)
        external
        override
        nonReentrant
        returns (uint256 reclaimedCount)
    {
        uint256 len = ticketIds.length;
        for (uint256 i = 0; i < len; ++i) {
            uint256 id = ticketIds[i];
            Ticket storage t = _tickets[id];
            if (t.status == TicketStatus.ACTIVE && block.timestamp > t.expiresAt) {
                _reclaimExpired(id);
                unchecked {
                    ++reclaimedCount;
                }
            }
        }
    }

    function _reclaimExpired(uint256 ticketId) internal {
        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.ACTIVE) revert TicketNotActive();
        if (block.timestamp <= t.expiresAt) revert TicketNotExpired();

        uint256 rem = t.remainingAmount;
        t.remainingAmount = 0;
        t.status = TicketStatus.RECLAIMED;

        Offer storage o = _offers[t.offerId];
        bool returnToOffer = (o.status == OfferStatus.ACTIVE && block.timestamp < o.expiry);
        if (returnToOffer) {
            vault.releaseTicketToOffer(ticketId, t.offerId, t.inventoryToken, rem);
        } else {
            vault.releaseTicketToFree(ticketId, t.lp, t.inventoryToken, rem);
        }

        ticketNft.burn(ticketId);
        emit TicketReclaimed(ticketId, rem, returnToOffer);
    }

    function quoteReservation(uint64 offerId, uint256 inventoryAmount, uint32 duration)
        external
        view
        override
        returns (uint256 grossPremium, uint256 protocolFee)
    {
        Offer storage o = _offers[offerId];
        if (o.lp == address(0)) revert OfferNotActive();
        return _quoteReservation(o, inventoryAmount, duration);
    }

    function quoteExercise(uint256 ticketId, uint256 fillAmount)
        external
        view
        override
        returns (uint256 actualFill, uint256 grossPayment, uint256 effPriceX36)
    {
        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.ACTIVE) revert TicketNotActive();
        actualFill = fillAmount == 0 ? t.remainingAmount : fillAmount;
        (grossPayment,, effPriceX36) = _quoteExercise(t, actualFill);
    }

    function getOffer(uint64 offerId) external view override returns (Offer memory) {
        return _offers[offerId];
    }

    function getTicket(uint256 ticketId) external view override returns (Ticket memory) {
        return _tickets[ticketId];
    }

    function _quoteReservation(Offer storage o, uint256 inventoryAmount, uint32 duration)
        internal
        view
        returns (uint256 grossPremium, uint256 fee)
    {
        uint256 effPremiumBps =
            uint256(o.basePremiumBps) + Math.ceilDiv(uint256(o.dailyPremiumBps) * uint256(duration), 86_400);
        if (effPremiumBps == 0) return (0, 0);

        uint256 refPriceX36;
        if (o.priceMode == PriceMode.FIXED) {
            refPriceX36 = o.fixedPriceX36;
        } else {
            refPriceX36 = _resolveFloatingPrice(
                o.oracle, o.inventoryToken, o.paymentToken, o.spreadBps, o.minPriceX36, o.maxPriceX36
            );
        }

        uint256 notionalPay = Math.mulDiv(inventoryAmount, refPriceX36, PRICE_SCALE, Math.Rounding.Ceil);
        grossPremium = Math.mulDiv(notionalPay, effPremiumBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        fee = _computeFeeCeil(grossPremium, o.protocolFeeBps);
    }

    function _quoteExercise(Ticket storage t, uint256 fillAmount)
        internal
        view
        returns (uint256 grossPayment, uint256 fee, uint256 effPriceX36)
    {
        if (t.priceMode == PriceMode.FIXED) {
            effPriceX36 = t.fixedOrMinPriceX36;
        } else {
            effPriceX36 = _resolveFloatingPrice(
                t.oracle, t.inventoryToken, t.paymentToken, t.spreadBps, t.fixedOrMinPriceX36, t.maxPriceX36
            );
        }

        grossPayment = Math.mulDiv(fillAmount, effPriceX36, PRICE_SCALE, Math.Rounding.Ceil);
        fee = _computeFeeCeil(grossPayment, t.protocolFeeBps);
    }

    function _computeFeeCeil(uint256 gross, uint16 feeBps) internal pure returns (uint256 fee) {
        if (gross == 0 || feeBps == 0) return 0;
        fee = Math.mulDiv(gross, feeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        if (fee > gross) fee = gross;
    }

    function _resolveFloatingPrice(
        address oracle,
        address invToken,
        address payToken,
        int16 spreadBps,
        uint256 minPriceX36,
        uint256 maxPriceX36
    ) internal view returns (uint256 effPriceX36) {
        IPriceOracle.PriceQuote memory q = IPriceOracle(oracle).getPriceX36(invToken, payToken);
        if (!q.isValid || q.priceX36 == 0) revert OracleUnavailable();

        uint256 factor = uint256(int256(BPS_DENOMINATOR) + int256(spreadBps));
        effPriceX36 = Math.mulDiv(q.priceX36, factor, BPS_DENOMINATOR, Math.Rounding.Ceil);

        if (minPriceX36 > 0 && effPriceX36 < minPriceX36) {
            effPriceX36 = minPriceX36;
        }
        if (maxPriceX36 > 0 && effPriceX36 > maxPriceX36) {
            effPriceX36 = maxPriceX36;
        }
    }
}
