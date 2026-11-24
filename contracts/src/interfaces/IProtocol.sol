// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Core interfaces and shared types for Tranche
enum PriceMode {
    FIXED,
    FLOATING
}

enum OfferStatus {
    ACTIVE,
    PAUSED,
    CANCELLED
}

enum TicketStatus {
    NONE,
    ACTIVE,
    EXERCISED,
    RECLAIMED
}

struct Offer {
    address lp;
    uint40 createdAt;
    uint40 expiry;
    PriceMode priceMode;
    OfferStatus status;
    address inventoryToken;
    uint32 minDuration;
    uint32 maxDuration;
    uint16 basePremiumBps;
    uint16 dailyPremiumBps;
    address paymentToken;
    int16 spreadBps;
    uint16 protocolFeeBps;
    address oracle;
    address complianceHook;
    uint256 minFillAmount;
    uint256 fixedPriceX36;
    uint256 minPriceX36;
    uint256 maxPriceX36;
}

struct Ticket {
    uint64 offerId;
    uint40 reservedAt;
    uint40 expiresAt;
    PriceMode priceMode;
    TicketStatus status;
    int16 spreadBps;
    uint16 protocolFeeBps;
    address lp;
    address inventoryToken;
    address paymentToken;
    address oracle;
    address complianceHook;
    uint256 initialAmount;
    uint256 remainingAmount;
    uint256 minFillAmount;
    uint256 fixedOrMinPriceX36;
    uint256 maxPriceX36;
}

struct CreateOfferParams {
    address inventoryToken;
    address paymentToken;
    uint256 initialAmount;
    uint256 minFillAmount;
    uint40 expiry;
    uint32 minDuration;
    uint32 maxDuration;
    uint16 basePremiumBps;
    uint16 dailyPremiumBps;
    PriceMode priceMode;
    int16 spreadBps;
    address oracle;
    address complianceHook;
    uint256 fixedPriceX36;
    uint256 minPriceX36;
    uint256 maxPriceX36;
}

interface ILiquidityVault {
    function deposit(address token, uint256 amount) external;
    function depositFor(address lp, address token, uint256 amount) external;
    function withdrawFree(address token, uint256 amount, address to) external;
    function claimProceeds(address token, uint256 amount, address to) external;

    function allocateToOffer(address lp, address token, uint64 offerId, uint256 amount) external;
    function deallocateFromOffer(address lp, address token, uint64 offerId, uint256 amount) external;
    function reserveFromOffer(uint64 offerId, uint256 ticketId, address token, uint256 amount) external;
    function splitTicketReserved(uint256 fromTicketId, uint256 toTicketId, address token, uint256 splitAmount) external;
    function releaseTicketToOffer(uint256 ticketId, uint64 offerId, address token, uint256 amount) external;
    function releaseTicketToFree(uint256 ticketId, address lp, address token, uint256 amount) external;

    function collectFeeAndProceeds(
        address payer,
        address payToken,
        address lp,
        uint256 lpNetProceeds,
        uint256 protocolFee
    ) external;

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
    ) external;

    function withdrawProtocolFees(address token, address to) external;
    function setDepositsPaused(bool paused) external;

    function lpFreeBalance(address lp, address token) external view returns (uint256);
    function offerBalance(uint64 offerId) external view returns (uint256);
    function ticketReserved(uint256 ticketId) external view returns (uint256);
    function lpPendingProceeds(address lp, address token) external view returns (uint256);
    function protocolFees(address token) external view returns (uint256);

    function totalLpFree(address token) external view returns (uint256);
    function totalOfferAvailable(address token) external view returns (uint256);
    function totalReserved(address token) external view returns (uint256);
    function totalPendingProceeds(address token) external view returns (uint256);
}

interface IExecutionTicket {
    function mint(address to, uint256 ticketId) external;
    function burn(uint256 ticketId) external;
    function isAuthorized(address spender, uint256 ticketId) external view returns (bool);
    function ownerOf(uint256 ticketId) external view returns (address);
}

interface ICommitmentManager {
    function createOffer(CreateOfferParams calldata params) external returns (uint64 offerId);
    function topUpOffer(uint64 offerId, uint256 addAmount) external;
    function decreaseOffer(uint64 offerId, uint256 removeAmount) external;
    function pauseOffer(uint64 offerId) external;
    function unpauseOffer(uint64 offerId) external;
    function cancelOffer(uint64 offerId) external;

    function reserve(
        uint64 offerId,
        uint256 inventoryAmount,
        uint32 duration,
        uint256 maxPremiumIn,
        address recipient
    ) external returns (uint256 ticketId);

    function exercise(
        uint256 ticketId,
        uint256 fillAmount,
        uint256 maxPaymentIn,
        address receiver
    ) external returns (uint256 actualFill, uint256 grossPayment);

    function exerciseFor(
        uint256 ticketId,
        uint256 fillAmount,
        uint256 maxPaymentIn,
        address exerciser,
        address tokenReceiver,
        address finalReceiver
    ) external returns (uint256 actualFill, uint256 grossPayment);

    function splitTicket(
        uint256 ticketId,
        uint256 splitAmount,
        address recipient
    ) external returns (uint256 newTicketId);

    function reclaimExpired(uint256 ticketId) external;
    function reclaimExpiredBatch(uint256[] calldata ticketIds) external;
    function reclaimExpiredBatchBestEffort(uint256[] calldata ticketIds) external returns (uint256 reclaimedCount);

    function quoteReservation(uint64 offerId, uint256 inventoryAmount, uint32 duration)
        external
        view
        returns (uint256 grossPremium, uint256 protocolFee);

    function quoteExercise(uint256 ticketId, uint256 fillAmount)
        external
        view
        returns (uint256 actualFill, uint256 grossPayment, uint256 effPriceX36);

    function getOffer(uint64 offerId) external view returns (Offer memory);
    function getTicket(uint256 ticketId) external view returns (Ticket memory);
    function vault() external view returns (ILiquidityVault);
    function ticketNft() external view returns (IExecutionTicket);
}

interface IPriceOracle {
    struct PriceQuote {
        uint256 priceX36;
        uint256 updatedAt;
        bool isValid;
    }

    function getPriceX36(address inventoryToken, address paymentToken)
        external
        view
        returns (PriceQuote memory);
}

interface IComplianceHook {
    function beforeCreateOffer(address lp, address inventoryToken, address paymentToken) external view;
    function beforeReserve(uint64 offerId, address taker, address recipient, uint256 amount) external view;
    function beforeTransfer(uint256 ticketId, address from, address to) external view;
    function beforeExercise(uint256 ticketId, address exerciser, address receiver) external view;
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface INonfungiblePositionManager {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
