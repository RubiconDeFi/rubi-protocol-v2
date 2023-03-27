// SPDX-License-Identifier: UNLICENSED

pragma solidity >=0.8.17;

interface IWETH {
    function allowance(address from, address to) external view returns(uint256);
    
    function deposit() external payable;

    function transfer(address to, uint256 value) external returns (bool);

    function withdraw(uint256) external;

    function approve(address guy, uint256 wad) external returns (bool);
}
