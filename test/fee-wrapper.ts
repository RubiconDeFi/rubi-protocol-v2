import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { formatUnits, parseUnits } from "ethers/lib/utils";
const { expect } = require("chai");

describe("Fee Wrapper", function () {
  const FEE_TO = "0x0000000000000000000000000000000000000FEE";

  async function deployRubiProtocolFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, otherAccount, testMaker] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    const weth = await WETH.deploy();

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

    const ComptrollerFactory = await ethers.getContractFactory("Comptroller");
    const comptroller = await ComptrollerFactory.deploy(); // TODO: Rename to bath house?

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

    const RubiconMarketFactory = await ethers.getContractFactory(
      "RubiconMarket"
    );
    const rubiconMarket = await RubiconMarketFactory.deploy();
    await rubiconMarket.initialize(testMaker.address);
    await rubiconMarket.setFeeBPS(10);

    // Make a liquid ERC-20 pair for testCoin and testStableCoin. Bid at $90 ask at $110.
    await testCoin.connect(owner).faucet();
    await testStableCoin.connect(owner).faucet();

    await testCoin!
      .connect(owner)
      .approve(rubiconMarket.address, parseUnits("1000"));
    await testStableCoin!
      .connect(owner)
      .approve(rubiconMarket.address, parseUnits("1000"));

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

    const RubiconRouter = await ethers.getContractFactory("RubiconRouter");
    const router = await RubiconRouter.deploy();
    await router.startErUp(rubiconMarket.address, weth.address);

    // fee wrapper
    const FeeWrapper = await ethers.getContractFactory("FeeWrapper");
    const feeWrapper = await FeeWrapper.deploy();

    // 3rd party protocol
    const PepeFinance = await ethers.getContractFactory("Test3rdPartyProtocol");
    const pepeFinance = await PepeFinance.deploy(
      feeWrapper.address,
      FEE_TO,
      router.address
    );

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
      testCoin,
      owner,
      otherAccount,
      testStableCoin,
      weth,
      cWETH,
      router,
      feeWrapper,
      pepeFinance,
    };
  }

    it("should call offerWithETH via 3rd party protocol", async function () {
      const { testCoin, pepeFinance } = await loadFixture(
        deployRubiProtocolFixture
      );

      const feeToETHBalance0 = await ethers.provider.getBalance(FEE_TO);
      await pepeFinance.executeOfferWithETH(
        parseUnits("9"),
        parseUnits("310"),
        testCoin.address,
        0,
        { value: parseUnits("9") }
      );
      const feeToETHBalance1 = await ethers.provider.getBalance(FEE_TO);
      expect(feeToETHBalance1).to.be.gt(feeToETHBalance0);
    });

    it("should call swap via 3rd party protocol", async function () {
      const {
        rubiconMarket,
        testCoin,
        testStableCoin,
        owner,
        pepeFinance,
      } = await loadFixture(deployRubiProtocolFixture);
      const pay_amt = parseUnits("53");
      const buy_amt = await rubiconMarket.getBuyAmountWithFee(
        testStableCoin.address,
        testCoin.address,
        pay_amt
      );

      const feeToBalance0 = await testCoin.balanceOf(FEE_TO);
      expect(feeToBalance0).to.be.equal(0);

      const balance0 = await testStableCoin.balanceOf(owner.address);
      await testCoin
        .connect(owner)
        .approve(pepeFinance.address, parseUnits("10000"));
      await pepeFinance
        .connect(owner)
        .executeSwap(pay_amt, buy_amt, [
          testCoin.address,
          testStableCoin.address,
        ]);

      const feeToBalance1 = await testCoin.balanceOf(FEE_TO);
      const balance1 = await testStableCoin.balanceOf(owner.address);

      expect(balance1).to.be.gt(balance0);
      expect(feeToBalance1).to.be.gt(feeToBalance0);
    });

    it("should call swapWithETH via 3rd party protocol", async function () {
      const {
        rubiconMarket,
        testCoin,
        weth,
        owner,
        pepeFinance,
      } = await loadFixture(deployRubiProtocolFixture);
      const pay_amt = parseUnits("0.1");
      const buy_amt = await rubiconMarket.getBuyAmountWithFee(
        weth.address,
        testCoin.address,
        pay_amt
      );

      const feeToETHBalance0 = await ethers.provider.getBalance(FEE_TO);
      const balance0 = await testCoin.balanceOf(owner.address);
      await pepeFinance
        .connect(owner)
        .executeSwapWithETH(
          pay_amt,
          buy_amt,
          [weth.address, testCoin.address],
          {
            value: pay_amt,
          }
        );
      const balance1 = await testCoin.balanceOf(owner.address);
      const feeToETHBalance1 = await ethers.provider.getBalance(FEE_TO);

      expect(balance1).to.be.gt(balance0);
      expect(feeToETHBalance1).to.be.gt(feeToETHBalance0);
    });

    it("should call depositWithETH via FeeWrapper", async function () {
      const {
        cWETH,
        owner,
        pepeFinance,
      } = await loadFixture(deployRubiProtocolFixture);
      const amount = parseUnits("0.1337");

      const feeToETHBalance0 = await ethers.provider.getBalance(FEE_TO);
      const cWEThBalance0 = await cWETH.balanceOf(owner.address);
      expect(cWEThBalance0).to.be.equal(0);

      await pepeFinance.executeDepositWithETH(amount, cWETH.address, {
        value: amount,
      });
      const feeToETHBalance1 = await ethers.provider.getBalance(FEE_TO);
      const cWEThBalance1 = await cWETH.balanceOf(owner.address);

      expect(cWEThBalance1).to.be.gt(cWEThBalance0);
      expect(feeToETHBalance1).to.be.gt(feeToETHBalance0);
    });

    it("should call swap via 3rd party protocol", async function () {
      const {
        rubiconMarket,
        testCoin,
        testStableCoin,
        owner,
        pepeFinance,
      } = await loadFixture(deployRubiProtocolFixture);
      const pay_amt = parseUnits("53");
      const buy_amt = await rubiconMarket.getBuyAmountWithFee(
        testStableCoin.address,
        testCoin.address,
        pay_amt
      );

      const feeToBalance0 = await testCoin.balanceOf(FEE_TO);
      expect(feeToBalance0).to.be.equal(0);

      const balance0 = await testStableCoin.balanceOf(owner.address);
      await testCoin
        .connect(owner)
        .approve(pepeFinance.address, parseUnits("10000"));
      await pepeFinance
        .connect(owner)
        .executeSwap(pay_amt, buy_amt, [
          testCoin.address,
          testStableCoin.address,
        ]);

      const feeToBalance1 = await testCoin.balanceOf(FEE_TO);
      const balance1 = await testStableCoin.balanceOf(owner.address);

      expect(balance1).to.be.gt(balance0);
      expect(feeToBalance1).to.be.gt(feeToBalance0);
  });
});