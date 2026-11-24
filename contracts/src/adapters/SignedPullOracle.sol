// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPriceOracle} from "../interfaces/IProtocol.sol";

/// @title SignedPullOracle
/// @notice Low-latency (<= 30s) EIP-712 signed pull oracle for HashKey Chain where public push feeds are absent.
contract SignedPullOracle is EIP712, IPriceOracle {
    error ZeroAddress();
    error Unauthorized();
    error InvalidSigner();
    error FutureTimestamp();
    error StaleTimestamp();
    error ZeroPrice();

    event SignerUpdated(address indexed signer);
    event PriceUpdated(
        address indexed inventoryToken,
        address indexed paymentToken,
        uint256 priceX36,
        uint256 reportTimestamp
    );

    bytes32 public constant PRICE_REPORT_TYPEHASH = keccak256(
        "PriceReport(address inventoryToken,address paymentToken,uint256 priceX36,uint256 reportTimestamp)"
    );

    address public immutable admin;
    address public authorizedSigner;

    struct StoredPrice {
        uint256 priceX36;
        uint256 updatedAt;
    }

    mapping(bytes32 => StoredPrice) internal _prices;

    constructor(address _authorizedSigner) EIP712("ProtocolSignedPullOracle", "1") {
        if (_authorizedSigner == address(0)) revert ZeroAddress();
        admin = msg.sender;
        authorizedSigner = _authorizedSigner;
    }

    function setAuthorizedSigner(address _signer) external {
        if (msg.sender != admin) revert Unauthorized();
        if (_signer == address(0)) revert ZeroAddress();
        authorizedSigner = _signer;
        emit SignerUpdated(_signer);
    }

    function updatePrice(
        address inventoryToken,
        address paymentToken,
        uint256 priceX36,
        uint256 reportTimestamp,
        bytes calldata signature
    ) external {
        if (priceX36 == 0) revert ZeroPrice();
        if (reportTimestamp > block.timestamp) revert FutureTimestamp();

        bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
        if (reportTimestamp <= _prices[pairKey].updatedAt) revert StaleTimestamp();

        bytes32 structHash = keccak256(
            abi.encode(PRICE_REPORT_TYPEHASH, inventoryToken, paymentToken, priceX36, reportTimestamp)
        );
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != authorizedSigner) revert InvalidSigner();

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
        if (p.priceX36 == 0) {
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }
        return PriceQuote({priceX36: p.priceX36, updatedAt: p.updatedAt, isValid: true});
    }
}
