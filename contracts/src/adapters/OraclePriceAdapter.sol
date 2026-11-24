// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IProtocol.sol";

/// @title OraclePriceAdapter
/// @notice Enforces staleness limits, hard price bounds, and cross-feed deviation circuit breakers.
contract OraclePriceAdapter is IPriceOracle {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    error Unauthorized();
    error InvalidConfig();

    struct PairConfig {
        address primaryFeed;
        address secondaryFeed;
        uint32 maxStaleness;
        uint16 maxDeviationBps;
        bool allowSecondaryFallback;
        uint256 hardMinPriceX36;
        uint256 hardMaxPriceX36;
    }

    address public immutable admin;
    mapping(bytes32 => PairConfig) public pairConfigs;

    constructor() {
        admin = msg.sender;
    }

    function setPairConfig(address inventoryToken, address paymentToken, PairConfig calldata cfg) external {
        if (msg.sender != admin) revert Unauthorized();
        if (cfg.primaryFeed == address(0) || cfg.maxStaleness == 0) revert InvalidConfig();
        if (cfg.hardMaxPriceX36 > 0 && cfg.hardMinPriceX36 > cfg.hardMaxPriceX36) revert InvalidConfig();

        bytes32 key = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        pairConfigs[key] = cfg;
    }

    function getPriceX36(address inventoryToken, address paymentToken)
        external
        view
        override
        returns (PriceQuote memory)
    {
        bytes32 key = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        PairConfig memory cfg = pairConfigs[key];
        if (cfg.primaryFeed == address(0)) {
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }

        (bool pOk, PriceQuote memory p) = _readAndValidate(cfg.primaryFeed, inventoryToken, paymentToken, cfg);

        if (cfg.secondaryFeed != address(0)) {
            (bool sOk, PriceQuote memory s) = _readAndValidate(cfg.secondaryFeed, inventoryToken, paymentToken, cfg);
            if (pOk && sOk) {
                uint256 minP = p.priceX36 < s.priceX36 ? p.priceX36 : s.priceX36;
                uint256 diff = p.priceX36 > s.priceX36 ? p.priceX36 - s.priceX36 : s.priceX36 - p.priceX36;
                if (cfg.maxDeviationBps > 0 && (diff * BPS_DENOMINATOR) / minP > cfg.maxDeviationBps) {
                    return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
                }
                return p;
            }
            if (!pOk && cfg.allowSecondaryFallback && sOk) {
                return s;
            }
            if (pOk && !sOk) {
                // Primary is healthy while secondary (e.g. thin TWAP) is unavailable
                return p;
            }
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }

        if (pOk) return p;
        return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
    }

    function _readAndValidate(
        address feed,
        address invToken,
        address payToken,
        PairConfig memory cfg
    ) internal view returns (bool ok, PriceQuote memory q) {
        try IPriceOracle(feed).getPriceX36(invToken, payToken) returns (PriceQuote memory res) {
            if (!res.isValid || res.priceX36 == 0) return (false, q);
            if (res.updatedAt > block.timestamp) return (false, q);
            if (block.timestamp - res.updatedAt > cfg.maxStaleness) return (false, q);
            if (cfg.hardMinPriceX36 > 0 && res.priceX36 < cfg.hardMinPriceX36) return (false, q);
            if (cfg.hardMaxPriceX36 > 0 && res.priceX36 > cfg.hardMaxPriceX36) return (false, q);
            return (true, res);
        } catch {
            return (false, q);
        }
    }
}
