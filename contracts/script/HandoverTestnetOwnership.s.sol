// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISafeL2} from "./DeployTestnet.s.sol";

/// @title HandoverTestnetOwnership
/// @notice Completes Ownable2Step ownership acceptance across all 6 admin-gated Tranche contracts
///         via the 3-of-5 Governance Safe + TimelockController and renounces deployer DEFAULT_ADMIN_ROLE.
contract HandoverTestnetOwnership is Script {
    bytes32 public constant HANDOVER_SALT = keccak256("tranche.testnet.ownership.handover.v1");

    error SafeExecFailed();
    error OwnerMismatch(address target, address actual, address expected);
    error DeployerStillAdmin();

    function scheduleHandover() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address govSafe = vm.envAddress("GOV_SAFE_ADDRESS");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));
        uint256[] memory govPks = _loadGovSignerPks();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _loadTargets();

        uint256 delay = timelock.getMinDelay();
        bytes memory data = abi.encodeWithSelector(
            timelock.scheduleBatch.selector,
            targets,
            values,
            payloads,
            bytes32(0),
            HANDOVER_SALT,
            delay
        );

        vm.startBroadcast(deployerPk);
        _execSafeTx(govSafe, govPks, address(timelock), data);
        vm.stopBroadcast();

        console2.log("Scheduled 6-contract acceptOwnership batch via Gov Safe. MinDelay (s):", delay);
    }

    function executeHandover() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address govSafe = vm.envAddress("GOV_SAFE_ADDRESS");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));
        uint256[] memory govPks = _loadGovSignerPks();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _loadTargets();

        bytes memory data = abi.encodeWithSelector(
            timelock.executeBatch.selector,
            targets,
            values,
            payloads,
            bytes32(0),
            HANDOVER_SALT
        );

        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();

        vm.startBroadcast(deployerPk);
        _execSafeTx(govSafe, govPks, address(timelock), data);
        if (timelock.hasRole(adminRole, deployer)) {
            timelock.renounceRole(adminRole, deployer);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < 6; ++i) {
            address actual = Ownable2Step(targets[i]).owner();
            if (actual != address(timelock)) revert OwnerMismatch(targets[i], actual, address(timelock));
        }
        if (timelock.hasRole(adminRole, deployer)) revert DeployerStillAdmin();

        console2.log("Handover complete: all 6 contracts owned by TimelockController; deployer admin renounced.");
    }

    function _loadTargets()
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](6);
        values = new uint256[](6);
        payloads = new bytes[](6);

        targets[0] = vm.envAddress("VAULT_ADDRESS");
        targets[1] = vm.envAddress("MANAGER_ADDRESS");
        targets[2] = vm.envAddress("PULL_ORACLE_ADDRESS");
        targets[3] = vm.envAddress("ORACLE_ADAPTER_ADDRESS");
        targets[4] = vm.envAddress("TWAP_ORACLE_ADDRESS");
        targets[5] = vm.envAddress("COMPLIANCE_HOOK_ADDRESS");

        bytes memory acceptData = abi.encodeWithSignature("acceptOwnership()");
        for (uint256 i = 0; i < 6; ++i) payloads[i] = acceptData;
    }

    function _loadGovSignerPks() internal view returns (uint256[] memory pks) {
        pks = new uint256[](3);
        pks[0] = vm.envUint("GOV_SIGNER_PK_1");
        pks[1] = vm.envUint("GOV_SIGNER_PK_2");
        pks[2] = vm.envUint("GOV_SIGNER_PK_3");
    }

    function _execSafeTx(address safeAddr, uint256[] memory pks, address to, bytes memory data) internal {
        ISafeL2 safe = ISafeL2(safeAddr);
        uint256 safeNonce = safe.nonce();
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safeNonce
        );

        address[] memory addrs = new address[](3);
        uint256[] memory sortedPks = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) {
            sortedPks[i] = pks[i];
            addrs[i] = vm.addr(pks[i]);
        }
        for (uint256 i = 0; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (addrs[j] < addrs[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (sortedPks[i], sortedPks[j]) = (sortedPks[j], sortedPks[i]);
                }
            }
        }
        bytes memory sigs;
        for (uint256 i = 0; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 sVal) = vm.sign(sortedPks[i], txHash);
            sigs = abi.encodePacked(sigs, r, sVal, v);
        }
        bool ok = safe.execTransaction(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        if (!ok) revert SafeExecFailed();
    }
}
