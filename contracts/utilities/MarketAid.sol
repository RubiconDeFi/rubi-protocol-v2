// SPDX-License-Identifier: MIT

/// @author rubicon.eth
/// @notice A contract that permissions an admin at initialization to allow for batch-actions on Rubicon Market
/// @notice Helpful for high-frequency market-making in a gas-efficient fashion on Rubicon
/// @notice AMMs will be rekt

pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "../interfaces/IRubiconMarket.sol";
import "../interfaces/ISwapRouter.sol";

contract MarketAid is Multicall {
    /// *** Libraries ***
    using SafeMath for uint256;
    using SafeMath for uint16;
    using SafeERC20 for IERC20;

    /// *** Storage Variables ***

    /// @notice admin
    address public admin;

    /// @notice The Rubicon Market that all market activity is pointed towards
    address public RubiconMarketAddress;

    /// @dev The id of the last StrategistTrade made by any strategist on this contract
    /// @dev This value is globally unique, and increments with every trade
    uint256 internal last_stratTrade_id;

    /// @notice Unique id => StrategistTrade created in market-making calls via placeMarketMakingTrades
    mapping(uint256 => StrategistTrade) public strategistTrades;

    /// @notice Map a strategist to their outstanding order IDs
    mapping(address => mapping(address => mapping(address => uint256[])))
        public outOffersByStrategist;

    /// @notice A mapping of approved strategists to access Pools liquidity
    mapping(address => bool) public approvedStrategists;

    /// @notice Re-entrancy gaurd
    bool locked;

    /// @notice Approve a unique operator who can call a kill-switch to block any OUTFLOWS (excluding withdrawal) while allowing cancels and INFLOWS
    address public killSwitchOperator;

    /// @notice Kill switch status
    bool public killed;

    /// *** Structs ***

    struct order {
        uint256 pay_amt;
        IERC20 pay_gem;
        uint256 buy_amt;
        IERC20 buy_gem;
    }

    struct StrategistTrade {
        uint256 askId;
        uint256 askPayAmt;
        address askAsset;
        uint256 bidId;
        uint256 bidPayAmt;
        address bidAsset;
        address strategist;
        uint256 timestamp;
    }

    /// *** Events ***

    /// @notice Log a new market-making trade placed by a strategist, resulting in a StrategistTrade
    event LogStrategistTrade(
        uint256 strategistTradeID,
        bytes32 askId,
        bytes32 bidId,
        address askAsset,
        address bidAsset,
        uint256 timestamp,
        address strategist
    );

    /// @notice Logs the cancellation of a StrategistTrade
    event LogScrubbedStratTrade(
        uint256 strategistIDScrubbed,
        uint256 assetFill,
        address assetAddress,
        uint256 quoteFill,
        address quoteAddress
    );

    /// @notice Log when an admin wants to pull all ERC20s back to their wallet
    event LogAdminPullFunds(
        address admin,
        address asset,
        uint256 amountOfReward,
        uint256 timestamp
    );

    /// @notice Log when a strategist places a batch market making order
    event LogBatchMarketMakingTrades(address strategist, uint256[] trades);

    /// @notice Log when a strategist requotes an offer
    event LogRequote(
        address strategist,
        uint256 scrubbedOfferID,
        uint256 newOfferID
    );

    /// @notice Log when a strategist batch requotes offers
    event LogBatchRequoteOffers(address strategist, uint256[] scrubbedOfferIDs);

    /// @notice Used for PNL tracking and to track inflows and outflows
    event LogBookUpdate(
        address adminCaller,
        address token,
        int amountChanged,
        uint timestamp
    );

    event LogAtomicArbitrage(
        address indexed caller,
        address indexed assetSold,
        address indexed assetReceived,
        uint256 amountSold,
        uint256 profit,
        uint24 uniPoolFee,
        bool isBuyRubiconFirst,
        uint256 timestamp
    );

    // this is a function to deal with any external swapping of tokens that may occur outside of the market
    // note, this should include any fees that are paid as a part of the swap
    event LogExternalSwap(
        address indexed caller,
        address indexed assetSold,
        address indexed assetReceived,
        uint256 amountSold,
        uint256 amountReceived,
        address venue
    );

    /// *** External Functions ***

    /// @dev native constructor, use initialization above INSTEAD of this constructor, to make this contract "proxy-safe"
    /// @dev Non-proxy safe native constructor for trustless handoff via createMarketAidInstance()
    constructor(address market, address _admin) {
        admin = _admin;
        RubiconMarketAddress = market;
        require(admin != address(0) && RubiconMarketAddress != address(0));
        approvedStrategists[admin] = true;

        /// @dev Approve self for batchBox functionality
        // approvedStrategists[address(this)] = true;
        killed = false;
    }

    /// *** Modifiers ***

    /// @notice Only the admin assigned at initialization may access these sensitive functions
    modifier onlyAdmin() {
        require(msg.sender == admin);
        _;
    }

    /// @notice Only approved strategists can access state mutating functions
    modifier onlyApprovedStrategist() {
        // Admin approves strategists directly on this contract
        require(
            isApprovedStrategist(msg.sender) == true,
            "you are not an approved strategist"
        );
        _;
    }

    /// @notice A function to check whether or not an address is an approved strategist
    function isApprovedStrategist(
        address wouldBeStrategist
    ) public view returns (bool) {
        if (approvedStrategists[wouldBeStrategist] == true) {
            return true;
        } else {
            return false;
        }
    }

    /// @dev Reentrancy gaurd
    modifier beGoneReentrantScum() {
        require(!locked);
        locked = true;
        _;
        locked = false;
    }

    // ** Admin **

    /// @notice Admin-only function to approve a new permissioned strategist
    function approveStrategist(address strategist) public onlyAdmin {
        require(strategist != address(0), "strategist is zero address");
        approvedStrategists[strategist] = true;
    }

    /// @notice Admin-only function to remove a permissioned strategist
    function removeStrategist(address strategist) external onlyAdmin {
        approvedStrategists[strategist] = false;
    }

    /// @notice Admin-only function to assign a kill-switch operator
    function assignKillSwitchOperator(address kso) external onlyAdmin {
        require(kso != address(0), "kill swithcer is zero address");
        killSwitchOperator = kso;
    }

    // *** Kill Switch Funtionality ***
    modifier KillSwitchOperatorOnly() {
        require(
            killSwitchOperator != address(0) &&
                msg.sender == killSwitchOperator,
            "you are not the kso or not assigned"
        );
        _;
    }

    function flipKillSwitchOn() external KillSwitchOperatorOnly {
        killed = true;
    }

    function flipKillSwitchOn(
        address strategistToBailOut,
        address asset,
        address quote
    ) external KillSwitchOperatorOnly {
        killed = true;

        /// @dev also wipe the book for a given strategist optionaly
        uint[] memory data = getOutstandingStrategistTrades(
            asset,
            quote,
            strategistToBailOut
        );
        for (uint i = 0; i < data.length; i++) {
            handleStratOrderAtID(data[i]);
        }
    }

    function flipKillSwitchOff() external {
        require(msg.sender == killSwitchOperator || msg.sender == admin);
        killed = false;
    }

    modifier blockIfKillSwitchIsFlipped() {
        require(!killed, "The switch has been flipped");
        _;
    }

    // *** Internal Functions ***

    /// @notice Internal function to provide the next unique StrategistTrade ID
    function _next_id() internal returns (uint256) {
        last_stratTrade_id++;
        return last_stratTrade_id;
    }

    /// @notice This function results in the removal of the Strategist Trade (bid and/or ask on Rubicon Market) from the books and it being deleted from the contract
    /// @dev The local array of strategist IDs that exists for any given strategist [query via getOutstandingStrategistTrades()] acts as an acitve RAM for outstanding strategist trades
    /// @dev Cancels outstanding orders and manages outstanding Strategist Trades memory accordingly
    function handleStratOrderAtID(uint256 id) internal {
        StrategistTrade memory info = strategistTrades[id];
        address _asset = info.askAsset;
        address _quote = info.bidAsset;

        order memory offer1 = getOfferInfo(info.askId); //ask
        order memory offer2 = getOfferInfo(info.bidId); //bid
        uint256 askDelta = info.askPayAmt.sub(offer1.pay_amt);
        uint256 bidDelta = info.bidPayAmt.sub(offer2.pay_amt);

        // NO ACCOUNTING BUT DO CANCEL THE ORDERS
        // if real
        address _RubiconMarketAddress = RubiconMarketAddress;
        if (info.askId != 0) {
            // if delta > 0 - delta is fill => handle any amount of fill here
            if (askDelta > 0) {
                // not a full fill
                if (askDelta != info.askPayAmt) {
                    IRubiconMarket(_RubiconMarketAddress).cancel(info.askId);
                }
            }
            // otherwise didn't fill so cancel
            else {
                IRubiconMarket(_RubiconMarketAddress).cancel(info.askId);
            }
        }

        // if real
        if (info.bidId != 0) {
            // if delta > 0 - delta is fill => handle any amount of fill here
            if (bidDelta > 0) {
                // not a full fill
                if (bidDelta != info.bidPayAmt) {
                    IRubiconMarket(_RubiconMarketAddress).cancel(info.bidId);
                }
            }
            // otherwise didn't fill so cancel
            else {
                IRubiconMarket(_RubiconMarketAddress).cancel(info.bidId);
            }
        }

        // Delete the order from outOffersByStrategist
        uint256 target = getIndexFromElement(
            id,
            outOffersByStrategist[_asset][_quote][info.strategist]
        );
        uint256[] storage current = outOffersByStrategist[_asset][_quote][
            info.strategist
        ];
        current[target] = current[current.length - 1];
        current.pop(); // Assign the last value to the value we want to delete and pop, best way to do this in solc AFAIK

        emit LogScrubbedStratTrade(id, askDelta, _asset, bidDelta, _quote);
    }

    /// @notice Get information about a Rubicon Market offer and return it as an order
    function getOfferInfo(uint256 id) internal view returns (order memory) {
        (
            uint256 ask_amt,
            IERC20 ask_gem,
            uint256 bid_amt,
            IERC20 bid_gem
        ) = IRubiconMarket(RubiconMarketAddress).getOffer(id);
        order memory offerInfo = order(ask_amt, ask_gem, bid_amt, bid_gem);
        return offerInfo;
    }

    /// @notice A function that returns the index of a uid from an array
    /// @dev uid *must* be in array for the purposes of this contract to *enforce outstanding trades per strategist are tracked correctly* - strategist can only cancel a valid offer
    function getIndexFromElement(
        uint256 uid,
        uint256[] storage array
    ) internal view returns (uint256 _index) {
        bool assigned = false;
        for (uint256 index = 0; index < array.length; index++) {
            if (uid == array[index]) {
                _index = index;
                assigned = true;
                return _index;
            }
        }
        require(assigned, "Didnt Find that element in live list, cannot scrub");
    }

    /// @dev function for infinite approvals of Rubicon Market
    function approveAssetOnMarket(
        address toApprove
    ) private beGoneReentrantScum {
        require(
            RubiconMarketAddress != address(this) &&
                RubiconMarketAddress != address(0),
            "Market Aid not initialized"
        );
        // Approve exchange
        IERC20(toApprove).safeApprove(RubiconMarketAddress, 2 ** 256 - 1);
    }

    /// @notice Low-level gaurd to ensure the market-maker does not trade with themselves
    /// @dev Take a single order pair, BID and ASK and make sure they don't fill with themselves
    function selfTradeProtection(
        uint256 askNum,
        uint256 askDen,
        uint256 bidNum,
        uint256 bidDen
    ) internal pure {
        require(
            // Pure case
            (askDen * bidDen > bidNum * askNum) ||
                /// @dev note that if one order is zero then self-trade is not possible
                (askDen == 0 && askNum == 0) ||
                (bidNum == 0 && bidDen == 0),
            "The trades must not match with self"
        );
    }

    // *** External Functions - Only Approved Strategists ***

    /// @notice Key entry point for strategists to place market-making trades on the Rubicon Order Book
    /// @dev note that this assumes the ERC-20s are sitting on this contract; this is helpful as all fill is returned to this contract from RubiconMarket.sol
    function placeMarketMakingTrades(
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256 askNumerator, // Quote / Asset
        uint256 askDenominator, // Asset / Quote
        uint256 bidNumerator, // size in ASSET
        uint256 bidDenominator, // size in QUOTES
        address recipient
    )
        public
        onlyApprovedStrategist
        blockIfKillSwitchIsFlipped
        returns (uint256 id)
    {
        // Require at least one order is non-zero
        require(
            (askNumerator > 0 && askDenominator > 0) ||
                (bidNumerator > 0 && bidDenominator > 0),
            "one order must be non-zero"
        );

        // *** Low-Level Self Trade Protection ***
        selfTradeProtection(
            askNumerator,
            askDenominator,
            bidNumerator,
            bidDenominator
        );

        address _underlyingAsset = tokenPair[0];
        address _underlyingQuote = tokenPair[1];
        address _RubiconMarketAddress = RubiconMarketAddress;

        // Calculate new bid and/or ask
        order memory ask = order(
            askNumerator,
            IERC20(_underlyingAsset),
            askDenominator,
            IERC20(_underlyingQuote)
        );
        order memory bid = order(
            bidNumerator,
            IERC20(_underlyingQuote),
            bidDenominator,
            IERC20(_underlyingAsset)
        );

        require(
            IERC20(ask.pay_gem).balanceOf(address(this)) > ask.pay_amt &&
                IERC20(bid.pay_gem).balanceOf(address(this)) > bid.pay_amt,
            "Not enough ERC20s to market make this call"
        );

        address input = address(ask.pay_gem);
        if (
            IERC20(input).allowance(address(this), _RubiconMarketAddress) <=
            ask.pay_amt
        ) {
            approveAssetOnMarket(input);
        }
        address _input = address(bid.pay_gem);
        if (
            IERC20(_input).allowance(address(this), _RubiconMarketAddress) <=
            bid.pay_amt
        ) {
            approveAssetOnMarket(_input);
        }

        uint256 newAskID;
        uint256 newBidID;
        // We know one is nonzero, If both orders are non-zero
        if (
            (askNumerator > 0 && askDenominator > 0) &&
            (bidNumerator > 0 && bidDenominator > 0)
        ) {
            // // Place new bid and/or ask
            newAskID = IRubiconMarket(_RubiconMarketAddress).offer(
                ask.pay_amt,
                ask.pay_gem,
                ask.buy_amt,
                ask.buy_gem,
                0,
                true
            );
            newBidID = IRubiconMarket(_RubiconMarketAddress).offer(
                bid.pay_amt,
                bid.pay_gem,
                bid.buy_amt,
                bid.buy_gem,
                0,
                true
            );
        } else if (askNumerator > 0 && askDenominator > 0) {
            newAskID = IRubiconMarket(_RubiconMarketAddress).offer(
                ask.pay_amt,
                ask.pay_gem,
                ask.buy_amt,
                ask.buy_gem,
                0,
                true
            );
        } else {
            newBidID = IRubiconMarket(_RubiconMarketAddress).offer(
                bid.pay_amt,
                bid.pay_gem,
                bid.buy_amt,
                bid.buy_gem,
                0,
                true
            );
        }

        // Strategist trade is recorded so they can get paid and the trade is logged for time
        StrategistTrade memory outgoing = StrategistTrade(
            newAskID,
            ask.pay_amt,
            _underlyingAsset,
            newBidID,
            bid.pay_amt,
            _underlyingQuote,
            recipient,
            block.timestamp
        );

        // Give each trade a unique id for easy handling by strategists
        id = _next_id();
        strategistTrades[id] = outgoing;
        // Allow strategists to easily call a list of their outstanding offers
        outOffersByStrategist[_underlyingAsset][_underlyingQuote][recipient]
            .push(id);

        emit LogStrategistTrade(
            id,
            bytes32(outgoing.askId),
            bytes32(outgoing.bidId),
            outgoing.askAsset,
            outgoing.bidAsset,
            block.timestamp,
            outgoing.strategist
        );
    }

    function placeMarketMakingTrades(
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256 askNumerator, // Quote / Asset
        uint256 askDenominator, // Asset / Quote
        uint256 bidNumerator, // size in ASSET
        uint256 bidDenominator // size in QUOTES
    ) public returns (uint256 id) {
        return
            placeMarketMakingTrades(
                tokenPair,
                askNumerator,
                askDenominator,
                bidNumerator,
                bidDenominator,
                msg.sender
            );
    }

    /// @notice A function to batch together many placeMarketMakingTrades() in a single transaction
    /// @dev this can be used to make an entire liquidity curve in a single transaction
    function batchMarketMakingTrades(
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256[] memory askNumerators, // Quote / Asset
        uint256[] memory askDenominators, // Asset / Quote
        uint256[] memory bidNumerators, // size in ASSET
        uint256[] memory bidDenominators, // size in QUOTES
        address recipient
    ) public onlyApprovedStrategist blockIfKillSwitchIsFlipped {
        /// Note: probably a redundant onlyApprovedStrategistCall?
        require(
            askNumerators.length == askDenominators.length &&
                askDenominators.length == bidNumerators.length &&
                bidNumerators.length == bidDenominators.length,
            "not all order lengths match"
        );
        uint256 quantity = askNumerators.length;

        uint256[] memory trades = new uint256[](quantity);

        for (uint256 index = 0; index < quantity; index++) {
            uint256 id = placeMarketMakingTrades(
                tokenPair,
                askNumerators[index],
                askDenominators[index],
                bidNumerators[index],
                bidDenominators[index],
                recipient
            );
            trades[index] = id;
        }
        emit LogBatchMarketMakingTrades(recipient, (trades));
    }

    function batchMarketMakingTrades(
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256[] memory askNumerators, // Quote / Asset
        uint256[] memory askDenominators, // Asset / Quote
        uint256[] memory bidNumerators, // size in ASSET
        uint256[] memory bidDenominators // size in QUOTES
    ) public {
        return
            batchMarketMakingTrades(
                tokenPair,
                askNumerators,
                askDenominators,
                bidNumerators,
                bidDenominators,
                msg.sender
            );
    }

    /// @notice A function to requote an outstanding order and replace it with a new Strategist Trade
    /// @dev Note that this function will create a new unique id for the requote'd ID due to the low-level functionality
    function requote(
        uint256 id,
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256 askNumerator, // Quote / Asset
        uint256 askDenominator, // Asset / Quote
        uint256 bidNumerator, // size in ASSET
        uint256 bidDenominator, // size in QUOTES
        address recipient
    ) public onlyApprovedStrategist blockIfKillSwitchIsFlipped {
        // 1. Scrub strat trade
        scrubStrategistTrade(id);

        // 2. Place another
        uint256 newOfferID = placeMarketMakingTrades(
            tokenPair,
            askNumerator,
            askDenominator,
            bidNumerator,
            bidDenominator,
            recipient
        );

        emit LogRequote(recipient, id, (newOfferID));
    }

    function requote(
        uint256 id,
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256 askNumerator, // Quote / Asset
        uint256 askDenominator, // Asset / Quote
        uint256 bidNumerator, // size in ASSET
        uint256 bidDenominator
    ) public {
        return
            requote(
                id,
                tokenPair,
                askNumerator,
                askDenominator,
                bidNumerator,
                bidDenominator,
                msg.sender
            );
    }

    /// @notice A function to batch together many requote() calls in a single transaction
    /// @dev Ids and input are indexed through to execute requotes
    /// @dev this can be used to update an entire liquidity curve in a single transaction
    function batchRequoteOffers(
        uint256[] memory ids,
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256[] memory askNumerators, // Quote / Asset
        uint256[] memory askDenominators, // Asset / Quote
        uint256[] memory bidNumerators, // size in ASSET
        uint256[] memory bidDenominators, // size in QUOTES
        address recipient
    ) public onlyApprovedStrategist blockIfKillSwitchIsFlipped {
        require(
            askNumerators.length == askDenominators.length &&
                askDenominators.length == bidNumerators.length &&
                bidNumerators.length == bidDenominators.length &&
                ids.length == askNumerators.length,
            "not all input lengths match"
        );

        // Scrub the orders
        scrubStrategistTrades(ids);

        // Then Batch market make
        batchMarketMakingTrades(
            tokenPair,
            askNumerators,
            askDenominators,
            bidNumerators,
            bidDenominators,
            recipient
        );

        emit LogBatchRequoteOffers(recipient, ids);
    }

    function batchRequoteOffers(
        uint256[] memory ids,
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256[] memory askNumerators, // Quote / Asset
        uint256[] memory askDenominators, // Asset / Quote
        uint256[] memory bidNumerators, // size in ASSET
        uint256[] memory bidDenominators // size in QUOTES
    ) public {
        return
            batchRequoteOffers(
                ids,
                tokenPair,
                askNumerators,
                askDenominators,
                bidNumerators,
                bidDenominators,
                msg.sender
            );
    }

    /// @dev function to requote all the outstanding offers for msg.sender
    /// @dev this can be used to update an entire liquidity curve in a single transaction
    function batchRequoteAllOffers(
        address[2] memory tokenPair, // ASSET, Then Quote
        uint256[] memory askNumerators, // Quote / Asset
        uint256[] memory askDenominators, // Asset / Quote
        uint256[] memory bidNumerators, // size in ASSET
        uint256[] memory bidDenominators // size in QUOTES
    ) external {
        uint[] memory stratIds = getOutstandingStrategistTrades(
            tokenPair[0],
            tokenPair[1],
            msg.sender
        );
        return
            batchRequoteOffers(
                stratIds,
                tokenPair,
                askNumerators,
                askDenominators,
                bidNumerators,
                bidDenominators
            );
    }

    /// @notice Cancel an outstanding strategist offers and return funds to LPs while logging fills
    function scrubStrategistTrade(uint256 id) public {
        require(
            msg.sender == strategistTrades[id].strategist ||
                msg.sender == killSwitchOperator ||
                msg.sender == address(this) ||
                isApprovedStrategist(msg.sender) == true,
            "you are not the strategist that made this order"
        );
        handleStratOrderAtID(id);
    }

    /// @notice Batch scrub outstanding strategist trades and return funds here
    /// @dev this can be used to wipe an entire liquidity curve in a single transaction
    function scrubStrategistTrades(
        uint256[] memory ids
    ) public onlyApprovedStrategist {
        for (uint256 index = 0; index < ids.length; index++) {
            uint256 _id = ids[index];
            scrubStrategistTrade(_id);
        }
    }

    function adminRebalanceFunds(
        address assetToSell,
        uint256 amountToSell,
        address assetToTarget
    ) external onlyAdmin returns (uint256 fill_amt) {
        // Market order in one direction to rebalance for market-making
        return
            IRubiconMarket(RubiconMarketAddress).sellAllAmount(
                IERC20(assetToSell),
                amountToSell,
                IERC20(assetToTarget),
                0
            );
    }

    /// @dev This contract may be needed to approve external targets - e.g. use of strategistRebalanceFunds()
    function adminMaxApproveTarget(
        address target,
        address token
    ) external onlyAdmin {
        // Market order in one direction to rebalance for market-making
        IERC20(token).approve(target, type(uint256).max);
    }

    function adminPullAllFunds(address[] memory erc20s) external onlyAdmin {
        address _admin = admin;
        require(_admin != address(0));
        for (uint i = 0; i < erc20s.length; i++) {
            uint amount = IERC20(erc20s[i]).balanceOf(address(this));
            IERC20(erc20s[i]).transfer(_admin, amount);
            emit LogAdminPullFunds(_admin, erc20s[i], amount, block.timestamp);
        }
    }

    /// @notice Best entry point to deposit funds as a market-maker because it enables subgraph fueled PNL tracking
    /// @dev make sure to approve this contract to pull your funds too
    function adminDepositToBook(
        address[] memory erc20s,
        uint[] calldata amounts
    ) external onlyAdmin {
        address _admin = admin;
        require(_admin != address(0) && erc20s.length == amounts.length);
        for (uint i = 0; i < erc20s.length; i++) {
            uint amount = amounts[i];
            IERC20(erc20s[i]).transferFrom(msg.sender, address(this), amount);
            emit LogBookUpdate(
                msg.sender,
                erc20s[i],
                int(amount),
                block.timestamp
            );
        }
    }

    /// @notice Best entry point to deposit funds as a market-maker because it enables subgraph fueled PNL tracking
    function adminWithdrawFromBook(
        address[] memory erc20s,
        uint[] calldata amounts
    ) external onlyAdmin {
        address _admin = admin;
        require(_admin != address(0) && erc20s.length == amounts.length);
        for (uint i = 0; i < erc20s.length; i++) {
            uint amount = amounts[i];
            IERC20(erc20s[i]).transfer(_admin, amount);
            emit LogBookUpdate(
                _admin,
                erc20s[i],
                int(amount) * -1,
                block.timestamp
            );
        }
    }

    /// @dev Market order in one direction to tap an external venue for arbitrage or rebalancing - e.g. UNI here
    function strategistRebalanceFunds(
        address assetToSell,
        uint256 amountToSell,
        address assetToTarget,
        uint24 poolFee //** new variable */
    ) public onlyApprovedStrategist returns (uint256 amountOut) {
        // *** ability to target AMM for rebalancing the book ***
        ISwapRouter swapRouter = ISwapRouter(
            address(0xE592427A0AEce92De3Edee1F18E0157C05861564)
        );
        if (
            IERC20(assetToSell).allowance(address(this), address(swapRouter)) <=
            amountToSell
        ) {
            IERC20(assetToSell).approve(address(swapRouter), amountToSell);
        }
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: assetToSell,
                tokenOut: assetToTarget,
                fee: poolFee,
                recipient: address(this), //keep funds here
                deadline: block.timestamp,
                amountIn: amountToSell,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });

        amountOut = swapRouter.exactInputSingle(params);
        // uni is fee inclusive so we do not need to add in the fee here
        emit LogExternalSwap(
            msg.sender,
            assetToSell,
            assetToTarget,
            amountToSell,
            amountOut,
            address(0xE592427A0AEce92De3Edee1F18E0157C05861564)
        );

        // Return the `amountOut` if the external call is successful
        return amountOut;
    }

    /// @notice Atomic arbitrage between Rubicon and UNI - Rubicon then UNI
    /// @dev Safely fails and does not break execution via try/catch if the arb is not profitable
    /// @dev Uses sellAllAmount on Rubicon with amountToSell and then takes that fill and uses strategistRebalanceFunds for the UNI side of the arb
    function _executeArbitrage0(
        address assetToSell,
        uint256 amountToSell,
        address assetToTarget,
        uint24 poolFee //** new variable */
    ) private returns (uint profit) {
        // Rubicon Leg of the trade
        uint256 fill_amt;
        address _RubiconMarketAddress = RubiconMarketAddress;

        /// @dev approval calls should be done via adminMaxApproveTarget() to avoid reverts
        // IERC20(assetToSell).approve(_RubiconMarketAddress, amountToSell);
        fill_amt = IRubiconMarket(_RubiconMarketAddress).sellAllAmount(
            IERC20(assetToSell),
            amountToSell,
            IERC20(assetToTarget),
            0
        );

        // UNI Leg of the trade
        uint256 amountOut = strategistRebalanceFunds(
            assetToTarget,
            fill_amt,
            assetToSell,
            poolFee
        );

        // If amountOut is greater than amountToSell, then we have a profit and we can return it
        require(amountOut > amountToSell, "Arbitrage not profitable");
        return amountOut - amountToSell;
    }

    function _executeArbitrage1(
        address assetToSell,
        uint256 amountToSell,
        address assetToTarget,
        uint24 poolFee //** new variable */
    ) private returns (uint profit) {
        // UNI Leg of the trade
        uint256 fill_amt = strategistRebalanceFunds(
            assetToSell,
            amountToSell,
            assetToTarget,
            poolFee
        );

        // Rubicon Leg of the trade
        uint256 amountOut = 0;
        address _RubiconMarketAddress = RubiconMarketAddress;
        /// @dev approval calls should be done via adminMaxApproveTarget() to avoid reverts
        // IERC20(assetToTarget).approve(_RubiconMarketAddress, fill_amt); // Add approve function for the asset being sold
        amountOut = IRubiconMarket(_RubiconMarketAddress).sellAllAmount(
            IERC20(assetToTarget),
            fill_amt,
            IERC20(assetToSell),
            0
        );

        // If amountOut is greater than amountToSell, then we have a profit and we can return it
        require(amountOut > amountToSell, "Arbitrage not profitable");
        return amountOut - amountToSell;
    }

    /// @notice Atomic arbitrage between Rubicon and UNI
    /// @dev Safely fails and does not break execution via try/catch if the arb is not profitable
    function captureAtomicArbOrPass(
        address assetToSell,
        uint256 amountToSell,
        address assetToTarget,
        uint24 poolFee, //** new variable */
        bool isBuyRubiconFirst
    ) public onlyApprovedStrategist {
        uint arbProfitIfAny;
        if (isBuyRubiconFirst) {
            arbProfitIfAny = _executeArbitrage0(
                assetToSell,
                amountToSell,
                assetToTarget,
                poolFee
            );
        } else {
            arbProfitIfAny = _executeArbitrage1(
                assetToSell,
                amountToSell,
                assetToTarget,
                poolFee
            );
        }

        // If we have a profit, then we can emit the event
        if (arbProfitIfAny > 0) {
            emit LogAtomicArbitrage(
                msg.sender,
                assetToSell,
                assetToTarget,
                amountToSell,
                arbProfitIfAny,
                poolFee,
                isBuyRubiconFirst,
                block.timestamp
            );
        }
    }

    /// @notice External entrypoint to batch together any arbitrary transactions calling public functions on this contract
    /// @dev notice that this address must be an approved strategist for this functionality to work
    function batchBox(
        bytes[] memory data
    )
        external
        blockIfKillSwitchIsFlipped
        onlyApprovedStrategist
        returns (bytes[] memory results)
    {
        results = this.multicall(data);
    }

    /// *** View Functions ***

    /// @notice The goal of this function is to enable a means to retrieve all outstanding orders a strategist has live in the books
    /// @dev This is helpful to manage orders as well as track all strategist orders (like their RAM of StratTrade IDs) and place any would-be constraints on strategists
    function getOutstandingStrategistTrades(
        address asset,
        address quote,
        address strategist
    ) public view returns (uint256[] memory) {
        // Could make onlyApprovedStrategist for stealth mode optionally 😎
        return outOffersByStrategist[asset][quote][strategist];
    }

    /// @notice returns the total amount of ERC20s (quote and asset) that the strategist has
    ///             in SUM on this contract AND the market place.
    function getStrategistTotalLiquidity(
        address asset,
        address quote,
        address strategist
    )
        public
        view
        returns (uint256 quoteWeiAmount, uint256 assetWeiAmount, bool status)
    {
        require(RubiconMarketAddress != address(0), "bad market address");
        uint256 quoteLocalBalance = IERC20(quote).balanceOf(address(this));
        uint256 assetLocalBalance = IERC20(asset).balanceOf(address(this));

        uint256[] memory stratBook = getOutstandingStrategistTrades(
            asset,
            quote,
            strategist
        );

        uint256 quoteOnChainBalance = 0;
        uint256 assetOnChainBalance = 0;
        if (stratBook.length > 0) {
            for (uint256 index = 0; index < stratBook.length; index++) {
                StrategistTrade memory info = strategistTrades[
                    stratBook[index]
                ];

                // Get ERC20 balances of this strategist on the books
                (uint256 quoteOnChainOrderValue, , , ) = IRubiconMarket(
                    RubiconMarketAddress
                ).getOffer(info.bidId);
                (
                    uint256 assetOnChainOrderValue, // Stack too deep so only sanity check on quote below
                    ,
                    ,

                ) = IRubiconMarket(RubiconMarketAddress).getOffer(info.askId);

                quoteOnChainBalance += quoteOnChainOrderValue;
                assetOnChainBalance += assetOnChainOrderValue;
            }
        }

        if (quoteOnChainBalance > 0 || assetOnChainBalance > 0) {
            status = true;
        }

        quoteWeiAmount = quoteLocalBalance + quoteOnChainBalance;
        assetWeiAmount = assetLocalBalance + assetOnChainBalance;
    }

    // Define a struct to hold the order details (uint256, ERC20, uint256, ERC20)
    struct MarketOffer {
        uint relevantStratTradeId;
        uint256 bidPay;
        uint256 bidBuy;
        uint256 askPay;
        uint256 askBuy;
    }

    /// @notice View function that gets a strategist's outOffersByStrategist, then loops through them and queries the market for the order details via getOffer
    /// @dev This will return the order details for all orders a strategist has live in the books - their on-chain book with all relevant data
    function getStrategistBookWithPriceData(
        address asset,
        address quote,
        address strategist
    ) public view returns (MarketOffer[] memory ordersOnBook) {
        uint256[] memory stratBook = getOutstandingStrategistTrades(
            asset,
            quote,
            strategist
        );

        if (stratBook.length > 0) {
            ordersOnBook = new MarketOffer[](stratBook.length);

            for (uint256 index = 0; index < stratBook.length; index++) {
                StrategistTrade memory info = strategistTrades[
                    stratBook[index]
                ];

                // Get ERC20 balances of this strategist on the books
                (uint256 _bidPay, , uint256 _bidBuy, ) = IRubiconMarket(
                    RubiconMarketAddress
                ).getOffer(info.bidId);
                (uint256 _askPay, , uint256 _askBuy, ) = IRubiconMarket(
                    RubiconMarketAddress
                ).getOffer(info.askId);

                ordersOnBook[index] = MarketOffer({
                    relevantStratTradeId: stratBook[index],
                    bidPay: _bidPay,
                    bidBuy: _bidBuy,
                    askPay: _askPay,
                    askBuy: _askBuy
                });
            }
        }

        return ordersOnBook;
    }
}
