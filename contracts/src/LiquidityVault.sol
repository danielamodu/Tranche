// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILiquidityVault} from "./interfaces/IProtocol.sol";

/// @title LiquidityVault
/// @notice Segregated 1:1 ERC-20 custody vault enforcing strict bucket accounting and pull-based LP proceeds.
contract LiquidityVault is ILiquidityVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error Unauthorized();
    error ManagerAlreadySet();
    error DepositsPaused();
    error InsufficientBalance();
    error UnsupportedTokenBalanceDelta();

    event ManagerSet(address indexed manager);
    event GuardianUpdated(address indexed guardian);
    event FeeCollectorUpdated(address indexed feeCollector);
    event DepositsPausedSet(bool paused);
    event Deposited(address indexed lp, address indexed token, uint256 amount);
    event WithdrawnFree(address indexed lp, address indexed token, address indexed to, uint256 amount);
    event ProceedsClaimed(address indexed lp, address indexed token, address indexed to, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    address public immutable admin;
    address public manager;
    address public guardian;
    address public feeCollector;
    bool public depositsPaused;

    // lp => token => amount
    mapping(address => mapping(address => uint256)) public override lpFreeBalance;
    // offerId => amount
    mapping(uint64 => uint256) public override offerBalance;
    // ticketId => amount
    mapping(uint256 => uint256) public override ticketReserved;
    // lp => token => amount
    mapping(address => mapping(address => uint256)) public override lpPendingProceeds;
    // token => amount
    mapping(address => uint256) public override protocolFees;

    // O(1) global per-token bucket totals
    mapping(address => uint256) public override totalLpFree;
    mapping(address => uint256) public override totalOfferAvailable;
    mapping(address => uint256) public override totalReserved;
    mapping(address => uint256) public override totalPendingProceeds;

    modifier onlyManager() {
        if (msg.sender != manager) revert Unauthorized();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(address _guardian, address _feeCollector) {
        if (_guardian == address(0) || _feeCollector == address(0)) revert ZeroAddress();
        admin = msg.sender;
        guardian = _guardian;
        feeCollector = _feeCollector;
    }

    function setManager(address _manager) external onlyAdmin {
        if (manager != address(0)) revert ManagerAlreadySet();
        if (_manager == address(0)) revert ZeroAddress();
        manager = _manager;
        emit ManagerSet(_manager);
    }

    function setGuardian(address _guardian) external onlyAdmin {
        if (_guardian == address(0)) revert ZeroAddress();
        guardian = _guardian;
        emit GuardianUpdated(_guardian);
    }

    function setFeeCollector(address _feeCollector) external onlyAdmin {
        if (_feeCollector == address(0)) revert ZeroAddress();
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    function setDepositsPaused(bool paused) external override {
        if (msg.sender != guardian && msg.sender != admin) revert Unauthorized();
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    /// @inheritdoc ILiquidityVault
    function deposit(address token, uint256 amount) external override nonReentrant {
        _deposit(msg.sender, token, amount);
    }

    /// @inheritdoc ILiquidityVault
    function depositFor(address lp, address token, uint256 amount) external override nonReentrant {
        _deposit(lp, token, amount);
    }

    function _deposit(address lp, address token, uint256 amount) internal {
        if (depositsPaused) revert DepositsPaused();
        if (lp == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _pullExact(token, msg.sender, amount);
        lpFreeBalance[lp][token] += amount;
        totalLpFree[token] += amount;

        emit Deposited(lp, token, amount);
    }

    /// @inheritdoc ILiquidityVault
    /// @dev Never paused, never gated by compliance hooks.
    function withdrawFree(address token, uint256 amount, address to) external override nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 bal = lpFreeBalance[msg.sender][token];
        if (bal < amount) revert InsufficientBalance();

        unchecked {
            lpFreeBalance[msg.sender][token] = bal - amount;
            totalLpFree[token] -= amount;
        }
        IERC20(token).safeTransfer(to, amount);

        emit WithdrawnFree(msg.sender, token, to, amount);
    }

    /// @inheritdoc ILiquidityVault
    /// @dev Never paused, never gated by compliance hooks. amount == 0 claims full pending proceeds.
    function claimProceeds(address token, uint256 amount, address to) external override nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();

        uint256 bal = lpPendingProceeds[msg.sender][token];
        uint256 claimAmt = amount == 0 ? bal : amount;
        if (claimAmt == 0) revert ZeroAmount();
        if (bal < claimAmt) revert InsufficientBalance();

        unchecked {
            lpPendingProceeds[msg.sender][token] = bal - claimAmt;
            totalPendingProceeds[token] -= claimAmt;
        }
        IERC20(token).safeTransfer(to, claimAmt);

        emit ProceedsClaimed(msg.sender, token, to, claimAmt);
    }

    /// @inheritdoc ILiquidityVault
    function allocateToOffer(address lp, address token, uint64 offerId, uint256 amount)
        external
        override
        onlyManager
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = lpFreeBalance[lp][token];
        if (bal < amount) revert InsufficientBalance();

        unchecked {
            lpFreeBalance[lp][token] = bal - amount;
            totalLpFree[token] -= amount;
        }
        offerBalance[offerId] += amount;
        totalOfferAvailable[token] += amount;
    }

    /// @inheritdoc ILiquidityVault
    function deallocateFromOffer(address lp, address token, uint64 offerId, uint256 amount)
        external
        override
        onlyManager
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = offerBalance[offerId];
        if (bal < amount) revert InsufficientBalance();

        unchecked {
            offerBalance[offerId] = bal - amount;
            totalOfferAvailable[token] -= amount;
        }
        lpFreeBalance[lp][token] += amount;
        totalLpFree[token] += amount;
    }

    /// @inheritdoc ILiquidityVault
    function reserveFromOffer(uint64 offerId, uint256 ticketId, address token, uint256 amount)
        external
        override
        onlyManager
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = offerBalance[offerId];
        if (bal < amount) revert InsufficientBalance();

        unchecked {
            offerBalance[offerId] = bal - amount;
            totalOfferAvailable[token] -= amount;
        }
        ticketReserved[ticketId] += amount;
        totalReserved[token] += amount;
    }

    /// @inheritdoc ILiquidityVault
    function splitTicketReserved(uint256 fromTicketId, uint256 toTicketId, address, uint256 splitAmount)
        external
        override
        onlyManager
        nonReentrant
    {
        if (splitAmount == 0) revert ZeroAmount();
        uint256 bal = ticketReserved[fromTicketId];
        if (bal < splitAmount) revert InsufficientBalance();

        unchecked {
            ticketReserved[fromTicketId] = bal - splitAmount;
        }
        ticketReserved[toTicketId] += splitAmount;
    }

    /// @inheritdoc ILiquidityVault
    function releaseTicketToOffer(uint256 ticketId, uint64 offerId, address token, uint256 amount)
        external
        override
        onlyManager
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = ticketReserved[ticketId];
        if (bal < amount) revert InsufficientBalance();

        unchecked {
            ticketReserved[ticketId] = bal - amount;
            totalReserved[token] -= amount;
        }
        offerBalance[offerId] += amount;
        totalOfferAvailable[token] += amount;
    }

    /// @inheritdoc ILiquidityVault
    function releaseTicketToFree(uint256 ticketId, address lp, address token, uint256 amount)
        external
        override
        onlyManager
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = ticketReserved[ticketId];
        if (bal < amount) revert InsufficientBalance();

        unchecked {
            ticketReserved[ticketId] = bal - amount;
            totalReserved[token] -= amount;
        }
        lpFreeBalance[lp][token] += amount;
        totalLpFree[token] += amount;
    }

    /// @inheritdoc ILiquidityVault
    function collectFeeAndProceeds(
        address payer,
        address payToken,
        address lp,
        uint256 lpNetProceeds,
        uint256 protocolFee
    ) external override onlyManager nonReentrant {
        _creditPayment(payer, payToken, lp, lpNetProceeds, protocolFee);
    }

    /// @inheritdoc ILiquidityVault
    function settleExercise(
        uint256 ticketId,
        address invToken,
        uint256 invAmount,
        address payer,
        address payToken,
        address lp,
        uint256 lpNetProceeds,
        uint256 protocolFee,
        address receiver
    ) external override onlyManager nonReentrant {
        if (invAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 res = ticketReserved[ticketId];
        if (res < invAmount) revert InsufficientBalance();
        unchecked {
            ticketReserved[ticketId] = res - invAmount;
            totalReserved[invToken] -= invAmount;
        }

        _creditPayment(payer, payToken, lp, lpNetProceeds, protocolFee);
        IERC20(invToken).safeTransfer(receiver, invAmount);
    }

    /// @inheritdoc ILiquidityVault
    function withdrawProtocolFees(address token, address to) external override nonReentrant {
        if (msg.sender != feeCollector) revert Unauthorized();
        if (token == address(0) || to == address(0)) revert ZeroAddress();

        uint256 amount = protocolFees[token];
        if (amount == 0) revert ZeroAmount();
        protocolFees[token] = 0;

        IERC20(token).safeTransfer(to, amount);
        emit ProtocolFeesWithdrawn(token, to, amount);
    }

    function _creditPayment(
        address payer,
        address payToken,
        address lp,
        uint256 lpNetProceeds,
        uint256 protocolFee
    ) internal {
        uint256 total = lpNetProceeds + protocolFee;
        if (total == 0) return;

        _pullExact(payToken, payer, total);
        if (lpNetProceeds > 0) {
            lpPendingProceeds[lp][payToken] += lpNetProceeds;
            totalPendingProceeds[payToken] += lpNetProceeds;
        }
        if (protocolFee > 0) {
            protocolFees[payToken] += protocolFee;
        }
    }

    function _pullExact(address token, address from, uint256 amount) internal {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 balAfter = IERC20(token).balanceOf(address(this));
        if (balAfter < balBefore || balAfter - balBefore != amount) {
            revert UnsupportedTokenBalanceDelta();
        }
    }
}
