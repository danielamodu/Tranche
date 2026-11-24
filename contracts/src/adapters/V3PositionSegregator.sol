// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILiquidityVault, INonfungiblePositionManager} from "../interfaces/IProtocol.sol";

/// @title V3PositionSegregator
/// @notice Stateless periphery adapter that withdraws liquidity and/or accrued fees from an HSKSwap V3 LP NFT
///         and segregates the resulting ERC-20 tokens into LiquidityVault.
contract V3PositionSegregator is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct WithdrawAndSegregateParams {
        uint256 tokenId;
        uint128 liquidityToWithdraw; // 0 = withdraw full position liquidity (or fee-only if posLiquidity == 0)
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        bool depositToken0;
        bool depositToken1;
    }

    error ZeroAddress();
    error NotPositionOwner();
    error ZeroLiquidity();
    error NothingCollected();

    event PositionSegregated(
        address indexed lp,
        uint256 indexed tokenId,
        uint128 liquidityWithdrawn,
        address token0,
        uint256 amount0,
        bool deposited0,
        address token1,
        uint256 amount1,
        bool deposited1
    );

    INonfungiblePositionManager public immutable nfpm;
    ILiquidityVault public immutable vault;

    constructor(address _nfpm, address _vault) {
        if (_nfpm == address(0) || _vault == address(0)) revert ZeroAddress();
        nfpm = INonfungiblePositionManager(_nfpm);
        vault = ILiquidityVault(_vault);
    }

    /// @notice Withdraws liquidity + accrued fees (or fees alone when posLiquidity == 0) from an HSKSwap V3 NFT
    ///         approved to this adapter and segregates chosen tokens into LiquidityVault for `msg.sender`.
    function withdrawAndSegregate(WithdrawAndSegregateParams calldata p)
        external
        nonReentrant
        returns (uint256 collected0, uint256 collected1)
    {
        if (nfpm.ownerOf(p.tokenId) != msg.sender) revert NotPositionOwner();

        (,, address token0, address token1,,,, uint128 posLiquidity,,,,) = nfpm.positions(p.tokenId);
        uint128 liq = p.liquidityToWithdraw == 0 ? posLiquidity : p.liquidityToWithdraw;
        if (liq > posLiquidity) revert ZeroLiquidity();

        if (liq > 0) {
            nfpm.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: p.tokenId,
                    liquidity: liq,
                    amount0Min: p.amount0Min,
                    amount1Min: p.amount1Min,
                    deadline: p.deadline
                })
            );
        }

        (collected0, collected1) = nfpm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: p.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        if (collected0 == 0 && collected1 == 0) revert NothingCollected();

        if (collected0 > 0) {
            if (p.depositToken0) {
                IERC20(token0).forceApprove(address(vault), collected0);
                vault.depositFor(msg.sender, token0, collected0);
                IERC20(token0).forceApprove(address(vault), 0);
            } else {
                IERC20(token0).safeTransfer(msg.sender, collected0);
            }
        }

        if (collected1 > 0) {
            if (p.depositToken1) {
                IERC20(token1).forceApprove(address(vault), collected1);
                vault.depositFor(msg.sender, token1, collected1);
                IERC20(token1).forceApprove(address(vault), 0);
            } else {
                IERC20(token1).safeTransfer(msg.sender, collected1);
            }
        }

        emit PositionSegregated(
            msg.sender,
            p.tokenId,
            liq,
            token0,
            collected0,
            p.depositToken0,
            token1,
            collected1,
            p.depositToken1
        );
    }
}
