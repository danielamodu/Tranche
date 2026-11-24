// Forge toolchain smoke contract - Phase 1 executable validation only.
pragma solidity ^0.8.24;

contract ForgeSmoke {
    uint256 public value;

    function setValue(uint256 _value) external {
        value = _value;
    }
}
