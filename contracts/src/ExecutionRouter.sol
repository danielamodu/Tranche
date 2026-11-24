// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICommitmentManager, IExecutionTicket, Ticket, IWETH9} from "./interfaces/IProtocol.sol";

/// @title ExecutionRouter
/// @notice Stateless batch aggregator for multi-ticket execution and native HSK/WHSK wrapping.
contract ExecutionRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ExerciseLeg {
        uint256 ticketId;
        uint256 fillAmount;
        uint256 maxLegPaymentIn;
    }

    struct BatchExerciseParams {
        address inventoryToken;
        address paymentToken;
        uint256 minTotalInventoryOut;
        uint256 maxTotalPaymentIn;
        uint256 deadline;
        address receiver;
        bool unwrapInventoryToNative;
        ExerciseLeg[] legs;
    }

    error ZeroAddress();
    error DeadlineExpired();
    error EmptyLegs();
    error InvalidNativePayment();
    error NotTicketAuthorized();
    error MismatchedTicketPair();
    error SlippageExceeded();
    error NativeTransferFailed();
    error UnauthorizedNativeSender();

    event BatchExercised(
        address indexed caller,
        address indexed receiver,
        uint256 totalInventoryOut,
        uint256 totalPaymentIn
    );

    ICommitmentManager public immutable manager;
    IExecutionTicket public immutable ticketNft;
    address public immutable vault;
    address public immutable whsk;

    constructor(address _manager, address _whsk) {
        if (_manager == address(0) || _whsk == address(0)) revert ZeroAddress();
        manager = ICommitmentManager(_manager);
        ticketNft = manager.ticketNft();
        vault = address(manager.vault());
        whsk = _whsk;
    }

    receive() external payable {
        if (msg.sender != whsk) revert UnauthorizedNativeSender();
    }

    function batchExercise(BatchExerciseParams calldata params)
        external
        payable
        nonReentrant
        returns (uint256 totalInventoryOut, uint256 totalPaymentIn)
    {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.legs.length == 0) revert EmptyLegs();
        if (params.receiver == address(0)) revert ZeroAddress();
        if (params.unwrapInventoryToNative && params.inventoryToken != whsk) revert MismatchedTicketPair();

        bool paidNative = msg.value > 0;
        if (paidNative) {
            if (params.paymentToken != whsk || msg.value != params.maxTotalPaymentIn) {
                revert InvalidNativePayment();
            }
            IWETH9(whsk).deposit{value: msg.value}();
        } else if (params.maxTotalPaymentIn > 0) {
            IERC20(params.paymentToken).safeTransferFrom(msg.sender, address(this), params.maxTotalPaymentIn);
        }

        IERC20(params.paymentToken).forceApprove(vault, params.maxTotalPaymentIn);
        address legReceiver = params.unwrapInventoryToNative ? address(this) : params.receiver;

        uint256 len = params.legs.length;
        for (uint256 i = 0; i < len; ++i) {
            ExerciseLeg calldata leg = params.legs[i];
            // Mandatory confused-deputy guard: verify msg.sender is authorized on EVERY leg
            if (!ticketNft.isAuthorized(msg.sender, leg.ticketId)) revert NotTicketAuthorized();

            Ticket memory t = manager.getTicket(leg.ticketId);
            if (t.inventoryToken != params.inventoryToken || t.paymentToken != params.paymentToken) {
                revert MismatchedTicketPair();
            }

            (uint256 filled, uint256 paid) =
                manager.exercise(leg.ticketId, leg.fillAmount, leg.maxLegPaymentIn, legReceiver);
            totalInventoryOut += filled;
            totalPaymentIn += paid;
        }

        if (totalInventoryOut < params.minTotalInventoryOut || totalPaymentIn > params.maxTotalPaymentIn) {
            revert SlippageExceeded();
        }

        // Reset residual vault allowance to 0 (INV-7)
        IERC20(params.paymentToken).forceApprove(vault, 0);

        uint256 unused = params.maxTotalPaymentIn - totalPaymentIn;
        if (unused > 0) {
            if (paidNative) {
                IWETH9(whsk).withdraw(unused);
                (bool ok,) = msg.sender.call{value: unused}("");
                if (!ok) revert NativeTransferFailed();
            } else {
                IERC20(params.paymentToken).safeTransfer(msg.sender, unused);
            }
        }

        if (params.unwrapInventoryToNative && totalInventoryOut > 0) {
            IWETH9(whsk).withdraw(totalInventoryOut);
            (bool ok,) = params.receiver.call{value: totalInventoryOut}("");
            if (!ok) revert NativeTransferFailed();
        }

        emit BatchExercised(msg.sender, params.receiver, totalInventoryOut, totalPaymentIn);
    }
}
