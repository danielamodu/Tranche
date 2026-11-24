// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {
    IExecutionTicket,
    ICommitmentManager,
    IComplianceHook,
    Ticket,
    PriceMode
} from "./interfaces/IProtocol.sol";

/// @title ExecutionTicket
/// @notice Transferable ERC-721 representing an inventory-backed execution commitment right.
contract ExecutionTicket is ERC721, EIP712, IExecutionTicket {
    using Strings for uint256;
    using Strings for uint64;
    using Strings for uint40;

    error Unauthorized();
    error ZeroAddress();
    error PermitExpired();
    error InvalidSignature();

    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)");

    address public immutable manager;
    mapping(uint256 => uint256) public nonces;

    modifier onlyManager() {
        if (msg.sender != manager) revert Unauthorized();
        _;
    }

    constructor(address _manager) ERC721("Execution Ticket", "EXET") EIP712("Execution Ticket", "1") {
        if (_manager == address(0)) revert ZeroAddress();
        manager = _manager;
    }

    function mint(address to, uint256 ticketId) external override onlyManager {
        // Uses _mint (not _safeMint) to eliminate onERC721Received reentrancy.
        _mint(to, ticketId);
    }

    function burn(uint256 ticketId) external override onlyManager {
        _burn(ticketId);
    }

    function isAuthorized(address spender, uint256 ticketId) external view override returns (bool) {
        address owner = _ownerOf(ticketId);
        if (owner == address(0)) return false;
        return _isAuthorized(owner, spender, ticketId);
    }

    function ownerOf(uint256 ticketId) public view override(ERC721, IExecutionTicket) returns (address) {
        return super.ownerOf(ticketId);
    }

    function permit(
        address spender,
        uint256 tokenId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();
        address owner = ownerOf(tokenId);

        uint256 nonce = nonces[tokenId]++;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, spender, tokenId, nonce, deadline));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        if (signer != owner && !isApprovedForAll(owner, signer)) revert InvalidSignature();

        _approve(spender, tokenId, address(0), true);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            // Invalidate unused permit signatures across ownership transfers (M-02 / EIP-4494)
            unchecked {
                nonces[tokenId]++;
            }
            Ticket memory t = ICommitmentManager(manager).getTicket(tokenId);
            if (t.complianceHook != address(0)) {
                IComplianceHook(t.complianceHook).beforeTransfer(tokenId, from, to);
            }
        }
        return super._update(to, tokenId, auth);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Ticket memory t = ICommitmentManager(manager).getTicket(tokenId);
        string memory modeStr = t.priceMode == PriceMode.FIXED ? "FIXED" : "FLOATING";

        string memory json = string.concat(
            '{"name":"Execution Ticket #',
            tokenId.toString(),
            '","description":"Inventory-backed time-bounded execution commitment.","attributes":[',
            '{"trait_type":"Offer ID","value":"',
            t.offerId.toString(),
            '"},{"trait_type":"Mode","value":"',
            modeStr,
            '"},{"trait_type":"Remaining Raw","value":"',
            t.remainingAmount.toString(),
            '"},{"trait_type":"Expires At","value":',
            t.expiresAt.toString(),
            "}]}"
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
