// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice A CEI-correct vault (safe-by-construction fixture).
contract SafeVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient balance");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }
}
