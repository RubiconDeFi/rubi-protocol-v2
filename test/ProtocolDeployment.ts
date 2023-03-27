import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { formatUnits, parseUnits } from "ethers/lib/utils";

// TODO: Implement Proxy-wrapping helper functions and proxy-wrapped contracts generally
describe("Rubicon v2 Protocol Tests", function () {
  const FEE_TO = "0x0000000000000000000000000000000000000FEE";

  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployRubiconProtocolFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, otherAccount, testMaker] = await ethers.getSigners();

    // Use Compound Fork to spawn some cTokens...
    // Note: In prod COMP uses Unitroller for Comptroller storage and upgradeability*
    const ComptrollerFactory = await ethers.getContractFactory("Comptroller");
    const comptroller = await ComptrollerFactory.deploy(); // TODO: Rename to bath house?

    // Deploy Test ERC20 to use throughout testing
    const testCoinFactory = await ethers.getContractFactory("TokenWithFaucet");
    const testCoin = await testCoinFactory.deploy(
      owner.address,
      "Test",
      "TEST",
      18
    );
    const testStableCoin = await testCoinFactory.deploy(
      owner.address,
      "Test Stablecoin",
      "TUSDC",
      6
    );

    const WETH = await ethers.getContractFactory("WETH9");
    const weth = await WETH.deploy();
    const RubiconMarketFactory = await ethers.getContractFactory(
      "RubiconMarket"
    );
    const rubiconMarket = await RubiconMarketFactory.deploy();
    await rubiconMarket.initialize(FEE_TO);
    await rubiconMarket.setFeeBPS(10);

    const interestRateModelFactory = await ethers.getContractFactory(
      "WhitePaperInterestRateModel"
    );

    // Inputs
    const baseRatePerYear = parseUnits("0.3"); //  TODO: WHAT SHOULD THIS BE?
    const multiplierPerYear = parseUnits("0.02"); //  TODO: WHAT SHOULD THIS BE?
    const irModel = await interestRateModelFactory.deploy(
      baseRatePerYear,
      multiplierPerYear
    );

    const cTokenFactory = await ethers.getContractFactory("CErc20Delegate");
    const cTokenImplementation = await cTokenFactory.deploy();

    // https://docs.compound.finance/v2/ctokens/#exchange-rate
    const stableExchangeRateMantissa = "2000000000000000";

    // Initialize the market
    const underlying = testCoin.address;
    const interestRateModel = irModel.address;
    const initialExchangeRateMantissa = "200000000000000000000000000"; // TODO: What should this be?
    const name = "Test Bath Token"; // TODO: move this process to Bath House factory
    const symbol = "bathTEST";
    const decimal = 18;

    const becomeImplementationData = "0x"; //TODO: What should this be?

    const cTokenDelegatorFactory = await ethers.getContractFactory(
      "CErc20Delegator"
    );

    // Note, admin deploys new cTokens
    const cToken = await cTokenDelegatorFactory
      .deploy(
        underlying,
        comptroller.address,
        interestRateModel,
        initialExchangeRateMantissa,
        name,
        symbol,
        decimal,
        owner.address, // Admin!
        cTokenImplementation.address,
        becomeImplementationData
      )
      .catch((e) => {
        console.log("\nError deploying cToken!", e.reason, "\n");
      });

    // Setup cToken in System correctly:
    await comptroller._supportMarket(cToken!.address).catch((e: any) => {
      console.log("\nError supporting new cToken market!", e.reason, "\n");
    });

    // Deploy a cToken for a TUSD - test stable pair. Use same params as above when possible
    // Note, admin deploys new cTokens
    const cTokenStable = await cTokenDelegatorFactory
      .deploy(
        testStableCoin.address,
        comptroller.address,
        interestRateModel,
        stableExchangeRateMantissa,
        name,
        "bathTUSDC",
        6,
        owner.address, // Admin!
        cTokenImplementation.address,
        becomeImplementationData
      )
      .catch((e) => {
        console.log("\nError deploying stable cToken!", e.reason, "\n");
      });

    // Setup cToken in System correctly:
    await comptroller._supportMarket(cTokenStable!.address).catch((e: any) => {
      console.log("\nError supporting new cToken market!", e.reason, "\n");
    });

    const cWETH = await cTokenDelegatorFactory
      .deploy(
        weth.address,
        comptroller.address,
        interestRateModel,
        initialExchangeRateMantissa,
        "WETH",
        "WETH",
        decimal,
        owner.address, // Admin!
        cTokenImplementation.address,
        becomeImplementationData
      )
      .catch((e) => {
        console.log("\nError deploying cWETH!", e.reason, "\n");
      });
    await comptroller._supportMarket(cWETH!.address).catch((e: any) => {
      console.log("\nError supporting new cToken market!", e.reason, "\n");
    });

    // Make a liquid ERC-20 pair for testCoin and testStableCoin. Bid at $90 ask at $110.
    await testCoin.connect(owner).faucet();
    await testCoin.connect(otherAccount).faucet();
    await testStableCoin.connect(owner).faucet();
    await testStableCoin.connect(testMaker).faucet();
    await testCoin!
      .connect(owner)
      .approve(rubiconMarket.address, parseUnits("100000"));
    await testStableCoin!
      .connect(owner)
      .approve(rubiconMarket.address, parseUnits("100000"));

    await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
      parseUnits("90", 6),
      testStableCoin.address,
      parseUnits("100"),
      testCoin.address,
      { from: owner.address }
    );
    await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
      parseUnits("100"),
      testCoin.address,
      parseUnits("110", 6),
      testStableCoin.address,
      { from: owner.address }
    );

    // *** Deploy a MarketAid Factory through which the user can create their own instance of Market Aid ***
    const marketAidFactory = await ethers.getContractFactory(
      "MarketAidFactory"
    );
    const marketAidFactoryInstance = await marketAidFactory.deploy();
    await marketAidFactoryInstance.initialize(rubiconMarket.address);

    const RubiconRouter = await ethers.getContractFactory("RubiconRouter");
    const router = await RubiconRouter.deploy();
    await router.startErUp(rubiconMarket.address, weth.address);

    await testCoin!.connect(owner).approve(router.address, parseUnits("320"));

    // MAKE WETH/TEST MARKETS
    await router.functions[
      "offerWithETH(uint256,uint256,address,uint256,address)"
    ](parseUnits("10"), parseUnits("300"), testCoin.address, 0, owner.address, {
      value: parseUnits("10"),
      from: owner.address,
    });
    await router.functions[
      "offerForETH(uint256,address,uint256,uint256,address)"
    ](parseUnits("300"), testCoin.address, parseUnits("11"), 0, owner.address, {
      from: owner.address,
    });

    return {
      rubiconMarket,
      comptroller,
      testCoin,
      cToken,
      owner,
      testMaker,
      otherAccount,
      testStableCoin,
      cTokenStable,
      marketAidFactoryInstance,
      router,
      weth,
      cWETH,
    };
  }

  describe("Protocol Tests", async function () {
    // *** Core ***
    describe("Rubicon Market", function () {
      it("Can be initialized correctly", async function () {
        const { rubiconMarket } = await loadFixture(
          deployRubiconProtocolFixture
        );

        expect(await rubiconMarket.initialized()).to.equal(true);
      });
      it("Has the right admin", async function () {
        const { rubiconMarket, owner } = await loadFixture(
          deployRubiconProtocolFixture
        );

        expect(await rubiconMarket.owner()).to.equal(owner.address);
      });
      it("Has the right fee recipient?", async function () {
        const { rubiconMarket } = await loadFixture(
          deployRubiconProtocolFixture
        );

        const feeRecipient = await rubiconMarket.getFeeTo();

        expect(feeRecipient).to.equal(FEE_TO);
      });

      it("Matching, buying, and market variables enabled?", async function () {
        const { rubiconMarket } = await loadFixture(
          deployRubiconProtocolFixture
        );

        const matchingEnabled = await rubiconMarket.matchingEnabled();
        const buyEnabled = await rubiconMarket.buyEnabled();

        expect(matchingEnabled).to.equal(true);
        expect(buyEnabled).to.equal(true);
      });

      it("Offer has right owner and recipient?", async function () {
        const { testStableCoin, testCoin, rubiconMarket, owner, otherAccount } =
          await loadFixture(deployRubiconProtocolFixture);
        await rubiconMarket.functions[
          "offer(uint256,address,uint256,address,address,address)"
        ](
          parseUnits("0.9", 6),
          testStableCoin.address,
          parseUnits("1"),
          testCoin.address,
          owner.address, // owner
          otherAccount.address, // recipient
          { from: owner.address }
        );

        expect(await rubiconMarket.getOwner(5)).to.equal(owner.address);
        expect(await rubiconMarket.getRecipient(5)).to.equal(
          otherAccount.address
        );
      });
    });

    describe("Rubicon Pools", function () {
      it("Comptroller Has the right admin?", async function () {
        const { comptroller, owner } = await loadFixture(
          deployRubiconProtocolFixture
        );

        expect(await comptroller.admin()).to.equal(owner.address);
      });
      it("cToken correctly spawned for test coin?", async function () {
        const { comptroller, cToken } = await loadFixture(
          deployRubiconProtocolFixture
        );

        const targetCTokenAddress = cToken!.address;
        const out = await comptroller.markets(targetCTokenAddress);

        // Live market and no bonus rewards
        expect(out.isListed).to.equal(true);
        expect(out.isComped).to.equal(false);
      });
      it("bath tokens have the right name, symbol, and decimals?", async function () {
        const { cToken } = await loadFixture(deployRubiconProtocolFixture);

        const name = await cToken!.name();
        const symbol = await cToken!.symbol();
        const decimals = await cToken!.decimals();

        expect(name).to.equal("Test Bath Token");
        expect(symbol).to.equal("bathTEST");
        expect(decimals).to.equal(18);
      });
      it("a user can deposit into a bath token and withdraw?", async function () {
        const { owner, cToken, testCoin } = await loadFixture(
          deployRubiconProtocolFixture
        );

        // Mint coins to the owner to then deposit
        const balance = await testCoin.balanceOf(owner.address);
        expect(balance).to.be.gte(0);

        // deposit
        await testCoin!
          .connect(owner)
          .approve(cToken!.address, parseUnits("100"));
        await cToken!.connect(owner).mint(parseUnits("100"));

        const cTokenBalance = await cToken!.balanceOf(owner.address);
        expect(cTokenBalance).to.be.gte(0);

        // // Fast forward the clock to earn yield?
        // await network.provider.send(
        //   "evm_increaseTime", [420000000000]
        // );

        await cToken!.connect(owner).redeem(cTokenBalance);
        const newBal = await testCoin.balanceOf(owner.address);
        expect(newBal).to.equal(balance);
      });

      it("all bath tokens of the blue-chip tier can be queried easily?", async function () {
        const { comptroller } = await loadFixture(deployRubiconProtocolFixture);

        // Return a list of all the bath tokens in the CL-feed, cToken-fork tier
        const markets = await comptroller.getAllMarkets();
        expect(markets.length).to.equal(3);
      });
      // it("an underwater user can be liquidated?", async function () {
      //   // ** Market Fixture **
      //   // Need to dump the pair to cause liquidation - ?? May need to manipulate a chain link feed somehow for testing
      //   // TODO: investigate use of ChainLink in the cTOKEN model
      //   // Note, liquidator must approve cToken spend on borrow they are liquidating?
      // });
    });

    // *** Utilities ***

    describe("Market Aid", function () {
      // *** TODO ***
      it("the marketAid factory is deployed with right params?", async function () {
        const { rubiconMarket, marketAidFactoryInstance, owner } =
          await loadFixture(deployRubiconProtocolFixture);
        expect(await marketAidFactoryInstance.rubiconMarket()).to.equal(
          rubiconMarket.address
        );
        expect(await marketAidFactoryInstance.admin()).to.equal(owner.address);
        expect(await marketAidFactoryInstance.initialized()).to.equal(true);
      });
      it("Market aid can create a new user instance via createMarketAidInstance?", async function () {
        const { marketAidFactoryInstance, owner, rubiconMarket } =
          await loadFixture(deployRubiconProtocolFixture);

        const marketAidFactory = await ethers.getContractFactory("MarketAid");
        await marketAidFactoryInstance.createMarketAidInstance({
          from: owner.address,
        });

        const myMarketAid: string = (
          await marketAidFactoryInstance.getUserMarketAids(owner.address)
        )[0];
        const myMarketAidInstance = marketAidFactory.attach(myMarketAid);
        const _admin = await myMarketAidInstance.admin();
        const _market = await myMarketAidInstance.RubiconMarketAddress();
        expect(_admin).to.equal(owner.address);
        expect(_market).to.equal(rubiconMarket.address);
      });
    });

    describe("Check da feez", function () {
      it("can properly set maker fee?", async function () {
        const { rubiconMarket } = await loadFixture(
          deployRubiconProtocolFixture
        );

        const fee = 10;

        await rubiconMarket.setMakerFee(fee);
        const _fee = await rubiconMarket.makerFee();
        expect(_fee).to.be.equal(fee);
      });

      it("fee calculations should include both maker and protocol fees", async function () {
        const { rubiconMarket } =
          await loadFixture(deployRubiconProtocolFixture);

        const quantity = parseUnits("14");

        // charging protocol fee ONLY
        const quantityAfterFee0 = await rubiconMarket.calcAmountAfterFee(
          quantity
        );

        // set MakerFee, so now there are both Protocol and Maker fees should be paid
        await rubiconMarket.setMakerFee(10);
        // charging BOTH protocol and maker
        const quantityAfterFee1 = await rubiconMarket.calcAmountAfterFee(
          quantity
        );

        // quantityafterfee1 should be less, since there are both fees charged
        expect(quantityAfterFee1).to.be.lt(quantityAfterFee0);
      });

      it("can take an offer with 0 makerFee", async function () {
        const { rubiconMarket, testCoin, owner } =
          await loadFixture(deployRubiconProtocolFixture);
        const balanceBefore = await testCoin.balanceOf(owner.address);
        // in TEST
        const quantity = parseUnits("14");

        // amount that should be received with fee deducted (only Protocol fee!)
        const quantityAfterFee = await rubiconMarket.calcAmountAfterFee(
          quantity
        );

        // buying TEST with USDCT
        await rubiconMarket.buy(2, quantity);
        // saving new balance state
        const balanceAfter = await testCoin.balanceOf(owner.address);

        // validating that owner received proper amount with ONLY protocol fee charged
        expect(balanceAfter.sub(balanceBefore)).to.be.equal(quantityAfterFee);
      });

      it("can take an offer with paying both maker and protocol fees", async function () {
        const { rubiconMarket, testCoin, owner } =
          await loadFixture(deployRubiconProtocolFixture);

        // set maker fee
        const fee = 10;
        await rubiconMarket.setMakerFee(fee);

        const balanceBefore = await testCoin.balanceOf(owner.address);
        // in TEST
        const quantity = parseUnits("14");

        // amount that should be received with fee deducted (MakerFee + ProtocolFee)
        const quantityAfterFee = await rubiconMarket.calcAmountAfterFee(
          quantity
        );

        // buying TEST with USDCT
        await rubiconMarket.buy(2, quantity);
        // saving new balance state
        const balanceAfter = await testCoin.balanceOf(owner.address);

        // validating that owner received proper amount with ONLY protocol fee charged
        expect(balanceAfter.sub(balanceBefore)).to.be.equal(quantityAfterFee);
      });

      it("can pay the fees through multiple offers", async function () {
        const { rubiconMarket, testStableCoin, testCoin, owner } =
          await loadFixture(deployRubiconProtocolFixture);

        for (let i = 0; i < 4; i++) {
          // selling USDCT for TEST
          await rubiconMarket.functions[
            "offer(uint256,address,uint256,address)"
          ](
            // ORDER-BOOK:
            // sell USDCT 90 for TEST 100 -> 1 TEST ~0.9 TUSDC
            // sell USDCT 5 for TEST 6 -> 1 TEST ~0.83 TUSDC (x3)
            parseUnits("5", 6),
            testStableCoin.address,
            parseUnits("6"),
            testCoin.address,
            { from: owner.address }
          );
        }

        // set maker fee
        const fee = 10;
        await rubiconMarket.setMakerFee(fee);

        const balanceBefore = await testStableCoin.balanceOf(owner.address);

        const pay_amt = parseUnits("90");
        const min_fill_amount = rubiconMarket.getBuyAmount(
          testStableCoin.address,
          testCoin.address,
          pay_amt
        );

        await rubiconMarket.sellAllAmount(
          testCoin.address,
          pay_amt,
          testStableCoin.address,
          min_fill_amount
        );

        const balanceAfter = await testStableCoin.balanceOf(owner.address);
        const fill_after_fee = await rubiconMarket.calcAmountAfterFee(
          min_fill_amount
        );
        expect(balanceAfter.sub(balanceBefore)).to.be.equal(fill_after_fee);
      });

      it("fees are properly sent to maker and feeTo", async function () {
        const { rubiconMarket, testStableCoin, testCoin, owner, testMaker } =
          await loadFixture(deployRubiconProtocolFixture);

        // set MakerFee
        await rubiconMarket.setMakerFee(10);
        const quantity = parseUnits("5", 6);
        const quantityAfterFee = await rubiconMarket.calcAmountAfterFee(
          quantity
        );
        const received = parseUnits("6");

        await testStableCoin
          .connect(testMaker)
          .approve(rubiconMarket.address, quantity);

        // maker makes an offer, BUT sets owner.address as a recipient of the fill
        await rubiconMarket
          .connect(testMaker)
          .functions["offer(uint256,address,uint256,address,address,address)"](
            quantity,
            testStableCoin.address,
            received,
            testCoin.address,
            testMaker.address, // offer.owner
            owner.address // offer.recipient
          );

        // recipient will receive this amount
        const receivedAfterFee = await rubiconMarket.calcAmountAfterFee(
          received
        );
        // fee received will be equal to this one
        const feeAmount = receivedAfterFee
          .sub(await rubiconMarket.calcAmountAfterFee(receivedAfterFee))
          .div(2);

        // save initial balances state
        const makerBalanceBefore = await testCoin.balanceOf(testMaker.address);
        const feeToBalanceBefore = await testCoin.balanceOf(FEE_TO);
        const ownerBalanceBefore = await testStableCoin.balanceOf(
          owner.address
        );

        // taker takes the exact 5th offer
        await rubiconMarket.buy(5, quantity);

        // here balances should be updated with received fee
        const makerBalanceAfter = await testCoin.balanceOf(testMaker.address);
        const feeToBalanceAfter = await testCoin.balanceOf(FEE_TO);
        const ownerBalanceAfter = await testStableCoin.balanceOf(owner.address);

        // maker should receive only maker fee
        expect(makerBalanceBefore).to.be.equal(0);
        expect(makerBalanceAfter.sub(makerBalanceBefore)).to.be.equal(
          feeAmount
        );

        // feeTo should receive only protocol fee
        expect(feeToBalanceBefore).to.be.equal(0);
        expect(feeToBalanceAfter.sub(feeToBalanceBefore)).to.be.equal(
          feeAmount
        );

        // owner will receive quantityafterfee fill
        expect(ownerBalanceAfter.sub(ownerBalanceBefore)).to.be.equal(
          quantityAfterFee
        );
      });
    });

    describe("Rubicon Router", function () {
      it("Should inspect the WOB", async function () {
        const { testCoin, testStableCoin, router, rubiconMarket, owner } =
          await loadFixture(deployRubiconProtocolFixture);

        const usdctQuantityAsk = parseUnits("9", 6);
        const testQuantityAsk = parseUnits("10");

        const usdctQuantityBid = parseUnits("11", 6);
        const testQuantityBid = parseUnits("10");

        // 2 asks + 2 bids
        for (let i = 0; i < 2; i++) {
          await rubiconMarket.functions[
            "offer(uint256,address,uint256,address)"
          ](
            usdctQuantityAsk,
            testStableCoin.address,
            testQuantityAsk,
            testCoin.address,
            { from: owner.address }
          );
          await rubiconMarket.functions[
            "offer(uint256,address,uint256,address)"
          ](
            testQuantityBid,
            testCoin.address,
            usdctQuantityBid,
            testStableCoin.address,
            { from: owner.address }
          );
        }

        const askSize = await router.getBookDepth(
          testStableCoin.address,
          testCoin.address
        );

        // 1 from fixture + 2 new asks
        expect(askSize[0]).to.be.equal(3);

        const bidSize = await router.getBookDepth(
          testCoin.address,
          testStableCoin.address
        );
        //console.log("bidSize:", bidSize);
        expect(bidSize[0]).to.be.equal(3);
        const book = await router.getBookFromPair(
          testStableCoin.address,
          testCoin.address
        );

        /// check asks \\\
        // checking the first ask, that was created in fixture
        // first value value should be equal to the first offer's input amount, i.e. 90 USDC
        expect(book[0][0][0]).to.be.equal(ethers.utils.parseUnits("90", 6));
        // the second one is 100 TEST
        expect(book[0][0][1]).to.be.equal(ethers.utils.parseUnits("100"));

        // now check asks from this exact test
        // usdct amount here is the one that we've provided in offer in for loop
        expect(book[0][1][0]).to.be.equal(usdctQuantityAsk);
        // test amount works the same as in the previous expect statement
        expect(book[0][1][1]).to.be.equal(testQuantityAsk);
        // 3rd ask
        expect(book[0][2][0]).to.be.equal(usdctQuantityAsk);
        expect(book[0][2][1]).to.be.equal(testQuantityAsk);

        /// check bids \\\
        // first bid from fixture
        expect(book[1][0][0]).to.be.equal(ethers.utils.parseUnits("100"));
        // the second one is 100 TEST
        expect(book[1][0][1]).to.be.equal(ethers.utils.parseUnits("110", 6));

        // bids from this test
        expect(book[1][1][0]).to.be.equal(testQuantityBid);
        expect(book[1][1][1]).to.be.equal(usdctQuantityBid);

        expect(book[1][2][0]).to.be.equal(testQuantityBid);
        expect(book[1][2][1]).to.be.equal(usdctQuantityBid);
      });

      it("Should get maker's active orders value", async function () {
        const { testCoin, testStableCoin, weth, router, rubiconMarket, owner } =
          await loadFixture(deployRubiconProtocolFixture);

        const usdctQuantityAsk = parseUnits("9", 6);
        const testQuantityAsk = parseUnits("10");
        const wethQuantityAsk = parseUnits("0.0031");

        // 5 asks of USDCT/TEST && USDCT/WETH
        // total -> 90 USDCT in pay_amt + 90 USDCT in fixture
        for (let i = 0; i < 5; i++) {
          await rubiconMarket.functions[
            "offer(uint256,address,uint256,address)"
          ](
            usdctQuantityAsk,
            testStableCoin.address,
            testQuantityAsk,
            testCoin.address,
            { from: owner.address }
          );
          await rubiconMarket.functions[
            "offer(uint256,address,uint256,address)"
          ](
            usdctQuantityAsk,
            testStableCoin.address,
            wethQuantityAsk,
            weth.address,
            { from: owner.address }
          );
        }

        const usdctTestBalance = await router.getMakerBalanceInPair(
          testStableCoin.address,
          testCoin.address,
          owner.address
        );
        const usdctWethBalance = await router.getMakerBalanceInPair(
          testStableCoin.address,
          weth.address,
          owner.address
        );

        // get total USDCT balance of maker across all the pairs TEST/[token0, token1] pairs
        const totalBalances = await router.getMakerBalance(
          testStableCoin.address,
          [testCoin.address, weth.address],
          owner.address
        );
        const balanceOfOwner = await testStableCoin.balanceOf(owner.address);

        // total value of USDCT in the book is valid
        expect(totalBalances[0]).to.equal(parseUnits("180", 6));
        expect(totalBalances[1]).to.equal(balanceOfOwner);
        // maker balance of pair and maker balance across all the pairs should return proper values
        expect(usdctWethBalance.add(usdctTestBalance)).to.equal(
          totalBalances[0]
        );
      });

      it("a user can cancel ETH offer via Router?", async function () {
        const { rubiconMarket, router } =
          await loadFixture(deployRubiconProtocolFixture);

        expect(await rubiconMarket.getOwner(3)).to.equal(router.address);
        await router.cancelForETH(3);
      });

      it("a user can deposit and withdraw ETH via Router?", async function () {
        const { owner, router, cWETH } = await loadFixture(
          deployRubiconProtocolFixture
        );

        // Mint coins to the owner to then deposit
        const amount = parseUnits("1");

        // deposit
        await router.depositWithETH(amount, cWETH.address, owner.address, { value: amount });

        const cWethBalance = await cWETH.balanceOf(owner.address);
        expect(cWethBalance).to.be.gte(0);

        await cWETH.approve(router.address, cWethBalance);
        await router.withdrawForETH(cWethBalance, cWETH.address);
      });

      it("should propely execute swap WITH native ETH", async function () {
        const { testCoin, router, rubiconMarket, owner, weth } =
          await loadFixture(deployRubiconProtocolFixture);

        const fee = 10;
        await rubiconMarket.setMakerFee(fee);

        const amountETH = parseUnits("0.1337");
        const buy_amt_min = await rubiconMarket.getBuyAmountWithFee(
          testCoin.address,
          weth.address,
          amountETH
        );
        const testBalanceBefore = await testCoin.balanceOf(owner.address);

        await router.swapWithETH(
          amountETH,
          buy_amt_min,
          [weth.address, testCoin.address],
          owner.address,
          { value: amountETH }
        );

        const testBalanceAfter = await testCoin.balanceOf(owner.address);
        expect(testBalanceAfter.sub(testBalanceBefore)).to.be.equal(
          buy_amt_min
        );
      });

      it("should propely execute swap FOR native ETH", async function () {
        const { testCoin, router, rubiconMarket, owner, weth } =
          await loadFixture(deployRubiconProtocolFixture);

        const fee = 10;
        await rubiconMarket.setMakerFee(fee);

        const amountTEST = parseUnits("55.555");
        const buy_amt_min = await rubiconMarket.getBuyAmountWithFee(
          weth.address,
          testCoin.address,
          amountTEST
        );

        await testCoin.approve(router.address, amountTEST);

        const ethBalanceBefore = await ethers.provider.getBalance(
          owner.address
        );
        await router.swapForETH(amountTEST, buy_amt_min, [
          testCoin.address,
          weth.address,
        ]);
        const ethBalanceAfter = await ethers.provider.getBalance(owner.address);
        expect(ethBalanceAfter).to.be.gt(ethBalanceBefore);
      });

      it("should propely buy all amount WITH native ETH", async function () {
        const { testCoin, router, rubiconMarket, weth } =
          await loadFixture(deployRubiconProtocolFixture);

        const fee = 10;
        await rubiconMarket.setMakerFee(fee);

        const amountETH = parseUnits("0.1337");
        const buy_amt = await rubiconMarket.getBuyAmountWithFee(
          testCoin.address,
          weth.address,
          amountETH
        );

        await router.buyAllAmountWithETH(
          testCoin.address,
          buy_amt,
          amountETH, // max fill
          { value: amountETH }
        );
      });

      it("should propely buy all amount FOR native ETH", async function () {
        const { testCoin, router, rubiconMarket, otherAccount, weth } =
          await loadFixture(deployRubiconProtocolFixture);

        const fee = 10;
        await rubiconMarket.setMakerFee(fee);

        const amountETH = parseUnits("1");
        const max_fill = await rubiconMarket.getPayAmount(
          testCoin.address,
          weth.address,
          amountETH
        );

        await testCoin.connect(otherAccount).approve(router.address, max_fill);
        await router
          .connect(otherAccount)
          .buyAllAmountForETH(amountETH, testCoin.address, max_fill);
      });
    });
  });
});