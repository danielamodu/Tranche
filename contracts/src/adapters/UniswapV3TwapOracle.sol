// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle, IUniswapV3Pool} from "../interfaces/IProtocol.sol";

/// @title UniswapV3TwapOracle
/// @notice Permissionless HSKSwap V3 TWAP reader with observationCardinality guard.
/// @dev Intended as a secondary circuit breaker on deep pools (e.g. WHSK/USDT), NOT sole fast oracle on thin pools.
contract UniswapV3TwapOracle is IPriceOracle {
    uint256 public constant PRICE_SCALE = 1e36;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    error ZeroAddress();
    error Unauthorized();
    error InvalidWindow();
    error UnsupportedPair();

    struct PoolConfig {
        address pool;
        uint32 twapWindow;
        uint16 minCardinality;
        bool invIsToken0;
    }

    address public immutable admin;
    mapping(bytes32 => PoolConfig) public poolConfigs;

    constructor() {
        admin = msg.sender;
    }

    function setPoolConfig(
        address inventoryToken,
        address paymentToken,
        address pool,
        uint32 twapWindow,
        uint16 minCardinality
    ) external {
        if (msg.sender != admin) revert Unauthorized();
        if (pool == address(0)) revert ZeroAddress();
        if (twapWindow == 0) revert InvalidWindow();

        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        bool invIsToken0;
        if (inventoryToken == t0 && paymentToken == t1) {
            invIsToken0 = true;
        } else if (inventoryToken == t1 && paymentToken == t0) {
            invIsToken0 = false;
        } else {
            revert UnsupportedPair();
        }

        bytes32 key = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        poolConfigs[key] = PoolConfig({
            pool: pool,
            twapWindow: twapWindow,
            minCardinality: minCardinality,
            invIsToken0: invIsToken0
        });
    }

    function getPriceX36(address inventoryToken, address paymentToken)
        external
        view
        override
        returns (PriceQuote memory)
    {
        bytes32 key = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        PoolConfig memory cfg = poolConfigs[key];
        if (cfg.pool == address(0)) {
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }

        (,,, uint16 cardinality,,,) = IUniswapV3Pool(cfg.pool).slot0();
        if (cardinality < cfg.minCardinality) {
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = cfg.twapWindow;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(cfg.pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives,
            uint160[] memory
        ) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int24 meanTick = int24(delta / int56(uint56(cfg.twapWindow)));
            if (delta < 0 && (delta % int56(uint56(cfg.twapWindow)) != 0)) {
                meanTick--;
            }
            uint160 sqrtPriceX96 = _getSqrtRatioAtTick(meanTick);
            uint256 priceX36 = _sqrtPriceToPriceX36(sqrtPriceX96, cfg.invIsToken0);
            return PriceQuote({priceX36: priceX36, updatedAt: block.timestamp, isValid: priceX36 > 0});
        } catch {
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }
    }

    function _sqrtPriceToPriceX36(uint160 sqrtPriceX96, bool invIsToken0) internal pure returns (uint256) {
        if (invIsToken0) {
            if (sqrtPriceX96 <= type(uint128).max) {
                uint256 ratioX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
                return Math.mulDiv(ratioX192, PRICE_SCALE, 1 << 192);
            }
            uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
            return Math.mulDiv(ratioX128, PRICE_SCALE, 1 << 128);
        } else {
            if (sqrtPriceX96 <= type(uint128).max) {
                uint256 ratioX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
                return Math.mulDiv(1 << 192, PRICE_SCALE, ratioX192);
            }
            uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
            return Math.mulDiv(1 << 128, PRICE_SCALE, ratioX128);
        }
    }

    /// @dev Standard Uniswap V3 TickMath.getSqrtRatioAtTick
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert InvalidWindow();

            uint256 ratio =
                (absTick & 0x1 != 0) ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
