import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { expect } from "chai";
import hre from "hardhat";

// this test should be run on forked Optimism mainnet
describe("V1->V2 Migration", function () {
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  // deploy V1 and V2 bathTokens contracts
  async function deployBathTokensFixture() {
    const [owner, otherAccount] = await ethers.getSigners();

    // testcoin to the moon
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

    // V1
    const BathTokenV1 = await ethers.getContractFactory("BathTokenV1");
    const bathTokenV1 = await BathTokenV1.deploy();
    // don't really care about `market` and `_feeTo` here
    await bathTokenV1.initialize(
      testCoin.address,
      testCoin.address,
      testCoin.address
    );

    // Comptroller
    // Note: In prod COMP uses Unitroller for Comptroller storage and upgradeability*
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
    const name = "bathTESTv1"; // TODO: move this process to Bath House factory
    const symbol = "bathTEST";
    const decimal = 18;

    const becomeImplementationData = "0x"; //TODO: What should this be?

    const cTokenDelegatorFactory = await ethers.getContractFactory(
      "CErc20Delegator"
    );

    // Note, admin deploys new cTokens
    const bathTokenV2 = await cTokenDelegatorFactory
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
    await comptroller._supportMarket(bathTokenV2!.address).catch((e: any) => {
      console.log("\nError supporting new bathToken market!", e.reason, "\n");
    });

    const Migrator = await ethers.getContractFactory("V2Migrator");
    const migrator = await Migrator.deploy(
      [bathTokenV1.address],
      [bathTokenV2.address]
    );

    const ProxyFactory = await ethers.getContractFactory(
      "TransparentUpgradeableProxy"
    );

    // deploy RubiconMarket V1!!!
    const Market = await ethers.getContractFactory("RubiconMarketV1");
    const market = await Market.deploy();
    await market.deployed();

    // deploy proxy wrapper for RubiconMarket
    const proxyMarket = await ProxyFactory.deploy(
      market.address,
      otherAccount.address,
      "0x"
    );
    await proxyMarket.deployed();
    const proxiedMarketV1 = await market.attach(proxyMarket.address);
    (await proxiedMarketV1.initialize(true, owner.address)).wait(2);

    await testCoin.connect(owner).faucet();
    await testStableCoin.connect(owner).faucet();

    const amount = await parseUnits("15");
    await testCoin.approve(bathTokenV1.address, amount);
    await bathTokenV1["deposit(uint256)"](amount);

    await testCoin!
      .connect(owner)
      .approve(proxiedMarketV1.address, parseUnits("100000"));
    await testStableCoin!
      .connect(owner)
      .approve(proxiedMarketV1.address, parseUnits("100000"));

    // id = 1 and 2
    await proxiedMarketV1.functions[
      "offer(uint256,address,uint256,address,uint256,bool)"
    ](
      parseUnits("90", 6),
      testStableCoin.address,
      parseUnits("100"),
      testCoin.address,
      0,
      true,
      { from: owner.address }
    );
    await proxiedMarketV1.functions[
      "offer(uint256,address,uint256,address,uint256,bool)"
    ](
      parseUnits("100"),
      testCoin.address,
      parseUnits("110", 6),
      testStableCoin.address,
      0,
      true,
      { from: owner.address }
    );

    return {
      migrator,
      bathTokenV1,
      bathTokenV2,
      owner,
      otherAccount,
      proxiedMarketV1,
      proxyMarket,
      testCoin,
      testStableCoin,
    };
  }

  it("should migrate the whole user's position from V1 to V2", async function () {
    const { migrator, bathTokenV1, bathTokenV2, owner } = await loadFixture(
      deployBathTokensFixture
    );

    // bath balance before migration
    const bathTokenV1BalanceBefore = await bathTokenV1.balanceOf(owner.address);
    const bathTokenV2BalanceBefore = await bathTokenV2.balanceOf(owner.address);

    await bathTokenV1.approve(migrator.address, bathTokenV1BalanceBefore);
    await migrator.migrate(bathTokenV1.address);

    // bath balance after migration
    const bathTokenV1BalanceAfter = await bathTokenV1.balanceOf(owner.address);
    const bathTokenV2BalanceAfter = await bathTokenV2.balanceOf(owner.address);

    expect(bathTokenV1BalanceBefore).to.be.gt(bathTokenV1BalanceAfter);
    expect(bathTokenV1BalanceAfter).to.be.equal("0");
    expect(bathTokenV2BalanceBefore).to.be.equal("0");
    expect(bathTokenV2BalanceBefore).to.be.lt(bathTokenV2BalanceAfter);
  });

  it("should upgrade V1 Market to V2 with an ability to interact with V1 orders", async function () {
    const {
      otherAccount,
      proxiedMarketV1,
      proxyMarket,
    } = await loadFixture(deployBathTokensFixture);

    const ownerV1 = (await proxiedMarketV1.offers(1))[4];

    // Upgrade to V2
    const MarketV2 = await ethers.getContractFactory("RubiconMarket");
    const marketv2 = await MarketV2.deploy();
    await marketv2.deployed();

    await proxyMarket.connect(otherAccount).upgradeTo(marketv2.address);
    // attach new implementation ABI
    const proxiedMarketV2 = await marketv2.attach(proxyMarket.address);

    const offer = await proxiedMarketV2.offers(2);
    // recipient should overwrite v1 owner
    expect(offer[4]).to.equal(ownerV1);
    expect(offer[6]).to.equal(ZERO_ADDRESS);

    // cancel v1 offer on v2
    await proxiedMarketV2.cancel(2);
  });
});
