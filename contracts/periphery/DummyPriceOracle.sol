pragma solidity 0.8.17;

import "../compound-v2-fork/PriceOracle.sol";

/// @notice DUMMY ORACLE that returns hardcoded prices
contract DummyPriceOracle is PriceOracle {
    mapping(CToken => uint256) public prices;

    function addCtoken(CToken cToken, uint256 price) external {
        prices[cToken] = price;
    }

    function getUnderlyingPrice(
        CToken cToken
    ) external view override returns (uint256) {
        return prices[cToken];
    }
}
