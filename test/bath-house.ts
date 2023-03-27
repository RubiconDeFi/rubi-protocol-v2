import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { formatUnits, parseUnits } from "ethers/lib/utils";
const { expect } = require("chai");

describe("Building Bath", function () {
  const CERC20_ABI = [
    "function name() external view returns(string memory)",
    "function symbol() external view returns(string memory)",
    "function decimals() external view returns(uint8)",
    "function admin() external view returns(address)",
  ];

  async function compInitsFixture() {
    const [owner] = await ethers.getSigners();

    //==========COMPTROLLER==========
    const ComptrollerFactory = await ethers.getContractFactory("Comptroller");
    const comptroller = await ComptrollerFactory.deploy();

    const Unitroller = await ethers.getContractFactory("Unitroller");
    const unitroller = await Unitroller.deploy();

    // set comptroller implementation
    await unitroller._setPendingImplementation(comptroller.address);
    // become implementation
    await comptroller._become(unitroller.address);

    // Unitroller wrapped in Comptroller's interface
    const troll = new ethers.Contract(
      unitroller.address,
      comptroller.interface,
      owner
    );

    const BathHouseV2 = await ethers.getContractFactory("BathHouseV2");
    const bathHouseV2 = await BathHouseV2.deploy();
    await bathHouseV2.initialize(unitroller.address, owner.address);

    //==========BATH TOKENS==========
    const testCoinFactory = await ethers.getContractFactory("TokenWithFaucet");
    const testCoin = await testCoinFactory.deploy(
      owner.address,
      "Test",
      "TEST",
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

    // implementation for bathToken
    const cTokenFactory = await ethers.getContractFactory("CErc20Delegate");
    const cTokenImplementation = await cTokenFactory.deploy();

    // Initialize the market
    const underlying = testCoin.address;
    const interestRateModel = irModel.address;
    const initialExchangeRateMantissa = "200000000000000000000000000"; // TODO: What should this be?
    const becomeImplementationData = "0x"; //TODO: What should this be?

    await bathHouseV2.createBathToken(
      underlying,
      interestRateModel,
      initialExchangeRateMantissa,
      cTokenImplementation.address,
      becomeImplementationData
    );

    const bathTokenAddress = await bathHouseV2.getBathTokenFromAsset(
      underlying
    );
    const bathTEST = new ethers.Contract(bathTokenAddress, CERC20_ABI, owner);

    const Oracle = await ethers.getContractFactory("DummyPriceOracle");
    const oracle = await Oracle.deploy();

    await troll._setPriceOracle(oracle.address);
    await troll._supportMarket(bathTEST.address);
    await oracle.addCtoken(bathTEST.address, parseUnits("1.337"));
    await troll._setCollateralFactor(bathTEST.address, parseUnits("0.7"));

    return {
      bathHouseV2,
      unitroller,
      testCoin,
      bathTEST,
      troll,
      owner,
    };
  }

  it("should correctly initialize BathHouseV2", async function () {
    const { bathHouseV2, unitroller, testCoin, bathTEST, troll, owner } =
      await loadFixture(compInitsFixture);

    // right admins
    expect(await unitroller.admin()).to.be.equal(owner.address);
    expect(await bathTEST.admin()).to.be.equal(owner.address);
    expect(await bathHouseV2.admin()).to.be.equal(owner.address);
    expect(await bathHouseV2.proxyAdmin()).to.be.equal(owner.address);

    // proper metadata
    expect(await bathTEST.name()).to.be.equal("bathTEST");
    expect(await bathTEST.symbol()).to.be.equal("bathTESTv2");
    expect(
      await bathHouseV2.getBathTokenFromAsset(testCoin.address)
    ).to.be.equal(bathTEST.address);

    const market = await troll.markets(bathTEST.address);
    // market successfully supported
    expect(market[0]).to.be.equal(true);
    expect(market[1]).to.be.equal(parseUnits("0.7"));
  });
});
