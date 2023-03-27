// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./compound-v2-fork/CTokenInterfaces.sol";

interface IBathToken is IERC20 {
    function withdraw(
        uint256 shares
    ) external returns (uint256 amountWithdrawn);

    function underlyingToken() external view returns(IERC20);
}

/// @notice Migratoooooooor
contract V2Migrator {
    /// @notice old bathToken -> new bathToken
    mapping(address => address) public v1ToV2Pools;

    event Migrated(
        address indexed from,
        address indexed v1Pool,
        address indexed v2Pool,
        uint256 amount
    );

    /// @dev underlying tokens should be the same for corresponding pools
    /// i.e. USDC -> USDC, WETH -> WETH, etc.
    constructor(address[] memory bathTokensV1, address[] memory bathTokensV2) {
        for (uint256 i = 0; i < bathTokensV1.length; ++i) {
            // set v1 to v2 bathTokens
            v1ToV2Pools[bathTokensV1[i]] = bathTokensV2[i];
        }
    }

    // let's go to another bath
    function migrate(IBathToken bathTokenV1) external {
        //////////////// V1 WITHDRAWAL ////////////////
        uint256 bathBalance = bathTokenV1.balanceOf(msg.sender);
        require(bathBalance > 0, "migrate: ZERO AMOUNT");

        /// @dev approve first
        bathTokenV1.transferFrom(msg.sender, address(this), bathBalance);

        // withdraw all tokens from the pool
        uint256 amountWithdrawn = bathTokenV1.withdraw(bathBalance);

        //////////////// V2 DEPOSIT ////////////////
        IERC20 underlying = bathTokenV1.underlyingToken();
        address bathTokenV2 = v1ToV2Pools[address(bathTokenV1)];

        underlying.approve(bathTokenV2, amountWithdrawn);
        require(
            CErc20Interface(bathTokenV2).mint(amountWithdrawn) == 0,
            "migrate: MINT FAILED"
        );
        /// @dev v2 bathTokens shouldn't be sent to this contract from anywhere other than this function
        IERC20(bathTokenV2).transfer(
            msg.sender,
            IERC20(bathTokenV2).balanceOf(address(this))
        );
        require(
            IERC20(bathTokenV2).balanceOf(address(this)) == 0,
            "migrate: BATH TOKENS V2 STUCK IN THE CONTRACT"
        );

        emit Migrated(
            msg.sender,
            address(bathTokenV1),
            address(bathTokenV2),
            amountWithdrawn
        );
    }
}
