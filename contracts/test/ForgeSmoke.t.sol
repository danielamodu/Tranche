// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ForgeSmoke} from "../src/ForgeSmoke.sol";

contract ForgeSmokeTest {
    ForgeSmoke internal target;

    function setUp() public {
        target = new ForgeSmoke();
    }

    function test_SetValue() public {
        target.setValue(42);
        require(target.value() == 42, "value mismatch");
    }
}
