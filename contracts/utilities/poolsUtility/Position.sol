// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../compound-v2-fork/Comptroller.sol";
import "../../compound-v2-fork/PriceOracle.sol";
import "../../BathHouseV2.sol";
import "../../RubiconMarket.sol";

/// @title PoolsUtility
/// @notice A contract allowing to open long and short positions
contract Position is Ownable, DSMath {
    // libs
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    uint256 public lastPositionId;

    // variables used in openPosition execution
    struct PosVars {
        uint256 borrowedAmount; // how much to borrow in current borrow loop
        uint256 initAssetBalance; // initial balance of asset
        uint256 limit; // limit of borrowing loops
        uint256 lastBorrow; // how much borrow on the last loop (check _borrowLimit)
        uint256 currentBathTokenAmount; // amount of basthTokenAsset in the moment of execution
        uint256 currentAssetBalance; // balance of asset in the moment of execution
        uint256 toBorrow; // certain perc. to borrow from max amount available to borrow
    }

    struct Position {
        address asset; // supplied as collateral
        address quote; // borrowed token
        uint256 borrowedAmount; // amount of borrowed quote
        uint256 bathTokenAmount; // amount of bathTokens to which collateral was supplied
        uint256 blockNum; // block number on which position was opened
        bool isActive; // false by default, when active - true
    }
    // position id => Position struct
    mapping(uint256 => Position) public positions;

    Comptroller public comptroller;
    PriceOracle public oracle;
    RubiconMarket public rubiconMarket;
    BathHouseV2 public bathHouseV2;

    // events
    event PositionOpened(uint256 positionId, Position position);
    event PositionClosed(uint256 positionId);
    event MarginIncreased(uint256 positionId, uint256 amount);

    constructor(address _oracle, address _rubiconMarket, address _bathHouseV2) {
        oracle = PriceOracle(_oracle);
        rubiconMarket = RubiconMarket(_rubiconMarket);
        bathHouseV2 = BathHouseV2(_bathHouseV2);
        comptroller = bathHouseV2.comptroller();
    }

    //============================= VIEW =============================

    /// @return balance - the user’s current borrow balance (with interest) in units of the underlying asset.
    /// not view function!
    function borrowBalance(address bathToken) public returns (uint256 balance) {
        balance = CTokenInterface(bathToken).borrowBalanceCurrent(
            address(this)
        );
    }

    /// @return balance - total borrowed balance of certain position
    function borrowBalanceOfPos(
        uint256 posId
    ) public view returns (uint256 balance) {
        Position memory pos = positions[posId];
        require(pos.isActive, "borrowBalanceOfPos: POS ISN'T ACTIVE");

        uint256 blockNum = pos.blockNum;
        address bathTokenQuote = bathHouseV2.getBathTokenFromAsset(pos.quote);
        uint256 borrowedAmount = pos.borrowedAmount;

        balance = _calculateDebt(bathTokenQuote, blockNum, borrowedAmount);
    }

    /// @notice get current borrow rate in `bathToken` market
    function borrowRate(address bathToken) public view returns (uint256 rate) {
        rate = CTokenInterface(bathToken).borrowRatePerBlock();
    }

    //============================= MAIN =============================

    /// @notice open long position in Rubicon Market
    function buyAllAmountWithLeverage(
        address quote,
        address asset,
        uint256 quotePayAmount,
        uint256 leverage
    ) external onlyOwner {
        _leverageCheck(leverage, true);
        require(
            openPosition(quote, asset, quotePayAmount, leverage),
            "buyAllAmountWithLeverage: FAILED TO OPEN POSITION"
        );
    }

    /// @notice open short position in Rubicon Market
    function sellAllAmountWithLeverage(
        address asset,
        address quote,
        uint256 assetPayAmount,
        uint256 leverage
    ) external onlyOwner {
        _leverageCheck(leverage, false);
        require(
            openPosition(asset, quote, assetPayAmount, leverage),
            "sellAllAmountWithLeverage: FAILED TO OPEN POSITION"
        );
    }

    /// @notice entry-point to open long/short positions
    /// @param asset - long ? long asset : short asset
    /// @param quote - opposite to asset ^
    /// @param initMargin - initial collateral amount
    /// @param leverage - leverage multiplier - n*1e18
    function openPosition(
        address asset,
        address quote,
        uint256 initMargin,
        uint256 leverage
    ) internal returns (bool OK) {
        address bathTokenAsset = bathHouseV2.getBathTokenFromAsset(asset);
        address bathTokenQuote = bathHouseV2.getBathTokenFromAsset(quote);

        /// @dev avoid stack too deep
        PosVars memory vars;

        /// @dev save initial borrow balance before borrowing more
        vars.borrowedAmount = borrowBalance(bathTokenQuote);
        /// @dev save initial balance of asset to calculate then amount to borrow
        vars.initAssetBalance = IERC20(asset).balanceOf(address(this));

        // transfer initial margin amount
        IERC20(asset).safeTransferFrom(msg.sender, address(this), initMargin);

        // enter bathTokenAsset market in order to
        // supply collateral and borrow quote
        _enterMarkets(bathTokenAsset);

        (vars.limit, vars.lastBorrow) = _borrowLimit(
            bathTokenAsset,
            asset,
            initMargin,
            leverage
        );

        // TODO: definitely need to work on naming things
        // supply/borrow/swap => until the iterations limit is reached
        for (uint256 i = 0; i < vars.limit; ++i) {
            /// @dev save borrowed balance of an asset
            uint256 assetBalance = IERC20(asset).balanceOf(address(this));

            // check to prevent underflow!
            if (vars.initAssetBalance == 0) {
                vars.currentAssetBalance = assetBalance;
            } else if (vars.initAssetBalance < assetBalance) {
                vars.currentAssetBalance = assetBalance.sub(
                    vars.initAssetBalance
                );
            } else {
                vars.currentAssetBalance = vars.initAssetBalance.sub(
                    assetBalance
                );
            }

            // borrow specifically lastBorrowAmount on the last iteration if needed
            if (i.add(1) == vars.limit && vars.lastBorrow != 0) {
                vars.toBorrow = vars.lastBorrow;
            } else {
                // otherwise borrow max amount available to borrow - 100% from _maxBorrow
                vars.toBorrow = WAD;
            }

            // increase bathToken amount in order to save it in positions map
            vars.currentBathTokenAmount += _borrowLoop(
                asset,
                quote,
                bathTokenAsset,
                bathTokenQuote,
                vars.currentAssetBalance,
                vars.toBorrow
            );
        }

        /// @dev save total borrow amount of this current position
        vars.borrowedAmount = (borrowBalance(bathTokenQuote)).sub(
            vars.borrowedAmount
        );
        _savePosition(
            asset,
            quote,
            vars.borrowedAmount,
            vars.currentBathTokenAmount
        );

        OK = true;
    }

    /// @notice entry-point to close opened position
    /// @param posId - id of the opened position
    function closePosition(uint256 posId) external onlyOwner {
        Position memory pos = positions[posId];
        require(pos.isActive, "closePosition: POS ISN'T ACTIVE");

        // load values to memory
        address asset = pos.asset;
        address quote = pos.quote;
        uint256 bathTokenAmount = pos.bathTokenAmount;

        _repay(asset, quote, posId);
        _redeem(asset, bathTokenAmount);

        _removePosition(posId);
    }

    /// @notice add more collateral to certain position
    function increaseMargin(uint256 posId, uint256 amount) external onlyOwner {
        Position memory pos = positions[posId];
        require(pos.isActive, "increaseMargin: POS ISN'T ACTIVE");

        address asset = pos.asset;

        // transfer amount of asset to supply
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        address bathTokenAsset = bathHouseV2.getBathTokenFromAsset(asset);
        // supply more collateral to bathTokenAsset's market
        uint256 bathTokenAmount = _supply(asset, bathTokenAsset, amount);
        _updateMargin(posId, bathTokenAmount, amount);
    }

    /// @notice withdraw amount of token from the contract
    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    //============================= BORROWING =============================

    /// @notice supply collateral, borrow quote token, swap to asset token
    /// @param _toBorrow - check _lastBorrow in _borrowLimit
    /// @return _bathTokenAmount - amount of _bathTokenAsset minted
    function _borrowLoop(
        address _asset,
        address _quote,
        address _bathTokenAsset,
        address _bathTokenQuote,
        uint256 _amount,
        uint256 _toBorrow
    ) internal returns (uint256 _bathTokenAmount) {
        // supply collateral
        _bathTokenAmount = _supply(_asset, _bathTokenAsset, _amount);

        // calculate how much is needed to borrow from _maxBorrow amount
        //_toBorrow = (_maxBorrow(_bathTokenQuote).mul(_toBorrow)).div(WAD);
        _toBorrow = wmul(_maxBorrow(_bathTokenQuote), _toBorrow);

        // swap borrowed quote tokens to asset tokens
        _borrow(_bathTokenQuote, _toBorrow);
        _rubiconSwap(_asset, _quote, _toBorrow, true);
    }

    /// @notice borrow `_amount` of underlying token of `_cToken`
    function _borrow(address _cToken, uint256 _amount) internal {
        require(
            CErc20Interface(_cToken).borrow(_amount) == 0,
            "_borrow: BORROW FAILED"
        );
    }

    /// @notice repay debt + interest
    function _repay(address _asset, address _quote, uint256 _posId) internal {
        address _bathTokenQuote = bathHouseV2.getBathTokenFromAsset(_quote);
        uint256 _amountToRepay = borrowBalanceOfPos(_posId);

        // sell asset for quote
        _rubiconSwap(_asset, _quote, _amountToRepay, false);
        uint256 _quoteBalance = IERC20(_quote).balanceOf(address(this));

        require(
            _amountToRepay <= _quoteBalance,
            "_repay: balance of quote lt. debt"
        );
        uint256 _borrowBalance = borrowBalance(_bathTokenQuote);
        if (_amountToRepay > _borrowBalance) {
            _amountToRepay = _borrowBalance;
        }

        IERC20(_quote).approve(_bathTokenQuote, _amountToRepay);
        require(
            CErc20Interface(_bathTokenQuote).repayBorrow(_amountToRepay) == 0,
            "_repay: ERROR"
        );
    }

    /// @notice calculate maximum amount available to borrow from `_cToken` market
    /// @param _bathToken - bathToken to borrow
    function _maxBorrow(
        address _bathToken
    ) internal view returns (uint256 _max) {
        (uint256 _err, uint256 _liq, uint256 _shortfall) = comptroller
            .getAccountLiquidity(address(this));

        require(_err == 0, "_maxBorrow: ERROR");
        require(_liq > 0, "_maxBorrow: LIQUIDITY == 0");
        require(_shortfall == 0, "_maxBorrow: SHORTFALL != 0");

        uint256 _price = oracle.getUnderlyingPrice(CToken(_bathToken));
        _max = (_liq.mul(10 ** 18)).div(_price);
        require(_max > 0, "_maxBorrow: can't borrow 0");
    }

    /// @notice calculate debt + interest, based on the borrow rate and blocks passed
    function _calculateDebt(
        address _bathToken,
        uint256 _startBlock,
        uint256 _borrowedAmount
    ) internal view returns (uint256 _debt) {
        uint256 _blockDelta = block.number - _startBlock;

        uint256 _interest = (
            (_borrowedAmount).mul(borrowRate(_bathToken).mul(_blockDelta))
        ).div(10 ** 18);
        _debt = _borrowedAmount.add(_interest);
    }

    /// @notice enter markets in order to supply collateral or borrow
    function _enterMarkets(address _bathToken) internal {
        address[] memory _bathTokens = new address[](1);
        _bathTokens[0] = _bathToken;
        uint256[] memory _errs = comptroller.enterMarkets(_bathTokens);
        require(_errs[0] == 0);
    }

    function _exitMarket(address _bathToken) internal {
        require(comptroller.exitMarket(_bathToken) == 0, "_exitMarket: ERROR");
    }

    //============================= COLLATERAL =============================

    /// @notice supply collateral to cToken's market
    function _supply(
        address _token,
        address _bathToken,
        uint256 _amount
    ) internal returns (uint256 _bathTokenAmount) {
        uint256 _initBathTokenAmount = IERC20(_bathToken).balanceOf(
            address(this)
        );
        IERC20(_token).safeApprove(_bathToken, _amount);
        require(
            CErc20Interface(_bathToken).mint(_amount) == 0,
            "_supply: MINT FAILED"
        );
        uint256 _currentBathTokenAmount = IERC20(_bathToken).balanceOf(
            address(this)
        );

        assembly {
            switch _initBathTokenAmount
            case 0 {
                _bathTokenAmount := _currentBathTokenAmount
            }
            default {
                _bathTokenAmount := sub(
                    _currentBathTokenAmount,
                    _initBathTokenAmount
                )
            }
        }
    }

    /// @notice convert `_bathTokenAsset` into underlying asset
    function _redeem(address _asset, uint256 _bathTokenAmount) internal {
        address _bathTokenAsset = bathHouseV2.getBathTokenFromAsset(_asset);

        require(
            CErc20Interface(_bathTokenAsset).redeem(_bathTokenAmount) == 0,
            "_redeem: REDEEM FAILED"
        );

        // exit bathToken market only if there is no collateral and debt in it
        if (
            IERC20(_bathTokenAsset).balanceOf(address(this)) == 0 &&
            borrowBalance(_bathTokenAsset) == 0
        ) {
            _exitMarket(_bathTokenAsset);
        }
    }

    //============================= POSITIONS MANAGEMENT =============================

    function _savePosition(
        address _asset,
        address _quote,
        uint256 _borrowedAmount,
        uint256 _currentBathTokenAmount
    ) internal {
        lastPositionId++;
        Position memory pos = Position(
            _asset,
            _quote,
            _borrowedAmount,
            _currentBathTokenAmount,
            block.number,
            true
        );
        positions[lastPositionId] = pos;

        emit PositionOpened(lastPositionId, pos);
    }

    function _removePosition(uint256 _positionId) internal {
        delete positions[_positionId];
        emit PositionClosed(_positionId);
    }

    function _updateMargin(
        uint256 _positionId,
        uint256 _bathTokenAmount,
        uint256 _marginAmount
    ) internal {
        positions[_positionId].bathTokenAmount += _bathTokenAmount;

        emit MarginIncreased(_positionId, _marginAmount);
    }

    //============================= RUBICON =============================

    /// @notice execute market buy on RubiconMarket
    /// @param _asset - input token
    /// @param _quote - output token
    /// @param _fillLimit - maximum amount of _quote to be sold
    /// @param _buy - true = market buy; false = market sell
    function _rubiconSwap(
        address _asset,
        address _quote,
        uint256 _fillLimit,
        bool _buy
    ) internal {
        _buy
            ? _marketBuy(_asset, _quote, _fillLimit)
            : _marketSell(_asset, _quote, _fillLimit);
    }

    function _marketBuy(
        address _asset,
        address _quote,
        uint256 _maxFill
    ) internal {
        uint256 _fee = _maxFill.mul(rubiconMarket.getFeeBPS()).div(10000);
        uint256 _buyAmount = rubiconMarket.getBuyAmount(
            ERC20(_asset),
            ERC20(_quote),
            _maxFill.sub(_fee)
        );
        IERC20(_quote).approve(address(rubiconMarket), _maxFill);

        rubiconMarket.buyAllAmount(
            ERC20(_asset),
            _buyAmount,
            ERC20(_quote),
            _maxFill
        );
    }

    function _marketSell(
        address _asset,
        address _quote,
        uint256 _minFill
    ) internal {
        uint256 _feeBPS = rubiconMarket.getFeeBPS();
        uint256 _fee = _minFill.mul(_feeBPS).div(10000);
        uint256 _payAmount = rubiconMarket.getPayAmount(
            ERC20(_asset),
            ERC20(_quote),
            _minFill.add(_fee)
        );
        uint256 _assetBalance = IERC20(_asset).balanceOf(address(this));

        /// @dev recalculate fee in _asset form
        _fee = _payAmount.mul(_feeBPS).div(10000);

        if (_assetBalance < _payAmount) {
            IERC20(_asset).transferFrom(
                msg.sender,
                address(this),
                _payAmount.sub(_assetBalance).add(_fee)
            );
        }

        IERC20(_asset).approve(
            address(rubiconMarket),
            IERC20(_asset).balanceOf(address(this))
        );

        rubiconMarket.sellAllAmount(
            ERC20(_asset),
            _payAmount,
            ERC20(_quote),
            _minFill
        );
    }

    //============================= HELPERS =============================

    /*
     * @notice calculate an amount of iterations needed to reach desired
     * amount with leverage
     * @param _bathToken - bathToken to which collateral will be supplied
     * @param _asset - token in which form collateral will be supplied
     * @param _assetAmount - initial margin
     * @param _leverage - check `leverage` in openPosition()
     * @return _limit - number of iterations
     * @return _lastBorrow - specifies value indicating how much % is needed
     * to borrow from _maxBorrow on the last _borrowLoop, in range [1:WAD]
     */
    function _borrowLimit(
        address _bathToken,
        address _asset,
        uint256 _assetAmount,
        uint256 _leverage
    ) internal returns (uint256 _limit, uint256 _lastBorrow) {
        (, uint256 _collateralFactor, ) = comptroller.markets(_bathToken);
        // how much is needed to borrow in asset form
        uint256 _desiredAmount = wmul(_assetAmount, _leverage);

        // check if collateral was already supplied
        uint256 _minted = IERC20(_bathToken).balanceOf(address(this));
	// how much is borrowed on a current loop
        uint256 _loopBorrowed;

        while (_assetAmount <= _desiredAmount) {
            if (_limit == 0) {
		// if collateral already provided
                if (_minted != 0) {
                    uint256 _max = _maxBorrow(_bathToken);

		    // take into account previous collateral
                    _loopBorrowed = wmul(_assetAmount, _collateralFactor).add(
                        _max
                    );
                } else {
                    _loopBorrowed = wmul(_assetAmount, _collateralFactor);
                }
            } else {
                _loopBorrowed = wmul(_loopBorrowed, _collateralFactor);
            }

            // here _assetAmount refers to the
            // TOTAL asset amount in the position
            _assetAmount += _loopBorrowed;

            if (_assetAmount > _desiredAmount) {
                // in case we've borrowed more than needed
                // return excess and calculate how much is
                // needed to borrow on the last loop
                // to not overflow _desiredAmount
                uint256 _borrowDelta = _desiredAmount.sub(
                    _assetAmount.sub(_loopBorrowed)
                );
                _lastBorrow = _borrowDelta.mul(WAD).div(_loopBorrowed);

                _limit++;
                break;
            } else if (_assetAmount == _desiredAmount) {
                // 1x short or perfect matching
                _limit++;
                break;
            } else {
                // default case
                _limit++;
            }
        }
    }

    /// @notice check if specified leverage fits into the current leverage boundaries
    function _leverageCheck(uint256 _leverage, bool _long) internal pure {
        uint256 _wad = WAD;
        uint256 _leverageMax = WAD.mul(3);

        _long // long can't be with 1x leverage
            ? require(
                _leverage > _wad && _leverage <= _leverageMax,
                "_leverageCheck{Long}: INVLAID LEVERAGE"
            )
            : require(
                _leverage >= _wad && _leverage <= _leverageMax,
                "_leverageCheck{Short}: INVLAID LEVERAGE"
            );
    }
}
