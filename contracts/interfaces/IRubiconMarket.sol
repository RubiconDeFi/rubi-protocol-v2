// SPDX-License-Identifier: MIT

pragma solidity >=0.8.16;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRubiconMarket {
    function cancel(uint256 id) external;

    function offer(
        uint256 pay_amt, //maker (ask) sell how much
        IERC20 pay_gem, //maker (ask) sell which token
        uint256 buy_amt, //maker (ask) buy how much
        IERC20 buy_gem, //maker (ask) buy which token
        uint256 pos, //position to insert offer, 0 should be used if unknown
        bool matching //match "close enough" orders?
    ) external returns (uint256);

    // Get best offer
    function getBestOffer(
        IERC20 sell_gem,
        IERC20 buy_gem
    ) external view returns (uint256);

    function getFeeBPS() external view returns (uint256);

    // get offer
    function getOffer(
        uint256 id
    ) external view returns (uint256, IERC20, uint256, IERC20);

    function sellAllAmount(
        IERC20 pay_gem,
        uint256 pay_amt,
        IERC20 buy_gem,
        uint256 min_fill_amount
    ) external returns (uint256 fill_amt);

    function buyAllAmount(
        IERC20 buy_gem,
        uint256 buy_amt,
        IERC20 pay_gem,
        uint256 max_fill_amount
    ) external returns (uint256 fill_amt);
}
