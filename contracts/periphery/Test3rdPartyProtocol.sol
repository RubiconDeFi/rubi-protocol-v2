// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../utilities/RubiconRouter.sol";
import "../utilities/FeeWrapper.sol";

contract Test3rdPartyProtocol {
    address public feeWrapper;
    uint256 feeType = 10_000; // BPS
    uint256 fee = 10; // 10/10_000
    address feeTo;
    address rubiRouter;

    constructor(address _feeWrapper, address _feeTo, address _rubiRouter) {
        feeWrapper = _feeWrapper;
        feeTo = _feeTo;
        rubiRouter = _rubiRouter;
    }

    function executeSwap(
        uint256 pay_amt,
        uint256 buy_amt_min,
        address[] calldata route
    ) external {
        // transfer full amount
        IERC20(route[0]).transferFrom(msg.sender, address(this), pay_amt);

        // for RubiconRouter both `pay_amt` and `buy_amt_min` should be updated
        uint256[] memory tokenAmounts = new uint256[](2);
        tokenAmounts[0] = pay_amt;
        tokenAmounts[1] = buy_amt_min;

        // calculate fee to pay using FeeWrapper
        (uint256[] memory new_amounts, uint256[] memory fees_) = FeeWrapper(
            feeWrapper
        ).calculateFee(tokenAmounts, feeType, fee);
        // construct fee params
        FeeWrapper.FeeParams memory feeParams = FeeWrapper.FeeParams(
            route[0],
            pay_amt,
            fees_[0], // use only the first fee for router
            feeTo
        );
        // approve total amount to the FeeWrapper
        IERC20(route[0]).approve(feeWrapper, pay_amt);

        // update both pay_amt and buy_amt_min with fee deducted
        pay_amt = new_amounts[0];
        buy_amt_min = new_amounts[1];

        FeeWrapper.CallParams memory params = FeeWrapper.CallParams(
            RubiconRouter.swap.selector,
            abi.encode(pay_amt, buy_amt_min, route, msg.sender),
            rubiRouter,
            feeParams
        );
        FeeWrapper(feeWrapper).rubicall(params);
    }

    function executeSwapWithETH(
        uint256 pay_amt,
        uint256 buy_amt_min,
        address[] calldata route
    ) external payable {
        require(msg.value == pay_amt, "nah bro");

        // for RubiconRouter both `pay_amt` and `buy_amt_min` should be updated
        uint256[] memory tokenAmounts = new uint256[](2);
        tokenAmounts[0] = pay_amt;
        tokenAmounts[1] = buy_amt_min;

        // calculate fee to pay using FeeWrapper
        (uint256[] memory new_amounts, uint256[] memory fees_) = FeeWrapper(
            feeWrapper
        ).calculateFee(tokenAmounts, feeType, fee);
        // construct fee params
        FeeWrapper.FeeParams memory feeParams = FeeWrapper.FeeParams(
            route[0], // MUS be WETH
            pay_amt,
            fees_[0], // use only the first fee for router
            feeTo
        );
        // approve total amount to the FeeWrapper
        IERC20(route[0]).approve(feeWrapper, pay_amt);

        // update both pay_amt and buy_amt_min with fee deducted
        pay_amt = new_amounts[0];
        buy_amt_min = new_amounts[1];

        FeeWrapper.CallParams memory params = FeeWrapper.CallParams(
            RubiconRouter.swapWithETH.selector,
            abi.encode(pay_amt, buy_amt_min, route, msg.sender),
            rubiRouter,
            feeParams
        );
        FeeWrapper(feeWrapper).rubicall{value: msg.value}(params);
    }

    function executeOfferWithETH(
        uint256 pay_amt,
        uint256 buy_amt,
        address buy_gem,
        uint256 pos
    ) external payable {
        require(pay_amt == msg.value, "no no no");
        uint256[] memory tokenAmounts = new uint256[](2);
        tokenAmounts[0] = pay_amt;
		tokenAmounts[1] = buy_amt;

        // calculate fee to pay using FeeWrapper
        (uint256[] memory new_amounts, uint256[] memory fees_) = FeeWrapper(
            feeWrapper
        ).calculateFee(tokenAmounts, feeType, fee);

        FeeWrapper.FeeParams memory feeParams = FeeWrapper.FeeParams(
            address(0), // don't care since the func is payable
            pay_amt,
            fees_[0],
            feeTo
        );

        // update both pay_amt and buy_amt_min with fee deducted
        pay_amt = new_amounts[0];

        FeeWrapper.CallParams memory params = FeeWrapper.CallParams(
            RubiconRouter.offerWithETH.selector,
            abi.encode(pay_amt, buy_amt, buy_gem, pos, msg.sender),
            rubiRouter,
            feeParams
        );
        FeeWrapper(feeWrapper).rubicall{value: msg.value}(params);
    }

    function executeDepositWithETH(
        uint256 amount,
        address bathToken
    ) external payable {
        require(amount == msg.value, "no no no");
        uint256[] memory tokenAmounts = new uint256[](1);
        tokenAmounts[0] = amount;

        // calculate fee to pay using FeeWrapper
        (uint256[] memory new_amounts, uint256[] memory fees_) = FeeWrapper(
            feeWrapper
        ).calculateFee(tokenAmounts, feeType, fee);

        FeeWrapper.FeeParams memory feeParams = FeeWrapper.FeeParams(
            address(0), // don't care since the func is payable
            amount,
            fees_[0],
            feeTo
        );

        // update both pay_amt and buy_amt_min with fee deducted
        amount = new_amounts[0];

        FeeWrapper.CallParams memory params = FeeWrapper.CallParams(
            RubiconRouter.depositWithETH.selector,
            abi.encode(amount, bathToken, msg.sender),
            rubiRouter,
            feeParams
        );
        FeeWrapper(feeWrapper).rubicall{value: msg.value}(params);
    }
}
