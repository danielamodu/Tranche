// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IComplianceHook} from "../interfaces/IProtocol.sol";

/// @title HSPComplianceHook
/// @notice Optional view-only compliance/KYC hook supporting allowlist and revocable EIP-712 HSP attestations.
/// @dev Never called on LiquidityVault withdrawals, LP proceeds claims, offer cancellations, or expired ticket reclaims.
contract HSPComplianceHook is EIP712, Ownable2Step, IComplianceHook {
    error ZeroAddress();
    error AttestationExpired();
    error InvalidNonce();
    error InvalidAttestationSigner();
    error NotCompliant(address subject);

    event AttestationSignerUpdated(address indexed signer);
    event SubjectStatusSet(address indexed subject, uint256 validUntil);
    event SubjectRevoked(address indexed subject);

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("ComplianceAttestation(address subject,uint256 nonce,uint256 expiry)");

    address public attestationSigner;

    mapping(address => uint256) public validUntil;
    mapping(address => uint256) public nonces;

    constructor(address _owner, address _attestationSigner)
        EIP712("ProtocolHSPCompliance", "1")
        Ownable(_owner)
    {
        if (_attestationSigner == address(0)) revert ZeroAddress();
        attestationSigner = _attestationSigner;
    }

    function setAttestationSigner(address _signer) external onlyOwner {
        if (_signer == address(0)) revert ZeroAddress();
        attestationSigner = _signer;
        emit AttestationSignerUpdated(_signer);
    }

    function setApproved(address subject, uint256 expiry) external onlyOwner {
        if (subject == address(0)) revert ZeroAddress();
        validUntil[subject] = expiry;
        emit SubjectStatusSet(subject, expiry);
    }

    function revoke(address subject) external onlyOwner {
        validUntil[subject] = 0;
        nonces[subject]++;
        emit SubjectRevoked(subject);
    }

    function submitAttestation(address subject, uint256 nonce, uint256 expiry, bytes calldata signature) external {
        if (subject == address(0)) revert ZeroAddress();
        if (block.timestamp > expiry) revert AttestationExpired();
        if (nonce != nonces[subject]) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, subject, nonce, expiry));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != attestationSigner) revert InvalidAttestationSigner();

        nonces[subject] = nonce + 1;
        validUntil[subject] = expiry;
        emit SubjectStatusSet(subject, expiry);
    }

    function isCompliant(address subject) public view returns (bool) {
        return validUntil[subject] >= block.timestamp;
    }

    function beforeCreateOffer(address lp, address, address) external view override {
        if (!isCompliant(lp)) revert NotCompliant(lp);
    }

    function beforeReserve(uint64, address taker, address recipient, uint256) external view override {
        if (!isCompliant(taker)) revert NotCompliant(taker);
        if (!isCompliant(recipient)) revert NotCompliant(recipient);
    }

    function beforeTransfer(uint256, address from, address to) external view override {
        if (!isCompliant(from)) revert NotCompliant(from);
        if (!isCompliant(to)) revert NotCompliant(to);
    }

    function beforeExercise(uint256, address exerciser, address receiver) external view override {
        if (!isCompliant(exerciser)) revert NotCompliant(exerciser);
        if (!isCompliant(receiver)) revert NotCompliant(receiver);
    }
}
