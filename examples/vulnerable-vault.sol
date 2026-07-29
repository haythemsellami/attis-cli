// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice A deliberately vulnerable vault (spike fixture: classic reentrancy).
contract VulnerableVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }
}
