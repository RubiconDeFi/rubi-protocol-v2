import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { formatUnits, parseUnits } from "ethers/lib/utils";

describe("Leverage positions Test", function () {
  // constants
  const POS_ABI = [
    "function owner() external view returns(address)",
    "function positions(uint256) external view returns(address, address, uint256, uint256, uint256)",
    "function lastPositionId() external view returns(uint256)",
    "function buyAllAmountWithLeverage(address, address, uint256, uint256)",
    "function sellAllAmountWithLeverage(address, address, uint256, uint256)",
    "function closePosition(uint256) external",
    "function increaseMargin(uint256, uint256)",
  ];
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const TUSDC_AMOUNT = parseUnits("25", 6);
  const TEST_AMOUNT = parseUnits("25");
  // leverage
  const x1 = parseUnits("1");
  const x1_25 = parseUnits("1.25");
  const x1_337 = parseUnits("1.337");
  const x2_332 = parseUnits("2.332");
  const omg = parseUnits("1.37133387");
  // wrong ones
  const x4 = parseUnits("4");
  const x0_5 = parseUnits("0.5");

  async function deployPoolsUtilityFixture() {
    const [owner, otherAccount] = await ethers.getSigners();

    const RubiconMarketFactory = await ethers.getContractFactory(
      "RubiconMarket"
    );
    const rubiconMarket = await RubiconMarketFactory.deploy();
    await rubiconMarket.initialize(owner.address);

    // Use Compound Fork to spawn some cTokens...
    // Note: In prod COMP uses Unitroller for Comptroller storage and upgradeability*
    const ComptrollerFactory = await ethers.getContractFactory("Comptroller");
    const comptroller = await ComptrollerFactory.deploy(); // TODO: Rename to bath house?

    // deploy bathHousev2
    const BathHouseV2 = await ethers.getContractFactory("BathHouseV2");
    const bathHouseV2 = await BathHouseV2.deploy();

    await bathHouseV2.initialize(comptroller.address, otherAccount.address);

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

    const interestRateModel = irModel.address;
    const initialExchangeRateMantissa = "200000000000000000000000000"; // TODO: What should this be?

    const becomeImplementationData = "0x"; //TODO: What should this be?

    // create BathTokens
    await bathHouseV2.createBathToken(testCoin.address, interestRateModel, initialExchangeRateMantissa, cTokenImplementation.address, becomeImplementationData);
    await bathHouseV2.createBathToken(testStableCoin.address, interestRateModel, stableExchangeRateMantissa, cTokenImplementation.address, becomeImplementationData);

    const cTokenAddr = await bathHouseV2.getBathTokenFromAsset(testCoin.address);
    const cTokenStableAddr = await bathHouseV2.getBathTokenFromAsset(testStableCoin.address);

    const cToken = await ethers.getContractAt("contracts/compound-v2-fork/CErc20Delegator.sol:CErc20Delegator", cTokenAddr);
    const cTokenStable = await ethers.getContractAt("contracts/compound-v2-fork/CErc20Delegator.sol:CErc20Delegator", cTokenStableAddr);

    // Setup cToken in System correctly:
    await comptroller._supportMarket(cToken!.address).catch((e: any) => {
      console.log("\nError supporting new cToken market!", e.reason, "\n");
    });
    // Setup cToken in System correctly:
    await comptroller._supportMarket(cTokenStable!.address).catch((e: any) => {
      console.log("\nError supporting new cToken market!", e.reason, "\n");
    });

    // Make a liquid ERC-20 pair for testCoin and testStableCoin. Bid at $90 ask at $110.
    await testCoin.connect(owner).faucet();
    await testStableCoin.connect(owner).faucet();
    await testCoin!
      .connect(owner)
      .approve(rubiconMarket.address, parseUnits("100000"));
    await testStableCoin!
      .connect(owner)
      .approve(rubiconMarket.address, parseUnits("100000"));

    await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
      parseUnits("900", 6),
      testStableCoin.address,
      parseUnits("1000"),
      testCoin.address,
      { from: owner.address }
    );
    await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
      parseUnits("1100"),
      testCoin.address,
      parseUnits("1000", 6),
      testStableCoin.address,
      { from: owner.address }
    );

    // *** POOLS UTILITY
    const PriceOracleFactory = await ethers.getContractFactory(
      "DummyPriceOracle"
    );
    const priceOracle = await PriceOracleFactory.deploy();

    // https://docs.compound.finance/v2/prices/#underlying-price
    // price of TUSDC = $1
    await priceOracle.addCtoken(cTokenStable.address, parseUnits("1", 30));
    // price of TEST = $0.9
    await priceOracle.addCtoken(cToken.address, parseUnits("0.9", 18));

    await comptroller._setPriceOracle(priceOracle.address);

    // collateralFactor = 70% for cTokenStable
    await comptroller._setCollateralFactor(
      cTokenStable.address,
      parseUnits("0.7", 18)
    );
    // collateralFactor = 70% for cToken
    await comptroller._setCollateralFactor(
      cToken.address,
      parseUnits("0.7", 18)
    );

    const PoolsUtilsFactory = await ethers.getContractFactory("PoolsUtility");
    const poolsUtils = await PoolsUtilsFactory.deploy();
    await poolsUtils.initialize(
      priceOracle.address,
      rubiconMarket.address,
      bathHouseV2.address
    );

    // supply some testStableCoin
    await testStableCoin.connect(otherAccount).faucet();
    await testStableCoin
      .connect(otherAccount)
      .approve(cTokenStable.address, parseUnits("1000", 6));
    await cTokenStable.connect(otherAccount).mint(parseUnits("1000", 6));

    // supply some testCoin
    await testCoin.connect(otherAccount).faucet();
    await testCoin
      .connect(otherAccount)
      .approve(cToken.address, parseUnits("1000"));
    await cToken.connect(otherAccount).mint(parseUnits("1000"));

    // deploy Position contract
    await poolsUtils.connect(owner).createPosition();

    const posAddress = await poolsUtils.getPositions(owner.address);
    const Position = new ethers.Contract(posAddress[0], POS_ABI, owner);

    // make approvals
    await testStableCoin!
      .connect(owner)
      .approve(Position.address, parseUnits("1000", 6));
    await testCoin!
      .connect(owner)
      .approve(Position.address, parseUnits("1000"));

    return {
      rubiconMarket,
      testCoin,
      cToken,
      owner,
      otherAccount,
      testStableCoin,
      cTokenStable,
      Position,
    };
  }

  describe("Pools Utility Test", async function () {
    describe("Short positions 📉", function () {
      it("should open short position", async function () {
        const { owner, testCoin, testStableCoin, Position } = await loadFixture(
          deployPoolsUtilityFixture
        );

        await Position.connect(owner).sellAllAmountWithLeverage(
          testStableCoin.address,
          testCoin.address,
          TUSDC_AMOUNT,
          x1_337
        );

        // fetch position with id 1
        const position = await Position.positions(1);
        expect(await Position.owner()).to.equal(owner.address);
        // position.asset == testStablecoin
        expect(position[0]).to.equal(testStableCoin.address);
        // position.quote == testCoin
        expect(position[1]).to.equal(testCoin.address);
      });

      it("should revert short with invalid leverage", async function () {
        const { owner, testCoin, testStableCoin, Position } = await loadFixture(
          deployPoolsUtilityFixture
        );

        await expect(
          Position.connect(owner).sellAllAmountWithLeverage(
            testStableCoin.address,
            testCoin.address,
            TUSDC_AMOUNT,
            x4
          )
        ).to.be.revertedWith("_leverageCheck{Short}: INVLAID LEVERAGE");

        await expect(
          Position.connect(owner).sellAllAmountWithLeverage(
            testStableCoin.address,
            testCoin.address,
            TUSDC_AMOUNT,
            x0_5
          )
        ).to.be.revertedWith("_leverageCheck{Short}: INVLAID LEVERAGE");
      });

      it("should increase margin for opened short position", async function () {
        const { owner, testCoin, testStableCoin, Position } = await loadFixture(
          deployPoolsUtilityFixture
        );

        await Position.connect(owner).sellAllAmountWithLeverage(
          testStableCoin.address,
          testCoin.address,
          TUSDC_AMOUNT,
          x2_332
        );

        const positionBefore = await Position.positions(1);

        await Position.connect(owner).increaseMargin(1, TUSDC_AMOUNT);

        const positionAfter = await Position.positions(1);
        expect(positionAfter[3]).to.be.gt(positionBefore[3]);
      });

      it("should close profitable short position", async function () {
        const { owner, testCoin, testStableCoin, Position, rubiconMarket } =
          await loadFixture(deployPoolsUtilityFixture);

        await Position.connect(owner).sellAllAmountWithLeverage(
          testStableCoin.address,
          testCoin.address,
          TUSDC_AMOUNT,
          x1_337
        );

        const position = await Position.positions(1);

        expect(await Position.owner()).to.equal(owner.address);
        expect(position[0]).to.equal(testStableCoin.address);
        expect(position[1]).to.equal(testCoin.address);

        await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
          parseUnits("1000"),
          testCoin.address,
          parseUnits("333.397", 6),
          testStableCoin.address,
          { from: owner.address }
        );

        await Position.connect(owner).closePosition(1);

        const positions = await Position.positions(1);
        // check that position was deleted
        expect(positions[0]).to.equal(ZERO_ADDRESS);
        expect(positions[1]).to.equal(ZERO_ADDRESS);
        expect(positions[2]).to.equal("0");
      });

      it("should close unprofitable short position", async function () {
        const { owner, testCoin, testStableCoin, Position, rubiconMarket } =
          await loadFixture(deployPoolsUtilityFixture);

        await Position.connect(owner).sellAllAmountWithLeverage(
          testStableCoin.address,
          testCoin.address,
          TUSDC_AMOUNT,
          omg
        );

        const position = await Position.positions(1);

        expect(await Position.owner()).to.equal(owner.address);
        expect(position[0]).to.equal(testStableCoin.address);
        expect(position[1]).to.equal(testCoin.address);

        await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
          parseUnits("1000"),
          testCoin.address,
          parseUnits("1200", 6),
          testStableCoin.address,
          { from: owner.address }
        );

        // approve more tokens to ensure that debt will be repaid
        await testStableCoin
          .connect(owner)
          .approve(Position.address, parseUnits("99999"));
        await Position.connect(owner).closePosition(1);

        const positions = await Position.positions(1);

        expect(positions[0]).to.equal(ZERO_ADDRESS);
        expect(positions[1]).to.equal(ZERO_ADDRESS);
        expect(positions[2]).to.equal("0");
      });
    });

    describe("Long positions 📈", function () {
      it("should open long position", async function () {
        const { owner, testCoin, testStableCoin, Position } = await loadFixture(
          deployPoolsUtilityFixture
        );

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x2_332
        );

        const position = await Position.positions(1);

        expect(await Position.owner()).to.equal(owner.address);
        expect(position[0]).to.equal(testCoin.address);
        expect(position[1]).to.equal(testStableCoin.address);
      });

      it("should revert long with 1x leverage", async function () {
        const { owner, testCoin, testStableCoin, Position } = await loadFixture(
          deployPoolsUtilityFixture
        );

        await expect(
          Position.connect(owner).buyAllAmountWithLeverage(
            testCoin.address,
            testStableCoin.address,
            TEST_AMOUNT,
            x1
          )
        ).to.be.revertedWith("_leverageCheck{Long}: INVLAID LEVERAGE");
      });

      it("should increase margin for opened long position", async function () {
        const { owner, testCoin, testStableCoin, Position } = await loadFixture(
          deployPoolsUtilityFixture
        );

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x2_332
        );

        const positionBefore = await Position.positions(1);

        await Position.connect(owner).increaseMargin(1, TEST_AMOUNT);

        const positionAfter = await Position.positions(1);
        expect(positionAfter[3]).to.be.gt(positionBefore[3]);
      });

      it("should close opened profitable long position?", async function () {
        const { owner, testCoin, testStableCoin, Position, rubiconMarket } =
          await loadFixture(deployPoolsUtilityFixture);

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x1_25
        );

        const position = await Position.positions(1);

        expect(await Position.owner()).to.equal(owner.address);
        expect(position[0]).to.equal(testCoin.address);
        expect(position[1]).to.equal(testStableCoin.address);

        await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
          parseUnits("1300", 6),
          testStableCoin.address,
          parseUnits("1000"),
          testCoin.address,
          { from: owner.address }
        );

        await Position.connect(owner).closePosition(1);

        const positions = await Position.positions(1);
        // check that position was deleted
        expect(positions[0]).to.equal(ZERO_ADDRESS);
        expect(positions[1]).to.equal(ZERO_ADDRESS);
        expect(positions[2]).to.equal("0");
      });

      it("should close unprofitable long position?", async function () {
        const { owner, testCoin, testStableCoin, Position, rubiconMarket } =
          await loadFixture(deployPoolsUtilityFixture);

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x1_337
        );

        const position = await Position.positions(1);

        expect(await Position.owner()).to.equal(owner.address);
        expect(position[0]).to.equal(testCoin.address);
        expect(position[1]).to.equal(testStableCoin.address);

        await rubiconMarket.functions["offer(uint256,address,uint256,address)"](
          parseUnits("600", 6),
          testStableCoin.address,
          parseUnits("1000"),
          testCoin.address,
          { from: owner.address }
        );

        // approve more tokens to ensure that debt will be repaid
        await testCoin
          .connect(owner)
          .approve(Position.address, parseUnits("99999"));
        await Position.connect(owner).closePosition(1);

        const positions = await Position.positions(1);

        expect(positions[0]).to.equal(ZERO_ADDRESS);
        expect(positions[1]).to.equal(ZERO_ADDRESS);
        expect(positions[2]).to.equal("0");
      });

      it("should open long position with 1.25x leverage?", async function () {
        const { owner, testCoin, testStableCoin, Position } =
          await loadFixture(deployPoolsUtilityFixture);

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x1_25
        );

        const position = await Position.positions(1);

        expect(await Position.owner()).to.equal(owner.address);
        expect(position[0]).to.equal(testCoin.address);
        expect(position[1]).to.equal(testStableCoin.address);
      });

      it("should open two longs and properly close them?", async function () {
        const { owner, testCoin, testStableCoin, Position } =
          await loadFixture(deployPoolsUtilityFixture);

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x2_332
        );

        let position1 = await Position.positions(1);
        expect(await Position.owner()).to.equal(owner.address);
        expect(position1[0]).to.equal(testCoin.address);
        expect(position1[1]).to.equal(testStableCoin.address);

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          TEST_AMOUNT,
          x1_25
        );

        let position2 = await Position.positions(2);
        expect(position2[0]).to.equal(testCoin.address);
        expect(position2[1]).to.equal(testStableCoin.address);

        await Position.connect(owner).closePosition(1);

        position1 = await Position.positions(1);

        expect(position1[0]).to.equal(ZERO_ADDRESS);
        expect(position1[1]).to.equal(ZERO_ADDRESS);
        expect(position1[2]).to.equal("0");

        await Position.connect(owner).closePosition(2);

        position2 = await Position.positions(2);

        expect(position2[0]).to.equal(ZERO_ADDRESS);
        expect(position2[1]).to.equal(ZERO_ADDRESS);
        expect(position2[2]).to.equal("0");
      });
    });
  });
  describe("Debt to equity ratio test", function () {
    it("should get correct borrowed amount {Short}", async function () {
      const { owner, testCoin, testStableCoin, Position, rubiconMarket } =
        await loadFixture(deployPoolsUtilityFixture);

      for (let i = 0; i < 3; i++) {
        // get random num between 1 and 3
        const leverage = Math.random() * (3.0 - 1.0) + 1.0;
        const leverageDec = parseUnits(leverage.toString());
        const amount = ~~(Math.random() * (80 - 1) + 1);
        const amountDec = parseUnits(amount.toString(), 6);

        await Position.connect(owner).sellAllAmountWithLeverage(
          testStableCoin.address,
          testCoin.address,
          amountDec,
          leverageDec
        );

        const posId = await Position.lastPositionId();
        const pos = await Position.positions(posId);
        const marginFormated = formatUnits(amountDec, 6);
        const borrowedFormated = formatUnits(pos[2]);
        const levFormated = formatUnits(leverageDec);

        const need = ~~(marginFormated * levFormated);

        const testPrice = formatUnits(
          await rubiconMarket.getBuyAmount(
            testStableCoin.address,
            testCoin.address,
            parseUnits("1")
          ),
          6
        );
        const borrowedInTUSDC = borrowedFormated * testPrice;
        const res = ~~marginFormated + ~~borrowedInTUSDC;

        // small spread is expected
        expect(res).to.be.oneOf([
          need - 3,
          need - 2,
          need - 1,
          need,
          need + 1,
          need + 2,
        ]);
      }
    });

    it("should get correct borrowed amount {Long}", async function () {
      const { owner, testCoin, testStableCoin, Position, rubiconMarket } =
        await loadFixture(deployPoolsUtilityFixture);

      for (let i = 0; i < 3; i++) {
        // get random num between 1 and 3
        const leverage = Math.random() * (3.0 - 1.0) + 1.0;
        const leverageDec = parseUnits(leverage.toString());
        const amount = ~~(Math.random() * (80 - 1) + 1);
        const amountDec = parseUnits(amount.toString());

        await Position.connect(owner).buyAllAmountWithLeverage(
          testCoin.address,
          testStableCoin.address,
          amountDec,
          leverageDec
        );

        const posId = await Position.lastPositionId();
        const pos = await Position.positions(posId);
        const marginFormated = formatUnits(amountDec);
        const borrowedFormated = formatUnits(pos[2], 6);
        const levFormated = formatUnits(leverageDec);

        const need = ~~(marginFormated * levFormated);

        const testPrice = formatUnits(
          await rubiconMarket.getBuyAmount(
            testCoin.address,
            testStableCoin.address,
            parseUnits("1", 6)
          ),
          18
        );
        const borrowedInTUSDC = borrowedFormated * testPrice;
        const res = ~~marginFormated + ~~borrowedInTUSDC;

        // small spread is expected
        expect(res).to.be.oneOf([
          need - 3,
          need - 2,
          need - 1,
          need,
          need + 1,
          need + 2,
        ]);
      }
    });
  });
});
