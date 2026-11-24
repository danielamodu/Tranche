// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPriceOracle} from "../interfaces/IProtocol.sol";

/// @title SignedPullOracle
/// @notice M-of-N threshold EIP-712 pull oracle with max-jump cap, internal TTL, and guardian price revocation.
contract SignedPullOracle is EIP712, Ownable2Step, IPriceOracle {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_JUMP_BPS_LIMIT = 5_000; // 50% ceiling

    error ZeroAddress();
    error Unauthorized();
    error AlreadySigner();
    error NotSigner();
    error InvalidThreshold();
    error ThresholdExceedsSignerCount();
    error InvalidMaxPriceAge();
    error InvalidMaxJumpBps();
    error InsufficientSignatures();
    error InvalidSigner();
    error UnsortedOrDuplicateSigner();
    error FutureTimestamp();
    error StaleTimestamp();
    error ZeroPrice();
    error MaxJumpExceeded();

    event GuardianUpdated(address indexed guardian);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdUpdated(uint256 threshold);
    event MaxPriceAgeUpdated(uint32 maxPriceAge);
    event MaxJumpBpsUpdated(address indexed inventoryToken, address indexed paymentToken, uint16 maxJumpBps);
    event PriceUpdated(
        address indexed inventoryToken,
        address indexed paymentToken,
        uint256 priceX36,
        uint256 reportTimestamp
    );
    event PriceRevoked(address indexed inventoryToken, address indexed paymentToken, address indexed caller);

    bytes32 public constant PRICE_REPORT_TYPEHASH = keccak256(
        "PriceReport(address inventoryToken,address paymentToken,uint256 priceX36,uint256 reportTimestamp)"
    );

    struct StoredPrice {
        uint256 priceX36;
        uint256 updatedAt;
    }

    address public guardian;
    uint32 public maxPriceAge;
    uint256 public signerCount;
    uint256 public threshold;

    mapping(address => bool) public isSigner;
    mapping(bytes32 => StoredPrice) internal _prices;
    mapping(bytes32 => uint16) public maxJumpBps;

    constructor(
        address _owner,
        address _guardian,
        address[] memory initialSigners,
        uint256 _threshold,
        uint32 _maxPriceAge
    ) EIP712("ProtocolSignedPullOracle", "2") Ownable(_owner) {
        if (_guardian == address(0)) revert ZeroAddress();
        if (_maxPriceAge == 0) revert InvalidMaxPriceAge();
        if (initialSigners.length == 0 || _threshold == 0 || _threshold > initialSigners.length) {
            revert InvalidThreshold();
        }

        guardian = _guardian;
        maxPriceAge = _maxPriceAge;
        threshold = _threshold;

        for (uint256 i = 0; i < initialSigners.length; ++i) {
            address s = initialSigners[i];
            if (s == address(0)) revert ZeroAddress();
            if (isSigner[s]) revert AlreadySigner();
            isSigner[s] = true;
            emit SignerAdded(s);
        }
        signerCount = initialSigners.length;

        emit GuardianUpdated(_guardian);
        emit MaxPriceAgeUpdated(_maxPriceAge);
        emit ThresholdUpdated(_threshold);
    }

    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ZeroAddress();
        guardian = _guardian;
        emit GuardianUpdated(_guardian);
    }

    function addSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        if (isSigner[signer]) revert AlreadySigner();
        isSigner[signer] = true;
        unchecked {
            ++signerCount;
        }
        emit SignerAdded(signer);
    }

    function removeSigner(address signer) external onlyOwner {
        if (!isSigner[signer]) revert NotSigner();
        if (signerCount - 1 < threshold) revert ThresholdExceedsSignerCount();
        isSigner[signer] = false;
        unchecked {
            --signerCount;
        }
        emit SignerRemoved(signer);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0 || newThreshold > signerCount) revert InvalidThreshold();
        threshold = newThreshold;
        emit ThresholdUpdated(newThreshold);
    }

    function setMaxPriceAge(uint32 newMaxPriceAge) external onlyOwner {
        if (newMaxPriceAge == 0) revert InvalidMaxPriceAge();
        maxPriceAge = newMaxPriceAge;
        emit MaxPriceAgeUpdated(newMaxPriceAge);
    }

    function setMaxJumpBps(address inventoryToken, address paymentToken, uint16 _maxJumpBps) external onlyOwner {
        if (inventoryToken == address(0) || paymentToken == address(0)) revert ZeroAddress();
        if (_maxJumpBps > MAX_JUMP_BPS_LIMIT) revert InvalidMaxJumpBps();
        bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        maxJumpBps[pairKey] = _maxJumpBps;
        emit MaxJumpBpsUpdated(inventoryToken, paymentToken, _maxJumpBps);
    }

    function revokePrice(address inventoryToken, address paymentToken) external {
        if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized();
        bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        // Clear priceX36 while preserving updatedAt so earlier signed reports cannot be replayed.
        _prices[pairKey].priceX36 = 0;
        emit PriceRevoked(inventoryToken, paymentToken, msg.sender);
    }

    function updatePrice(
        address inventoryToken,
        address paymentToken,
        uint256 priceX36,
        uint256 reportTimestamp,
        bytes[] calldata signatures
    ) external {
        if (inventoryToken == address(0) || paymentToken == address(0)) revert ZeroAddress();
        if (priceX36 == 0) revert ZeroPrice();
        if (reportTimestamp > block.timestamp) revert FutureTimestamp();

        bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        StoredPrice memory prev = _prices[pairKey];
        if (reportTimestamp <= prev.updatedAt) revert StaleTimestamp();
        if (signatures.length < threshold) revert InsufficientSignatures();

        bytes32 structHash = keccak256(
            abi.encode(PRICE_REPORT_TYPEHASH, inventoryToken, paymentToken, priceX36, reportTimestamp)
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        address prevSigner = address(0);
        uint256 len = signatures.length;
        for (uint256 i = 0; i < len; ++i) {
            address recovered = ECDSA.recover(digest, signatures[i]);
            if (!isSigner[recovered]) revert InvalidSigner();
            if (recovered <= prevSigner) revert UnsortedOrDuplicateSigner();
            prevSigner = recovered;
        }

        uint16 jumpCap = maxJumpBps[pairKey];
        if (jumpCap > 0 && prev.priceX36 > 0) {
            uint256 diff = priceX36 > prev.priceX36 ? priceX36 - prev.priceX36 : prev.priceX36 - priceX36;
            if ((diff * BPS_DENOMINATOR) / prev.priceX36 > jumpCap) {
                revert MaxJumpExceeded();
            }
        }

        _prices[pairKey] = StoredPrice({priceX36: priceX36, updatedAt: reportTimestamp});
        emit PriceUpdated(inventoryToken, paymentToken, priceX36, reportTimestamp);
    }

    function getPriceX36(address inventoryToken, address paymentToken)
        external
        view
        override
        returns (PriceQuote memory)
    {
        bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        StoredPrice memory p = _prices[pairKey];
        if (p.priceX36 == 0 || p.updatedAt > block.timestamp || block.timestamp - p.updatedAt > maxPriceAge) {
            return PriceQuote({priceX36: 0, updatedAt: p.updatedAt, isValid: false});
        }
        return PriceQuote({priceX36: p.priceX36, updatedAt: p.updatedAt, isValid: true});
    }
}
