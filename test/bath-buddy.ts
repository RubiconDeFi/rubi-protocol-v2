import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { formatUnits, parseUnits } from "ethers/lib/utils";

// TODO: Implement Proxy-wrapping helper functions and proxy-wrapped contracts generally
describe("RubiconV2 rewards system", function () {
  const CERC20_ABI = [
    "function name() external view returns(string memory)",
    "function symbol() external view returns(string memory)",
    "function decimals() external view returns(uint8)",
    "function balanceOf(address) external view returns(uint256)",
    "function admin() external view returns(address)",
    "function mint(uint256) external returns(uint256)",
  ];
  const BUDDY_ABI = [
    "function setRewardsDuration(uint256,address) external",
    "function notifyRewardAmount(uint256,address) external",
    "function earned(address,address) external view returns(uint256)",
  ];

  async function buddySetupFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, otherAccount] = await ethers.getSigners();

    // Use Compound Fork to spawn some cTokens...
    // Note: In prod COMP uses Unitroller for Comptroller storage and upgradeability*
    const ComptrollerFactory = await ethers.getContractFactory("Comptroller");
    const comptroller = await ComptrollerFactory.deploy(); // TODO: Rename to bath house?

    const BathHouse = await ethers.getContractFactory("BathHouseV2");
    const bathHouse = await BathHouse.deploy();

    await bathHouse.initialize(comptroller.address, owner.address);

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

    const testRewardCoin = await testCoinFactory
      .connect(otherAccount)
      .deploy(
        otherAccount.address,
        "SuperHyperCoolTokenThatRewardsLiquidityProvidersWithHugeReturns",
        "BTC",
        18
      );

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

    const becomeImplementationData = "0x"; //TODO: What should this be?

    await bathHouse.createBathToken(
      underlying,
      interestRateModel,
      initialExchangeRateMantissa,
      cTokenImplementation.address,
      becomeImplementationData
    );
    const bathTokenAddress = await bathHouse.getBathTokenFromAsset(underlying);
    const bathTEST = new ethers.Contract(bathTokenAddress, CERC20_ABI, owner);

    const buddyAddress = await bathHouse.whoIsBuddy(bathTokenAddress);
    const buddy = new ethers.Contract(buddyAddress, BUDDY_ABI, owner);

    // Setup cToken in System correctly:
    await comptroller._supportMarket(bathTEST!.address).catch((e: any) => {
      console.log("\nError supporting new cToken market!", e.reason, "\n");
    });

    await testCoin.connect(owner).faucet();
    await testStableCoin.connect(owner).faucet();

    await buddy.setRewardsDuration(
      (await time.latest()) + 365 * 24 * 60 * 60,
      testStableCoin.address
    );
    await testStableCoin.transfer(buddy.address, parseUnits("10000", 6));
    await buddy.notifyRewardAmount(
      parseUnits("10000", 6),
      testStableCoin.address
    );

    await comptroller.setCompAddress(testRewardCoin.address);
    await comptroller._setCompSpeeds(
      [bathTEST.address],
      [parseUnits("2.28")],
      [parseUnits("0.322")]
    );

    const PriceOracleFactory = await ethers.getContractFactory(
      "DummyPriceOracle"
    );
    const priceOracle = await PriceOracleFactory.deploy();

    // price of TEST = $0.9
    await priceOracle.addCtoken(bathTEST.address, parseUnits("0.9", 18));

    await comptroller._setPriceOracle(priceOracle.address);

    await comptroller._setCollateralFactor(bathTEST.address, parseUnits("0.7"));

    const rewardBalance = await testRewardCoin.balanceOf(otherAccount.address);
    await testRewardCoin.transfer(comptroller.address, rewardBalance);

    return {
      comptroller,
      testCoin,
      bathTEST,
      owner,
      otherAccount,
      testStableCoin,
      testRewardCoin,
      buddy,
      bathHouse,
    };
  }

  describe("Testing the rewards", async function () {
    it("should get rewards from both Comptroller and BathBuddy", async function () {
      const {
        owner,
        testCoin,
        testStableCoin,
        testRewardCoin,
        bathTEST,
        buddy,
        bathHouse,
        comptroller,
      } = await loadFixture(buddySetupFixture);

      expect(await comptroller.getCompAddress()).to.be.equal(
        testRewardCoin.address
      );

      await testCoin.approve(bathTEST.address, parseUnits("1000"));
      await bathTEST.mint(parseUnits("1000"));

      const earned = await buddy.earned(owner.address, testStableCoin.address);

      const earnedComp = await testRewardCoin.balanceOf(owner.address);
      expect(earnedComp).to.be.equal(0);

      // skip a year
      await time.increaseTo((await time.latest()) + 365 * 24 * 60 * 60);

      bathHouse.claimRewards([buddy.address], [testStableCoin.address]);

      const earned2 = await testStableCoin.balanceOf(owner.address);
      const earnedComp2 = await testRewardCoin.balanceOf(owner.address);

      expect(earned).to.be.lt(earned2);
      expect(earnedComp).to.be.lt(earnedComp2);
    });
  });
});
